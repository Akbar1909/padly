import { Prisma, type Job, type JobItemStatus, type JobStatus } from "@prisma/client";
import prisma from "../db.server";
import {
  InsufficientCreditsError,
  lockShop,
  RESERVING_ITEM_STATUSES,
  RESERVING_JOB_STATUSES,
  reservedCredits,
} from "./credits.server";
import { env } from "./env.server";
import { errorMessage } from "./errors";
import { describeFilter, filterForClient, MAX_SELECTION_IDS, type JobFilter } from "./filters";
import { log } from "./log.server";
import {
  insertNotification,
  notificationCreated,
  notifyNeedsCredits,
  phaseEndedNotification,
} from "./notifications.server";
import { creditsFor, isUpscaleEligible, type PresetSettings } from "./presets";
import { summarizeProcessing } from "./processing";
import {
  creditsNotice,
  jobNotices,
  jobProgress,
  skippedNotice,
  withNotice,
  withoutCreditsNotice,
  type JobProgress,
  type StatusCounts,
} from "./progress";
import { enqueueJobTask, ENQUEUE_TIMEOUT_MS, isGpuDown, itemsQueue, itemTaskId, type ItemTask } from "./queue.server";
import { withTimeout } from "./redis.server";
import type { ReadItem } from "./shopify/media.server";

export type { StatusCounts } from "./progress";

export class JobStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JobStateError";
  }
}

/** The job doesn't exist or belongs to another shop (the API answers 404). */
export class JobNotFoundError extends JobStateError {
  constructor() {
    super("Job not found");
    this.name = "JobNotFoundError";
  }
}

export const INFLIGHT_ITEM_STATUSES: JobItemStatus[] = ["processing", "applying", "restoring"];

/** Where an in-flight item goes back to if its task is lost. */
export const REVERT_STATUS: Partial<Record<JobItemStatus, JobItemStatus>> = {
  processing: "queued",
  applying: "approved",
  restoring: "restore_queued",
};

const KIND_FOR_CLAIMED: Partial<Record<JobItemStatus, ItemTask["kind"]>> = {
  processing: "process",
  applying: "apply",
  restoring: "restore",
};

async function jobForShop(db: Prisma.TransactionClient | typeof prisma, shopId: string, jobId: string): Promise<Job> {
  const job = await db.job.findFirst({ where: { id: jobId, shopId } });
  if (!job) throw new JobNotFoundError();
  return job;
}

/**
 * The work is committed; handing it to the queue can wait. If Redis is down, claimed items
 * without a task are put back by maintenance within a few minutes and the per-minute nudge
 * claims them again, so the merchant's action still succeeded.
 */
async function pumpAfterCommit(shopId: string, context: string): Promise<void> {
  try {
    await pumpShop(shopId);
  } catch (error) {
    log.warn("pump after commit failed; maintenance will retry", { shopId, context, error: errorMessage(error) });
  }
}

/** A compare-and-set on the job found it changed since it was read. */
const CHANGED_MEANWHILE = "This job changed meanwhile. Reload the page.";

/**
 * Of this job's images selected by `mine` (a query returning "mediaId" from "JobItem" i), the
 * ones another unfinished job of the shop also has (reserved in an active job, or being
 * restored). Processing one image twice at once would double the GPU work, and the later job
 * would back up the earlier job's output as its "original".
 *
 * Computed once per call, in two plain statements: this job's media, then the other items
 * matching that list (`= ANY(array)`, hashed by Postgres). Anything correlated (EXISTS per
 * row, or IN over a subquery of the same table) was planned as a nested loop over the shop's
 * items while statistics were stale, as they are right after a big read: tens of seconds under
 * the shop lock at 5,000 images.
 */
async function busyMedia(
  tx: Prisma.TransactionClient,
  shopId: string,
  jobId: string,
  mine: Prisma.Sql,
): Promise<string[]> {
  const own = (await tx.$queryRaw<Array<{ mediaId: string }>>(mine)).map((r) => r.mediaId);
  if (!own.length) return [];
  const rows = await tx.$queryRaw<Array<{ mediaId: string }>>`
    SELECT DISTINCT o."mediaId"
    FROM "JobItem" o
    JOIN "Job" oj ON oj."id" = o."jobId"
    WHERE o."shopId" = ${shopId}
      AND o."jobId" <> ${jobId}
      AND o."mediaId" = ANY(${own}::text[])
      AND (
        (o."status"::text = ANY(${RESERVING_ITEM_STATUSES}::text[])
          AND oj."status"::text = ANY(${RESERVING_JOB_STATUSES}::text[]))
        OR o."status" IN ('restore_queued', 'restoring')
      )`;
  return rows.map((r) => r.mediaId);
}

// ─── Reading ────────────────────────────────────────────────────────────────

export interface CreateJobOptions {
  /** Idempotency key (New job form hidden field, API Idempotency-Key). Same key → same job. */
  requestKey?: string | null;
  /** Start as soon as reading finishes (reserves credits; nothing is written to Shopify). */
  autoStart?: boolean;
  /** For the BULK_JOB_CREATED log line. */
  source?: "ui" | "api";
}

/** `created` is false when the request key was seen before and the existing job came back. */
export type CreatedJob = Job & { created: boolean };

export async function createJob(
  shopId: string,
  filter: JobFilter,
  preset: PresetSettings,
  opts: CreateJobOptions = {},
): Promise<CreatedJob> {
  const requestKey = opts.requestKey?.trim().slice(0, 200) || null;
  let job: Job;
  try {
    job = await prisma.job.create({
      data: {
        shopId,
        filter,
        presetSnapshot: preset,
        status: "reading",
        requestKey,
        autoStart: opts.autoStart ?? false,
      },
    });
  } catch (error) {
    // A replay (double click, network retry, a second tab): hand back the first job.
    if (requestKey && error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const existing = await prisma.job.findFirst({ where: { shopId, requestKey } });
      if (existing) return { ...existing, created: false };
    }
    throw error;
  }
  log.info("BULK_JOB_CREATED", {
    jobId: job.id,
    shopId,
    source: opts.source ?? "ui",
    selection: describeFilter(filter),
    autoStart: job.autoStart,
  });
  try {
    await enqueueJobTask({ name: "read", jobId: job.id }, { jobId: `read-${job.id}` });
  } catch (error) {
    // The job row is committed; maintenance's reading sweep enqueues the read later.
    log.warn("read task not enqueued; maintenance will retry", { jobId: job.id, error: errorMessage(error) });
  }
  return { ...job, created: true };
}

