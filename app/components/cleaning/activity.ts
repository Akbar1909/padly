import type { ApiItem, ApiItemsPage } from "../../lib/api.server";

/**
 * The job page's cleaning strip: the images in flight (claimed for processing) and the last ones
 * that finished, from GET /api/image-jobs/:jobId/items (ACTIVITY_QUERY). Pure: used by the job
 * page's loader (first render), useLiveJob's poll and the strip.
 */

/** "Just cleaned" shows this many of the last finished images. */
export const RECENT_LIMIT = 6;

/**
 * The images processing has just finished, last changed first, plus the ones in flight. Only
 * the statuses processing produces (ready, flagged, unchanged, failed): "completed" would also take
 * approved, rejected and applied images, which a job back in processing after a retry has
 * (and bumps), and show them as just cleaned.
 */
export const ACTIVITY_QUERY = `status=ready,flagged,unchanged,failed&sort=recent&limit=${RECENT_LIMIT}&include=active`;

export const activityUrl = (jobId: string) => `/api/image-jobs/${encodeURIComponent(jobId)}/items?${ACTIVITY_QUERY}`;

/** One image in the strip: only what it shows. */
export interface CleaningItem {
  id: string;
  title: string;
  status: "processing" | "completed" | "failed";
  /** Flagged by the automatic checks: the merchant should look at it before approving. */
  flagged: boolean;
  /** The original, small (Shopify CDN). */
  thumbnailUrl: string | null;
  /** The cleaned preview (signed), once processed. */
  previewUrl: string | null;
}

export interface JobActivity {
  /** In flight: claimed for processing (being worked on, or next in line at the image service). */
  active: CleaningItem[];
  /** The last finished, newest first. */
  recent: CleaningItem[];
  /**
   * The latest change among the images it lists (their updatedAt, ISO; "" for none): tells an
   * older answer from a newer one. Not shown, so not part of activityKey.
   */
  asOf: string;
}

function toCleaningItem(item: ApiItem): CleaningItem {
  return {
    id: item.id,
    title: item.productTitle,
    status: item.status === "failed" ? "failed" : item.status === "processing" || item.status === "queued" ? "processing" : "completed",
    flagged: item.reviewStatus === "flagged" || (Array.isArray(item.flags) && item.flags.length > 0),
    thumbnailUrl: item.thumbnailUrl ?? null,
    previewUrl: item.outputImageUrl ?? null,
  };
}

/** The strip's view of an items page fetched with ACTIVITY_QUERY. */
export function toActivity(page: Pick<ApiItemsPage, "items" | "active">): JobActivity {
  const active = page.active ?? [];
  const recent = page.items.filter((i) => i.status === "completed" || i.status === "failed").slice(0, RECENT_LIMIT);
  const asOf = [...active, ...recent].reduce((max, i) => (typeof i.updatedAt === "string" && i.updatedAt > max ? i.updatedAt : max), "");
  return { active: active.map(toCleaningItem), recent: recent.map(toCleaningItem), asOf };
}

/**
 * True when `a` shows a later state of the job than `b` (or `b` is missing): a page reload
 * that started before a poll can land after it, with older images.
 */
export function isNewerActivity(a: JobActivity, b: JobActivity | null): boolean {
  return b === null || a.asOf > b.asOf;
}

/** A poll's answer for the strip, with the loader data that was on the page when it landed. */
export interface PolledActivity {
  jobId: string;
  base: JobActivity | null;
  data: JobActivity;
}

/**
 * What the strip shows: the last poll's answer until a page reload brings newer images. A
 * reload whose strip lookup failed (null) or that lands with older images than the poll (it
 * started first) doesn't replace it, so no tile unmounts and replays its reveal. Another
 * job's answer (the page moved to another job) is never used.
 */
export function chooseActivity(
  jobId: string,
  loaderActivity: JobActivity | null,
  polled: PolledActivity | null,
): JobActivity | null {
  if (!polled || polled.jobId !== jobId) return loaderActivity;
  return polled.base === loaderActivity || isNewerActivity(polled.data, loaderActivity) ? polled.data : loaderActivity;
}

/** Changes only when something the strip shows changed: an unchanged poll keeps the same object. */
export function activityKey(activity: JobActivity | null | undefined): string {
  if (!activity) return "";
  const row = (i: CleaningItem) => [i.id, i.status, i.flagged ? 1 : 0, i.thumbnailUrl ?? "", i.previewUrl ?? ""].join("\u0001");
  return [activity.active.map(row).join("\u0002"), activity.recent.map(row).join("\u0002")].join("\u0003");
}

/** A poll answer that looks like an items page (a proxy or an error page must not break the strip). */
export function isItemsPage(x: unknown): x is Pick<ApiItemsPage, "items" | "active"> {
  if (!x || typeof x !== "object") return false;
  const page = x as { items?: unknown; active?: unknown };
  return Array.isArray(page.items) && (page.active === undefined || Array.isArray(page.active));
}

/**
 * Cards keep their slot between polls, so only the slot of an image that finished changes: an
 * image still in flight stays at its index, a new one takes the first slot an image left (then
 * goes at the end), and a slot left with nothing to fill it stays empty (null) rather than
 * letting the cards after it close up. Trailing empty slots are dropped. `previous` is the last
 * result's ids (null for an empty slot).
 */
export function keepSlots<T extends { id: string }>(previous: readonly (string | null)[], next: readonly T[]): Array<T | null> {
  const byId = new Map(next.map((item) => [item.id, item] as const));
  const placed = new Set<string>();
  const slots: Array<T | null> = previous.map((id) => {
    const item = id === null || placed.has(id) ? undefined : byId.get(id);
    if (!item) return null;
    placed.add(item.id);
    return item;
  });
  let hole = 0;
  for (const item of next) {
    if (placed.has(item.id)) continue;
    placed.add(item.id);
    while (hole < slots.length && slots[hole] !== null) hole++;
    if (hole < slots.length) slots[hole] = item;
    else slots.push(item);
  }
  while (slots.length > 0 && slots[slots.length - 1] === null) slots.pop();
  return slots;
}
