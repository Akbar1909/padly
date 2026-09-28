/**
 * In-app notification copy. Pure, so the UI, the server and the tests share it. The rows are
 * created by app/lib/notifications.server.ts.
 */

export type NotificationKind = "job_processed" | "job_applied" | "job_needs_credits";
export type NotificationTone = "success" | "warning" | "critical" | "info";

export interface NotificationCopy {
  kind: NotificationKind;
  tone: NotificationTone;
  title: string;
  /** Where "Review results" goes: the job page, or its Failed tab when nothing succeeded. */
  url: string;
}

const n = (x: number) => x.toLocaleString("en-US");
const images = (x: number) => `${n(x)} image${x === 1 ? "" : "s"}`;

export const jobUrl = (jobId: string, tab?: "failed") => `/app/jobs/${jobId}${tab ? `?tab=${tab}` : ""}`;

/** Processing finished: "100 product images are ready." / "97 images are ready. 3 need attention." */
export function processedCopy(jobId: string, ok: number, failed: number): NotificationCopy | null {
  if (ok + failed === 0) return null;
  if (failed === 0) {
    return {
      kind: "job_processed",
      tone: "success",
      title: ok === 1 ? "1 product image is ready." : `${n(ok)} product images are ready.`,
      url: jobUrl(jobId),
    };
  }
  if (ok === 0) {
    return {
      kind: "job_processed",
      tone: "critical",
      title: `${images(failed)} couldn't be processed.`,
      url: jobUrl(jobId, "failed"),
    };
  }
  return {
    kind: "job_processed",
    tone: "warning",
    title: `${images(ok)} ${ok === 1 ? "is" : "are"} ready. ${n(failed)} ${failed === 1 ? "needs" : "need"} attention.`,
    url: jobUrl(jobId),
  };
}

/** Applying finished: "12 images were updated in your store." */
export function appliedCopy(jobId: string, ok: number, failed: number): NotificationCopy | null {
  if (ok + failed === 0) return null;
  if (failed === 0) {
    return {
      kind: "job_applied",
      tone: "success",
      title: `${images(ok)} ${ok === 1 ? "was" : "were"} updated in your store.`,
      url: jobUrl(jobId),
    };
  }
  if (ok === 0) {
    return {
      kind: "job_applied",
      tone: "critical",
      title: `${images(failed)} couldn't be updated.`,
      url: jobUrl(jobId, "failed"),
    };
  }
  return {
    kind: "job_applied",
    tone: "warning",
    title: `${images(ok)} ${ok === 1 ? "was" : "were"} updated. ${n(failed)} couldn't be updated.`,
    url: jobUrl(jobId),
  };
}

/** An auto-started (API) job couldn't reserve its credits and waits in "estimated". */
export function needsCreditsCopy(jobId: string, count: number): NotificationCopy {
  return {
    kind: "job_needs_credits",
    tone: "warning",
    title: `Not enough credits to start processing ${images(count)}.`,
    url: jobUrl(jobId),
  };
}
