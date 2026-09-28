import { JobItemStatus, type Job, type JobItem, type Prisma } from "@prisma/client";
import { z, ZodError } from "zod";
import prisma from "../db.server";
import { requireShop } from "./app-context.server";
import { getCreditSummary, InsufficientCreditsError } from "./credits.server";
import { env } from "./env.server";
import { describeFilter, filterForClient, JobFilterSchema, MAX_SELECTION_IDS, type JobFilter } from "./filters";
import { itemCounts, JobNotFoundError, JobStateError, selectionEstimate, waitingForEarlierJob } from "./jobs.server";
import { log } from "./log.server";
import { jobUrl } from "./notifications";
import { PresetSchema, toPresetSettings, type PresetSettings } from "./presets";
import { itemFinalStatus, type FinalStatus, type ProcessingRecord } from "./processing";
import {
  itemStatusFilter,
  jobProgress,
  needsAction,
  toApiItemStatus,
  toApiJobStatus,
  type ApiItemStatus,
  type ApiJobStatus,
  type NeedsAction,
} from "./progress";
import { getDefaultPreset } from "./shops.server";
import { presignGet } from "./storage.server";

/**
 * Building blocks for the JSON API under /api/image-jobs (resource routes). Everything is
 * scoped by shop, answers JSON with Cache-Control: no-store, and maps errors the same way:
 * validation 400, missing Authorization 401, InsufficientCreditsError 402 {needed, available},
 * not found 404, JobStateError 409.
 */

// ─── Responses and errors ───────────────────────────────────────────────────

export function apiJson(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store", ...headers } });
}

/** An error with its own HTTP status and JSON body. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** Map anything thrown in an API route to a JSON response (Responses pass through, made no-store). */
export function apiError(error: unknown): Response {
  if (error instanceof Response) return passThrough(error);
  if (error instanceof ApiError) return apiJson({ error: error.message, ...error.extra }, error.status);
  if (error instanceof ZodError) {
    return apiJson(
      {
        error: "Invalid request",
        issues: error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      },
      400,
    );
  }
  if (error instanceof JobNotFoundError) return apiJson({ error: "Job not found" }, 404);
  if (error instanceof InsufficientCreditsError) {
    return apiJson({ error: error.message, needed: error.needed, available: error.available }, 402);
  }
  if (error instanceof JobStateError) return apiJson({ error: error.message }, 409);
  log.error("api request failed", { error: error instanceof Error ? error.message : String(error) });
  return apiJson({ error: "Something went wrong. Please try again in a moment." }, 500);
}

const REAUTHORIZE_HEADER = "X-Shopify-API-Request-Failure-Reauthorize-Url";

/**
 * A Response thrown by the Shopify library (or by us), copied with Cache-Control: no-store.
 * Status and every header are kept: App Bridge's fetch reads X-Shopify-Retry-Invalid-Session-Request
 * (retry with a fresh session token) and the reauthorize URL header. The library's errors have
 * no body; those get a JSON one so every API error is JSON.
 */
function passThrough(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store");
  let body: BodyInit | null = response.body;
  if (body === null && response.status >= 400) {
    const error =
      response.status !== 401
        ? response.statusText || "Request failed."
        : headers.has(REAUTHORIZE_HEADER)
          ? "The app needs to be authorized again."
          : "Invalid or expired session token.";
    body = JSON.stringify({ error });
    headers.set("Content-Type", "application/json");
  }
  try {
    return new Response(body, { status: response.status, statusText: response.statusText, headers });
  } catch {
    // An unusable body (already read): answer the original rather than nothing.
    return response;
  }
}

/** 405 for a method a resource route doesn't serve (React Router's default is an HTML error). */
export function apiMethodNotAllowed(allow: "GET" | "POST"): Response {
  return apiJson({ error: `Method not allowed. Use ${allow}.` }, 405, { Allow: allow });
}

/** 404 body shared by every route (the same as a JobNotFoundError through apiError). */
export const jobNotFound = () => new ApiError(404, "Job not found");

/**
 * The shop behind an API request. Without an Authorization header, authenticate.admin would
 * answer with the embedded-app bounce page, so answer 401 JSON first. App Bridge adds the
 * session token to same-origin fetch from the embedded app.
 */
