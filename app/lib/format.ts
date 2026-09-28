/** Labels and badge tones shared by the UI. */

import type { Job, JobStatus } from "@prisma/client";
import { describeFilter, filterForClient, type ClientJobFilter, type JobFilter } from "./filters";
import type { FinalStatus } from "./processing";
import {
  CREDITS_NOTICE_PREFIX,
  jobNotices,
  jobProgress,
  needsAction,
  PROCESSED_ITEM_STATUSES,
  toApiJobStatus,
  type JobProgress,
  type StatusCounts,
} from "./progress";

export type Tone = "info" | "success" | "warning" | "critical" | "neutral" | "caution" | "auto";

export interface StatusBadge {
  label: string;
  tone: Tone;
}

export const ITEM_STATUS: Record<string, { label: string; tone: Tone }> = {
  queued: { label: "Queued", tone: "neutral" },
  processing: { label: "Processing", tone: "info" },
  ready: { label: "Ready", tone: "info" },
  flagged: { label: "Needs review", tone: "warning" },
  unchanged: { label: "Already clean", tone: "success" },
  approved: { label: "Approved", tone: "success" },
  // "Keep original" (a rejection): nothing is written to the store.
  rejected: { label: "Original kept", tone: "neutral" },
  applying: { label: "Applying", tone: "info" },
  applied: { label: "Applied", tone: "success" },
  failed: { label: "Failed", tone: "critical" },
  restore_queued: { label: "Restore queued", tone: "info" },
  restoring: { label: "Restoring", tone: "info" },
  restored: { label: "Restored", tone: "neutral" },
};

export const FLAG_LABELS: Record<string, string> = {
  mask_empty: "Product not found",
  mask_full: "Background not found",
  mask_fragmented: "Cut-out in pieces",
  mask_low_confidence: "Uncertain edges",
  text_detected: "Text on product",
  fidelity_low: "Upscale changed details",
  color_drift: "Colour shifted",
  upscale_capped: "Still below target size",
  cutout_check: "Check the cut-out",
  output_check: "Check the layout",
  needs_review: "Check this image",
};

/** What an already clean (NO_CHANGE) image says instead of a result to approve. */
export const UNCHANGED_TEXT = "Already clean — no change needed";

/**
 * The automatic verdict on an image (processing's final status). Worded as what the checks
 * found, never as a guarantee.
 */
export const FINAL_STATUS: Record<FinalStatus, { label: string; tone: Tone; help: string }> = {
  READY: {
    label: "Passed automatic checks",
    tone: "success",
    help: "Every automatic check passed. Look it over before you apply it.",
  },
  NEEDS_REVIEW: {
    label: "Needs your review",
    tone: "warning",
    help: "Our checks couldn't confirm this result. Approve it, keep the original, or retry with the stronger model.",
  },
  FAILED: { label: "Couldn't be processed", tone: "critical", help: "No result could be made for this image." },
  NO_CHANGE: {
    label: UNCHANGED_TEXT,
    tone: "success",
    help: "This photo already matches your settings, so nothing will be changed or charged.",
  },
};

/**
 * What to check for each flag, shown under the badges. The image service's own messages
 * carry measurements (SSIM, ΔE) that mean nothing to a merchant.
 */
export const FLAG_HELP: Record<string, string> = {
  mask_empty: "We couldn't find the product in this photo. Check the result, or reject it.",
  mask_full: "The background may not have been removed.",
  mask_fragmented: "The cut-out is in several pieces. Check that nothing is missing.",
  mask_low_confidence: "Edges may be rough (glass, hair or jewelry). Check them up close.",
  text_detected: "Text or a label was found, so this photo was resized without AI to keep it readable.",
  fidelity_low: "AI upscaling may have changed fine details. Compare it with the original.",
  color_drift: "The product's colour may have changed. Compare it with the original.",
  upscale_capped: "The result is still smaller than your output width.",
  output_check: "The product may not be centred or padded as set. Compare it with the original, or reject it.",
  needs_review: "Our automatic checks couldn't confirm this result. Compare it with the original before approving.",
};

/** How a photo was enlarged, in plain words; null when it wasn't. */
export function upscaleLabel(method: string | null): string | null {
  if (!method) return null;
  const ai = /^realesrgan-x(\d+)$/.exec(method);
  if (ai) return `AI upscaled ×${ai[1]}`;
  if (method === "lanczos") return "Resized";
  return null;
}