/**
 * Insert read images. Returns false (and inserts nothing) when the job is no longer reading,
 * e.g. the merchant cancelled it, so the read can stop early.
 */
export async function addReadItems(
  job: Pick<Job, "id" | "shopId" | "presetSnapshot">,
  items: ReadItem[],
): Promise<boolean> {
  // Heartbeat: a read that is making progress keeps its job out of the reading sweep.
  const reading = await prisma.job.updateMany({ where: { id: job.id, status: "reading" }, data: { updatedAt: new Date() } });
  if (!reading.count) return false;
  if (!items.length) return true;
  const preset = job.presetSnapshot as unknown as PresetSettings;
  await prisma.jobItem.createMany({
    data: items.map((it) => ({
      jobId: job.id,
      shopId: job.shopId,
      productId: it.productId,
      productTitle: it.productTitle.slice(0, 500),
      mediaId: it.mediaId,
      position: it.position,
      alt: it.alt,
      originalUrl: it.originalUrl,
      thumbnailUrl: it.thumbnailUrl,
      mimeType: it.mimeType,
      width: it.width,
      height: it.height,
      fileSize: it.fileSize,
      upscaleEligible: isUpscaleEligible(preset, it.width, it.height),
      status: "queued" as const,
    })),
    skipDuplicates: true,
  });
  return true;
}

/** Shown on a job whose selection had no images. A notice, not a failure. */
export const NO_MATCH_NOTICE = "No product images matched this selection.";

/**
 * Reading finished: compute the cost and wait for the merchant to start, or start right away
 * when the job asked for it (autoStart). `notice` is shown on the job (e.g. the read was capped).
 */
export async function finishReading(jobId: string, notice?: string): Promise<void> {
  const job = await prisma.job.findUnique({ where: { id: jobId } });
  if (!job || job.status !== "reading") return;
  const [total, eligible] = await Promise.all([
    prisma.jobItem.count({ where: { jobId } }),
    prisma.jobItem.count({ where: { jobId, upscaleEligible: true } }),
  ]);
  if (total === 0) {
    // Nothing to do isn't an error (an empty store, a filter that matches
    // nothing): the job ends as done, with a notice the job page shows. Nothing
    // was reserved yet, so there's nothing to release.
    await prisma.job.updateMany({
      where: { id: jobId, status: "reading" },
      data: { status: "done", total: 0, estimatedCredits: 0, error: NO_MATCH_NOTICE, completedAt: new Date() },
    });
    return;
  }
  const moved = await prisma.job.updateMany({
    where: { id: jobId, status: "reading" },
    data: {
      status: "estimated",
      total,
      estimatedCredits: total * creditsFor(false) + eligible,
      ...(notice ? { error: withNotice(job.error, notice) } : {}),
    },
  });
  if (moved.count && job.autoStart) await autoStart(job, total);
}

/**
 * Start an API job right after reading. Starting only reserves credits; nothing is charged or
 * written to Shopify before the merchant reviews and applies. If it can't start (not enough
 * credits, every image already in another job), the job waits in "estimated" with a notice,
 * and a notification when credits are short.
 */
async function autoStart(job: Job, images: number): Promise<void> {
  try {
    await startJob(job.shopId, job.id);
  } catch (error) {
    let notice: string;
    if (error instanceof InsufficientCreditsError) {
      notice = creditsNotice(images, error.needed, error.available);
    } else if (error instanceof JobStateError) {
      notice = error.message;
    } else {
      // The merchant can still press Start; don't fail (or re-run) the read over it.
      log.error("auto-start failed", { jobId: job.id, error: errorMessage(error) });
      return;
    }
    const current = await prisma.job.findUnique({ where: { id: job.id }, select: { error: true } });
    await prisma.job.updateMany({
      where: { id: job.id, status: "estimated" },
      data: { error: withNotice(current?.error, notice) },
    });
    log.info("auto-start blocked", {
      jobId: job.id,
      shopId: job.shopId,
      reason: error instanceof InsufficientCreditsError ? "credits" : "state",
      ...(error instanceof InsufficientCreditsError ? { needed: error.needed, available: error.available } : {}),
    });
    if (error instanceof InsufficientCreditsError) {
      try {
        await notifyNeedsCredits(job, images);
      } catch (e) {
        log.warn("notification not created", { jobId: job.id, error: errorMessage(e) });
      }
    }
  }
}

/** Reading failed for good. Only a job still reading can fail this way (never a cancelled one). */
export async function failJob(jobId: string, error: string): Promise<boolean> {
  const r = await prisma.job.updateMany({
    where: { id: jobId, status: "reading" },
    data: { status: "failed", error: error.slice(0, 1000), completedAt: new Date() },
  });
  return r.count > 0;
}

// ─── Starting (credit reservation) ──────────────────────────────────────────

export interface StartResult {
  /** Images that will be processed. */
  started: number;
  /** Images dropped because another unfinished job already has them. */
  skipped: number;
  /** Credits reserved. */
  cost: number;
}

/** startJob refused because every selected image is in another unfinished job. */
export const ALL_IN_ANOTHER_JOB_MESSAGE =
  "All of these images are already in another job that hasn't finished. Start this one after it does.";
/** startJob refused because nothing is selected. */
export const NOTHING_SELECTED_MESSAGE = "Select at least one image to process.";

/**
 * Notices that say why the job couldn't start (a blocked auto-start stores them): out of date
 * once it starts. The UI hides them by the same starts (app/lib/format.ts START_BLOCKED_PREFIXES).
 */
function withoutStartNotices(error: string | null | undefined): string | null {
  const lines = jobNotices(withoutCreditsNotice(error)).filter(
    (l) => l !== ALL_IN_ANOTHER_JOB_MESSAGE && l !== NOTHING_SELECTED_MESSAGE,
  );
  return lines.length ? lines.join("\n") : null;
}