export async function requireApiShop(request: Request) {
  if (!request.headers.get("authorization")) {
    throw apiJson({ error: "Missing Authorization header (a Shopify session token)." }, 401);
  }
  return requireShop(request);
}

const MAX_BODY_BYTES = 1_000_000;

export async function readJsonBody(request: Request): Promise<unknown> {
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > MAX_BODY_BYTES) throw new ApiError(413, "Request body too large");
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) throw new ApiError(413, "Request body too large");
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError(400, "The request body must be JSON.");
  }
}

/** The required Idempotency-Key header of POST /api/image-jobs/bulk. */
export function idempotencyKeyFrom(request: Request): string {
  const key = request.headers.get("idempotency-key")?.trim();
  if (!key) throw new ApiError(400, "The Idempotency-Key header is required.");
  if (key.length > 200) throw new ApiError(400, "The Idempotency-Key header is at most 200 characters.");
  return key;
}

// ─── Bulk create ────────────────────────────────────────────────────────────

const idArray = z.array(z.union([z.string(), z.number()])).max(MAX_SELECTION_IDS);

export const BulkRequestSchema = z
  .object({
    /** Numeric product ids or Product gids. */
    productIds: idArray.min(1),
    /** MediaImage gids (or numeric ids) of those products: narrows the selection to exactly these images. */
    mediaIds: idArray.optional(),
    /** Alias of mediaIds (only valid together with productIds, which is required anyway). */
    imageIds: idArray.optional(),
    imageScope: z.enum(["first", "all"]).optional(),
    /** Overrides of the shop's default preset. */
    preset: PresetSchema.partial().strict().optional(),
    /** Start processing once reading finishes (reserves credits; never writes to Shopify). Default true. */
    autoStart: z.boolean().optional(),
  })
  .strict();

export interface BulkRequest {
  filter: JobFilter;
  preset: Partial<PresetSettings>;
  autoStart: boolean;
}

/** Validate a bulk body. Throws ZodError / ApiError (both 400 through apiError). */
export function parseBulkRequest(body: unknown, maxItems: number): BulkRequest {
  const b = BulkRequestSchema.parse(body);
  if (b.mediaIds && b.imageIds) throw new ApiError(400, "Send mediaIds or imageIds, not both.");
  const mediaIds = b.mediaIds ?? b.imageIds;
  if (b.productIds.length > maxItems) throw new ApiError(400, `At most ${maxItems} products per job.`);
  if (mediaIds && mediaIds.length > maxItems) throw new ApiError(400, `At most ${maxItems} images per job.`);
  const filter = JobFilterSchema.parse({ productIds: b.productIds, mediaIds, imageScope: b.imageScope ?? "first" });
  return { filter, preset: b.preset ?? {}, autoStart: b.autoStart ?? true };
}

/** The shop's default preset with the request's overrides, validated. */
export async function resolvePreset(shopId: string, overrides: Partial<PresetSettings>): Promise<PresetSettings> {
  const base = toPresetSettings((await getDefaultPreset(shopId)) as unknown as PresetSettings);
  return PresetSchema.parse({ ...base, ...overrides });
}

/**
 * Body of a 202 (new job) or 200 (replayed Idempotency-Key). Same body both times. `total` is
 * the number of images when known up front (named images; one per product for "first"), else
 * null until the products are read.
 */
export function bulkAcceptedBody(job: Pick<Job, "id" | "filter">) {
  const f = job.filter as Partial<JobFilter>;
  const total = f.mediaIds?.length ? f.mediaIds.length : f.imageScope !== "all" ? (f.productIds?.length ?? null) : null;
  return { jobId: job.id, status: "queued" as const, total };
}

// ─── Job ────────────────────────────────────────────────────────────────────

