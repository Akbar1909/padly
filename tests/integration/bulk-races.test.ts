/**
 * Bulk jobs under contention: operations that change the same job from different places
 * (a cancel while a start runs, a finish or an apply while a retry runs, a stale refresh after
 * a retry reopened the job), retries at MAX_ITEMS_PER_JOB with a competing active job, shop
 * slots during retry backoff, and maintenance scans that page past healthy rows.
 * Real Postgres and Redis; the races are forced with row locks held by a second transaction.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "../../app/db.server";
import { getCreditSummary } from "../../app/lib/credits.server";
import {
  ALL_IN_ANOTHER_JOB_MESSAGE,
  APPLY_STOPPED_NOTICE,
  applyApproved,
  cancelJob,
  finishJob,
  finishReading,
  itemRetryScheduled,
  JobStateError,
  pumpShop,
  refreshJobState,
  retryFailed,
  startJob,
} from "../../app/lib/jobs.server";
import { listUnreadNotifications } from "../../app/lib/notifications.server";
import { itemsQueue, itemTaskId, jobsQueue } from "../../app/lib/queue.server";
import { redis } from "../../app/lib/redis.server";
import { presignGet } from "../../app/lib/storage.server";
import { maintenance } from "../../worker/tasks/jobs";
import { ageRows, captureLogs, makeJob, makeShop, resetState, statusesOf } from "./helpers";

beforeEach(resetState);
afterAll(async () => {
  await itemsQueue().close();
  await jobsQueue().close();
  await redis().quit();
  await prisma.$disconnect();
});

const MINUTE = 60_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const settle = <T>(p: Promise<T>) =>
  p.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );

/** Hold a row lock on one JobItem in another transaction until release() is called. */
function holdItemLock(itemId: string) {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let locked!: () => void;
  const isLocked = new Promise<void>((r) => (locked = r));
  const done = prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM "JobItem" WHERE "id" = ${itemId} FOR UPDATE`;
      locked();
      await gate;
    },
    { timeout: 30_000 },
  );
  return { isLocked, release, done };
}

describe("a start and a cancel at the same time", () => {
  it("a cancel that commits while startJob runs wins: nothing is reserved or processed", async () => {
    const shop = await makeShop(undefined, 25);
    const { job, items } = await makeJob(shop.id, [{}, {}, { excluded: true }], "estimated");
    const hold = holdItemLock(items[0].id);
    await hold.isLocked;
    const start = settle(startJob(shop.id, job.id));
    await sleep(300); // startJob now waits on the locked item (the reservation update)
    expect(await cancelJob(shop.id, job.id)).toBe("cancelled");
    hold.release();
    await hold.done;

    const res = await start;
    expect(res.ok).toBe(false);
    expect(!res.ok && res.error).toBeInstanceOf(JobStateError);
    const row = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(row).toMatchObject({ status: "cancelled", startedAt: null, phaseTotal: 0 });
    // Rolled back whole: the unticked image wasn't deleted, nothing reserved, nothing queued.
    expect(await prisma.jobItem.count({ where: { jobId: job.id } })).toBe(3);
    expect(await prisma.jobItem.aggregate({ _sum: { creditsReserved: true }, where: { jobId: job.id } })).toMatchObject({
      _sum: { creditsReserved: 0 },
    });
    expect((await getCreditSummary(shop.id)).reserved).toBe(0);
    expect(await pumpShop(shop.id)).toBe(0);
  });
});

describe("a retry racing other changes of the job", () => {
  it("a finish that commits while retryFailed runs wins; the retry rolls back", async () => {
    const shop = await makeShop(undefined, 25);
    const { job, items } = await makeJob(shop.id, [{ status: "failed" }, { status: "ready", reserved: 1, outputKey: "o" }], "review");
    const failed = items.find((i) => i.status === "failed")!;
    const hold = holdItemLock(failed.id);
    await hold.isLocked;
    const retry = settle(retryFailed(shop.id, job.id));
    await sleep(300);
    await finishJob(shop.id, job.id);
    hold.release();
    await hold.done;

    const res = await retry;
    expect(!res.ok && res.error).toBeInstanceOf(JobStateError);
    expect((await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("done");
    expect(await prisma.jobItem.findUniqueOrThrow({ where: { id: failed.id } })).toMatchObject({
      status: "failed",
      creditsReserved: 0,
    });
    expect(await pumpShop(shop.id)).toBe(0);
  });

  it("an apply that commits while retryFailed runs keeps its apply-phase snapshot", async () => {
    const shop = await makeShop(undefined, 25);
    const { job, items } = await makeJob(
      shop.id,
      [{ status: "failed" }, { status: "approved", reserved: 1, outputKey: "o" }],
      "review",
    );
    const failed = items.find((i) => i.status === "failed")!;
    const hold = holdItemLock(failed.id);
    await hold.isLocked;
    const retry = settle(retryFailed(shop.id, job.id));
    await sleep(300);
    await applyApproved(shop.id, job.id);
    hold.release();
    await hold.done;

    expect((await retry).ok).toBe(false);
    expect(await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({
      status: "applying",
      phaseTotal: 1,
      phaseFailedBase: 1,
    });
    expect((await prisma.jobItem.findUniqueOrThrow({ where: { id: failed.id } })).status).toBe("failed");
  });

  it("the review expiry that commits while retryFailed runs isn't overwritten", async () => {
    const shop = await makeShop(undefined, 25);
    const { job, items } = await makeJob(shop.id, [{ status: "failed", outputKey: "o" }], "review");
    const hold = holdItemLock(items[0].id);
    await hold.isLocked;
    const retry = settle(retryFailed(shop.id, job.id));
    await sleep(300);
    await prisma.job.updateMany({ where: { id: job.id, status: "review" }, data: { status: "done", completedAt: new Date() } });
    hold.release();
    await hold.done;
    expect((await retry).ok).toBe(false);
    expect((await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("done");
    expect(await statusesOf(job.id)).toEqual(["failed"]);
  });
});

type Transaction = (...args: unknown[]) => Promise<unknown>;

/**
 * Intercept the next prisma.$transaction call only: `wrap` gets the call's arguments and the
 * real $transaction. Prisma's client is a proxy (vi.spyOn can't restore it), so the override
 * is an own property, deleted on first use or by the returned restore().
 */
function interceptNextTransaction(wrap: (args: unknown[], real: Transaction) => Promise<unknown>): () => void {
  const client = prisma as unknown as { $transaction?: Transaction };
  const real = client.$transaction!;
  const restore = () => {
    delete client.$transaction;
  };
  client.$transaction = (...args: unknown[]) => {
    restore();
    return wrap(args, (...a: unknown[]) => real.apply(prisma, a));
  };
  return restore;
}

describe("a stale refresh after Retry reopened the job", () => {
  it("never ends the new phase with counts read in the old one", async () => {
    const shop = await makeShop(undefined, 25);
    // Same total, same zeroed counters and same phase size before and after the retry: only
    // the phase's start tells the two phases apart.
    const { job, items } = await makeJob(shop.id, [{ status: "failed" }], "processing");
    await prisma.job.update({
      where: { id: job.id },
      data: { phaseTotal: 1, phaseStartedAt: new Date(Date.now() - MINUTE), startedAt: new Date(Date.now() - MINUTE) },
    });

    // The first transaction is the stale refresh ending the phase. Before it writes: another
    // refresh ends the phase, and the merchant retries the failed image.
    let inner: unknown;
    const restore = interceptNextTransaction(async (args, real) => {
      await refreshJobState(job.id);
      inner = await retryFailed(shop.id, job.id);
      return real(...args);
    });
    try {
      expect(await refreshJobState(job.id)).toBe("processing");
    } finally {
      restore();
    }
    expect(inner).toEqual({ retried: 1, skipped: 0, status: "processing" });
    expect(await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({
      status: "processing",
      completedAt: null,
      phaseTotal: 1,
      failed: 0,
    });
    expect((await prisma.jobItem.findUniqueOrThrow({ where: { id: items[0].id } })).status).toBe("processing");
    // Exactly one notification: the first phase's.
    expect((await listUnreadNotifications(shop.id)).map((n) => n.title)).toEqual(["1 image couldn't be processed."]);
  });

  it("creates the phase-end notification in the transaction that ends the phase", async () => {
    const shop = await makeShop(undefined, 25);
    const { job } = await makeJob(shop.id, [{ status: "ready", reserved: 1 }], "processing");
    await prisma.job.update({ where: { id: job.id }, data: { phaseTotal: 1, phaseStartedAt: new Date() } });
    // If the notification can't be written, the phase doesn't end either (the next refresh
    // or the stuck-phase sweep ends it, with its notification).
    const failing = vi.fn().mockRejectedValue(new Error("connection lost"));
    const restore = interceptNextTransaction(async ([fn, ...rest], real) =>
      real(async (tx: object) => {
        const broken = new Proxy(tx, {
          get: (target, key) => (key === "notification" ? { createMany: failing } : Reflect.get(target, key)),
        });
        return (fn as (t: object) => Promise<unknown>)(broken);
      }, ...rest),
    );
    try {
      await expect(refreshJobState(job.id)).rejects.toThrow("connection lost");
    } finally {
      restore();
    }
    expect(failing).toHaveBeenCalledTimes(1);
    expect((await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("processing");
    expect(await refreshJobState(job.id)).toBe("review");
    expect((await listUnreadNotifications(shop.id)).map((n) => n.title)).toEqual(["1 product image is ready."]);
  });
});

describe("notices go when they're out of date", () => {
  it("drops a blocked auto-start's reason once the job starts, and a stopped apply's notice on the next apply", async () => {
    const shop = await makeShop(undefined, 25);
    const M = "gid://shopify/MediaImage/555";
    const { job: other } = await makeJob(shop.id, [{ mediaId: M, reserved: 1 }], "processing");
    const { job } = await makeJob(shop.id, [{ mediaId: M }], "reading");
    await prisma.job.update({ where: { id: job.id }, data: { autoStart: true } });
    await finishReading(job.id);
    expect(await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({
      status: "estimated",
      error: ALL_IN_ANOTHER_JOB_MESSAGE,
    });
    await prisma.job.update({ where: { id: other.id }, data: { status: "done" } });
    await startJob(shop.id, job.id);
    expect((await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).error).toBeNull();

    const { job: applying } = await makeJob(shop.id, [{ status: "approved", reserved: 1 }, { status: "approved", reserved: 1 }], "applying");
    await prisma.job.update({ where: { id: applying.id }, data: { error: "Kept notice" } });
    expect(await cancelJob(shop.id, applying.id)).toBe("review");
    expect((await prisma.job.findUniqueOrThrow({ where: { id: applying.id } })).error).toBe(`Kept notice\n${APPLY_STOPPED_NOTICE}`);
    await applyApproved(shop.id, applying.id);
    expect((await prisma.job.findUniqueOrThrow({ where: { id: applying.id } })).error).toBe("Kept notice");
  });
});

// ─── Scale ──────────────────────────────────────────────────────────────────

async function bigJob(
  shopId: string,
  n: number,
  status: "estimated" | "review" | "processing",
  itemStatus: "queued" | "failed" | "ready",
  media: (i: number) => string,
) {
  const job = await prisma.job.create({
    data: { shopId, status, filter: { imageScope: "first" }, presetSnapshot: {}, total: n },
  });
  for (let off = 0; off < n; off += 1000) {
    await prisma.jobItem.createMany({
      data: Array.from({ length: Math.min(1000, n - off) }, (_, k) => {
        const i = off + k;
        return {
          jobId: job.id,
          shopId,
          productId: `gid://shopify/Product/${i}`,
          productTitle: `P ${i}`,
          mediaId: media(i),
          position: 0,
          originalUrl: "https://cdn.example.com/x.jpg",
          status: itemStatus,
          creditsReserved: itemStatus === "ready" ? 1 : 0,
        };
      }),
    });
  }
  return job;
}

