import type { JobItemStatus } from "@prisma/client";
import prisma from "../../app/db.server";
import { env } from "../../app/lib/env.server";
import { errorMessage, PermanentError } from "../../app/lib/errors";
import { buildProductSearchQuery, JobFilterSchema } from "../../app/lib/filters";
import {
  addReadItems,
  failJob,
  finishReading,
  INFLIGHT_ITEM_STATUSES,
  pumpShop,
  refreshJobState,
  REVERT_STATUS,
} from "../../app/lib/jobs.server";
import { cappedNotice } from "../../app/lib/progress";
import {
  enqueueJobTask,
  itemsQueue,
  itemTaskId,
  jobsQueue,
  purgeTaskId,
  verifyTaskId,
  type ItemTask,
} from "../../app/lib/queue.server";
import { redis, tryLock } from "../../app/lib/redis.server";
import { markUninstalled } from "../../app/lib/shops.server";
import {
  loadOfflineSession,
  ShopifyAuthError,
  shopifyClientFor,
} from "../../app/lib/shopify/client.server";
import {
  countProducts,
  fetchJsonlLines,
  getBulkOperation,
  parseBulkJsonl,
  readProductsByIds,
  readProductsPaginated,
  startBulkRead,
  type ReadItem,
} from "../../app/lib/shopify/media.server";
import { deletePrefix, keys } from "../../app/lib/storage.server";
import { cleanupTries } from "../../app/lib/try.server";
import { log } from "../log";
import { MESSAGES } from "../messages";
import { markItemFailed } from "./items";

const BULK_POLL_MS = 60_000;
const BULK_MAX_WAIT_MS = 6 * 3600_000;
/** One read per job at a time; refreshed with every inserted page. */
const READ_LOCK_MS = 10 * 60_000;
const INGEST_LOCK_S = 600;
/** BullMQ states in which a task will still run (or is running). */
const LIVE_TASK_STATES = ["waiting", "active", "delayed", "prioritized", "waiting-children"];

/** A reading job that made no progress this long gets its read enqueued again. */
const READING_STALE_MS = 5 * 60_000;
/**
 * Processing/applying jobs with nothing left to do in their phase and no job-row write this
 * long get a refreshJobState (the item task's own refresh normally ends the phase at once).
 */
const PHASE_STALE_MS = 2 * 60_000;
const SWEEP_BUCKET_MS = 10 * 60_000;

// ─── read ───────────────────────────────────────────────────────────────────

/** The job left "reading" (cancelled) while its images were being read: stop reading. */
class ReadStopped extends Error {}

/** Read the selection's images. Small selections page through products; big ones use a bulk operation. */
export async function readJob(jobId: string): Promise<void> {
  const job = await prisma.job.findUnique({ where: { id: jobId }, include: { shop: true } });
  if (!job || job.status !== "reading" || job.bulkOperationId) return;

  const parsed = JobFilterSchema.safeParse(job.filter);
  if (!parsed.success) {
    // Retrying can't fix a bad selection; say so instead of spinning on "Reading products".
    const reason = parsed.error.issues.map((i) => i.message).join("; ");
    await failJob(jobId, `This selection isn't valid (${reason}). Please create a new job.`);
    return;
  }
  const filter = parsed.data;

  // The reading sweep may enqueue a second read of a job that looked stuck: never run two.
  const lockKey = `read-lock:${jobId}`;
  const release = await tryLock(lockKey, READ_LOCK_MS);
  if (!release) return;
  try {
    const client = await shopifyClientFor(job.shop.domain);
    const max = env().MAX_ITEMS_PER_JOB;
    const onBatch = async (items: ReadItem[]) => {
      if (!(await addReadItems(job, items))) throw new ReadStopped();
      await redis().pexpire(lockKey, READ_LOCK_MS);
    };

    if (filter.productIds?.length) {
      // Named products (the API): read them by id, never with a bulk operation.
      await prisma.jobItem.deleteMany({ where: { jobId } });
      const read = await readProductsByIds(client, filter.productIds, filter.mediaIds, filter.imageScope, onBatch, max);
      log.info("id read done", { jobId, products: filter.productIds.length, images: read });
      await finishReading(jobId, read >= max ? cappedNotice(max) : undefined);
      return;
    }

    const search = buildProductSearchQuery(filter);
    const count = await countProducts(client, search);

    if (count > env().BULK_READ_THRESHOLD) {
      // Bulk queries don't count against the rate limit. The bulk_operations/finish
      // webhook triggers ingestion; the delayed poll is a safety net.
      const bulkId = await startBulkRead(client, search);
      await prisma.job.update({ where: { id: jobId }, data: { bulkOperationId: bulkId } });
      await enqueueJobTask(
        { name: "ingest-bulk", jobId, url: null },
        { delay: BULK_POLL_MS, jobId: `ingest-poll-${jobId}-${Date.now()}` },
      );
      log.info("bulk read started", { jobId, bulkId, products: count });
      return;
    }

    // A previous attempt may have inserted part of the selection.
    await prisma.jobItem.deleteMany({ where: { jobId } });
    const read = await readProductsPaginated(client, search, filter.imageScope, onBatch, max);
    log.info("paginated read done", { jobId, products: count, images: read });
    await finishReading(jobId, read >= max ? cappedNotice(max) : undefined);
  } catch (error) {
    if (!(error instanceof ReadStopped)) throw error;
    log.info("read stopped: the job is no longer reading", { jobId });
  } finally {
    await release();
  }
}