export interface ApiJob {
  id: string;
  /** Spec vocabulary: queued | processing | completed | completed_with_errors | failed | cancelled. */
  status: ApiJobStatus;
  /** Internal JobStatus (reading, estimated, processing, review, applying, done, failed, cancelled). */
  phase: Job["status"];
  total: number;
  completed: number;
  failed: number;
  processing: number;
  queued: number;
  remaining: number;
  progress: number;
  etaSeconds: number | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
  needsAction: NeedsAction;
  /** Failure reason (failed jobs) or notices for the merchant, one per line. */
  notice: string | null;
  /** Queued behind an older job of the shop (the pump serves the oldest job first). */
  waitingForEarlierJob: boolean;
  /** Human-readable selection, e.g. "12 selected products · first image". */
  selection: string;
  reviewUrl: string;
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

/** The job as the API (and the job page's poll) shows it; null when it isn't this shop's. */
export async function getApiJob(shopId: string, jobId: string): Promise<ApiJob | null> {
  const job = await prisma.job.findFirst({ where: { id: jobId, shopId } });
  if (!job) return null;
  const counts = await itemCounts(job.id);
  const p = jobProgress(job, counts);
  let credits: { needed: number; available: number } | null = null;
  if (job.status === "estimated") {
    const [estimate, summary] = await Promise.all([selectionEstimate(job.id), getCreditSummary(shopId)]);
    credits = { needed: estimate.cost, available: summary.available };
  }
  return {
    id: job.id,
    status: toApiJobStatus(job.status, counts),
    phase: job.status,
    total: p.total,
    completed: p.completed,
    failed: p.failed,
    processing: p.processing,
    queued: p.queued,
    remaining: p.remaining,
    progress: p.progress,
    etaSeconds: p.etaSeconds,
    createdAt: job.createdAt.toISOString(),
    startedAt: iso(job.phaseStartedAt ?? job.startedAt),
    completedAt: iso(job.completedAt),
    updatedAt: job.updatedAt.toISOString(),
    needsAction: needsAction(job, credits),
    notice: job.error,
    waitingForEarlierJob: await waitingForEarlierJob(job, counts),
    selection: describeFilter(filterForClient(job.filter)),
    reviewUrl: jobUrl(job.id),
  };
}

// ─── Items ──────────────────────────────────────────────────────────────────

export interface ApiItem {
  id: string;
  bulkJobId: string;
  productId: string;
  productTitle: string;
  mediaId: string;
  position: number;
  /** Spec vocabulary: queued | processing | completed | failed. "completed" = processed, not published. */
  status: ApiItemStatus;
  /** Internal JobItemStatus: ready, flagged, unchanged, approved, rejected, applying, applied, restored… */
  reviewStatus: JobItem["status"];
  /**
   * The automatic verdict: READY (every check passed, nothing flagged), NEEDS_REVIEW (a result
   * the checks can't vouch for; `flags` say why), FAILED (no result) or NO_CHANGE (already
   * clean: nothing to apply, never charged). Null while it is queued or processing.
   */
  finalStatus: FinalStatus | null;
  /** What produced the kept result: no_change, deterministic, local, replicate, local_then_replicate, reused. */
  route: string | null;
  /** Structured reasons from the image service (LOW_SEGMENTATION_CONFIDENCE, FORCED_BY_MERCHANT…). */
  reasonCodes: string[];
  /** "Retry with stronger model" was asked for this image: the paid model goes first. */
  strongerModel: boolean;
  /** Times the image was picked up (retries after a crash or a merchant retry count). */
  attemptCount: number;
  /** How it was processed: local, replicate, local+replicate, reused… (null before processing). */
  processingMethod: string | null;
  /** Machine-readable failure reason; apply failures start with "apply_". */
  errorCode: string | null;
  errorMessage: string | null;
  /** Public Shopify CDN URL of the image as read. */
  sourceImageUrl: string | null;
  /** The original at thumbnail size (Shopify CDN, 400 px wide); null when it isn't on Shopify's CDN. */
  thumbnailUrl: string | null;
  /** Signed preview URL of the result, always absolute (valid for at least an hour). */
  outputImageUrl: string | null;
  /** Flag codes the merchant should check (mask_low_confidence, text_detected…). */
  flags: string[];
  /** Time the image service spent on it (ms), when processed. */
  durationMs: number | null;
  updatedAt: string;
}

type ItemRow = Pick<
  JobItem,
  | "id"
  | "jobId"
  | "productId"
  | "productTitle"
  | "mediaId"
  | "position"
  | "status"
  | "attempts"
  | "processing"
  | "errorCode"
  | "error"
  | "outputKey"
  | "originalUrl"
  | "thumbnailUrl"
  | "previewKey"
  | "flags"
  | "updatedAt"
  | "forceEscalation"
>;

/**
 * A browser URL made absolute. With S3_BROWSER_PROXY, presignGet answers a path on the app's own
 * origin (/s3-proxy/…) that only same-origin callers can use; the API always gives a full URL.
 */
export function absoluteAppUrl(url: string, appUrl: string = env().SHOPIFY_APP_URL): string {
  if (!url.startsWith("/") || url.startsWith("//") || !appUrl) return url;
  try {
    return new URL(url, appUrl).toString();
  } catch {
    return url;
  }
}

/**
 * A Shopify CDN image URL at thumbnail size (the CDN resizes on ?width=). Null for anything
 * that isn't on cdn.shopify.com: other URLs (a signed one, say) may expire or not resize.
 */
export function shopifyThumbnail(url: string | null | undefined, width = 400): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" || u.hostname !== "cdn.shopify.com") return null;
    u.searchParams.set("width", String(width));
    return u.toString();
  } catch {
    return null;
  }
}