export async function startJob(shopId: string, jobId: string): Promise<StartResult> {
  const result = await prisma.$transaction(async (tx) => {
    await lockShop(tx, shopId);
    const job = await jobForShop(tx, shopId, jobId);
    if (job.status !== "estimated") throw new JobStateError(`This job is already ${job.status}.`);

    // Images another unfinished job already has are skipped. Under the shop lock, so two
    // jobs starting at once can't both take the same image.
    const busy = await busyMedia(
      tx,
      shopId,
      jobId,
      Prisma.sql`SELECT i."mediaId" FROM "JobItem" i WHERE i."jobId" = ${jobId} AND i."excluded" = false`,
    );
    const skipped = busy.length
      ? await tx.$executeRaw`
          UPDATE "JobItem" i SET "excluded" = true, "updatedAt" = now()
          WHERE i."jobId" = ${jobId} AND i."excluded" = false AND i."mediaId" = ANY(${busy}::text[])`
      : 0;

    // Images the merchant unticked (and the skipped ones) were never processed; drop them.
    await tx.jobItem.deleteMany({ where: { jobId, excluded: true } });

    const [count, eligible] = await Promise.all([
      tx.jobItem.count({ where: { jobId, status: "queued" } }),
      tx.jobItem.count({ where: { jobId, status: "queued", upscaleEligible: true } }),
    ]);
    if (count === 0) {
      throw new JobStateError(skipped ? ALL_IN_ANOTHER_JOB_MESSAGE : NOTHING_SELECTED_MESSAGE);
    }
    const cost = count * creditsFor(false) + eligible;
    const shop = await tx.shop.findUniqueOrThrow({ where: { id: shopId } });
    const available = shop.creditBalance - (await reservedCredits(tx, shopId));
    if (cost > available) throw new InsufficientCreditsError(cost, available);

    await tx.jobItem.updateMany({
      where: { jobId, status: "queued", upscaleEligible: true },
      data: { creditsReserved: creditsFor(true) },
    });
    await tx.jobItem.updateMany({
      where: { jobId, status: "queued", upscaleEligible: false },
      data: { creditsReserved: creditsFor(false) },
    });
    let notices = withoutStartNotices(job.error);
    if (skipped) notices = withNotice(notices, skippedNotice(skipped));
    const now = new Date();
    // Compare-and-set: cancelJob and finishJob don't take the shop lock, so a cancel can commit
    // while this transaction runs. Starting anyway would process (and pay the image service
    // for) a job the merchant cancelled; throwing rolls back the reservation and the deletes.
    const moved = await tx.job.updateMany({
      where: { id: jobId, shopId, status: "estimated" },
      data: {
        status: "processing",
        startedAt: now,
        estimatedCredits: cost,
        total: count,
        done: 0,
        failed: 0,
        phaseTotal: count,
        phaseFailedBase: 0,
        phaseStartedAt: now,
        completedAt: null,
        error: notices,
      },
    });
    if (!moved.count) throw new JobStateError(CHANGED_MEANWHILE);
    return { started: count, skipped, cost };
  });
  log.info("job started", { jobId, shopId, ...result });
  await pumpAfterCommit(shopId, "start");
  return result;
}

/**
 * Tick or untick images before the job starts. `itemIds: "all"` applies to
 * every image in the job. Unticked images are dropped by startJob.
 */
export async function setIncluded(
  shopId: string,
  jobId: string,
  itemIds: string[] | "all",
  included: boolean,
): Promise<number> {
  const job = await jobForShop(prisma, shopId, jobId);
  if (job.status !== "estimated") throw new JobStateError("Images can only be picked before the job starts.");
  const r = await prisma.jobItem.updateMany({
    where: { jobId, ...(itemIds === "all" ? {} : { id: { in: itemIds } }) },
    data: { excluded: !included },
  });
  return r.count;
}

/** What starting the job would cost with the current selection. */
export async function selectionEstimate(jobId: string) {
  const [total, selected, eligible, products] = await Promise.all([
    prisma.jobItem.count({ where: { jobId } }),
    prisma.jobItem.count({ where: { jobId, excluded: false } }),
    prisma.jobItem.count({ where: { jobId, excluded: false, upscaleEligible: true } }),
    prisma.$queryRaw<Array<{ n: bigint }>>`
      SELECT COUNT(DISTINCT "productId") AS n FROM "JobItem" WHERE "jobId" = ${jobId}`,
  ]);
  return {
    total,
    selected,
    eligible,
    products: Number(products[0]?.n ?? 0),
    cost: selected * creditsFor(false) + eligible,
  };
}

// ─── Fair-share scheduling ──────────────────────────────────────────────────

/**
 * Claim the next items for a shop, up to SHOP_CONCURRENCY in flight, and put
 * them on the queue. Keeping each shop's in-flight count small is what stops
 * one 10,000-image catalog from starving every other store (BullMQ's OSS
 * edition has no per-group concurrency). Called after every state change
 * and by the reconciler; safe to call any time from anywhere.
 *
 * While the image service is down (the gpu:down breaker), no new images are claimed for
 * processing; applies and restores continue.
 *
 * An image waiting for an automatic retry (JobItem.retryAt in the future) doesn't hold a slot
 * during its backoff, so the shop's other images, restores and applies keep moving. When
 * retries come due the shop can briefly have more in flight than SHOP_CONCURRENCY; counting
 * the waiting ones against twice the limit bounds that burst.
 */