/** A JobFilter, or its browser-safe ClientJobFilter form (counts instead of id lists). */
type HeadingFilter = Partial<
  Pick<JobFilter, "collectionId" | "collectionTitle" | "vendor" | "productType" | "tag" | "productIds" | "mediaIds">
> &
  Pick<ClientJobFilter, "productCount" | "mediaCount">;

/**
 * Page heading for a job: what it covers, e.g. "Collection “Shoes”", "All products" or, for
 * jobs that name their products (the API), "12 selected products" / "30 selected images".
 * Pass filterForClient(job.filter): the id lists themselves never reach the browser.
 */
export function jobHeading(filter: HeadingFilter): string {
  const products = filter.productCount ?? filter.productIds?.length ?? 0;
  const media = filter.mediaCount ?? filter.mediaIds?.length ?? 0;
  if (media) return plural(media, "selected image");
  if (products) return plural(products, "selected product");
  const parts: string[] = [];
  if (filter.collectionTitle || filter.collectionId) parts.push(`collection “${filter.collectionTitle ?? "selected"}”`);
  if (filter.vendor) parts.push(`vendor “${filter.vendor}”`);
  if (filter.productType) parts.push(`type “${filter.productType}”`);
  if (filter.tag) parts.push(`tag “${filter.tag}”`);
  if (!parts.length) return "All products";
  const text = parts.join(", ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const LEDGER_REASONS: Record<string, string> = {
  free_grant: "Free credits",
  purchase: "Credit pack",
  apply: "Image applied",
  adjustment: "Adjustment",
};

/**
 * Credit history label. Older purchase rows carry the pack id ("starter pack"); show the pack's
 * name. Packs are passed in because they live in a server-only module.
 */
export function ledgerLabel(
  row: { reason: string; note: string | null },
  packs: ReadonlyArray<{ id: string; name: string }>,
): string {
  if (row.reason === "purchase") {
    const pack = packs.find((p) => row.note === `${p.id} pack`);
    if (pack) return pack.name;
  }
  return row.note ?? LEDGER_REASONS[row.reason] ?? row.reason;
}

export function formatDate(value: string | Date): string {
  return new Date(value).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Date without the time, e.g. "Oct 11". */
export function formatDay(value: string | Date): string {
  return new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export const num = (n: number) => n.toLocaleString("en-US");

export const plural = (n: number, word: string) => `${num(n)} ${word}${n === 1 ? "" : "s"}`;

// ─── Jobs: status, progress and list rows ───────────────────────────────────

const countWord = (n: number, one: string, many: string) => (n === 1 ? one : many);

/**
 * The merchant's badge for a job. The API speaks the spec vocabulary (toApiJobStatus: queued,
 * processing, completed, completed_with_errors, failed, cancelled), where "completed" means
 * processed, not written to the store. A merchant reads a green "Completed" as "my store is
 * updated", so the UI says what happened to the store: "Ready for review" while previews wait
 * for approval, "Completed" only once images were applied, "Finished, not applied" for a job
 * closed without applying. toApiJobStatus still decides failed and with-errors. Two more states
 * where the merchant has to act: "Ready to start" (confirm the selection and cost) and "Needs
 * credits" (an auto-started job short of credits).
 */
export function jobDisplayStatus(
  status: JobStatus,
  counts: StatusCounts,
  opts: { needsCredits?: boolean } = {},
): StatusBadge {
  switch (status) {
    case "reading":
      return { label: "Queued", tone: "info" };
    case "estimated":
      return opts.needsCredits ? { label: "Needs credits", tone: "warning" } : { label: "Ready to start", tone: "caution" };
    case "processing":
      return { label: "Processing", tone: "info" };
    case "applying":
      return { label: "Applying", tone: "info" };
    case "failed":
      return { label: "Failed", tone: "critical" };
    case "cancelled":
      return { label: "Cancelled", tone: "neutral" };
    case "review":
    case "done": {
      const any = Object.values(counts).some((n) => (n ?? 0) > 0);
      // A selection that matched no images is neither a success nor a failure.
      if (status === "done" && !any) return { label: "No images", tone: "neutral" };
      const api = toApiJobStatus(status, counts);
      if (api === "failed") return { label: "Failed", tone: "critical" };
      const withErrors = api === "completed_with_errors";
      if (status === "review") {
        return withErrors ? { label: "Ready for review, with errors", tone: "warning" } : { label: "Ready for review", tone: "info" };
      }
      // Done: applied (or applied, then restored) images changed the store; none means it didn't.
      if (!appliedCount(counts) && !(counts.restored ?? 0)) return { label: "Finished, not applied", tone: "neutral" };
      return withErrors ? { label: "Completed with errors", tone: "warning" } : { label: "Completed", tone: "success" };
    }
    default:
      return { label: String(status), tone: "neutral" };
  }
}

/** Images whose processing produced a preview (whatever was decided about them since). */
export function processedCount(counts: StatusCounts): number {
  return PROCESSED_ITEM_STATUSES.reduce((a, s) => a + (counts[s] ?? 0), 0);
}

/** Images written to the store and still there (restores under way included). */
export function appliedCount(counts: StatusCounts): number {
  return (counts.applied ?? 0) + (counts.restore_queued ?? 0) + (counts.restoring ?? 0);
}

/**
 * "about 12 min left" from a measured ETA (JobProgress.etaSeconds); null when there is none
 * yet. Rounded up, so it never promises less than it measured.
 */
export function formatEta(seconds: number | null | undefined): string | null {
  if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) return null;
  const minutes = Math.ceil(seconds / 60);
  if (seconds < 60) return "less than a minute left";
  if (minutes < 60) return `about ${minutes} min left`;
  let hours = Math.floor(minutes / 60);
  let rest = Math.round((minutes % 60) / 10) * 10;
  if (rest === 60) {
    hours += 1;
    rest = 0;
  }
  return `about ${hours} h${rest ? ` ${rest} min` : ""} left`;
}

/**
 * The counts line under a running phase: "67 of 100 processed · 3 failed · 30 remaining ·
 * about 5 min left". `doneWord` is "processed" while processing, "updated" while applying.
 */
export function progressSummary(
  p: Pick<JobProgress, "total" | "completed" | "failed" | "remaining" | "etaSeconds">,
  doneWord: string,
): string {
  const parts = [`${num(p.completed)} of ${num(p.total)} ${doneWord}`];
  if (p.failed) parts.push(`${num(p.failed)} failed`);
  if (p.remaining) parts.push(`${num(p.remaining)} remaining`);
  const eta = formatEta(p.etaSeconds);
  if (eta) parts.push(eta);
  return parts.join(" · ");
}

/** "3 need attention", "1 needs attention". */
export const needAttention = (failed: number) => `${num(failed)} ${countWord(failed, "needs", "need")} attention`;

/**
 * A finished job in the jobs list: "97 ready · 3 need attention" while in review; once done,
 * "50 applied · …" (or "97 processed · …" when nothing was applied); "3 failed" when nothing
 * was processed at all.
 */
export function finishedSummary(counts: StatusCounts, status: "review" | "done" = "review"): string {
  const ok = processedCount(counts);
  const failed = counts.failed ?? 0;
  if (!ok && !failed) return "—";
  if (!ok) return `${num(failed)} failed`;
  const applied = appliedCount(counts);
  let head = `${num(ok)} ready`;
  if (status === "done") head = applied ? `${num(applied)} applied` : `${num(ok)} processed`;
  return failed ? `${head} · ${needAttention(failed)}` : head;
}

/** What the job page says once a phase has finished (review or done). */
export interface FinishedCopy {
  heading: string;
  /** e.g. "97 successfully processed", "50 images updated in your store"; null when nothing worked. */
  done: string | null;
  /** In review: "7 need your review" (NEEDS_REVIEW images); absent when there are none. */
  review?: string;
  /** "5 already clean — no change needed" (NO_CHANGE images); absent when there are none. */
  unchanged?: string;
  /** e.g. "3 need attention"; null when nothing failed. */
  attention: string | null;
  /** The job page tab the main button opens. */
  link: { label: string; tab: "review" | "failed" | "applied" } | null;
}

/**
 * The job page's finished state from lifetime counts: "Your images are ready · 97 successfully
 * processed · 3 need attention · [Review results]" in review. Once done: what reached the
 * store, or that nothing could be processed. Null for a selection that matched no images (it
 * has its own banner).
 */
export function finishedCopy(status: "review" | "done", counts: StatusCounts): FinishedCopy | null {
  const ok = processedCount(counts);
  const failed = counts.failed ?? 0;
  const attention = failed ? needAttention(failed) : null;
  const clean = counts.unchanged ?? 0;
  const extra = {
    ...(status === "review" && (counts.flagged ?? 0) > 0
      ? { review: `${num(counts.flagged ?? 0)} ${countWord(counts.flagged ?? 0, "needs", "need")} your review` }
      : {}),
    ...(clean > 0 ? { unchanged: `${num(clean)} already clean — no change needed` } : {}),
  };
  if (status === "review") {
    return {
      heading: clean > 0 && clean === ok ? "Your images are already clean" : "Your images are ready",
      done: `${num(ok)} successfully processed`,
      ...extra,
      attention,
      link: { label: "Review results", tab: "review" },
    };
  }
  if (!ok && !failed) return null;
  if (!ok) {
    return {
      heading: failed === 1 ? "This image couldn't be processed" : "These images couldn't be processed",
      done: null,
      attention,
      link: { label: "See why", tab: "failed" },
    };
  }
  const applied = appliedCount(counts);
  if (applied) {
    return {
      heading: "Your store is updated",
      done: `${plural(applied, "image")} updated in your store`,
      ...extra,
      attention,
      link: { label: "View updated images", tab: "applied" },
    };
  }
  if (clean > 0 && clean === ok) {
    return { heading: "Your images are already clean", done: null, ...extra, attention, link: null };
  }
  return { heading: "Job finished", done: `${num(ok)} successfully processed, none applied`, ...extra, attention, link: null };
}

/** Heading, counts word and reassurance for a running phase (job page, Home). */
export function phaseCopy(status: "processing" | "applying"): { heading: string; doneWord: string; leave: string } {
  return status === "applying"
    ? {
        heading: "Updating images in your store",
        doneWord: "updated",
        leave: "You can safely leave this page. We'll notify you when your store is updated.",
      }
    : {
        heading: "Cleaning your product images",
        doneWord: "processed",
        leave: "You can safely leave this page. We'll notify you when your images are ready.",
      };
}

/** The start of APPLY_STOPPED_NOTICE (app/lib/jobs.server.ts, which the browser can't import). */
export const APPLY_STOPPED_PREFIX = "Applying stopped";

/**
 * The starts of startJob's JobStateError messages (app/lib/jobs.server.ts), which an auto-start
 * that couldn't run stores on the job: "All of these images are already in another job that
 * hasn't finished. Start this one after it does." They explain why the job waits in
 * "estimated", and are out of date once it has started.
 */
export const START_BLOCKED_PREFIXES = ["All of these images are already in another job", "Select at least one image"] as const;

/**
 * The notices (Job.error lines, app/lib/progress.ts) the job page shows as banners: images
 * skipped because another job has them, a capped selection, an auto-start that couldn't run.
 * Left out: a failed job's error (its failure reason, shown on its own), a selection that
 * matched nothing (its own banner), the credits notice (the estimate's "Not enough credits"
 * banner says it with live numbers, and hides once credits are bought), why an auto-start
 * couldn't start once the job has started, and "Applying stopped" once no approved image is
 * waiting any more (the next apply round finished).
 */
export function visibleJobNotices(status: JobStatus, error: string | null | undefined, counts: StatusCounts): string[] {
  if (status === "failed") return [];
  if (status === "done" && !Object.values(counts).some((n) => (n ?? 0) > 0)) return [];
  return jobNotices(error).filter((line) => {
    if (line.startsWith(CREDITS_NOTICE_PREFIX)) return false;
    if (START_BLOCKED_PREFIXES.some((p) => line.startsWith(p))) return status === "estimated";
    if (line.startsWith(APPLY_STOPPED_PREFIX)) return status === "review" && (counts.approved ?? 0) > 0;
    return true;
  });
}

/**
 * The toast after "Retry failed" (retryFailed's result). Images that failed while applying
 * already have their result, so they go back to approved instead of through processing:
 * `reapproved` of the `retried` images. When nothing needs processing the job stays in (or
 * reopens to) review, and nothing runs until the merchant applies again, so the message says
 * that instead of "Retrying".
 */
export function retryMessage(retried: number, reapproved: number, status: JobStatus): string {
  const again = Math.max(0, Math.min(reapproved, retried));
  const them = (n: number) => (n === 1 ? "it" : "them");
  if (status === "review") {
    return `${plural(retried, "image")} ${retried === 1 ? "is" : "are"} approved again. Apply ${them(retried)} to update your store`;
  }
  if (status === "processing" && again > 0 && again < retried) {
    return `Retrying ${plural(retried - again, "image")}. ${plural(again, "image")} ${
      again === 1 ? "is" : "are"
    } approved again: apply ${them(again)} once processing finishes`;
  }
  return `Retrying ${plural(retried, "image")}`;
}

/**
 * The Images column of the jobs list: "67 / 100 · 3 failed" while a phase runs (scoped to
 * the phase), "97 ready · 3 need attention" once finished, the image count otherwise.
 */
export function jobImagesSummary(status: JobStatus, p: JobProgress, counts: StatusCounts): string {
  switch (status) {
    case "processing":
    case "applying":
      return `${num(p.completed)} / ${num(p.total)}${p.failed ? ` · ${num(p.failed)} failed` : ""}`;
    case "review":
    case "done":
      return finishedSummary(counts, status);
    default:
      return p.total ? num(p.total) : "—";
  }
}

/** The Job fields a list row needs. The raw filter stays on the server. */
export type JobListSource = Pick<
  Job,
  "id" | "status" | "filter" | "createdAt" | "autoStart" | "error" | "phaseTotal" | "phaseFailedBase" | "phaseStartedAt"
>;

/** Prisma `select` for JobListSource (Home, Jobs). */
export const JOB_LIST_FIELDS = {
  id: true,
  status: true,
  filter: true,
  createdAt: true,
  autoStart: true,
  error: true,
  phaseTotal: true,
  phaseFailedBase: true,
  phaseStartedAt: true,
} as const satisfies Record<keyof JobListSource, true>;

/**
 * Which images of each product a job covers, for the line under its name: null when the name
 * already says it ("30 selected images").
 */
export function imageScopeLabel(filter: Pick<ClientJobFilter, "imageScope" | "mediaCount">): string | null {
  if (filter.mediaCount) return null;
  return filter.imageScope === "all" ? "All images" : "First image of each product";
}

/** One row of the jobs list (Home, Jobs): display strings only, safe to send to the browser. */
export interface JobRow {
  id: string;
  /** jobHeading, e.g. "Collection “Shoes”" or "12 selected products". */
  name: string;
  /** imageScopeLabel, e.g. "First image of each product". */
  scope: string | null;
  /** describeFilter, e.g. "collection “Shoes” · first image". */
  selection: string;
  createdAt: string | Date;
  /** jobDisplayStatus, e.g. "Ready for review" (it says so itself: no second badge). */
  badge: StatusBadge;
  images: string;
}

/** Build a list row from a job and its live item counts (itemCountsByJob). */
export function jobListRow(job: JobListSource, counts: StatusCounts): JobRow {
  const filter = filterForClient(job.filter);
  const p = jobProgress(job, counts);
  return {
    id: job.id,
    name: jobHeading(filter),
    scope: imageScopeLabel(filter),
    selection: describeFilter(filter),
    createdAt: job.createdAt,
    badge: jobDisplayStatus(job.status, counts, { needsCredits: needsAction(job) === "credits" }),
    images: jobImagesSummary(job.status, p, counts),
  };
}

/** Home's banner for a job that is processing or applying right now. */
export interface ActiveJobBanner {
  id: string;
  heading: string;
  /** jobHeading of the job. */
  name: string;
  /** progressSummary, e.g. "67 of 100 processed · 3 failed · 30 remaining". */
  summary: string;
}

export function activeJobBanner(job: JobListSource, counts: StatusCounts, now: number = Date.now()): ActiveJobBanner {
  const copy = phaseCopy(job.status === "applying" ? "applying" : "processing");
  const p = jobProgress(job, counts, now);
  return {
    id: job.id,
    heading: copy.heading,
    name: jobHeading(filterForClient(job.filter)),
    summary: progressSummary(p, copy.doneWord),
  };
}