export async function toApiItem(item: ItemRow): Promise<ApiItem> {
  // A queued image may still carry the record of a run "Retry with stronger model" replaces.
  const pending = item.status === "queued" || item.status === "processing";
  const p = pending ? null : ((item.processing ?? null) as ProcessingRecord | null);
  const errorCode =
    item.errorCode ?? (item.status === "failed" ? (item.outputKey ? "apply_unknown" : "unknown") : null);
  return {
    id: item.id,
    bulkJobId: item.jobId,
    productId: item.productId,
    productTitle: item.productTitle,
    mediaId: item.mediaId,
    position: item.position,
    status: toApiItemStatus(item.status),
    reviewStatus: item.status,
    finalStatus: itemFinalStatus(item),
    route: typeof p?.route === "string" ? p.route : typeof p?.method === "string" && p.method === "reused" ? "reused" : null,
    reasonCodes: Array.isArray(p?.reason_codes) ? p.reason_codes.filter((c): c is string => typeof c === "string") : [],
    strongerModel: item.forceEscalation,
    attemptCount: item.attempts,
    processingMethod: typeof p?.method === "string" ? p.method : null,
    errorCode,
    errorMessage: item.error,
    sourceImageUrl: item.thumbnailUrl,
    thumbnailUrl: shopifyThumbnail(item.thumbnailUrl ?? item.originalUrl),
    outputImageUrl: item.previewKey ? absoluteAppUrl(await presignGet(item.previewKey)) : null,
    flags: Array.isArray(item.flags)
      ? item.flags.map((f) => (f as { code?: unknown } | null)?.code).filter((c): c is string => typeof c === "string")
      : [],
    durationMs: typeof p?.duration_ms === "number" ? p.duration_ms : null,
    updatedAt: item.updatedAt.toISOString(),
  };
}

export interface ApiItemsPage {
  items: ApiItem[];
  page: number;
  pages: number;
  total: number;
  limit: number;
  /**
   * With ?include=active only: the images in flight (oldest claim first, at most
   * API_ACTIVE_MAX), whatever the status filter and page. In flight means claimed for
   * processing: being worked on, or queued for the worker or the image service (a shop has up
   * to SHOP_CONCURRENCY claimed, and the image service may take fewer at once). An image
   * waiting out an automatic retry's backoff is still "processing" in `items` but isn't active.
   */
  active?: ApiItem[];
}

export const API_ITEMS_MAX_LIMIT = 100;
/** Most images ?include=active lists (a shop has SHOP_CONCURRENCY in flight, briefly twice that). */
export const API_ACTIVE_MAX = 12;
/** Most statuses one ?status= list can name. */
const MAX_STATUS_PARTS = 20;

const JOB_ITEM_STATUSES = new Set<string>(Object.values(JobItemStatus));