describe("at MAX_ITEMS_PER_JOB with another active job of the shop", () => {
  it("starts and retries 5,000 images quickly, skipping only the ones the other job has", async () => {
    const shop = await makeShop(undefined, 30_000);
    // Fresh rows, no ANALYZE: the planner works from stale statistics, as right after a big read.
    await bigJob(shop.id, 5000, "review", "ready", (i) => `gid://shopify/MediaImage/9${i}`);
    const overlap = (i: number) => (i < 100 ? `gid://shopify/MediaImage/9${i}` : `gid://shopify/MediaImage/1${i}`);

    const estimated = await bigJob(shop.id, 5000, "estimated", "queued", overlap);
    let t0 = Date.now();
    expect(await startJob(shop.id, estimated.id)).toMatchObject({ started: 4900, skipped: 100 });
    const startMs = Date.now() - t0;

    const failed = await bigJob(shop.id, 5000, "review", "failed", (i) =>
      i < 100 ? `gid://shopify/MediaImage/9${i}` : `gid://shopify/MediaImage/2${i}`,
    );
    t0 = Date.now();
    expect(await retryFailed(shop.id, failed.id)).toEqual({ retried: 4900, skipped: 100, status: "processing" });
    const retryMs = Date.now() - t0;

    expect(startMs).toBeLessThan(3000);
    expect(retryMs).toBeLessThan(3000);
    expect(await prisma.jobItem.count({ where: { jobId: failed.id, errorCode: "in_another_job" } })).toBe(100);
  });
});