export async function pumpShop(shopId: string): Promise<number> {
  const allowProcess = !(await isGpuDown());
  const claimed = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`pump:${shopId}`}))`;
    const [inflight, waiting] = await Promise.all([
      tx.jobItem.count({ where: { shopId, status: { in: INFLIGHT_ITEM_STATUSES } } }),
      tx.jobItem.count({ where: { shopId, status: { in: INFLIGHT_ITEM_STATUSES }, retryAt: { gt: new Date() } } }),
    ]);
    const limit = env().SHOP_CONCURRENCY;
    const slots = Math.min(limit - (inflight - waiting), 2 * limit - inflight);
    if (slots <= 0) return [];

    // Restores first (merchant is waiting on a specific image), then oldest job.
    const candidates = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT i."id"
      FROM "JobItem" i
      JOIN "Job" j ON j."id" = i."jobId"
      WHERE i."shopId" = ${shopId}
        AND (
          (${allowProcess}::boolean AND j."status" = 'processing' AND i."status" = 'queued')
          OR (j."status" = 'applying' AND i."status" = 'approved')
          OR i."status" = 'restore_queued'
        )
      ORDER BY (i."status" = 'restore_queued') DESC, j."createdAt" ASC, i."position" ASC, i."createdAt" ASC
      LIMIT ${slots}
      FOR UPDATE OF i SKIP LOCKED`;
    if (!candidates.length) return [];

    return tx.$queryRaw<Array<{ id: string; jobId: string; status: JobItemStatus; attempts: number }>>`
      UPDATE "JobItem"
      SET "status" = (CASE "status"
            WHEN 'queued' THEN 'processing'
            WHEN 'approved' THEN 'applying'
            WHEN 'restore_queued' THEN 'restoring'
          END)::"JobItemStatus",
          "attempts" = "attempts" + 1,
          "retryAt" = NULL,
          "updatedAt" = now()
      WHERE "id" = ANY(${candidates.map((c) => c.id)}::text[])
      RETURNING "id", "jobId", "status", "attempts"`;
  });

  if (!claimed.length) return 0;
  await withTimeout(
    itemsQueue().addBulk(
      claimed.map((row) => {
        const kind = KIND_FOR_CLAIMED[row.status]!;
        return {
          name: kind,
          data: { kind, itemId: row.id, jobId: row.jobId, shopId },
          opts: { jobId: itemTaskId(kind, row.id, row.attempts) },
        };
      }),
    ),
    ENQUEUE_TIMEOUT_MS,
    "enqueue",
  );
  return claimed.length;
}

const INFLIGHT_FOR_KIND: Record<ItemTask["kind"], JobItemStatus> = {
  process: "processing",
  apply: "applying",
  restore: "restoring",
};

/**
 * An item task failed and BullMQ runs it again after `delayMs`. Until then the image gives its
 * shop slot back (see pumpShop), and the slot goes to the shop's next work right away.
 */
export async function itemRetryScheduled(task: ItemTask, delayMs: number): Promise<void> {
  const r = await prisma.jobItem.updateMany({
    where: { id: task.itemId, status: INFLIGHT_FOR_KIND[task.kind] },
    data: { retryAt: new Date(Date.now() + delayMs) },
  });
  if (r.count) await pumpAfterCommit(task.shopId, "retry-backoff");
}

// ─── Progress and phase transitions ─────────────────────────────────────────

export async function itemCounts(jobId: string): Promise<StatusCounts> {
  const rows = await prisma.jobItem.groupBy({
    by: ["status"],
    where: { jobId },
    _count: { _all: true },
  });
  return Object.fromEntries(rows.map((r) => [r.status, r._count._all]));
}

/** Live counts for a page of jobs (Home, Jobs list) in one query on the [jobId, status] index. */
export async function itemCountsByJob(jobIds: string[]): Promise<Map<string, StatusCounts>> {
  const out = new Map<string, StatusCounts>(jobIds.map((id) => [id, {}]));
  if (!jobIds.length) return out;
  const rows = await prisma.jobItem.groupBy({
    by: ["jobId", "status"],
    where: { jobId: { in: jobIds } },
    _count: { _all: true },
  });
  for (const r of rows) out.get(r.jobId)![r.status] = r._count._all;
  return out;
}

/**
 * The job is processing but none of its images are in flight, while an older job of the shop
 * is still running: the pump serves the oldest job first, so this one waits its turn.
 */
export async function waitingForEarlierJob(
  job: Pick<Job, "id" | "shopId" | "status" | "createdAt">,
  counts: StatusCounts,
): Promise<boolean> {
  if (job.status !== "processing" || (counts.processing ?? 0) > 0 || !(counts.queued ?? 0)) return false;
  const older = await prisma.job.findFirst({
    where: {
      shopId: job.shopId,
      id: { not: job.id },
      status: { in: ["processing", "applying"] },
      createdAt: { lt: job.createdAt },
    },
    select: { id: true },
  });
  return older !== null;
}

/**
 * Pure phase-transition rule, exported for tests. Processing ends in review while anything can
 * still be decided: a result to approve or keep the original of, or an already clean photo
 * (unchanged) the merchant may want to retry with the stronger model.
 */
export function nextJobStatus(current: JobStatus, c: StatusCounts): JobStatus {
  const n = (s: JobItemStatus) => c[s] ?? 0;
  if (current === "processing" && n("queued") + n("processing") === 0) {
    return n("ready") + n("flagged") + n("approved") + n("unchanged") > 0 ? "review" : "done";
  }
  if (current === "applying" && n("approved") + n("applying") === 0) {
    // Unapproved images left over: back to review so the merchant can finish.
    return n("ready") + n("flagged") > 0 ? "review" : "done";
  }
  return current;
}

const isPhase = (s: JobStatus): s is "processing" | "applying" => s === "processing" || s === "applying";

/**
 * Recount a job's items, store the phase's completed/failed counts, and move the job to the
 * next phase when the current one is finished. Every write is a compare-and-set on the values
 * it read, including the phase's identity (phaseStartedAt, phaseTotal), so concurrent
 * refreshes never go backwards and a refresh computed for an earlier phase never writes into
 * a later one (Retry failed and Apply reset the counters to the same zeros). The refresh that
 * ends a phase is the only one that logs BULK_JOB_COMPLETED, and it creates the merchant's
 * notification in the same transaction, so the notification exists exactly once even if the
 * process dies right after. Returns the status after.
 */
export async function refreshJobState(jobId: string): Promise<JobStatus | null> {
  for (let round = 0; round < 5; round++) {
    const job = await prisma.job.findUnique({ where: { id: jobId } });
    if (!job) return null;
    const counts = await itemCounts(jobId);
    const total = Object.values(counts).reduce<number>((a, b) => a + (b ?? 0), 0);
    const p = jobProgress(job, counts);
    const next = nextJobStatus(job.status, counts);
    const inPhase = isPhase(job.status);
    const phaseEnded = inPhase && next !== job.status;

    const data: Prisma.JobUpdateManyMutationInput = {};
    if (total !== job.total) data.total = total;
    if (inPhase && p.completed !== job.done) data.done = p.completed;
    if (inPhase && p.failed !== job.failed) data.failed = p.failed;
    if (next !== job.status) data.status = next;
    if (phaseEnded) data.completedAt = new Date();
    if (!Object.keys(data).length) return job.status;

    const where: Prisma.JobWhereInput = {
      id: jobId,
      status: job.status,
      total: job.total,
      done: job.done,
      failed: job.failed,
      phaseTotal: job.phaseTotal,
      phaseStartedAt: job.phaseStartedAt,
    };

    if (!phaseEnded) {
      const r = await prisma.job.updateMany({ where, data });
      if (!r.count) continue; // another refresh got there first: look again
      if (inPhase) logProgressStep(job, p);
      return next;
    }

    const note = phaseEndedNotification(job, job.status as "processing" | "applying", p);
    const ended = await prisma.$transaction(async (tx) => {
      const r = await tx.job.updateMany({ where, data });
      if (!r.count) return null;
      return { notified: note ? await insertNotification(tx, note) : false };
    });
    if (!ended) continue;

    logProgressStep(job, p);
    await phaseFinished(job, p, next);
    if (note && ended.notified) await notificationCreated(note);
    return next;
  }
  log.warn("refreshJobState gave up after concurrent updates", { jobId });
  return null;
}

