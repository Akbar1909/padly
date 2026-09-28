import type { JobItemStatus, JobStatus } from "@prisma/client";

/**
 * Job progress and the public status vocabulary. Pure (no server imports): used by the
 * worker, the loaders, the JSON API and the UI.
 *
 * Internal JobStatus / JobItemStatus names never change; the spec vocabulary ("queued",
 * "processing", "completed", "completed_with_errors", "failed", "cancelled") is mapped here, at
 * the edges only. "completed" always means processed and ready for review, never "written to
 * Shopify": nothing is written before the merchant approves and applies.
 */

export type StatusCounts = Partial<Record<JobItemStatus, number>>;

/** Item statuses where processing produced a result (a preview exists), whatever was decided after. */
export const PROCESSED_ITEM_STATUSES: JobItemStatus[] = [
  "ready",
  "flagged",
  // Already clean (NO_CHANGE): processed, with nothing to apply.
  "unchanged",
  "approved",
  "rejected",
  "applying",
  "applied",
  "restore_queued",
  "restoring",
  "restored",
];

/** Job statuses the job page and the API client should keep polling. */
export const POLLING_JOB_STATUSES: JobStatus[] = ["reading", "processing", "applying"];

/** Finished images needed before an ETA is shown: before that the rate is noise. */
export const ETA_MIN_FINISHED = 5;

/** The fields of a Job that progress needs (a Prisma Job, or its JSON-serialised form). */
export interface ProgressJob {
  status: JobStatus;
  phaseTotal?: number | null;
  phaseFailedBase?: number | null;
  phaseStartedAt?: Date | string | null;
}

export interface JobProgress {
  /** The internal status the numbers are scoped to. */
  phase: JobStatus;
  /** Images in this phase (processing or applying), else all images in the job. */
  total: number;
  /** Processed (or, while applying, written to Shopify) in this phase. */
  completed: number;
  /** Failed in this phase. */
  failed: number;
  /** In flight right now (being processed, or being written while applying). */
  processing: number;
  /** Waiting for a slot (queued, or approved and waiting to be written while applying). */
  queued: number;
  /** queued + processing. */
  remaining: number;
  /** floor((completed + failed) / total × 100): never shows 100 while work is left. */
  progress: number;
  /** Measured, never simulated: null until ETA_MIN_FINISHED images finished in this phase. */
  etaSeconds: number | null;
}

const sum = (counts: StatusCounts, statuses?: JobItemStatus[]) =>
  statuses
    ? statuses.reduce((a, s) => a + (counts[s] ?? 0), 0)
    : Object.values(counts).reduce<number>((a, b) => a + (b ?? 0), 0);

/**
 * Progress of a job from its live item counts (itemCounts), scoped to the current phase.
 *
 * While processing or applying, the numbers come from the snapshot taken when the phase
 * started (Job.phaseTotal / phaseFailedBase / phaseStartedAt): a job reopened by "Retry failed"
 * starts again at 0 %, and an apply round counts only the images it is writing. Every other
 * status, and jobs started before the snapshot existed (phaseTotal 0), use lifetime counts.
 */
export function jobProgress(job: ProgressJob, counts: StatusCounts, now: number = Date.now()): JobProgress {
  const n = (s: JobItemStatus) => counts[s] ?? 0;
  const applying = job.status === "applying";
  const queued = applying ? n("approved") : n("queued");
  const processing = applying ? n("applying") : n("processing");
  const remaining = queued + processing;

  const inPhase = job.status === "processing" || applying;
  const phaseTotal = job.phaseTotal ?? 0;
  const phased = inPhase && phaseTotal > 0;

  let total: number;
  let failed: number;
  if (phased) {
    failed = Math.max(0, n("failed") - (job.phaseFailedBase ?? 0));
    // Never below what is visibly there (a decision racing the phase start).
    total = Math.max(phaseTotal, remaining + failed);
  } else {
    failed = n("failed");
    total = sum(counts);
  }
  const completed = Math.max(0, total - remaining - failed);
  const finished = completed + failed;

  let progress: number;
  if (total > 0) progress = Math.floor((finished / total) * 100);
  else progress = job.status === "review" || job.status === "done" ? 100 : 0;

  let etaSeconds: number | null = null;
  if (phased && job.phaseStartedAt && remaining > 0 && finished >= ETA_MIN_FINISHED) {
    const elapsed = now - new Date(job.phaseStartedAt).getTime();
    if (elapsed > 0) etaSeconds = Math.max(1, Math.round(((elapsed / finished) * remaining) / 1000));
  }

  return { phase: job.status, total, completed, failed, processing, queued, remaining, progress, etaSeconds };
}

// ─── Public (spec) status vocabulary ────────────────────────────────────────

export type ApiJobStatus = "queued" | "processing" | "completed" | "completed_with_errors" | "failed" | "cancelled";
export type ApiItemStatus = "queued" | "processing" | "completed" | "failed";

/**
 * Job status in the spec vocabulary. review and done are judged on lifetime counts: nothing
 * processed and something failed → failed; some failed → completed_with_errors; else completed
 * (including a selection that matched no images).
 */
