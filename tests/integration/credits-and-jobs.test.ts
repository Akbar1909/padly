import { afterAll, beforeEach, describe, expect, it } from "vitest";
import prisma from "../../app/db.server";
import { applyPurchaseStatus } from "../../app/lib/billing.server";
import {
  getCreditSummary,
  InsufficientCreditsError,
  lockShop,
  recordLedger,
} from "../../app/lib/credits.server";
import {
  applyApproved,
  approveAllUnflagged,
  decideItems,
  finishJob,
  finishReading,
  JobStateError,
  NO_MATCH_NOTICE,
  pumpShop,
  refreshJobState,
  restoreItems,
  retryFailed,
  selectionEstimate,
  setIncluded,
  startJob,
} from "../../app/lib/jobs.server";
import { itemsQueue } from "../../app/lib/queue.server";
import { redis } from "../../app/lib/redis.server";
import { ensureShop } from "../../app/lib/shops.server";
import { flag, makeJob, makeShop, resetState, statusesOf } from "./helpers";

beforeEach(resetState);
afterAll(async () => {
  await itemsQueue().close();
  await redis().quit();
  await prisma.$disconnect();
});

describe("install", () => {
  it("creates the shop with a default preset and grants free credits exactly once", async () => {
    const first = await ensureShop("fresh.myshopify.com");
    const again = await ensureShop("fresh.myshopify.com");
    expect(again.id).toBe(first.id);
    expect(again.creditBalance).toBe(25);
    expect(await prisma.creditLedger.count({ where: { shopId: first.id } })).toBe(1);
    expect(await prisma.preset.count({ where: { shopId: first.id, isDefault: true } })).toBe(1);

    // Reinstall: clears uninstalledAt, no second free grant.
    await prisma.shop.update({ where: { id: first.id }, data: { uninstalledAt: new Date() } });
    const reinstalled = await ensureShop("fresh.myshopify.com");
    expect(reinstalled.uninstalledAt).toBeNull();
    expect(reinstalled.creditBalance).toBe(25);
  });
});

describe("reading", () => {
  it("a selection with no images ends as done with a notice, not failed", async () => {
    const shop = await makeShop(undefined, 25);
    const { job } = await makeJob(shop.id, [], "reading");
    await finishReading(job.id);
    const row = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(row).toMatchObject({ status: "done", total: 0, error: NO_MATCH_NOTICE });
    expect(row.completedAt).not.toBeNull();
    expect(await getCreditSummary(shop.id)).toEqual({ balance: 25, reserved: 0, available: 25 });
  });
});