// ─── bulk ingest ────────────────────────────────────────────────────────────

/**
 * Turn a finished bulk operation into job items. Triggered by the webhook and
 * by the delayed poll; a Redis lock makes sure only one of them does the work.
 */
export async function ingestBulk(jobId: string): Promise<void> {
  const job = await prisma.job.findUnique({ where: { id: jobId }, include: { shop: true } });
  if (!job || job.status !== "reading" || !job.bulkOperationId) return;

  const client = await shopifyClientFor(job.shop.domain);
  const op = await getBulkOperation(client, job.bulkOperationId);
  if (!op) {
    log.warn("bulk operation not found", { jobId, bulkId: job.bulkOperationId });
    throw new PermanentError(MESSAGES.bulkFailed);
  }

  if (op.status === "CREATED" || op.status === "RUNNING") {
    if (Date.now() - job.createdAt.getTime() > BULK_MAX_WAIT_MS) {
      await failJob(jobId, MESSAGES.readTooLong);
      return;
    }
    // Heartbeat: while this poll chain is alive the reading sweep leaves the job alone.
    await prisma.job.updateMany({ where: { id: jobId, status: "reading" }, data: { updatedAt: new Date() } });
    await enqueueJobTask(
      { name: "ingest-bulk", jobId, url: null },
      { delay: BULK_POLL_MS, jobId: `ingest-poll-${jobId}-${Date.now()}` },
    );
    return;
  }
  if (op.status !== "COMPLETED") {
    log.warn("bulk read failed", { jobId, status: op.status, errorCode: op.errorCode });
    await failJob(jobId, MESSAGES.bulkFailed);
    return;
  }

  // Held while ingesting, refreshed with every batch, so a crashed ingest frees it soon.
  const lockKey = `ingest-lock:${jobId}`;
  const lock = await redis().set(lockKey, "1", "EX", INGEST_LOCK_S, "NX");
  if (!lock) return;
  try {
    await prisma.jobItem.deleteMany({ where: { jobId } });
    let notice: string | undefined;
    if (op.url) {
      const filter = JobFilterSchema.parse(job.filter);
      const max = env().MAX_ITEMS_PER_JOB;
      let batch: ReadItem[] = [];
      let total = 0;
      for await (const item of parseBulkJsonl(fetchJsonlLines(op.url), filter.imageScope)) {
        batch.push(item);
        total++;
        if (batch.length >= 500) {
          if (!(await addReadItems(job, batch))) return; // cancelled meanwhile
          await redis().expire(lockKey, INGEST_LOCK_S);
          batch = [];
        }
        if (total >= max) break;
      }
      await addReadItems(job, batch);
      if (total >= max) notice = cappedNotice(max);
      log.info("bulk ingest done", { jobId, images: total });
    }
    await finishReading(jobId, notice);
  } finally {
    await redis().del(lockKey);
  }
}

// ─── maintenance ────────────────────────────────────────────────────────────

/**
 * In-flight items whose task is gone are put back after this. Live tasks (waiting, running,
 * retrying) are never touched: their BullMQ state is checked first.
 */
const STALE_INFLIGHT_MS = 3 * 60_000;
const DAY_MS = 24 * 3600_000;
/**
 * Uninstalled shops are erased after this even if shop/redact never arrives.
 * Below 30 days on purpose: the privacy policy promises erasure within 30 days.
 */