/** BULK_JOB_PROGRESS once per 10 % step of the current phase. */
function logProgressStep(job: Job, p: JobProgress): void {
  const before = p.total ? Math.floor(((job.done + job.failed) / p.total) * 100) : 0;
  if (Math.floor(p.progress / 10) <= Math.floor(before / 10)) return;
  log.info("BULK_JOB_PROGRESS", {
    jobId: job.id,
    shopId: job.shopId,
    phase: job.status,
    total: p.total,
    completed: p.completed,
    failed: p.failed,
    remaining: p.remaining,
    progress: p.progress,
    etaSeconds: p.etaSeconds,
  });
}

/** Once per phase end (the refresh whose compare-and-set left the phase): the summary logs. */
async function phaseFinished(job: Job, p: JobProgress, next: JobStatus): Promise<void> {
  const phase = job.status as "processing" | "applying";
  const startedAt = job.phaseStartedAt ?? job.startedAt ?? job.createdAt;
  const durationMs = Date.now() - startedAt.getTime();
  try {
    // The images this phase handled: changed since it started, in its end states.
    const rows = await prisma.jobItem.findMany({
      where: {
        jobId: job.id,
        ...(job.phaseStartedAt ? { updatedAt: { gte: job.phaseStartedAt } } : {}),
        OR:
          phase === "processing"
            ? [{ status: { in: ["ready", "flagged", "unchanged"] } }, { status: "failed", outputKey: null }]
            : [{ status: "applied" }, { status: "failed", outputKey: { not: null } }],
      },
      select: { status: true, processing: true, attempts: true, flags: true, outputKey: true },
    });
    const summaryOpts = { fallbackCutoutUsd: env().REPLICATE_AVG_CUTOUT_USD };
    const s = summarizeProcessing(phase === "processing" ? rows : [], summaryOpts);
    const finished = p.completed + p.failed;
    log.info("BULK_JOB_COMPLETED", {
      jobId: job.id,
      shopId: job.shopId,
      phase,
      next,
      durationMs,
      avgMsPerImage: finished ? Math.round(durationMs / finished) : null,
      total: p.total,
      completed: p.completed,
      failed: p.failed,
      retries: s.retries,
      reclaims: rows.reduce((a, r) => a + Math.max(0, r.attempts - 1), 0),
      ...(phase === "processing"
        ? {
            methods: s.byMethod,
            avgGpuMs: s.avgDurationMs,
            replicateCalls: s.replicateCalls,
            replicateImages: s.replicateImages,
            estimatedUsd: s.estimatedUsd,
            finalStatuses: s.finalStatuses,
            routes: s.byRoute,
            localAccepted: s.localAccepted,
            sentToReplicate: s.sentToReplicate,
            noChange: s.noChange,
          }
        : {}),
    });
    if (phase === "processing") {
      // Whole-job summary under its documented name (README), once per processing phase.
      const all = await prisma.jobItem.findMany({
        where: { jobId: job.id },
        select: { status: true, processing: true, flags: true, outputKey: true },
      });
      log.info("JOB_PROCESSING_SUMMARY", { jobId: job.id, ...summarizeProcessing(all, summaryOpts) });
    }
  } catch (error) {
    log.warn("phase summary failed", { jobId: job.id, error: errorMessage(error) });
  }
}

// ─── Review decisions ───────────────────────────────────────────────────────

export type ReviewDecision = "approve" | "reject" | "reset";

/**
 * Reviewing keeps a job open: maintenance closes reviews REVIEW_EXPIRY_DAYS after the job's
 * updatedAt (the job page shows the same date), so every decision moves it forward.
 */
async function touchReview(jobId: string, changed: number): Promise<number> {
  if (changed) {
    await prisma.job.updateMany({ where: { id: jobId, status: "review" }, data: { updatedAt: new Date() } });
  }
  return changed;
}

export async function decideItems(
  shopId: string,
  jobId: string,
  itemIds: string[],
  decision: ReviewDecision,
): Promise<number> {
  const job = await jobForShop(prisma, shopId, jobId);
  if (job.status !== "review") throw new JobStateError("Images can only be reviewed while the job is in review.");
  if (!itemIds.length) return 0;

  if (decision === "approve") {
    const r = await prisma.jobItem.updateMany({
      where: { jobId, id: { in: itemIds }, status: { in: ["ready", "flagged"] } },
      data: { status: "approved" },
    });
    return touchReview(jobId, r.count);
  }
  if (decision === "reject") {
    const r = await prisma.jobItem.updateMany({
      where: { jobId, id: { in: itemIds }, status: { in: ["ready", "flagged", "approved"] } },
      data: { status: "rejected" },
    });
    return touchReview(jobId, r.count);
  }
  // reset: un-approve or un-reject. Un-rejecting takes credits back into
  // reservation, so check the balance under the shop lock.
  const reset = await prisma.$transaction(async (tx) => {
    await lockShop(tx, shopId);
    const rejected = await tx.jobItem.aggregate({
      _sum: { creditsReserved: true },
      where: { jobId, id: { in: itemIds }, status: "rejected" },
    });
    const needed = rejected._sum.creditsReserved ?? 0;
    if (needed > 0) {
      const shop = await tx.shop.findUniqueOrThrow({ where: { id: shopId } });
      const available = shop.creditBalance - (await reservedCredits(tx, shopId));
      if (needed > available) throw new InsufficientCreditsError(needed, available);
    }
    return tx.$executeRaw`
      UPDATE "JobItem"
      SET "status" = (CASE WHEN jsonb_array_length("flags") > 0 THEN 'flagged' ELSE 'ready' END)::"JobItemStatus",
          "updatedAt" = now()
      WHERE "jobId" = ${jobId}
        AND "id" = ANY(${itemIds}::text[])
        AND "status" IN ('approved', 'rejected')`;
  });
  return touchReview(jobId, reset);
}

