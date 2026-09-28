/**
 * Bulk jobs: idempotent creation, one image in one active job at a time, batched retries,
 * phase-scoped progress with exactly-once notifications, compare-and-set cancel/stop, the
 * maintenance sweeps, the image-service breaker, auto-start and the API building blocks.
 * Real Postgres and Redis; no Shopify or image-service calls.
 */
import { UnrecoverableError, Worker } from "bullmq";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "../../app/db.server";
import {
  apiError,
  ApiError,
  bulkAcceptedBody,
  getApiJob,
  listApiItems,
  parseBulkRequest,
  requireApiShop,
} from "../../app/lib/api.server";
import { getCreditSummary, InsufficientCreditsError } from "../../app/lib/credits.server";
import {
  APPLY_STOPPED_NOTICE,
  applyApproved,
  cancelJob,
  createJob,
  decideItems,
  failJob,
  finishJob,
  finishReading,
  IN_ANOTHER_JOB_MESSAGE,
  itemCountsByJob,
  JobNotFoundError,
  JobStateError,
  pumpShop,
  refreshJobState,
  retryFailed,
  startJob,
  waitingForEarlierJob,
} from "../../app/lib/jobs.server";
import {
  listUnreadNotifications,
  markJobNotificationsRead,
  markNotificationRead,
} from "../../app/lib/notifications.server";
import { DEFAULT_PRESET } from "../../app/lib/presets";
import { cappedNotice, jobProgress, skippedNotice } from "../../app/lib/progress";
import { GPU_DOWN_KEY, ITEMS_QUEUE, itemsQueue, itemTaskId, jobsQueue } from "../../app/lib/queue.server";
import { createRedis, redis } from "../../app/lib/redis.server";
import { presignGet } from "../../app/lib/storage.server";
import { maintenance } from "../../worker/tasks/jobs";
import { MESSAGES } from "../../worker/messages";
import { runItemTask } from "../../worker/tasks/items";
import { ageRows, captureLogs, makeJob, makeShop, resetState, statusesOf } from "./helpers";

beforeEach(resetState);
afterAll(async () => {
  await itemsQueue().close();
  await jobsQueue().close();
  await redis().quit();
  await prisma.$disconnect();
});

const MINUTE = 60_000;
const byMsg = (lines: Array<Record<string, unknown>>, msg: string) => lines.filter((l) => l.msg === msg);

const PENDING = ["waiting", "prioritized", "delayed"] as const;
const pendingItemTasks = () => itemsQueue().getJobs([...PENDING]);
const pendingJobTasks = () => jobsQueue().getJobs([...PENDING]);

async function setStatus(itemId: string, status: "ready" | "flagged" | "failed" | "applied" | "approved") {
  await prisma.jobItem.update({ where: { id: itemId }, data: { status } });
}

describe("creating a job is idempotent", () => {
  it("returns the same job for a replayed request key, and enqueues one read", async () => {
    const shop = await makeShop(undefined, 25);
    const filter = { imageScope: "first" as const };
    const { result: first, lines } = await captureLogs(() =>
      createJob(shop.id, filter, DEFAULT_PRESET, { requestKey: "form-1", source: "ui" }),
    );
    const again = await createJob(shop.id, filter, DEFAULT_PRESET, { requestKey: "form-1" });
    expect(first.created).toBe(true);
    expect(again).toMatchObject({ id: first.id, created: false });
    expect(byMsg(lines, "BULK_JOB_CREATED")).toHaveLength(1);
    expect(byMsg(lines, "BULK_JOB_CREATED")[0]).toMatchObject({ jobId: first.id, source: "ui", selection: "All products · first image" });

    // Two tabs / a double click racing each other.
    const racing = await Promise.all([1, 2, 3].map(() => createJob(shop.id, filter, DEFAULT_PRESET, { requestKey: "race" })));
    expect(new Set(racing.map((j) => j.id)).size).toBe(1);
    expect(racing.filter((j) => j.created)).toHaveLength(1);

    expect(await prisma.job.count({ where: { shopId: shop.id } })).toBe(2);
    const reads = (await pendingJobTasks()).filter((t) => t.name === "read");
    expect(reads.map((t) => t.id).sort()).toEqual([`read-${first.id}`, `read-${racing[0].id}`].sort());

    // Keys are per shop; no key means no dedupe.
    const other = await makeShop("other.myshopify.com", 25);
    expect((await createJob(other.id, filter, DEFAULT_PRESET, { requestKey: "form-1" })).id).not.toBe(first.id);
    const a = await createJob(shop.id, filter, DEFAULT_PRESET);
    const b = await createJob(shop.id, filter, DEFAULT_PRESET);
    expect(a.id).not.toBe(b.id);
  });
});