const RETENTION_AFTER_UNINSTALL_MS = 25 * DAY_MS;
/**
 * Shops with no token activity for this long are asked whether the app is
 * still installed, so a lost app/uninstalled (and a lost shop/redact) is caught
 * within the 30 days: this + the hourly sweep + retention stays under 30.
 */
const INACTIVE_CHECK_AFTER_MS = 3 * DAY_MS;
const INACTIVE_CHECKS_PER_SWEEP = 100;
/**
 * A check that couldn't reach a verdict (network, 5xx…) is tried again this
 * soon. One that did answer holds the shop off for INACTIVE_CHECK_AFTER_MS.
 */
const INACTIVE_RETRY_MS = 12 * 3600_000;
const inactiveCheckKey = (shopId: string) => `shops:inactive-check:${shopId}`;
/** Where the next sweep continues, so shops that stay idle can't crowd out the rest. */
const INACTIVE_CURSOR_KEY = "shops:inactive-cursor";

/** Runs every minute: recovers lost tasks, keeps queues flowing, closes abandoned reviews. */
export async function maintenance(): Promise<void> {
  // 1. In-flight items whose BullMQ task is gone (crash between claim and enqueue, Redis
  //    flush…) go back to be claimed again. Ones BullMQ gave up on (it stalled twice: the
  //    image keeps killing the worker) fail for good instead of looping forever.
  await sweepStaleInflight();

  // 1b. Jobs stuck in "reading": the read task was lost (Redis down when the job was
  //     created, a crash, a stalled read) or its bulk poll chain died.
  await sweepReadingJobs();

  // 1c. Jobs whose phase should have ended but didn't (a decision raced the phase start, a
  //     refresh that lost its task): recount them. Selected in SQL by what the phase still
  //     has to do, so the many healthy jobs (running, or waiting behind an older job of their
  //     shop) never fill the batch.
  const stuck = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT j."id"
    FROM "Job" j
    WHERE j."updatedAt" < ${new Date(Date.now() - PHASE_STALE_MS)}
      AND (
        (j."status" = 'processing' AND NOT EXISTS (
          SELECT 1 FROM "JobItem" i WHERE i."jobId" = j."id" AND i."status" IN ('queued', 'processing')))
        OR (j."status" = 'applying' AND NOT EXISTS (
          SELECT 1 FROM "JobItem" i WHERE i."jobId" = j."id" AND i."status" IN ('approved', 'applying')))
      )
    ORDER BY j."updatedAt" ASC
    LIMIT 100`;
  for (const { id } of stuck) {
    try {
      await refreshJobState(id);
    } catch (error) {
      log.warn("stuck-phase refresh failed", { jobId: id, error: errorMessage(error) });
    }
  }

  // 2. Nudge every shop that has claimable work. One shop's failure (Redis slow to take the
  //    tasks) must not stop the rest of maintenance.
  const shops = await prisma.$queryRaw<Array<{ shopId: string }>>`
    SELECT DISTINCT i."shopId"
    FROM "JobItem" i JOIN "Job" j ON j."id" = i."jobId"
    WHERE (j."status" = 'processing' AND i."status" = 'queued')
       OR (j."status" = 'applying' AND i."status" = 'approved')
       OR i."status" = 'restore_queued'`;
  for (const { shopId } of shops) {
    try {
      await pumpShop(shopId);
    } catch (error) {
      log.warn("maintenance pump failed", { shopId, error: errorMessage(error) });
    }
  }

  // 3. Reviews nobody finished: close them so their reservations are released.
  const expiry = new Date(Date.now() - env().REVIEW_EXPIRY_DAYS * 24 * 3600_000);
  const expired = await prisma.job.updateMany({
    where: { status: "review", updatedAt: { lt: expiry } },
    data: { status: "done", completedAt: new Date() },
  });
  if (expired.count) log.info("expired review jobs", { count: expired.count });

  // 4. Erase uninstalled shops that asked for it (shop/redact) or have been gone
  //    too long. Retried every hour until the row is gone.
  const toPurge = await prisma.shop.findMany({
    where: {
      uninstalledAt: { not: null },
      OR: [
        { redactRequestedAt: { not: null } },
        { uninstalledAt: { lt: new Date(Date.now() - RETENTION_AFTER_UNINSTALL_MS) } },
      ],
    },
    select: { id: true },
    take: 50,
  });
  for (const { id } of toPurge) {
    await enqueueJobTask({ name: "purge-shop", shopId: id }, { jobId: purgeTaskId(id) });
  }

  // 5. shop/redact for a shop we think is installed: keep asking Shopify until
  //    the check succeeds (the first one may have failed on a network error).
  const redactPending = await prisma.shop.findMany({
    where: { uninstalledAt: null, redactRequestedAt: { not: null } },
    select: { id: true },
    take: 50,
  });
  for (const { id } of redactPending) {
    await enqueueJobTask({ name: "verify-uninstalled", shopId: id, reason: "redact" }, { jobId: verifyTaskId(id) });
  }

  // 6. Hourly: shops with no token activity for a while may have uninstalled
  //    without us hearing about it. Each is checked once per period, and again
  //    after 12 hours while the check can't get an answer from Shopify.
  if (await redis().set("shops:inactive-sweep", "1", "EX", 3600, "NX")) {
    await queueInactiveChecks();
  }

  // 7. Landing-page try-it uploads are deleted after 24 hours (checked hourly).
  if (await redis().set("try:cleanup", "1", "EX", 3600, "NX")) {
    const removed = await cleanupTries();
    if (removed) log.info("deleted old try-it uploads", { objects: removed });
  }

  // 8. Waitlist emails are kept for at most 12 months (privacy policy). Checked daily.
  //    The key must not start with "waitlist:", the landing page's per-IP rate-limit prefix.
  if (await redis().set("waitlist-retention:sweep", "1", "EX", 24 * 3600, "NX")) {
    const { count } = await prisma.waitlist.deleteMany({
      where: { createdAt: { lt: new Date(Date.now() - 365 * DAY_MS) } },
    });
    if (count) log.info("deleted old waitlist emails", { count });
  }
}

/** Where the stale in-flight sweep goes on next minute: "<updatedAt ms>|<id>", or "" to start over. */
const INFLIGHT_CURSOR_KEY = "maintenance:inflight-cursor";
const STALE_INFLIGHT_PAGE = 500;

async function readInflightCursor(): Promise<{ at: Date; id: string } | null> {
  try {
    const raw = await redis().get(INFLIGHT_CURSOR_KEY);
    const [ms, id] = (raw ?? "").split("|");
    return ms && id && Number.isFinite(Number(ms)) ? { at: new Date(Number(ms)), id } : null;
  } catch {
    return null;
  }
}

/**
 * In-flight items not touched for STALE_INFLIGHT_MS, checked against their BullMQ task. Many of
 * them are alive (waiting for the image service's slot, or backing off before a retry), so the
 * sweep pages through them in (updatedAt, id) order across runs instead of looking at the same
 * first page every minute, and one item's error doesn't stop the others.
 */
async function sweepStaleInflight(now = Date.now()): Promise<void> {
  const cursor = await readInflightCursor();
  const stale = await prisma.jobItem.findMany({
    where: {
      status: { in: INFLIGHT_ITEM_STATUSES },
      updatedAt: { lt: new Date(now - STALE_INFLIGHT_MS) },
      ...(cursor ? { OR: [{ updatedAt: { gt: cursor.at } }, { updatedAt: cursor.at, id: { gt: cursor.id } }] } : {}),
    },
    orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
    select: { id: true, status: true, attempts: true, shopId: true, jobId: true, updatedAt: true },
    take: STALE_INFLIGHT_PAGE,
  });
  // A full page: go on after it next time. A short one reached the end: start over.
  const last = stale.at(-1);
  const next = stale.length === STALE_INFLIGHT_PAGE && last ? `${last.updatedAt.getTime()}|${last.id}` : "";
  await redis()
    .set(INFLIGHT_CURSOR_KEY, next, "EX", 3600)
    .catch((error: unknown) => log.warn("in-flight sweep cursor not saved", { error: errorMessage(error) }));

  for (const item of stale) {
    try {
      await checkInflightItem(item);
    } catch (error) {
      log.warn("stale in-flight check failed", { itemId: item.id, error: errorMessage(error) });
    }
  }
}

async function checkInflightItem(item: {
  id: string;
  status: JobItemStatus;
  attempts: number;
  shopId: string;
  jobId: string;
}): Promise<void> {
  const kind: ItemTask["kind"] =
    item.status === "processing" ? "process" : item.status === "applying" ? "apply" : "restore";
  const task = await itemsQueue().getJob(itemTaskId(kind, item.id, item.attempts));
  const state = task ? await task.getState() : "missing";
  if (LIVE_TASK_STATES.includes(state)) return;
  if (state === "failed") {
    // Our processor never ends an item task as failed itself (it records the failure and
    // completes), so BullMQ failed it: stalled too often, or our own bookkeeping threw.
    const stalled = /stall/i.test(task?.failedReason ?? "");
    const error = stalled
      ? new PermanentError(MESSAGES.crashed, "crashed")
      : new PermanentError(MESSAGES.unknown, "task_failed");
    const itemTask: ItemTask = { kind, itemId: item.id, jobId: item.jobId, shopId: item.shopId };
    await markItemFailed(itemTask, error);
    log.warn("IMAGE_JOB_FAILED", {
      itemId: item.id,
      jobId: item.jobId,
      kind,
      attempt: task?.attemptsMade,
      retryable: false,
      final: true,
      reason: error.code,
      failedReason: task?.failedReason,
    });
    await refreshJobState(item.jobId);
    return;
  }
  await prisma.jobItem.updateMany({
    where: { id: item.id, status: item.status },
    data: { status: REVERT_STATUS[item.status]! },
  });
  log.warn("requeued stale item", { itemId: item.id, was: item.status, taskState: state });
}

/**
 * Re-enqueue the read of jobs that made no progress in "reading" for READING_STALE_MS (every
 * read heartbeats Job.updatedAt), and fail those older than BULK_MAX_WAIT_MS. Task ids are
 * bucketed per 10 minutes, and readJob holds a per-job lock, so this never runs two reads.
 */
async function sweepReadingJobs(now = Date.now()): Promise<void> {
  const jobs = await prisma.job.findMany({
    where: { status: "reading", updatedAt: { lt: new Date(now - READING_STALE_MS) } },
    select: { id: true, createdAt: true, bulkOperationId: true },
    take: 50,
  });
  const bucket = Math.floor(now / SWEEP_BUCKET_MS);
  for (const job of jobs) {
    try {
      if (now - job.createdAt.getTime() > BULK_MAX_WAIT_MS) {
        if (await failJob(job.id, MESSAGES.readTooLong)) log.warn("read timed out", { jobId: job.id });
        continue;
      }
      if (job.bulkOperationId) {
        await enqueueJobTask({ name: "ingest-bulk", jobId: job.id, url: null }, { jobId: `ingest-sweep-${job.id}-${bucket}` });
        log.warn("requeued stuck bulk ingest", { jobId: job.id });
        continue;
      }
      const ids = [`read-${job.id}`, `read-${job.id}-${bucket}`, `read-${job.id}-${bucket - 1}`];
      const states = await Promise.all(
        ids.map(async (id) => {
          const task = await jobsQueue().getJob(id);
          return task ? task.getState() : "missing";
        }),
      );
      if (states.some((s) => LIVE_TASK_STATES.includes(s))) continue;
      await enqueueJobTask({ name: "read", jobId: job.id }, { jobId: `read-${job.id}-${bucket}` });
      log.warn("requeued stuck read", { jobId: job.id, taskStates: states });
    } catch (error) {
      log.warn("reading sweep failed", { jobId: job.id, error: errorMessage(error) });
    }
  }
}

/**
 * Shops that look installed but haven't used their token for
 * INACTIVE_CHECK_AFTER_MS. Expiring offline tokens last an hour and are renewed
 * on every use (web or worker), so the session's expiry tracks the last activity.
 */
async function queueInactiveChecks(now = Date.now()): Promise<number> {
  const cutoff = new Date(now - INACTIVE_CHECK_AFTER_MS);
  const limit = INACTIVE_CHECKS_PER_SWEEP * 5;
  // Shops with non-expiring tokens, or whose check keeps being skipped, stay
  // idle for good. Walk the whole set in id order across sweeps so they can
  // never hold the window and starve newer idle shops.
  const after = (await redis().get(INACTIVE_CURSOR_KEY)) ?? "";
  const idle = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT s."id"
    FROM "Shop" s
    WHERE s."uninstalledAt" IS NULL
      AND s."installedAt" < ${cutoff}
      AND s."id" > ${after}
      AND NOT EXISTS (
        SELECT 1 FROM "Session" x WHERE x."shop" = s."domain" AND x."expires" > ${cutoff}
      )
    ORDER BY s."id" ASC
    LIMIT ${limit}`;
  let queued = 0;
  let last = "";
  for (const { id } of idle) {
    if (queued >= INACTIVE_CHECKS_PER_SWEEP) break;
    last = id;
    // Throttled per shop: a check that answers sets the full period itself.
    const fresh = await redis().set(inactiveCheckKey(id), "1", "PX", INACTIVE_RETRY_MS, "NX");
    if (!fresh) continue;
    await enqueueJobTask({ name: "verify-uninstalled", shopId: id, reason: "inactive" }, { jobId: verifyTaskId(id) });
    queued++;
  }
  // Start over from the beginning once the end of the set was reached.
  const reachedEnd = idle.length < limit && last === idle.at(-1)?.id;
  await redis().set(INACTIVE_CURSOR_KEY, reachedEnd ? "" : last, "EX", 7 * 24 * 3600);
  if (queued) log.info("queued install checks for inactive shops", { shops: queued });
  return queued;
}