// ─── Shop slots during retry backoff ────────────────────────────────────────

describe("an image waiting to retry gives its shop slot back", () => {
  it("lets the shop's next work run during the backoff, and bounds the burst when retries come due", async () => {
    const shop = await makeShop(undefined, 25); // SHOP_CONCURRENCY is 3 in tests
    const { job } = await makeJob(shop.id, Array.from({ length: 8 }, () => ({ reserved: 1 })), "processing");
    expect(await pumpShop(shop.id)).toBe(3);
    const task = (itemId: string) => ({ kind: "process" as const, itemId, jobId: job.id, shopId: shop.id });
    const inflight = () =>
      prisma.jobItem.findMany({ where: { jobId: job.id, status: "processing" }, orderBy: { attempts: "asc" } });

    // Two images fail and wait to retry: the next two images are claimed right away.
    const [a, b] = await inflight();
    await itemRetryScheduled(task(a.id), MINUTE);
    await itemRetryScheduled(task(b.id), MINUTE);
    expect((await inflight()).length).toBe(5);
    expect((await prisma.jobItem.findUniqueOrThrow({ where: { id: a.id } })).retryAt).not.toBeNull();

    // Everything in flight waits to retry: at most twice SHOP_CONCURRENCY in flight, counting them.
    for (const item of await inflight()) {
      if (!item.retryAt) await itemRetryScheduled(task(item.id), MINUTE);
    }
    expect((await inflight()).length).toBe(6);
    expect(await pumpShop(shop.id)).toBe(0);

    // A backoff that ran out holds its slot again.
    await prisma.jobItem.updateMany({ where: { jobId: job.id, status: "processing" }, data: { retryAt: new Date(Date.now() - 1000) } });
    expect(await pumpShop(shop.id)).toBe(0);

    // A claim clears it.
    await prisma.jobItem.updateMany({
      where: { jobId: job.id, status: "processing" },
      data: { status: "queued", retryAt: new Date(Date.now() + MINUTE) },
    });
    expect(await pumpShop(shop.id)).toBe(3);
    expect((await inflight()).every((i) => i.retryAt === null)).toBe(true);

    // Only the image's in-flight status is marked (a task that already settled is left alone).
    const queued = await prisma.jobItem.findFirstOrThrow({ where: { jobId: job.id, status: "queued" } });
    await itemRetryScheduled(task(queued.id), 10 * MINUTE);
    expect((await prisma.jobItem.findUniqueOrThrow({ where: { id: queued.id } })).retryAt).toEqual(queued.retryAt);
  });
});