/**
 * itemStatusFilter, accepting only real status lists (defence in depth: ?status=toString,
 * __proto__ or constructor must be a 400, never reach Prisma).
 */
function statusesFor(value: string): JobItemStatus[] | null {
  const statuses: unknown = itemStatusFilter(value);
  if (!Array.isArray(statuses) || statuses.length === 0) return null;
  return statuses.every((s) => typeof s === "string" && JOB_ITEM_STATUSES.has(s)) ? (statuses as JobItemStatus[]) : null;
}

/** A ?status= value: one status or a comma-separated list of them (their union). ApiError 400 if any is unknown. */
function statusListFor(value: string): JobItemStatus[] {
  const parts = value.split(",").map((p) => p.trim());
  if (parts.length > MAX_STATUS_PARTS) throw new ApiError(400, `At most ${MAX_STATUS_PARTS} statuses per request.`);
  const out = new Set<JobItemStatus>();
  for (const part of parts) {
    const statuses = part ? statusesFor(part) : null;
    if (!statuses) throw new ApiError(400, `Unknown status "${(part || value).slice(0, 40)}".`);
    statuses.forEach((s) => out.add(s));
  }
  return [...out];
}

type ItemOrder = Prisma.JobItemOrderByWithRelationInput[];

/**
 * ?sort=: the default is by product (title, then image position); "recent" is last changed
 * first, served by the (jobId, updatedAt) index: a few rows read, whatever the job's size.
 */
const ITEM_ORDERS: Record<string, ItemOrder> = {
  product: [{ productTitle: "asc" }, { position: "asc" }, { id: "asc" }],
  recent: [{ updatedAt: "desc" }, { id: "desc" }],
};

function orderFor(value: string | null): ItemOrder {
  if (!value) return ITEM_ORDERS.product;
  if (!Object.hasOwn(ITEM_ORDERS, value)) throw new ApiError(400, `Unknown sort "${value.slice(0, 40)}". Use "recent".`);
  return ITEM_ORDERS[value];
}

/**
 * GET /api/image-jobs/:jobId/items?status=&sort=&include=&page=&limit=. status is a spec
 * status (queued, processing, completed, failed) or an internal one (ready, approved,
 * applied…), or a comma-separated list of them. sort=recent lists the last changed first
 * (a finished image changes when it finishes). include=active adds `active`, the images in
 * flight (claimed for processing). Null when the job isn't this shop's; ApiError 400 for a bad
 * status, sort or include.
 */
export async function listApiItems(shopId: string, jobId: string, params: URLSearchParams): Promise<ApiItemsPage | null> {
  const job = await prisma.job.findFirst({ where: { id: jobId, shopId }, select: { id: true } });
  if (!job) return null;
  const statusParam = params.get("status");
  const statuses = statusParam ? statusListFor(statusParam) : null;
  const orderBy = orderFor(params.get("sort"));
  const include = params.get("include");
  if (include && include !== "active") throw new ApiError(400, `Unknown include "${include.slice(0, 40)}". Use "active".`);
  const limit = Math.min(API_ITEMS_MAX_LIMIT, Math.max(1, Number.parseInt(params.get("limit") ?? "50", 10) || 50));
  const page = Math.max(1, Number.parseInt(params.get("page") ?? "1", 10) || 1);
  const where = { jobId, ...(statuses ? { status: { in: statuses } } : {}) };
  const now = new Date();
  const [total, rows, activeRows] = await Promise.all([
    prisma.jobItem.count({ where }),
    prisma.jobItem.findMany({ where, orderBy, skip: (page - 1) * limit, take: limit }),
    include
      ? prisma.jobItem.findMany({
          where: { jobId, status: "processing", OR: [{ retryAt: null }, { retryAt: { lte: now } }] },
          orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
          take: API_ACTIVE_MAX,
        })
      : Promise.resolve(null),
  ]);
  const [items, active] = await Promise.all([
    Promise.all(rows.map(toApiItem)),
    activeRows ? Promise.all(activeRows.map(toApiItem)) : Promise.resolve(null),
  ]);
  return {
    items,
    page,
    pages: Math.max(1, Math.ceil(total / limit)),
    total,
    limit,
    ...(active ? { active } : {}),
  };
}