export function toApiJobStatus(status: JobStatus, counts: StatusCounts): ApiJobStatus {
  switch (status) {
    case "reading":
    case "estimated":
      return "queued";
    case "processing":
    case "applying":
      return "processing";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "review":
    case "done": {
      const ok = sum(counts, PROCESSED_ITEM_STATUSES);
      const bad = counts.failed ?? 0;
      if (ok === 0 && bad > 0) return "failed";
      if (bad > 0) return "completed_with_errors";
      return "completed";
    }
  }
}

/**
 * Item status in the spec vocabulary. Every status after processing is "completed" (a
 * preview exists); the internal status (the review decision, applied or not) is reported
 * separately as reviewStatus so nobody reads "completed" as "published to Shopify".
 */
export function toApiItemStatus(status: JobItemStatus): ApiItemStatus {
  if (status === "queued" || status === "processing" || status === "failed") return status;
  return "completed";
}

const API_ITEM_STATUSES: Record<ApiItemStatus, JobItemStatus[]> = {
  queued: ["queued"],
  processing: ["processing"],
  completed: PROCESSED_ITEM_STATUSES,
  failed: ["failed"],
};

const INTERNAL_ITEM_STATUSES: JobItemStatus[] = ["queued", "processing", "failed", ...PROCESSED_ITEM_STATUSES];

/**
 * Internal statuses matching a ?status= value: a spec status (queued | processing |
 * completed | failed) or an internal one (ready, approved, applied…). Null when unknown.
 */
export function itemStatusFilter(value: string): JobItemStatus[] | null {
  // Own keys only: "constructor", "toString"… must not reach Object.prototype.
  if (Object.hasOwn(API_ITEM_STATUSES, value)) return API_ITEM_STATUSES[value as ApiItemStatus];
  return INTERNAL_ITEM_STATUSES.includes(value as JobItemStatus) ? [value as JobItemStatus] : null;
}

/** Keep polling while this is true (the merchant has nothing to do yet). */
export function isPollingStatus(status: JobStatus): boolean {
  return POLLING_JOB_STATUSES.includes(status);
}

// ─── What the merchant has to do ────────────────────────────────────────────

export type NeedsAction = null | "start" | "credits" | "review";

/**
 * null while the app is working (or the job is closed). estimated → "start" (confirm the
 * selection and cost), or "credits" when the shop can't afford it. Pass the live cost and
 * balance when known; otherwise a blocked auto-start (its credits notice) counts as "credits".
 * review → "review".
 */
export function needsAction(
  job: { status: JobStatus; autoStart?: boolean | null; error?: string | null },
  credits?: { needed: number; available: number } | null,
): NeedsAction {
  if (job.status === "review") return "review";
  if (job.status !== "estimated") return null;
  if (credits) return credits.needed > credits.available ? "credits" : "start";
  return job.autoStart && hasCreditsNotice(job.error) ? "credits" : "start";
}

// ─── Notices (Job.error on jobs that did not fail) ──────────────────────────

/**
 * Job.error holds the failure reason of a failed job. On other jobs it holds notices for the
 * merchant, one per line: nothing matched, the selection was capped, images skipped because
 * another job has them, an auto-start that needs credits.
 */
export function jobNotices(error: string | null | undefined): string[] {
  return (error ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
}

/** Add a notice line (once). */
export function withNotice(error: string | null | undefined, notice: string): string {
  const lines = jobNotices(error);
  if (!lines.includes(notice)) lines.push(notice);
  return lines.join("\n").slice(0, 1000);
}

export const CREDITS_NOTICE_PREFIX = "Not enough credits";

const images = (n: number) => `${n.toLocaleString("en-US")} image${n === 1 ? "" : "s"}`;

/** The first sentence is also the notification title. */
export function creditsNotice(count: number, needed?: number, available?: number): string {
  const head = `${CREDITS_NOTICE_PREFIX} to start processing ${images(count)}.`;
  if (needed === undefined || available === undefined) return head;
  return `${head} This job needs ${needed.toLocaleString("en-US")} credits; ${available.toLocaleString("en-US")} are available.`;
}

export function hasCreditsNotice(error: string | null | undefined): boolean {
  return jobNotices(error).some((l) => l.startsWith(CREDITS_NOTICE_PREFIX));
}

export function withoutCreditsNotice(error: string | null | undefined): string | null {
  const lines = jobNotices(error).filter((l) => !l.startsWith(CREDITS_NOTICE_PREFIX));
  return lines.length ? lines.join("\n") : null;
}

/** Shown when startJob skipped images another unfinished job already has. */
export function skippedNotice(skipped: number): string {
  return `${images(skipped)} ${skipped === 1 ? "is" : "are"} already in another job that hasn't finished, so ${
    skipped === 1 ? "it was" : "they were"
  } skipped.`;
}

/** Shown when the read stopped at MAX_ITEMS_PER_JOB. */
export function cappedNotice(max: number): string {
  return `Only the first ${images(max)} were read: one job can hold at most ${max.toLocaleString("en-US")}. Start another job for the rest.`;
}