describe("starting a job", () => {
  it("reserves 1 credit per image +1 per upscale-eligible image, then claims up to SHOP_CONCURRENCY", async () => {
    const shop = await makeShop(undefined, 25);
    const { job } = await makeJob(shop.id, [{ eligible: true }, {}, {}, {}, {}]);

    await startJob(shop.id, job.id);

    const credits = await getCreditSummary(shop.id);
    expect(credits).toEqual({ balance: 25, reserved: 6, available: 19 });
    expect((await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("processing");

    const statuses = await statusesOf(job.id);
    expect(statuses.filter((s) => s === "processing")).toHaveLength(3);
    expect(statuses.filter((s) => s === "queued")).toHaveLength(2);

    const waiting = await itemsQueue().getJobs(["waiting", "prioritized"]);
    expect(waiting).toHaveLength(3);
    expect(waiting.every((j) => j.data.kind === "process" && /^process-.+-1$/.test(j.id!))).toBe(true);
  });

  it("refuses to start without enough credits and reserves nothing", async () => {
    const shop = await makeShop(undefined, 3);
    const { job } = await makeJob(shop.id, [{}, {}, { eligible: true }]);

    await expect(startJob(shop.id, job.id)).rejects.toBeInstanceOf(InsufficientCreditsError);
    expect((await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("estimated");
    expect((await getCreditSummary(shop.id)).reserved).toBe(0);
  });

  it("counts other open jobs' reservations against the balance", async () => {
    const shop = await makeShop(undefined, 5);
    await makeJob(shop.id, [{ status: "ready", reserved: 2 }, { status: "flagged", reserved: 1 }], "review");
    const { job } = await makeJob(shop.id, [{}, {}, {}]);
    await expect(startJob(shop.id, job.id)).rejects.toMatchObject({ needed: 3, available: 2 });
  });

  it("only starts estimated jobs, and only the owner's", async () => {
    const shop = await makeShop(undefined, 25);
    const other = await makeShop("other.myshopify.com", 25);
    const { job } = await makeJob(shop.id, [{}]);
    await expect(startJob(other.id, job.id)).rejects.toBeInstanceOf(JobStateError);
    await startJob(shop.id, job.id);
    await expect(startJob(shop.id, job.id)).rejects.toBeInstanceOf(JobStateError);
  });
});

describe("picking images before start", () => {
  it("prices only the ticked images and drops the unticked ones on start", async () => {
    const shop = await makeShop(undefined, 25);
    const { job, items } = await makeJob(shop.id, [{ eligible: true }, {}, {}, { eligible: true }]);

    await setIncluded(shop.id, job.id, [items[0].id, items[1].id], false);
    expect(await selectionEstimate(job.id)).toMatchObject({ total: 4, selected: 2, eligible: 1, cost: 3 });

    await startJob(shop.id, job.id);
    const left = await prisma.jobItem.findMany({ where: { jobId: job.id } });
    expect(left.map((i) => i.id).sort()).toEqual([items[2].id, items[3].id].sort());
    expect(await getCreditSummary(shop.id)).toMatchObject({ reserved: 3 });
    expect((await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).total).toBe(2);
  });

  it("select all / deselect all, and refuses to start with nothing selected", async () => {
    const shop = await makeShop(undefined, 25);
    const { job } = await makeJob(shop.id, [{}, {}, {}]);
    expect(await setIncluded(shop.id, job.id, "all", false)).toBe(3);
    await expect(startJob(shop.id, job.id)).rejects.toThrow("Select at least one image");
    // The failed start rolled back: nothing was deleted.
    expect(await prisma.jobItem.count({ where: { jobId: job.id } })).toBe(3);
    await setIncluded(shop.id, job.id, "all", true);
    expect((await selectionEstimate(job.id)).selected).toBe(3);
  });

  it("only allows picking while the job waits to start, and only for the owner", async () => {
    const shop = await makeShop(undefined, 25);
    const other = await makeShop("other.myshopify.com", 25);
    const { job, items } = await makeJob(shop.id, [{ status: "ready", reserved: 1 }], "review");
    await expect(setIncluded(shop.id, job.id, [items[0].id], false)).rejects.toBeInstanceOf(JobStateError);
    const { job: waiting } = await makeJob(shop.id, [{}]);
    await expect(setIncluded(other.id, waiting.id, "all", false)).rejects.toBeInstanceOf(JobStateError);
  });
});

describe("fair-share pump", () => {
  it("never puts more than SHOP_CONCURRENCY items in flight, even with concurrent pumps", async () => {
    const shop = await makeShop(undefined, 100);
    const { job } = await makeJob(shop.id, Array.from({ length: 10 }, () => ({ reserved: 1 })), "processing");

    await Promise.all(Array.from({ length: 6 }, () => pumpShop(shop.id)));
    expect((await statusesOf(job.id)).filter((s) => s === "processing")).toHaveLength(3);

    // One finishes → exactly one more is claimed.
    const inflight = await prisma.jobItem.findFirstOrThrow({ where: { jobId: job.id, status: "processing" } });
    await prisma.jobItem.update({ where: { id: inflight.id }, data: { status: "ready" } });
    expect(await pumpShop(shop.id)).toBe(1);
    expect(await pumpShop(shop.id)).toBe(0);
  });

  it("keeps each shop's slots separate", async () => {
    const big = await makeShop("big.myshopify.com", 100);
    const small = await makeShop("small.myshopify.com", 100);
    await makeJob(big.id, Array.from({ length: 20 }, () => ({ reserved: 1 })), "processing");
    await makeJob(small.id, [{ reserved: 1 }], "processing");
    await pumpShop(big.id);
    await pumpShop(small.id);
    const tasks = await itemsQueue().getJobs(["waiting", "prioritized"]);
    expect(tasks.filter((t) => t.data.shopId === big.id)).toHaveLength(3);
    expect(tasks.filter((t) => t.data.shopId === small.id)).toHaveLength(1);
  });

  it("serves restores before new processing work", async () => {
    const shop = await makeShop(undefined, 100);
    await makeJob(shop.id, Array.from({ length: 5 }, () => ({ reserved: 1 })), "processing");
    const { job: done } = await makeJob(shop.id, [{ status: "applied", backupKey: "k" }], "done");
    await restoreItems(shop.id, done.id);
    expect(await statusesOf(done.id)).toEqual(["restoring"]);
  });
});

describe("review", () => {
  it("'approve all' skips flagged images", async () => {
    const shop = await makeShop(undefined, 25);
    const { job } = await makeJob(
      shop.id,
      [
        { status: "ready", reserved: 1 },
        { status: "flagged", reserved: 1, flags: [flag("mask_low_confidence")] },
        { status: "ready", reserved: 1 },
      ],
      "review",
    );
    expect(await approveAllUnflagged(shop.id, job.id)).toBe(2);
    expect(await statusesOf(job.id)).toEqual(["approved", "flagged", "approved"]);
  });

  it("rejecting releases credits; undoing a rejection takes them back and restores 'flagged'", async () => {
    const shop = await makeShop(undefined, 10);
    const { job, items } = await makeJob(
      shop.id,
      [
        { status: "ready", reserved: 2 },
        { status: "flagged", reserved: 1, flags: [flag("text_detected")] },
      ],
      "review",
    );
    expect((await getCreditSummary(shop.id)).reserved).toBe(3);

    await decideItems(shop.id, job.id, items.map((i) => i.id), "reject");
    expect((await getCreditSummary(shop.id)).reserved).toBe(0);

    await decideItems(shop.id, job.id, items.map((i) => i.id), "reset");
    expect(await statusesOf(job.id)).toEqual(["ready", "flagged"]);
    expect((await getCreditSummary(shop.id)).reserved).toBe(3);
  });

  it("won't un-reject past the available balance", async () => {
    const shop = await makeShop(undefined, 2);
    const { job, items } = await makeJob(shop.id, [{ status: "rejected", reserved: 2 }], "review");
    await makeJob(shop.id, [{ status: "ready", reserved: 1 }], "review");
    await expect(decideItems(shop.id, job.id, [items[0].id], "reset")).rejects.toBeInstanceOf(
      InsufficientCreditsError,
    );
  });

  it("finishing a job releases everything not applied", async () => {
    const shop = await makeShop(undefined, 25);
    const { job } = await makeJob(shop.id, [{ status: "ready", reserved: 1 }, { status: "approved", reserved: 2 }], "review");
    await finishJob(shop.id, job.id);
    expect((await getCreditSummary(shop.id)).reserved).toBe(0);
    expect((await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("done");
  });

  it("apply needs at least one approved image and moves the job to applying", async () => {
    const shop = await makeShop(undefined, 25);
    const { job, items } = await makeJob(shop.id, [{ status: "ready", reserved: 1 }], "review");
    await expect(applyApproved(shop.id, job.id)).rejects.toBeInstanceOf(JobStateError);
    await decideItems(shop.id, job.id, [items[0].id], "approve");
    await applyApproved(shop.id, job.id);
    expect(await statusesOf(job.id)).toEqual(["applying"]);
    const [task] = await itemsQueue().getJobs(["waiting", "prioritized"]);
    expect(task.data).toMatchObject({ kind: "apply", itemId: items[0].id });
  });
});

describe("phase transitions and retries", () => {
  it("goes processing → review → (apply) → done", async () => {
    const shop = await makeShop(undefined, 25);
    const { job, items } = await makeJob(
      shop.id,
      [{ status: "ready", reserved: 1 }, { status: "failed", reserved: 1 }],
      "processing",
    );
    await refreshJobState(job.id);
    let row = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(row).toMatchObject({ status: "review", total: 2, done: 1, failed: 1 });

    await prisma.job.update({ where: { id: job.id }, data: { status: "applying" } });
    await prisma.jobItem.update({ where: { id: items[0].id }, data: { status: "applied" } });
    await refreshJobState(job.id);
    row = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(row.status).toBe("done");
    expect(row.completedAt).not.toBeNull();
  });

  it("retries failed images: unprocessed ones go back through the pipeline, apply failures back to approved", async () => {
    const shop = await makeShop(undefined, 25);
    const { job } = await makeJob(
      shop.id,
      [
        { status: "failed", eligible: true },
        { status: "failed", outputKey: "out.jpg" },
        { status: "ready", reserved: 1 },
      ],
      "review",
    );
    await retryFailed(shop.id, job.id);
    const statuses = await statusesOf(job.id);
    expect(statuses[0]).toBe("processing"); // requeued and immediately claimed by the pump
    expect(statuses[1]).toBe("approved");
    expect((await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("processing");
    expect((await getCreditSummary(shop.id)).reserved).toBe(2 + 1 + 1);
  });

  it("retries apply failures after the job is done, applying them straight away", async () => {
    const shop = await makeShop(undefined, 25);
    const { job } = await makeJob(
      shop.id,
      [{ status: "applied" }, { status: "failed", outputKey: "out.jpg", upscaleApplied: true }],
      "done",
    );
    await retryFailed(shop.id, job.id);
    expect(await statusesOf(job.id)).toEqual(["applied", "applying"]);
    const row = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(row).toMatchObject({ status: "applying", completedAt: null });
    expect((await getCreditSummary(shop.id)).reserved).toBe(2);
    const [task] = await itemsQueue().getJobs(["waiting", "prioritized"]);
    expect(task.data).toMatchObject({ kind: "apply" });
  });

  it("reopening a done job with undecided images goes back to review and counts their credits", async () => {
    const shop = await makeShop(undefined, 3);
    const { job } = await makeJob(
      shop.id,
      [
        { status: "approved", reserved: 2 }, // left when the merchant finished the job
        { status: "failed", outputKey: "out.jpg" },
      ],
      "done",
    );
    await retryFailed(shop.id, job.id);
    expect((await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("review");
    expect(await statusesOf(job.id)).toEqual(["approved", "approved"]); // nothing applied without a click
    expect((await getCreditSummary(shop.id)).reserved).toBe(3);

    // Not enough credits for both: refused, nothing changes.
    const poorer = await makeShop("poorer.myshopify.com", 2);
    const { job: other } = await makeJob(
      poorer.id,
      [{ status: "ready", reserved: 2 }, { status: "failed", eligible: true }],
      "done",
    );
    await expect(retryFailed(poorer.id, other.id)).rejects.toMatchObject({ needed: 4, available: 2 });
    expect((await prisma.job.findUniqueOrThrow({ where: { id: other.id } })).status).toBe("done");
  });

  it("reprocesses images that failed before producing a result, from a done job", async () => {
    const shop = await makeShop(undefined, 25);
    const { job } = await makeJob(shop.id, [{ status: "failed" }, { status: "failed" }], "done");
    await retryFailed(shop.id, job.id);
    expect((await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("processing");
    expect(await statusesOf(job.id)).toEqual(["processing", "processing"]);
  });

  it("refuses to retry while the job is still running", async () => {
    const shop = await makeShop(undefined, 25);
    const { job } = await makeJob(shop.id, [{ status: "failed" }, { status: "queued", reserved: 1 }], "processing");
    await expect(retryFailed(shop.id, job.id)).rejects.toBeInstanceOf(JobStateError);
  });
});

describe("ledger", () => {
  it("charges each item once however often apply bookkeeping runs", async () => {
    const shop = await makeShop(undefined, 10);
    const charge = () =>
      prisma.$transaction(async (tx) => {
        await lockShop(tx, shop.id);
        return recordLedger(tx, { shopId: shop.id, delta: -2, reason: "apply", idempotencyKey: "apply:item-1" });
      });
    expect(await charge()).toBe(true);
    expect(await charge()).toBe(false);
    expect((await prisma.shop.findUniqueOrThrow({ where: { id: shop.id } })).creditBalance).toBe(8);
  });

  it("credits a purchase once, from either the return URL or the webhook", async () => {
    const shop = await makeShop(undefined, 0);
    const purchase = await prisma.purchase.create({
      data: { shopId: shop.id, pack: "starter", credits: 300, amount: 9, shopifyChargeId: "gid://shopify/AppPurchaseOneTime/1" },
    });
    await applyPurchaseStatus(purchase.id, "PENDING");
    expect((await prisma.shop.findUniqueOrThrow({ where: { id: shop.id } })).creditBalance).toBe(0);
    await applyPurchaseStatus(purchase.id, "ACTIVE");
    await applyPurchaseStatus(purchase.id, "ACTIVE");
    expect((await prisma.shop.findUniqueOrThrow({ where: { id: shop.id } })).creditBalance).toBe(300);
    expect((await prisma.purchase.findUniqueOrThrow({ where: { id: purchase.id } })).status).toBe("active");
  });

  it("doesn't credit declined charges", async () => {
    const shop = await makeShop(undefined, 0);
    const purchase = await prisma.purchase.create({
      data: { shopId: shop.id, pack: "growth", credits: 1500, amount: 29 },
    });
    await applyPurchaseStatus(purchase.id, "DECLINED");
    expect((await prisma.shop.findUniqueOrThrow({ where: { id: shop.id } })).creditBalance).toBe(0);
  });
});