/** A check reached a verdict (or can't ever reach one): leave the shop alone for the full period. */
async function holdInactiveCheck(shopId: string): Promise<void> {
  await redis().set(inactiveCheckKey(shopId), "1", "PX", INACTIVE_CHECK_AFTER_MS);
}

// ─── uninstall / redact ─────────────────────────────────────────────────────

/**
 * Is the app still installed? Asks Shopify with the shop's own token (a
 * one-point query). Only a refused token or a missing session counts as
 * uninstalled; network errors and 5xx throw and are retried.
 *
 * - reason "redact": shop/redact arrived while we thought the shop was
 *   installed. Uninstalled → mark it and purge now. Installed → the merchant
 *   reinstalled, so clear the request (a later uninstall gets its own).
 * - reason "inactive": no activity for a while. Uninstalled → mark it; the
 *   retention sweep (or shop/redact) erases it later, and opening the app
 *   again undoes the mark.
 */
export async function verifyInstalled(shopId: string, reason: "redact" | "inactive"): Promise<void> {
  const shop = await prisma.shop.findUnique({ where: { id: shopId } });
  if (!shop || shop.uninstalledAt) return; // already handled (maintenance purges pending redacts)
  if (reason === "redact" && !shop.redactRequestedAt) return; // merchant came back meanwhile

  const session = await loadOfflineSession(shop.domain);
  if (
    reason === "inactive" &&
    session?.isExpired() &&
    (!session.refreshToken || (session.refreshTokenExpires && session.refreshTokenExpires.getTime() < Date.now()))
  ) {
    // Our own refresh token lapsed: a refusal wouldn't prove anything.
    log.info("install check skipped: no usable token", { shop: shop.domain });
    await holdInactiveCheck(shop.id);
    return;
  }

  let installed: boolean;
  try {
    const client = await shopifyClientFor(shop.domain);
    await client.request(
      `#graphql
      query InstallCheck { shop { id } }`,
      {},
      { cost: 1 },
    );
    installed = true;
  } catch (error) {
    if (!(error instanceof ShopifyAuthError)) throw error;
    log.info("install check: Shopify refused the token", { shop: shop.domain, reason, error: error.message });
    installed = false;
  }

  if (installed) {
    if (reason === "inactive") await holdInactiveCheck(shop.id);
    if (reason === "redact") {
      await prisma.shop.updateMany({
        where: { id: shop.id, uninstalledAt: null },
        data: { redactRequestedAt: null },
      });
      log.warn("shop/redact ignored: the app is installed", { shop: shop.domain });
    }
    return;
  }

  // Unless the merchant re-authenticated while we were checking.
  if (!(await markUninstalled(shop.id, new Date(), shop.installedAt))) return;
  await prisma.session.deleteMany({ where: { shop: shop.domain } });
  log.warn("marked uninstalled: Shopify refused our token", { shop: shop.domain, reason });
  if (reason === "redact") await purgeShop(shop.id);
}

/** shop/redact: erase everything we hold for the shop (DB rows cascade from Shop; objects by prefix). */
export async function purgeShop(shopId: string): Promise<void> {
  const shop = await prisma.shop.findUnique({ where: { id: shopId } });
  if (!shop) return;
  if (!shop.uninstalledAt) {
    // Reinstalled between the request and now: never wipe an active merchant.
    log.warn("purge skipped: shop is installed", { shop: shop.domain });
    return;
  }
  const removed = await deletePrefix(keys.shopPrefix(shopId));
  await prisma.session.deleteMany({ where: { shop: shop.domain } });
  await prisma.shop.delete({ where: { id: shopId } });
  log.info("shop purged", { shop: shop.domain, objects: removed });
}