/**
 * "Approve all" takes READY images only (status ready: every automatic check passed, nothing
 * flagged). Flagged (NEEDS_REVIEW) images need the merchant to look at each one, and already
 * clean (unchanged) images have nothing to apply.
 */
export async function approveAllUnflagged(shopId: string, jobId: string): Promise<number> {
  const job = await jobForShop(prisma, shopId, jobId);
  if (job.status !== "review") throw new JobStateError("Images can only be reviewed while the job is in review.");
  // Defence in depth: a ready image never has flags (the worker and "reset" both make a
  // flagged image flagged), but bulk approval must not depend on that alone.
  const r = await prisma.$executeRaw`
    UPDATE "JobItem"
    SET "status" = 'approved', "updatedAt" = now()
    WHERE "jobId" = ${jobId} AND "status" = 'ready'
      AND jsonb_typeof("flags") = 'array' AND jsonb_array_length("flags") = 0
      AND COALESCE("processing"->>'final_status', 'READY') = 'READY'`;
  return touchReview(jobId, r);
}

export async function applyApproved(shopId: string, jobId: string): Promise<void> {
  const job = await jobForShop(prisma, shopId, jobId);
  if (job.status !== "review") throw new JobStateError(`This job is ${job.status}.`);
  const approved = await prisma.jobItem.count({ where: { jobId, status: "approved" } });
  if (!approved) throw new JobStateError("Approve at least one image first.");
  // Compare-and-set, with the apply phase's snapshot taken in the same statement. A previous
  // round's "Applying stopped" notice is dropped in it too: this round supersedes it.
  const moved = await prisma.$executeRaw`
    UPDATE "Job" j
    SET "status" = 'applying',
        "phaseTotal" = (SELECT COUNT(*) FROM "JobItem" WHERE "jobId" = j."id" AND "status" = 'approved'),
        "phaseFailedBase" = (SELECT COUNT(*) FROM "JobItem" WHERE "jobId" = j."id" AND "status" = 'failed'),
        "phaseStartedAt" = now(),
        "done" = 0,
        "failed" = 0,
        "completedAt" = NULL,
        "error" = NULLIF(
          array_to_string(array_remove(string_to_array(COALESCE(j."error", ''), E'\n'), ${APPLY_STOPPED_NOTICE}::text), E'\n'),
          ''
        ),
        "updatedAt" = now()
    WHERE j."id" = ${jobId} AND j."shopId" = ${shopId} AND j."status" = 'review'`;
  if (!moved) throw new JobStateError(CHANGED_MEANWHILE);
  await pumpAfterCommit(shopId, "apply");
}

/** Close the job; anything not applied is released from reservation. */
export async function finishJob(shopId: string, jobId: string): Promise<void> {
  const job = await jobForShop(prisma, shopId, jobId);
  if (job.status !== "review" && job.status !== "estimated") throw new JobStateError(`This job is ${job.status}.`);
  const r = await prisma.job.updateMany({
    where: { id: jobId, shopId, status: job.status },
    data: { status: job.status === "estimated" ? "cancelled" : "done", completedAt: new Date() },
  });
  if (!r.count) throw new JobStateError(CHANGED_MEANWHILE);
}

/** Shown after the merchant stops an apply. */
export const APPLY_STOPPED_NOTICE = "Applying stopped. Images already written to your store stay applied.";

/**
 * Cancel a job, or stop applying. reading, estimated or processing → cancelled: queued images
 * are never claimed again, and images already at the image service finish (their previews
 * are kept but the job is closed). applying → review: no new image is written, writes already
 * under way finish and are charged, and the rest stay approved so Apply can resume.
 * review, done, failed and cancelled can't be cancelled (review closes with finishJob).
 * Returns the job's new status.
 */
export async function cancelJob(shopId: string, jobId: string): Promise<JobStatus> {
  for (let round = 0; round < 3; round++) {
    const job = await jobForShop(prisma, shopId, jobId);
    if (job.status === "applying") {
      const r = await prisma.job.updateMany({
        where: { id: jobId, shopId, status: "applying" },
        data: { status: "review", completedAt: new Date(), error: withNotice(job.error, APPLY_STOPPED_NOTICE) },
      });
      if (!r.count) continue;
      log.info("job apply stopped", { jobId, shopId });
      return "review";
    }
    if (job.status !== "reading" && job.status !== "estimated" && job.status !== "processing") {
      throw new JobStateError(`A job that is ${job.status} can't be cancelled.`);
    }
    const r = await prisma.job.updateMany({
      where: { id: jobId, shopId, status: job.status },
      data: { status: "cancelled", completedAt: new Date() },
    });
    if (!r.count) continue; // it moved on meanwhile (e.g. processing → review): decide again
    log.info("job cancelled", { jobId, shopId, was: job.status });
    return "cancelled";
  }
  throw new JobStateError(CHANGED_MEANWHILE);
}

// ─── Restore ────────────────────────────────────────────────────────────────

/** Queue restores for applied images (all applied images in the job when itemIds is omitted). Free. */
export async function restoreItems(shopId: string, jobId: string, itemIds?: string[]): Promise<number> {
  await jobForShop(prisma, shopId, jobId);
  const r = await prisma.jobItem.updateMany({
    where: {
      jobId,
      status: "applied",
      backupKey: { not: null },
      ...(itemIds ? { id: { in: itemIds } } : {}),
    },
    data: { status: "restore_queued", error: null, errorCode: null },
  });
  if (r.count) await pumpAfterCommit(shopId, "restore");
  return r.count;
}

// ─── Retry ──────────────────────────────────────────────────────────────────

export interface RetryResult {
  /** Images sent back to processing or applying. 0 when nothing matched (a repeat click). */
  retried: number;
  /** Failed images left alone because another unfinished job has them. */
  skipped: number;
  status: JobStatus;
}

/** Stored on failed images a retry skipped because another unfinished job has them. */
export const IN_ANOTHER_JOB_MESSAGE =
  "This image is in another job that hasn't finished. Retry it once that job is done.";