describe("Redis trouble after the database commit", () => {
  it("keeps a new job whose read couldn't be enqueued; the reading sweep enqueues it later", async () => {
    const shop = await makeShop(undefined, 25);
    const add = vi.spyOn(jobsQueue(), "add").mockRejectedValueOnce(new Error("Stream isn't writeable"));
    try {
      const { result: job, lines } = await captureLogs(() => createJob(shop.id, { imageScope: "first" }, DEFAULT_PRESET));
      expect(job).toMatchObject({ status: "reading", created: true });
      expect(byMsg(lines, "read task not enqueued; maintenance will retry")).toHaveLength(1);
      expect(await pendingJobTasks()).toHaveLength(0);
      await ageRows("Job", [job.id], 10 * MINUTE);
      await presignGet("warmup");
      await maintenance();
      expect((await pendingJobTasks()).filter((t) => t.name === "read")).toHaveLength(1);
    } finally {
      add.mockRestore();
    }
  });

  it("starts the job even if handing images to the queue fails; maintenance puts them back", async () => {
    const shop = await makeShop(undefined, 25);
    const { job } = await makeJob(shop.id, [{}, {}]);
    const addBulk = vi.spyOn(itemsQueue(), "addBulk").mockRejectedValueOnce(new Error("Stream isn't writeable"));
    try {
      await startJob(shop.id, job.id); // resolves: the reservation and status are committed
    } finally {
      addBulk.mockRestore();
    }
    expect((await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("processing");
    expect(await statusesOf(job.id)).toEqual(["processing", "processing"]);
    expect(await pendingItemTasks()).toHaveLength(0);

    const items = await prisma.jobItem.findMany({ where: { jobId: job.id } });
    await ageRows("JobItem", items.map((i) => i.id), 4 * MINUTE);
    await presignGet("warmup");
    await maintenance();
    const again = await prisma.jobItem.findMany({ where: { jobId: job.id } });
    expect(again.map((i) => [i.status, i.attempts])).toEqual([
      ["processing", 2],
      ["processing", 2],
    ]);
    expect(await pendingItemTasks()).toHaveLength(2);
  });
});

describe("one image in one unfinished job at a time", () => {
  it("skips images another active job has, with a notice, and reserves only the rest", async () => {
    const shop = await makeShop(undefined, 25);
    const M1 = "gid://shopify/MediaImage/9001";
    const M2 = "gid://shopify/MediaImage/9002";
    const { job: a } = await makeJob(shop.id, [{ mediaId: M1, reserved: 1 }], "processing");
    const { job: b } = await makeJob(shop.id, [{ mediaId: M1 }, { mediaId: M2 }]);

    expect(await startJob(shop.id, b.id)).toEqual({ started: 1, skipped: 1, cost: 1 });
    const rowB = await prisma.job.findUniqueOrThrow({ where: { id: b.id } });
    expect(rowB).toMatchObject({ status: "processing", total: 1, phaseTotal: 1, error: skippedNotice(1) });
    expect((await prisma.jobItem.findMany({ where: { jobId: b.id } })).map((i) => i.mediaId)).toEqual([M2]);
    expect((await getCreditSummary(shop.id)).reserved).toBe(2);

    // Nothing left to start: refused, nothing changes.
    const { job: c } = await makeJob(shop.id, [{ mediaId: M1 }]);
    await expect(startJob(shop.id, c.id)).rejects.toThrow("already in another job");
    expect(await prisma.jobItem.count({ where: { jobId: c.id } })).toBe(1);

    // Once the first job is finished, the image is free again.
    await prisma.job.update({ where: { id: a.id }, data: { status: "done" } });
    expect(await startJob(shop.id, c.id)).toMatchObject({ started: 1, skipped: 0 });
  });

  it("counts an image being restored as busy, and retry leaves such a failed image alone", async () => {
    const shop = await makeShop(undefined, 25);
    const M3 = "gid://shopify/MediaImage/9003";
    await makeJob(shop.id, [{ mediaId: M3, status: "restore_queued", backupKey: "k" }], "done");
    const { job: e } = await makeJob(shop.id, [{ mediaId: M3 }, {}]);
    expect(await startJob(shop.id, e.id)).toMatchObject({ started: 1, skipped: 1 });

    const M4 = "gid://shopify/MediaImage/9004";
    await makeJob(shop.id, [{ mediaId: M4, reserved: 1 }], "processing");
    const { job: f, items } = await makeJob(shop.id, [{ mediaId: M4, status: "failed", error: "busy" }], "done");
    expect(await retryFailed(shop.id, f.id)).toEqual({ retried: 0, skipped: 1, status: "done" });
    // Its own failure reason stays, with why it wasn't retried after it (once, however often retried).
    expect(await retryFailed(shop.id, f.id)).toEqual({ retried: 0, skipped: 1, status: "done" });
    expect(await prisma.jobItem.findUniqueOrThrow({ where: { id: items[0].id } })).toMatchObject({
      status: "failed",
      error: `busy ${IN_ANOTHER_JOB_MESSAGE}`,
      errorCode: "in_another_job",
    });
  });
});

describe("retrying failed images", () => {
  it("retries only the chosen images, scopes the new phase to them, and a repeat is a no-op", async () => {
    const shop = await makeShop(undefined, 25);
    const { job, items } = await makeJob(
      shop.id,
      [{ status: "failed", errorCode: "busy" }, { status: "failed" }, { status: "failed" }, { status: "ready", reserved: 1 }],
      "review",
    );
    expect(await retryFailed(shop.id, job.id, [items[0].id])).toEqual({ retried: 1, skipped: 0, status: "processing" });
    expect(await statusesOf(job.id)).toEqual(["processing", "failed", "failed", "ready"]);
    const row = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(row).toMatchObject({ phaseTotal: 1, phaseFailedBase: 2, done: 0, failed: 0, completedAt: null });
    expect((await prisma.jobItem.findUniqueOrThrow({ where: { id: items[0].id } })).errorCode).toBeNull();
    expect(jobProgress(row, { processing: 1, failed: 2, ready: 1 })).toMatchObject({ total: 1, progress: 0 });

    // A second click (same ids) finds nothing failed: no-op, no error.
    expect(await retryFailed(shop.id, job.id, [items[0].id])).toMatchObject({ retried: 0 });
    // Other failed images still wait for the job to leave processing.
    await expect(retryFailed(shop.id, job.id, [items[1].id])).rejects.toBeInstanceOf(JobStateError);
  });

  it("retries 1,500 failures in a few statements, within the transaction timeout", async () => {
    const shop = await makeShop(undefined, 2000);
    const specs = [
      ...Array.from({ length: 1300 }, (_, i) => ({ status: "failed" as const, eligible: i % 10 === 0 })),
      ...Array.from({ length: 200 }, () => ({ status: "failed" as const, outputKey: "out.jpg" })),
    ];
    const { job } = await makeJob(shop.id, specs, "review");
    const t0 = Date.now();
    const result = await retryFailed(shop.id, job.id);
    const ms = Date.now() - t0;
    expect(result).toEqual({ retried: 1500, skipped: 0, status: "processing" });
    expect(ms).toBeLessThan(10_000);
    const counts = (await itemCountsByJob([job.id])).get(job.id)!;
    expect(counts).toMatchObject({ queued: 1297, processing: 3, approved: 200 });
    expect(counts.failed ?? 0).toBe(0);
    // 1300 to reprocess (130 upscale-eligible count double) + 200 to reapply.
    expect((await getCreditSummary(shop.id)).reserved).toBe(1300 + 130 + 200);
    expect(await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({ phaseTotal: 1300, phaseFailedBase: 0 });
  });
});

describe("progress and notifications", () => {
  it("notifies exactly once per phase end, however many refreshes race", async () => {
    const shop = await makeShop(undefined, 25);
    const { job, items } = await makeJob(shop.id, [{}, {}, {}]);
    await startJob(shop.id, job.id);
    await setStatus(items[0].id, "ready");
    await setStatus(items[1].id, "flagged");
    await setStatus(items[2].id, "failed");

    const { lines } = await captureLogs(() => Promise.all([1, 2, 3, 4, 5].map(() => refreshJobState(job.id))));
    let row = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(row).toMatchObject({ status: "review", total: 3, done: 2, failed: 1 });
    expect(row.completedAt).not.toBeNull();
    expect(byMsg(lines, "BULK_JOB_COMPLETED")).toHaveLength(1);
    expect(byMsg(lines, "BULK_JOB_COMPLETED")[0]).toMatchObject({ phase: "processing", completed: 2, failed: 1, next: "review" });
    expect(byMsg(lines, "JOB_PROCESSING_SUMMARY")).toHaveLength(1);
    expect(byMsg(lines, "BULK_JOB_PROGRESS").length).toBeGreaterThanOrEqual(1);
    let notes = await listUnreadNotifications(shop.id);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      kind: "job_processed",
      tone: "warning",
      title: "2 images are ready. 1 needs attention.",
      url: `/app/jobs/${job.id}`,
      jobId: job.id,
      body: "All products · first image",
    });

    // Apply round: scoped to the 2 approved images, its own notification.
    await decideItems(shop.id, job.id, [items[0].id, items[1].id], "approve");
    await applyApproved(shop.id, job.id);
    row = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(row).toMatchObject({ status: "applying", phaseTotal: 2, phaseFailedBase: 1, done: 0, failed: 0, completedAt: null });
    await setStatus(items[0].id, "applied");
    await setStatus(items[1].id, "applied");
    await Promise.all([1, 2, 3].map(() => refreshJobState(job.id)));
    expect((await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("done");
    notes = await listUnreadNotifications(shop.id);
    expect(notes.map((n) => n.title)).toEqual(["2 images were updated in your store.", "2 images are ready. 1 needs attention."]);

    // Retry reopens the job: a new phase, a new notification.
    expect(await retryFailed(shop.id, job.id)).toMatchObject({ retried: 1, status: "processing" });
    await setStatus(items[2].id, "ready");
    await refreshJobState(job.id);
    await refreshJobState(job.id);
    notes = await listUnreadNotifications(shop.id);
    expect(notes).toHaveLength(3);
    expect(notes[0]).toMatchObject({ title: "1 product image is ready.", tone: "success" });

    // Reading the job page (or dismissing) marks them read; other shops can't touch them.
    const other = await makeShop("other.myshopify.com", 25);
    expect(await markNotificationRead(other.id, notes[0].id)).toBe(0);
    expect(await markNotificationRead(shop.id, notes[0].id)).toBe(1);
    expect(await markJobNotificationsRead(shop.id, job.id)).toBe(2);
    expect(await listUnreadNotifications(shop.id)).toHaveLength(0);
  });

  it("links to the Failed tab when nothing succeeded", async () => {
    const shop = await makeShop(undefined, 25);
    const { job, items } = await makeJob(shop.id, [{}, {}]);
    await startJob(shop.id, job.id);
    for (const i of items) await setStatus(i.id, "failed");
    await refreshJobState(job.id);
    expect((await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("done");
    expect(await listUnreadNotifications(shop.id)).toMatchObject([
      { tone: "critical", title: "2 images couldn't be processed.", url: `/app/jobs/${job.id}?tab=failed` },
    ]);
  });

  it("logs BULK_JOB_PROGRESS on 10 % steps only", async () => {
    const shop = await makeShop(undefined, 100);
    const { job, items } = await makeJob(shop.id, Array.from({ length: 20 }, () => ({})));
    await startJob(shop.id, job.id);
    const { lines } = await captureLogs(async () => {
      for (const i of items) {
        await setStatus(i.id, "ready");
        await refreshJobState(job.id);
      }
    });
    const steps = byMsg(lines, "BULK_JOB_PROGRESS").map((l) => l.progress);
    expect(steps).toEqual([10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
  });

  it("tells a job that waits behind an older one", async () => {
    const shop = await makeShop(undefined, 100);
    await makeJob(shop.id, Array.from({ length: 5 }, () => ({ reserved: 1 })), "processing");
    const { job: newer } = await makeJob(shop.id, [{ reserved: 1 }], "processing");
    await prisma.job.update({ where: { id: newer.id }, data: { createdAt: new Date(Date.now() + 1000) } });
    await pumpShop(shop.id);
    const row = await prisma.job.findUniqueOrThrow({ where: { id: newer.id } });
    const counts = (await itemCountsByJob([newer.id])).get(newer.id)!;
    expect(counts).toEqual({ queued: 1 });
    expect(await waitingForEarlierJob(row, counts)).toBe(true);
  });
});

describe("cancel and stop are compare-and-set", () => {
  it("cancels running work; queued images are never claimed again", async () => {
    const shop = await makeShop(undefined, 25);
    const { job } = await makeJob(shop.id, [{}, {}, {}, {}, {}]);
    await startJob(shop.id, job.id);
    expect(await cancelJob(shop.id, job.id)).toBe("cancelled");
    await prisma.jobItem.updateMany({ where: { jobId: job.id, status: "processing" }, data: { status: "ready" } });
    expect(await pumpShop(shop.id)).toBe(0);
    await expect(cancelJob(shop.id, job.id)).rejects.toBeInstanceOf(JobStateError);
    // A read failing after the cancel doesn't turn it into "failed".
    expect(await failJob(job.id, "boom")).toBe(false);
    expect((await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("cancelled");
  });

  it("stops applying: back to review, the rest stays approved, unstarted writes are put back", async () => {
    const shop = await makeShop(undefined, 25);
    const { job, items } = await makeJob(
      shop.id,
      [
        { status: "approved", reserved: 1 },
        { status: "applying", reserved: 1 },
        { status: "applied" },
      ],
      "applying",
    );
    expect(await cancelJob(shop.id, job.id)).toBe("review");
    const row = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(row).toMatchObject({ status: "review", error: APPLY_STOPPED_NOTICE });
    expect(await pumpShop(shop.id)).toBe(0);
    // The in-flight write's task sees the job left applying and hands the image back.
    await runItemTask({ kind: "apply", itemId: items[1].id, jobId: job.id, shopId: shop.id });
    expect(await statusesOf(job.id)).toEqual(["approved", "approved", "applied"]);
    // Apply can resume.
    await applyApproved(shop.id, job.id);
    expect((await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).phaseTotal).toBe(2);
  });

  it("refuses review/done, and only one of two racing cancels or finishes wins", async () => {
    const shop = await makeShop(undefined, 25);
    const { job: review } = await makeJob(shop.id, [{ status: "ready", reserved: 1 }], "review");
    await expect(cancelJob(shop.id, review.id)).rejects.toThrow("can't be cancelled");
    const finishes = await Promise.allSettled([finishJob(shop.id, review.id), finishJob(shop.id, review.id)]);
    expect(finishes.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    await expect(cancelJob(shop.id, review.id)).rejects.toBeInstanceOf(JobStateError);

    const { job } = await makeJob(shop.id, [{ reserved: 1 }], "processing");
    const cancels = await Promise.allSettled([cancelJob(shop.id, job.id), cancelJob(shop.id, job.id)]);
    expect(cancels.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    await expect(cancelJob("someone-else", job.id)).rejects.toBeInstanceOf(JobNotFoundError);
  });
});

describe("maintenance sweeps", () => {
  // Maintenance also sweeps old try-it uploads: make sure the test bucket exists.
  beforeEach(() => presignGet("warmup").then(() => undefined));

  it("re-enqueues a read that was lost, never twice, and fails reads that took too long", async () => {
    const shop = await makeShop(undefined, 25);
    const lost = await prisma.job.create({
      data: { shopId: shop.id, status: "reading", filter: { imageScope: "first" }, presetSnapshot: DEFAULT_PRESET },
    });
    const alive = await prisma.job.create({
      data: { shopId: shop.id, status: "reading", filter: { imageScope: "first" }, presetSnapshot: DEFAULT_PRESET },
    });
    await jobsQueue().add("read", { name: "read", jobId: alive.id }, { jobId: `read-${alive.id}`, delay: 60_000 });
    const bulk = await prisma.job.create({
      data: {
        shopId: shop.id,
        status: "reading",
        filter: { imageScope: "first" },
        presetSnapshot: DEFAULT_PRESET,
        bulkOperationId: "gid://shopify/BulkOperation/1",
      },
    });
    const ancient = await prisma.job.create({
      data: {
        shopId: shop.id,
        status: "reading",
        filter: { imageScope: "first" },
        presetSnapshot: DEFAULT_PRESET,
        createdAt: new Date(Date.now() - 7 * 3600_000),
      },
    });
    await ageRows("Job", [lost.id, alive.id, bulk.id, ancient.id], 10 * MINUTE);

    await maintenance();
    await maintenance(); // same 10-minute bucket: no second task
    const tasks = await pendingJobTasks();
    const reads = tasks.filter((t) => t.name === "read");
    expect(reads.filter((t) => t.data.name === "read" && t.data.jobId === lost.id)).toHaveLength(1);
    expect(reads.filter((t) => t.data.name === "read" && t.data.jobId === alive.id).map((t) => t.id)).toEqual([`read-${alive.id}`]);
    expect(tasks.filter((t) => t.name === "ingest-bulk" && t.id?.startsWith(`ingest-sweep-${bulk.id}-`))).toHaveLength(1);
    expect(await prisma.job.findUniqueOrThrow({ where: { id: ancient.id } })).toMatchObject({
      status: "failed",
      error: MESSAGES.readTooLong,
    });
  });

  it("fails an image BullMQ gave up on (it kept stalling) instead of requeueing it forever", async () => {
    const shop = await makeShop(undefined, 25);
    const { job, items } = await makeJob(shop.id, [{ status: "processing", reserved: 1 }], "processing");
    await prisma.job.update({ where: { id: job.id }, data: { phaseTotal: 1, phaseStartedAt: new Date() } });
    await prisma.jobItem.update({ where: { id: items[0].id }, data: { attempts: 1 } });
    const taskId = itemTaskId("process", items[0].id, 1);
    await itemsQueue().add("process", { kind: "process", itemId: items[0].id, jobId: job.id, shopId: shop.id }, { jobId: taskId, attempts: 1 });

    // Stand-in for BullMQ failing a task after repeated stalls (the processor's catch never runs).
    const worker = new Worker(
      ITEMS_QUEUE,
      async () => {
        throw new UnrecoverableError("job stalled more than allowable limit");
      },
      { connection: createRedis(), autorun: false },
    );
    const failed = new Promise<void>((resolve) => worker.on("failed", () => resolve()));
    void worker.run();
    await failed;
    await worker.close();
    expect(await (await itemsQueue().getJob(taskId))!.getState()).toBe("failed");

    await ageRows("JobItem", [items[0].id], 5 * MINUTE);
    const { lines } = await captureLogs(() => maintenance());
    expect(await prisma.jobItem.findUniqueOrThrow({ where: { id: items[0].id } })).toMatchObject({
      status: "failed",
      error: MESSAGES.crashed,
      errorCode: "crashed",
    });
    expect(byMsg(lines, "IMAGE_JOB_FAILED")[0]).toMatchObject({ reason: "crashed", final: true });
    expect((await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("done");
    expect(await listUnreadNotifications(shop.id)).toMatchObject([{ title: "1 image couldn't be processed." }]);
  });

  it("puts back in-flight images whose task is gone after a few minutes, and ends stuck phases", async () => {
    const shop = await makeShop(undefined, 25);
    const { job, items } = await makeJob(shop.id, [{ status: "processing", reserved: 1 }], "processing");
    await ageRows("JobItem", [items[0].id], 2 * MINUTE);
    await maintenance();
    expect(await statusesOf(job.id)).toEqual(["processing"]); // too fresh to touch
    await ageRows("JobItem", [items[0].id], 4 * MINUTE);
    await maintenance();
    // Reverted to queued, then claimed again by the nudge with a new attempt number.
    const item = await prisma.jobItem.findUniqueOrThrow({ where: { id: items[0].id } });
    expect(item).toMatchObject({ status: "processing", attempts: 1 });
    expect((await pendingItemTasks()).map((t) => t.id)).toContain(itemTaskId("process", item.id, 1));

    // An apply round whose last image finished without moving the job on.
    const { job: stuck } = await makeJob(shop.id, [{ status: "applied" }, { status: "rejected" }], "applying");
    await prisma.job.update({ where: { id: stuck.id }, data: { phaseTotal: 1, phaseStartedAt: new Date() } });
    await ageRows("Job", [stuck.id], 10 * MINUTE);
    await maintenance();
    expect((await prisma.job.findUniqueOrThrow({ where: { id: stuck.id } })).status).toBe("done");
    expect((await listUnreadNotifications(shop.id)).map((n) => n.title)).toContain("1 image was updated in your store.");
  });
});

describe("image-service breaker", () => {
  it("claims no new processing while gpu:down is set; applies and restores continue", async () => {
    const shop = await makeShop(undefined, 25);
    const { job } = await makeJob(shop.id, [{ reserved: 1 }, { reserved: 1 }], "processing");
    const { job: done } = await makeJob(shop.id, [{ status: "restore_queued", backupKey: "k" }], "done");
    await redis().set(GPU_DOWN_KEY, "1", "EX", 60);
    expect(await pumpShop(shop.id)).toBe(1);
    expect(await statusesOf(done.id)).toEqual(["restoring"]);
    expect(await statusesOf(job.id)).toEqual(["queued", "queued"]);
    await redis().del(GPU_DOWN_KEY);
    expect(await pumpShop(shop.id)).toBe(2);
  });
});

describe("auto-start (API jobs)", () => {
  async function readJobWith(shopId: string, n: number) {
    const { job } = await makeJob(shopId, Array.from({ length: n }, () => ({})), "reading");
    await prisma.job.update({ where: { id: job.id }, data: { autoStart: true } });
    return job;
  }

  it("starts processing as soon as reading finishes (reserving, not charging)", async () => {
    const shop = await makeShop(undefined, 25);
    const job = await readJobWith(shop.id, 4);
    await finishReading(job.id);
    const row = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(row).toMatchObject({ status: "processing", phaseTotal: 4 });
    expect(await getCreditSummary(shop.id)).toEqual({ balance: 25, reserved: 4, available: 21 });
  });

  it("waits in estimated with a notice and a notification when credits are short", async () => {
    const shop = await makeShop(undefined, 2);
    const job = await readJobWith(shop.id, 3);
    await finishReading(job.id, cappedNotice(3));
    const row = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(row.status).toBe("estimated");
    expect(row.error).toBe(
      `${cappedNotice(3)}\nNot enough credits to start processing 3 images. This job needs 3 credits; 2 are available.`,
    );
    expect(await listUnreadNotifications(shop.id)).toMatchObject([
      { kind: "job_needs_credits", title: "Not enough credits to start processing 3 images.", url: `/app/jobs/${job.id}` },
    ]);
    const api = await getApiJob(shop.id, job.id);
    expect(api).toMatchObject({ status: "queued", phase: "estimated", needsAction: "credits", total: 3 });

    // More credits, then Start: the credits notice goes, the other stays.
    await prisma.shop.update({ where: { id: shop.id }, data: { creditBalance: 10 } });
    expect((await getApiJob(shop.id, job.id))?.needsAction).toBe("start");
    await startJob(shop.id, job.id);
    expect((await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).error).toBe(cappedNotice(3));
  });

  it("surfaces insufficient credits to a manual start as before", async () => {
    const shop = await makeShop(undefined, 1);
    const { job } = await makeJob(shop.id, [{}, {}]);
    await expect(startJob(shop.id, job.id)).rejects.toBeInstanceOf(InsufficientCreditsError);
  });
});

describe("API building blocks", () => {
  it("validates bulk requests", () => {
    const parsed = parseBulkRequest({ productIds: ["1", 2], imageIds: ["gid://shopify/MediaImage/5"] }, 5000);
    expect(parsed).toEqual({
      filter: {
        productIds: ["gid://shopify/Product/1", "gid://shopify/Product/2"],
        mediaIds: ["gid://shopify/MediaImage/5"],
        imageScope: "first",
      },
      preset: {},
      autoStart: true,
    });
    expect(parseBulkRequest({ productIds: ["1"], imageScope: "all", autoStart: false, preset: { marginPct: 12 } }, 5000)).toMatchObject({
      preset: { marginPct: 12 },
      autoStart: false,
    });
    const status = (fn: () => unknown) => {
      try {
        fn();
      } catch (error) {
        return apiError(error).status;
      }
      return 200;
    };
    expect(status(() => parseBulkRequest({ productIds: [] }, 5000))).toBe(400);
    expect(status(() => parseBulkRequest({ productIds: ["1"], mediaIds: ["2"], imageIds: ["3"] }, 5000))).toBe(400);
    expect(status(() => parseBulkRequest({ productIds: ["1", "2", "3"] }, 2))).toBe(400);
    expect(status(() => parseBulkRequest({ productIds: ["1"], preset: { colour: "red" } }, 5000))).toBe(400);
    expect(status(() => parseBulkRequest({ productIds: ["1"], extra: true }, 5000))).toBe(400);
    expect(status(() => parseBulkRequest({ productIds: ["gid://shopify/Collection/1"] }, 5000))).toBe(400);
  });

  it("maps errors to statuses, and requires a session token", async () => {
    expect(apiError(new JobNotFoundError()).status).toBe(404);
    expect(apiError(new JobStateError("nope")).status).toBe(409);
    const credits = apiError(new InsufficientCreditsError(10, 3));
    expect(credits.status).toBe(402);
    expect(await credits.json()).toMatchObject({ needed: 10, available: 3 });
    expect(apiError(new ApiError(413, "big")).status).toBe(413);
    expect(apiError(new Error("boom")).status).toBe(500);
    expect(apiError(new Error("boom")).headers.get("cache-control")).toBe("no-store");
    const unauth = await requireApiShop(new Request("https://vio.example.com/api/image-jobs/x")).catch((e: unknown) => e);
    expect(unauth).toBeInstanceOf(Response);
    expect((unauth as Response).status).toBe(401);
  });

  it("serialises jobs and pages of items, scoped by shop", async () => {
    const shop = await makeShop(undefined, 25);
    const other = await makeShop("other.myshopify.com", 25);
    const { job, items } = await makeJob(
      shop.id,
      [{ status: "ready", reserved: 1 }, { status: "failed", errorCode: "busy", error: "busy" }, { status: "applied" }, { status: "failed", outputKey: "o.jpg" }],
      "review",
    );
    expect(await getApiJob(other.id, job.id)).toBeNull();
    expect(await listApiItems(other.id, job.id, new URLSearchParams())).toBeNull();

    const api = await getApiJob(shop.id, job.id);
    expect(api).toMatchObject({
      id: job.id,
      status: "completed_with_errors",
      phase: "review",
      total: 4,
      completed: 2,
      failed: 2,
      progress: 100,
      etaSeconds: null,
      needsAction: "review",
      selection: "All products · first image",
      reviewUrl: `/app/jobs/${job.id}`,
    });

    const failed = await listApiItems(shop.id, job.id, new URLSearchParams({ status: "failed" }));
    expect(failed?.total).toBe(2);
    expect(failed?.items.map((i) => [i.status, i.errorCode])).toEqual(
      expect.arrayContaining([
        ["failed", "busy"],
        ["failed", "apply_unknown"],
      ]),
    );
    const completed = await listApiItems(shop.id, job.id, new URLSearchParams({ status: "completed", limit: "1", page: "2" }));
    expect(completed).toMatchObject({ total: 2, page: 2, pages: 2, limit: 1 });
    expect(completed?.items[0]).toMatchObject({ status: "completed", bulkJobId: job.id });
    expect((await listApiItems(shop.id, job.id, new URLSearchParams({ limit: "1000" })))?.limit).toBe(100);
    await expect(listApiItems(shop.id, job.id, new URLSearchParams({ status: "weird" }))).rejects.toBeInstanceOf(ApiError);
    const approved = await listApiItems(shop.id, job.id, new URLSearchParams({ status: "applied" }));
    expect(approved?.items.map((i) => [i.id, i.reviewStatus])).toEqual([[items[2].id, "applied"]]);

    expect(bulkAcceptedBody({ id: "j", filter: { productIds: ["a", "b"], imageScope: "first" } })).toEqual({
      jobId: "j",
      status: "queued",
      total: 2,
    });
    expect(bulkAcceptedBody({ id: "j", filter: { productIds: ["a"], imageScope: "all" } }).total).toBeNull();
    expect(bulkAcceptedBody({ id: "j", filter: { productIds: ["a"], mediaIds: ["m1", "m2", "m3"], imageScope: "first" } }).total).toBe(3);
  });
});