// ─── Maintenance scans ──────────────────────────────────────────────────────

describe("maintenance pages past healthy rows", () => {
  beforeEach(() => presignGet("warmup").then(() => undefined));

  it("finds a stuck phase among many jobs that are just waiting their turn", async () => {
    const shop = await makeShop(undefined, 1000);
    const waiting: string[] = [];
    for (let i = 0; i < 120; i++) {
      const { job } = await makeJob(shop.id, [{ reserved: 1 }], "processing");
      waiting.push(job.id);
    }
    const { job: stuck } = await makeJob(shop.id, [{ status: "ready", reserved: 1 }], "processing");
    await prisma.job.update({ where: { id: stuck.id }, data: { phaseTotal: 1, phaseStartedAt: new Date() } });
    await ageRows("Job", waiting, 30 * MINUTE); // older than the stuck one: first in any updatedAt order
    await ageRows("Job", [stuck.id], 10 * MINUTE);
    await maintenance();
    expect((await prisma.job.findUniqueOrThrow({ where: { id: stuck.id } })).status).toBe("review");
    expect(await prisma.job.count({ where: { id: { in: waiting }, status: "processing" } })).toBe(120);
  });

  it("reaches a lost in-flight image behind a full page of live ones, on the next run", async () => {
    const shop = await makeShop(undefined, 1000);
    const { job, items } = await makeJob(
      shop.id,
      Array.from({ length: 501 }, () => ({ status: "processing" as const, reserved: 1 })),
      "processing",
    );
    await prisma.jobItem.updateMany({ where: { jobId: job.id }, data: { attempts: 1 } });
    const lost = items[500];
    const live = items.slice(0, 500);
    // Live tasks (retrying later) for all but one image.
    await itemsQueue().addBulk(
      live.map((i) => ({
        name: "process",
        data: { kind: "process" as const, itemId: i.id, jobId: job.id, shopId: shop.id },
        opts: { jobId: itemTaskId("process", i.id, 1), delay: 10 * MINUTE },
      })),
    );
    await ageRows("JobItem", live.map((i) => i.id), 20 * MINUTE);
    await ageRows("JobItem", [lost.id], 10 * MINUTE);

    await maintenance();
    expect((await prisma.jobItem.findUniqueOrThrow({ where: { id: lost.id } })).status).toBe("processing");
    await maintenance();
    // Put back to be claimed again (the shop's slots are all taken by the live ones).
    expect((await prisma.jobItem.findUniqueOrThrow({ where: { id: lost.id } })).status).toBe("queued");
    expect(await prisma.jobItem.count({ where: { jobId: job.id, status: "processing" } })).toBe(500);
  });

  it("goes on with the other steps when one shop's pump fails", async () => {
    const shop = await makeShop(undefined, 25);
    await makeJob(shop.id, [{ reserved: 1 }], "processing");
    const { job: review } = await makeJob(shop.id, [{ status: "ready", reserved: 1 }], "review");
    await ageRows("Job", [review.id], 15 * 24 * 60 * MINUTE);
    const addBulk = vi.spyOn(itemsQueue(), "addBulk").mockRejectedValueOnce(new Error("Command timed out"));
    try {
      const { lines } = await captureLogs(() => maintenance());
      expect(lines.filter((l) => l.msg === "maintenance pump failed")).toHaveLength(1);
    } finally {
      addBulk.mockRestore();
    }
    // The review expiry (a later step) still ran.
    expect((await prisma.job.findUniqueOrThrow({ where: { id: review.id } })).status).toBe("done");
  });
});