/**
 * Retry failed images (all of them, or `itemIds`), in review or after the job is done. Ones
 * that never produced an output go back through the pipeline; ones that failed while applying
 * go back to approved. The job moves to where that work happens: processing if anything needs
 * processing, else applying when reopening a finished job with nothing else left to decide,
 * else review (the merchant presses Apply again). Batched, so thousands of failures retry in
 * a few statements. Nothing matching is a no-op (retried 0), so a second click is harmless.
 */
export async function retryFailed(shopId: string, jobId: string, itemIds?: string[]): Promise<RetryResult> {
  const result = await prisma.$transaction(
    async (tx): Promise<RetryResult> => {
      await lockShop(tx, shopId);
      const job = await jobForShop(tx, shopId, jobId);
      const only = itemIds ? Prisma.sql`AND i."id" = ANY(${itemIds}::text[])` : Prisma.empty;
      const matching = await tx.$queryRaw<Array<{ n: number }>>`
        SELECT COUNT(*)::int AS n FROM "JobItem" i WHERE i."jobId" = ${jobId} AND i."status" = 'failed' ${only}`;
      if (!matching[0]?.n) return { retried: 0, skipped: 0, status: job.status };
      if (job.status !== "review" && job.status !== "done") {
        throw new JobStateError("Failed images can be retried once the job is in review or done.");
      }

      // Reprocessing an image another unfinished job has would process it twice: leave it
      // failed, and say why (after its own failure reason, which stays).
      const busy = await busyMedia(
        tx,
        shopId,
        jobId,
        Prisma.sql`SELECT i."mediaId" FROM "JobItem" i
          WHERE i."jobId" = ${jobId} AND i."status" = 'failed' AND i."outputKey" IS NULL ${only}`,
      );
      const skipped = busy.length
        ? await tx.$executeRaw`
            UPDATE "JobItem" i
            SET "error" = CASE
                  WHEN i."error" IS NULL OR i."error" = '' THEN ${IN_ANOTHER_JOB_MESSAGE}
                  WHEN strpos(i."error", ${IN_ANOTHER_JOB_MESSAGE}) > 0 THEN i."error"
                  ELSE left(i."error" || ' ' || ${IN_ANOTHER_JOB_MESSAGE}, 1000)
                END,
                "errorCode" = 'in_another_job',
                "updatedAt" = now()
            WHERE i."jobId" = ${jobId} AND i."status" = 'failed' AND i."outputKey" IS NULL ${only}
              AND i."mediaId" = ANY(${busy}::text[])`
        : 0;

      const groups = await tx.$queryRaw<Array<{ reprocess: boolean; upscale: boolean; n: number }>>`
        SELECT (i."outputKey" IS NULL) AS reprocess,
               (CASE WHEN i."outputKey" IS NULL THEN i."upscaleEligible" ELSE i."upscaleApplied" END) AS upscale,
               COUNT(*)::int AS n
        FROM "JobItem" i
        WHERE i."jobId" = ${jobId} AND i."status" = 'failed' ${only}
          AND NOT (i."outputKey" IS NULL AND i."mediaId" = ANY(${busy}::text[]))
        GROUP BY 1, 2`;
      const reprocessCount = groups.filter((g) => g.reprocess).reduce((a, g) => a + g.n, 0);
      const reapplyCount = groups.filter((g) => !g.reprocess).reduce((a, g) => a + g.n, 0);
      if (!reprocessCount && !reapplyCount) return { retried: 0, skipped, status: job.status };
      let cost = groups.reduce((a, g) => a + g.n * creditsFor(g.upscale), 0);

      // A done job holds no reservation. Reopening it brings back whatever was
      // left undecided when it closed (ready, flagged or approved images), so
      // those count against the balance too.
      const leftover =
        job.status === "done"
          ? await tx.jobItem.aggregate({
              _count: { _all: true },
              _sum: { creditsReserved: true },
              where: { jobId, status: { in: RESERVING_ITEM_STATUSES } },
            })
          : null;
      cost += leftover?._sum.creditsReserved ?? 0;

      const shop = await tx.shop.findUniqueOrThrow({ where: { id: shopId } });
      const available = shop.creditBalance - (await reservedCredits(tx, shopId));
      if (cost > available) throw new InsufficientCreditsError(cost, available);

      await tx.$executeRaw`
        UPDATE "JobItem" i
        SET "status" = 'queued', "error" = NULL, "errorCode" = NULL, "updatedAt" = now(),
            "creditsReserved" = CASE WHEN i."upscaleEligible" THEN ${creditsFor(true)} ELSE ${creditsFor(false)} END
        WHERE i."jobId" = ${jobId} AND i."status" = 'failed' AND i."outputKey" IS NULL ${only}
          AND NOT (i."mediaId" = ANY(${busy}::text[]))`;
      await tx.$executeRaw`
        UPDATE "JobItem" i
        SET "status" = 'approved', "error" = NULL, "errorCode" = NULL, "updatedAt" = now(),
            "creditsReserved" = CASE WHEN i."upscaleApplied" THEN ${creditsFor(true)} ELSE ${creditsFor(false)} END
        WHERE i."jobId" = ${jobId} AND i."status" = 'failed' AND i."outputKey" IS NOT NULL ${only}`;

      let next: JobStatus = job.status;
      if (reprocessCount) next = "processing";
      else if (job.status === "done") next = leftover?._count._all ? "review" : "applying";
      // Compare-and-set on the status read above: finishJob, applyApproved and the review
      // expiry change the job without the shop lock. If one committed meanwhile, throwing rolls
      // the item changes back instead of overwriting its outcome.
      const moved = await tx.job.updateMany({
        where: { id: jobId, shopId, status: job.status },
        data:
          next !== job.status
            ? {
                // A new phase: progress starts from the images sent back, and failures left
                // behind (not retried) don't count against it.
                status: next,
                completedAt: null,
                done: 0,
                failed: 0,
                phaseTotal: next === "processing" ? reprocessCount : next === "applying" ? reapplyCount : 0,
                phaseFailedBase: await tx.jobItem.count({ where: { jobId, status: "failed" } }),
                phaseStartedAt: new Date(),
              }
            : // Still in review: images were approved again, which keeps the review open.
              { updatedAt: new Date() },
      });
      if (!moved.count) throw new JobStateError(CHANGED_MEANWHILE);
      return { retried: reprocessCount + reapplyCount, skipped, status: next };
    },
    { timeout: 20_000 },
  );
  if (result.retried) {
    log.info("failed images retried", { jobId, shopId, ...result, selected: itemIds?.length ?? null });
    await pumpAfterCommit(shopId, "retry");
  }
  return result;
}

// ─── Retry with stronger model ──────────────────────────────────────────────

/** What "Retry with stronger model" takes: a result not decided on yet, or an already clean photo. */
export const RETRY_STRONGER_STATUSES: JobItemStatus[] = ["ready", "flagged", "unchanged"];

export interface RetryStrongerResult {
  /** Images sent back to processing with the paid model first. 0 when nothing matched (a repeat click). */
  retried: number;
  /** Selected images left alone because another unfinished job has them. */
  skipped: number;
  status: JobStatus;
}

/**
 * "Retry with stronger model" for images in review: ready, flagged (NEEDS_REVIEW) or unchanged
 * (NO_CHANGE) ones go back to queued with forceEscalation, so the worker asks the image service
 * for its paid backend first (settings.force_escalation), and the job goes back to processing
 * for them (a new phase). Nothing is charged: credits are only charged when an image is applied.
 * The images are reserved again at their quoted price (an already clean image held no
 * reservation), checked against the balance under the shop lock (402 when short).
 *
 * The earlier result is dropped from the image (its files stay in storage: another item may
 * have reused them) and the run's processing record is kept in the new one's superseded_runs,
 * so its cost still counts. Batched (two statements whatever the count), compare-and-set on
 * the item and job statuses, and idempotent: a repeat finds nothing to take (retried 0).
 * Images another unfinished job has now are skipped.
 */
export async function retryStronger(shopId: string, jobId: string, itemIds: string[]): Promise<RetryStrongerResult> {
  const ids = [...new Set(itemIds)].slice(0, MAX_SELECTION_IDS);
  const result = await prisma.$transaction(
    async (tx): Promise<RetryStrongerResult> => {
      await lockShop(tx, shopId);
      const job = await jobForShop(tx, shopId, jobId);
      if (!ids.length) return { retried: 0, skipped: 0, status: job.status };
      const selected = Prisma.sql`i."jobId" = ${jobId} AND i."id" = ANY(${ids}::text[])
        AND i."status"::text = ANY(${RETRY_STRONGER_STATUSES}::text[])`;
      const matching = await tx.$queryRaw<Array<{ n: number }>>`
        SELECT COUNT(*)::int AS n FROM "JobItem" i WHERE ${selected}`;
      if (!matching[0]?.n) return { retried: 0, skipped: 0, status: job.status };
      if (job.status !== "review") {
        throw new JobStateError("Images can be retried with a stronger model while the job is in review.");
      }

      // An already clean image holds no reservation, so another unfinished job may have it now.
      const busy = await busyMedia(tx, shopId, jobId, Prisma.sql`SELECT i."mediaId" FROM "JobItem" i WHERE ${selected}`);
      const counts = await tx.$queryRaw<Array<{ n: number; skipped: number; needed: number }>>`
        SELECT COUNT(*) FILTER (WHERE NOT (i."mediaId" = ANY(${busy}::text[])))::int AS n,
               COUNT(*) FILTER (WHERE i."mediaId" = ANY(${busy}::text[]))::int AS skipped,
               COALESCE(SUM(
                 CASE WHEN i."mediaId" = ANY(${busy}::text[]) THEN 0
                      ELSE GREATEST(
                        (CASE WHEN i."upscaleEligible" THEN ${creditsFor(true)} ELSE ${creditsFor(false)} END)
                          - (CASE WHEN i."status" = 'unchanged' THEN 0 ELSE i."creditsReserved" END),
                        0)
                 END), 0)::int AS needed
        FROM "JobItem" i WHERE ${selected}`;
      const { n, skipped, needed } = counts[0] ?? { n: 0, skipped: 0, needed: 0 };
      if (!n) return { retried: 0, skipped, status: job.status };
      if (needed > 0) {
        const shop = await tx.shop.findUniqueOrThrow({ where: { id: shopId } });
        const available = shop.creditBalance - (await reservedCredits(tx, shopId));
        if (needed > available) throw new InsufficientCreditsError(needed, available);
      }

      // decideItems doesn't take the shop lock: the status filter again, and the count moved is
      // what the phase counts.
      const moved = await tx.$executeRaw`
        UPDATE "JobItem" i
        SET "status" = 'queued',
            "forceEscalation" = true,
            "creditsReserved" = CASE WHEN i."upscaleEligible" THEN ${creditsFor(true)} ELSE ${creditsFor(false)} END,
            "outputKey" = NULL, "previewKey" = NULL, "beforeKey" = NULL, "maskKey" = NULL,
            "outputFormat" = NULL, "outputWidth" = NULL, "outputHeight" = NULL,
            "flags" = '[]'::jsonb, "metrics" = NULL, "fidelity" = NULL, "models" = NULL,
            "upscaleApplied" = false, "resultKey" = NULL,
            "error" = NULL, "errorCode" = NULL, "retryAt" = NULL, "updatedAt" = now()
        WHERE ${selected} AND NOT (i."mediaId" = ANY(${busy}::text[]))`;
      if (!moved) return { retried: 0, skipped, status: job.status };

      const r = await tx.job.updateMany({
        where: { id: jobId, shopId, status: "review" },
        data: {
          status: "processing",
          completedAt: null,
          done: 0,
          failed: 0,
          phaseTotal: moved,
          phaseFailedBase: await tx.jobItem.count({ where: { jobId, status: "failed" } }),
          phaseStartedAt: new Date(),
        },
      });
      if (!r.count) throw new JobStateError(CHANGED_MEANWHILE);
      return { retried: moved, skipped, status: "processing" };
    },
    { timeout: 20_000 },
  );
  if (result.retried) {
    log.info("RETRY_STRONGER", { jobId, shopId, ...result, selected: ids.length });
    await pumpAfterCommit(shopId, "retry-stronger");
  }
  return result;
}

/** Filter-free job view for loaders: never send the raw filter (it can hold thousands of ids). */
export function jobSelectionLabel(job: Pick<Job, "filter">): string {
  return describeFilter(filterForClient(job.filter));
}
