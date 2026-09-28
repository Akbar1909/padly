import type { GpuFlag, GpuProcessing } from "./gpu.server";

/**
 * Cost and quality monitoring for image processing. The image service reports how each image
 * was made (`processing`); the worker stores it on the JobItem with the total duration, logs
 * one line per image, and these helpers summarise it per job, for the ops report
 * (`npm run report:processing`) and for GET /internal/metrics. Pure: no server imports.
 */
export type ProcessingRecord = GpuProcessing & {
  duration_ms?: number;
  /** BullMQ attempt (1-based) that produced the result; attempt - 1 retries came before it. */
  attempt?: number;
  /** Set when method is "reused": the item whose identical result was copied. */
  reused_from?: string;
  /**
   * Earlier runs of this item that "Retry with stronger model" replaced, oldest first (their
   * cost was real, so the totals keep it). Compact: see supersededRun.
   */
  superseded_runs?: SupersededRun[];
};

/** What is kept of a run that "Retry with stronger model" replaced. */
export type SupersededRun = Pick<
  ProcessingRecord,
  | "method"
  | "route"
  | "final_status"
  | "gate"
  | "ai_gate"
  | "reason_codes"
  | "replicate_calls"
  | "replicate_attempts"
  | "estimated_cost_usd"
  | "duration_ms"
>;

// ─── Final status ───────────────────────────────────────────────────────────

/**
 * The automatic verdict on an image, as the API and the job page show it. READY: every check
 * confidently passed and nothing is flagged. NEEDS_REVIEW: a result exists but the checks can't
 * vouch for it (its flags say why). FAILED: no result could be made. NO_CHANGE: the photo
 * already met the preset, so there is nothing to apply.
 */
export type FinalStatus = "READY" | "NEEDS_REVIEW" | "FAILED" | "NO_CHANGE";
export const FINAL_STATUSES: readonly FinalStatus[] = ["READY", "NEEDS_REVIEW", "FAILED", "NO_CHANGE"];

/** Item statuses processing ends in (besides failed). */
export type ResultStatus = "ready" | "flagged" | "unchanged";

/**
 * Added when the image service says NEEDS_REVIEW (or a final status this version doesn't know)
 * without a flag saying why: a flagged image always carries at least one flag, so the merchant
 * sees a reason and undoing a decision (decideItems "reset") puts it back to flagged.
 */
export const NEEDS_REVIEW_FLAG: GpuFlag = {
  code: "needs_review",
  severity: "warning",
  message: "Automatic checks couldn't confirm this result. Compare it with the original before approving.",
};

/**
 * Pure: the item status for a processed image, and the flags to store with it. The image
 * service's final_status decides: READY → ready (flagged anyway if it came with a flag: never
 * claim more than the flags allow), NEEDS_REVIEW → flagged, NO_CHANGE → unchanged (never
 * applied or charged). Without a final_status (an older service) the rule is what it always
 * was: flagged when anything is flagged, else ready. A final_status this version doesn't know
 * is treated as NEEDS_REVIEW.
 */
export function resultStatus(
  flags: GpuFlag[],
  processing: Pick<GpuProcessing, "final_status"> | null | undefined,
): { status: ResultStatus; flags: GpuFlag[] } {
  const final: unknown = processing?.final_status;
  if (final === undefined || final === null) return { status: flags.length ? "flagged" : "ready", flags };
  if (final === "NO_CHANGE") return { status: "unchanged", flags };
  if (final === "READY" && !flags.length) return { status: "ready", flags };
  if (final === "READY") return { status: "flagged", flags };
  // NEEDS_REVIEW, or a value this version doesn't know: if uncertain, the merchant looks.
  return { status: "flagged", flags: flags.length ? flags : [NEEDS_REVIEW_FLAG] };
}

/**
 * Pure: an item's FinalStatus, from its status, flags and processing record. Null while it has
 * no result (queued or processing, including a "Retry with stronger model" in progress). An
 * image that failed while applying (it has an output) keeps its processing verdict: the API's
 * status and errorCode say that applying failed.
 */
export function itemFinalStatus(item: {
  status: string;
  flags?: unknown;
  processing?: unknown;
  /** Pass it when known: a failed item with an output failed while applying. */
  outputKey?: string | null;
}): FinalStatus | null {
  if (item.status === "unchanged") return "NO_CHANGE";
  if (item.status === "queued" || item.status === "processing") return null;
  if (item.status === "failed" && !item.outputKey) return "FAILED";
  const p = item.processing as Partial<ProcessingRecord> | null | undefined;
  const final: unknown = p && typeof p === "object" ? p.final_status : undefined;
  if (final === "NO_CHANGE") return "NO_CHANGE";
  if (Array.isArray(item.flags) && item.flags.length > 0) return "NEEDS_REVIEW";
  if (final === undefined || final === null || final === "READY") return "READY";
  return "NEEDS_REVIEW";
}

// ─── Log fields ─────────────────────────────────────────────────────────────

/** Flat fields for a PROCESSING_SUCCESS / TRY_PROCESSING log line. */
export function processingLogFields(p: GpuProcessing | null | undefined, durationMs?: number) {
  if (!p) return { method: "unknown", duration_ms: durationMs };
  return {
    operations: p.operations.join(","),
    method: p.method,
    route: p.route ?? undefined,
    gate: p.gate ?? undefined,
    ai_gate: p.ai_gate ?? undefined,
    final_status: p.final_status ?? undefined,
    reason_codes: p.reason_codes?.length ? p.reason_codes : undefined,
    local_attempted: p.local_attempted ?? undefined,
    local_accepted: p.local_accepted ?? undefined,
    replicate_used: p.replicate_used,
    replicate_calls: p.replicate_calls,
    replicate_attempts: p.replicate_attempts ?? undefined,
    replicate_models: p.replicate_models.join(",") || undefined,
    estimated_usd: p.estimated_cost_usd,
    fallback_reason: p.fallback_reason ?? undefined,
    quality_score: p.quality_score,
    duration_ms: durationMs,
  };
}

/** The route/gate/final status/reason codes of a result, for IMAGE_JOB_COMPLETED. */
export function qualityLogFields(p: Partial<GpuProcessing> | null | undefined, finalStatus: FinalStatus | null) {
  return {
    route: p?.route ?? undefined,
    gate: p?.gate ?? undefined,
    ai_gate: p?.ai_gate ?? undefined,
    final_status: finalStatus ?? undefined,
    reason_codes: p?.reason_codes?.length ? p.reason_codes : undefined,
  };
}

// ─── Summaries ──────────────────────────────────────────────────────────────

/** REPLICATE_AVG_CUTOUT_USD's default: the average paid cut-out when none was observed. */
export const DEFAULT_REPLICATE_AVG_CUTOUT_USD = 0.0009;

export interface ShadowSummary {
  /** Images processed in shadow mode (local judged, paid result used). */
  count: number;
  /** Of those, how many the local result would have been kept for. */
  localWouldHaveBeenUsed: number;
  localWouldHaveBeenUsedRate: number | null;
  /** Mean overlap of the local cut-out with the one used, where measured. */
  meanIou: number | null;
}

export interface ProcessingSummary {
  images: number; // processed (with a processing record), reused ones included
  failed: number;
  byMethod: Record<string, number>;
  replicateImages: number; // images that made at least one Replicate call
  replicateShare: number; // replicateImages / images
  replicateCalls: number;
  /** Total estimated USD, runs replaced by "Retry with stronger model" included. */
  estimatedUsd: number;
  usdPerImage: number;
  avgDurationMs: number | null;
  avgQuality: number | null;
  fallbackReasons: Record<string, number>;
  /** Automatic retries (BullMQ attempts after the first) behind the processed images. */
  retries: number;

  // ── Cost dashboard (local-first pipeline) ──
  /** Images the image service looked at (a processing record that isn't a reused copy). */
  analyzed: number;
  /** Already met the preset: nothing to do (final status NO_CHANGE). */
  noChange: number;
  /** A local AI step ran. */
  localAttempted: number;
  /** The local result was kept and its gate said SAFE_LOCAL (route local). */
  localAccepted: number;
  /** A local AI step ran and its gate said UNCERTAIN or FAILED. */
  localRejected: number;
  /** The gate said SAFE_LOCAL, but the paid result was used (shadow mode, rollout, forced). */
  localSafeNotUsed: number;
  /** Images with at least one paid attempt. */
  sentToReplicate: number;
  /** Paid results that passed their gate (ai_gate PASS) / were judged unsafe (UNSAFE). */
  replicatePassed: number;
  replicateRejected: number;
  /** localAccepted / localAttempted. */
  localAcceptanceRate: number | null;
  /** sentToReplicate / analyzed. */
  replicateUsage: number | null;
  /** Estimated USD per image that used Replicate. */
  avgReplicateUsdPerImage: number | null;
  /** Average paid cut-out cost: observed in these records, else REPLICATE_AVG_CUTOUT_USD. */
  avgReplicateCutoutUsd: number;
  avgReplicateCutoutUsdSource: "observed" | "configured";
  /** (localAccepted + noChange) × avgReplicateCutoutUsd: an estimate, not a measurement. */
  spendAvoidedUsd: number;
  /** Each reason code counted once per image. */
  reasonCodes: Record<string, number>;
  topReasonCodes: Array<{ code: string; count: number }>;
  shadow: ShadowSummary;
  /** Every item with a verdict (failed ones without a record included). */
  finalStatuses: Record<FinalStatus, number>;
  byRoute: Record<string, number>;
  /** Results copied from an identical earlier one (no image-service call). */
  reused: number;
  /** Processed with "Retry with stronger model" (reason code FORCED_BY_MERCHANT). */
  forcedByMerchant: number;
  /** Earlier runs replaced by "Retry with stronger model" (their cost is in estimatedUsd). */
  supersededRuns: number;
}

export interface SummaryOptions {
  /** Average paid cut-out cost when no paid cut-out was observed (REPLICATE_AVG_CUTOUT_USD). */
  fallbackCutoutUsd?: number;
  /** How many reason codes topReasonCodes lists. */
  topReasons?: number;
}

export interface SummaryRow {
  status: string;
  processing: unknown;
  flags?: unknown;
  outputKey?: string | null;
}

const round = (n: number, d = 6) => Math.round(n * 10 ** d) / 10 ** d;
const rate = (n: number, of: number) => (of ? round(n / of, 4) : null);
const inc = (m: Record<string, number>, k: string, by = 1) => {
  m[k] = (m[k] ?? 0) + by;
};
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** What produced the kept result, for a record from before `route` existed. */
function legacyRoute(method: string): string {
  if (method === "deterministic" || method === "source_alpha") return "deterministic";
  if (method === "local+replicate") return "local_then_replicate";
  return method;
}

/** The dashboard's view of one record; records from older services are mapped from their method and attempts. */
function viewOf(p: ProcessingRecord) {
  const attempts = Array.isArray(p.attempts) ? p.attempts : [];
  const modern = typeof p.route === "string";
  const route = modern ? p.route! : p.method === "reused" ? "reused" : legacyRoute(p.method);
  const localAttempted = modern
    ? p.local_attempted === true
    : attempts.some((a) => a?.operation === "background_removal" && String(a.method ?? "").startsWith("local"));
  const gate = modern ? (p.gate ?? null) : null;
  const localAccepted = modern
    ? route === "local" && gate === "SAFE_LOCAL"
    : route === "local" && localAttempted && !p.fallback_reason && !num(p.replicate_calls);
  const localRejected = modern ? localAttempted && gate !== "SAFE_LOCAL" : localAttempted && !localAccepted;
  const replicateAttempts = Math.max(num(p.replicate_attempts), num(p.replicate_calls));
  return {
    route,
    localAttempted,
    localAccepted,
    localRejected,
    localSafeNotUsed: modern && localAttempted && gate === "SAFE_LOCAL" && !localAccepted,
    replicateAttempts,
    aiGate: p.ai_gate ?? null,
    reasonCodes: Array.isArray(p.reason_codes) ? p.reason_codes.filter((c): c is string => typeof c === "string") : [],
  };
}

/** Summarise stored processing records (JobItem.processing) of any set of items. */
export function summarizeProcessing(rows: SummaryRow[], opts: SummaryOptions = {}): ProcessingSummary {
  const s: ProcessingSummary = {
    images: 0,
    failed: 0,
    byMethod: {},
    replicateImages: 0,
    replicateShare: 0,
    replicateCalls: 0,
    estimatedUsd: 0,
    usdPerImage: 0,
    avgDurationMs: null,
    avgQuality: null,
    fallbackReasons: {},
    retries: 0,
    analyzed: 0,
    noChange: 0,
    localAttempted: 0,
    localAccepted: 0,
    localRejected: 0,
    localSafeNotUsed: 0,
    sentToReplicate: 0,
    replicatePassed: 0,
    replicateRejected: 0,
    localAcceptanceRate: null,
    replicateUsage: null,
    avgReplicateUsdPerImage: null,
    avgReplicateCutoutUsd: 0,
    avgReplicateCutoutUsdSource: "configured",
    spendAvoidedUsd: 0,
    reasonCodes: {},
    topReasonCodes: [],
    shadow: { count: 0, localWouldHaveBeenUsed: 0, localWouldHaveBeenUsedRate: null, meanIou: null },
    finalStatuses: { READY: 0, NEEDS_REVIEW: 0, FAILED: 0, NO_CHANGE: 0 },
    byRoute: {},
    reused: 0,
    forcedByMerchant: 0,
    supersededRuns: 0,
  };
  let durations = 0;
  let durationCount = 0;
  let quality = 0;
  let qualityCount = 0;
  let replicateUsd = 0;
  let cutoutUsd = 0;
  let cutoutCount = 0;
  let iou = 0;
  let iouCount = 0;
  for (const row of rows) {
    if (row.status === "failed") s.failed += 1;
    const final = itemFinalStatus(row);
    if (final) s.finalStatuses[final] += 1;
    const p = row.processing as ProcessingRecord | null;
    if (!p || typeof p !== "object" || typeof p.method !== "string") continue;
    s.images += 1;
    s.byMethod[p.method] = (s.byMethod[p.method] ?? 0) + 1;
    s.replicateCalls += num(p.replicate_calls);
    if (num(p.replicate_calls) > 0) s.replicateImages += 1;
    s.estimatedUsd += num(p.estimated_cost_usd);
    if (typeof p.attempt === "number" && p.attempt > 1) s.retries += p.attempt - 1;
    if (typeof p.duration_ms === "number") {
      durations += p.duration_ms;
      durationCount += 1;
    }
    if (typeof p.quality_score === "number") {
      quality += p.quality_score;
      qualityCount += 1;
    }
    // "background_artifacts; replicate_unavailable" → count each reason once per image
    for (const reason of new Set((p.fallback_reason ?? "").split(";").map((r) => r.trim()).filter(Boolean))) {
      s.fallbackReasons[reason] = (s.fallbackReasons[reason] ?? 0) + 1;
    }
    for (const run of Array.isArray(p.superseded_runs) ? p.superseded_runs : []) {
      s.supersededRuns += 1;
      s.estimatedUsd += num(run?.estimated_cost_usd);
      s.replicateCalls += num(run?.replicate_calls);
    }

    const v = viewOf(p);
    inc(s.byRoute, v.route);
    if (v.route === "reused") {
      s.reused += 1;
      continue; // no image-service call: not part of the pipeline funnel
    }
    s.analyzed += 1;
    if (p.final_status === "NO_CHANGE" || v.route === "no_change" || row.status === "unchanged") s.noChange += 1;
    if (v.localAttempted) s.localAttempted += 1;
    if (v.localAccepted) s.localAccepted += 1;
    if (v.localRejected) s.localRejected += 1;
    if (v.localSafeNotUsed) s.localSafeNotUsed += 1;
    if (v.replicateAttempts > 0) {
      s.sentToReplicate += 1;
      replicateUsd += num(p.estimated_cost_usd);
    }
    if (v.aiGate === "PASS") s.replicatePassed += 1;
    if (v.aiGate === "UNSAFE") s.replicateRejected += 1;
    for (const code of new Set(v.reasonCodes)) inc(s.reasonCodes, code);
    if (v.reasonCodes.includes("FORCED_BY_MERCHANT")) s.forcedByMerchant += 1;
    for (const a of Array.isArray(p.attempts) ? p.attempts : []) {
      if (a?.operation === "background_removal" && String(a.method ?? "").startsWith("replicate") && num(a.cost_usd) > 0) {
        cutoutUsd += num(a.cost_usd);
        cutoutCount += 1;
      }
    }
    if (p.shadow && typeof p.shadow === "object") {
      s.shadow.count += 1;
      if (p.shadow.local_would_have_been_used === true) s.shadow.localWouldHaveBeenUsed += 1;
      if (typeof p.shadow.iou_local_vs_final === "number" && Number.isFinite(p.shadow.iou_local_vs_final)) {
        iou += p.shadow.iou_local_vs_final;
        iouCount += 1;
      }
    }
  }
  s.estimatedUsd = round(s.estimatedUsd);
  s.usdPerImage = s.images ? round(s.estimatedUsd / s.images) : 0;
  s.replicateShare = s.images ? round(s.replicateImages / s.images, 4) : 0;
  s.avgDurationMs = durationCount ? Math.round(durations / durationCount) : null;
  s.avgQuality = qualityCount ? round(quality / qualityCount, 3) : null;
  s.localAcceptanceRate = rate(s.localAccepted, s.localAttempted);
  s.replicateUsage = rate(s.sentToReplicate, s.analyzed);
  s.avgReplicateUsdPerImage = s.sentToReplicate ? round(replicateUsd / s.sentToReplicate) : null;
  if (cutoutCount) {
    s.avgReplicateCutoutUsd = round(cutoutUsd / cutoutCount);
    s.avgReplicateCutoutUsdSource = "observed";
  } else {
    s.avgReplicateCutoutUsd = opts.fallbackCutoutUsd ?? DEFAULT_REPLICATE_AVG_CUTOUT_USD;
  }
  s.spendAvoidedUsd = round((s.localAccepted + s.noChange) * s.avgReplicateCutoutUsd);
  s.topReasonCodes = Object.entries(s.reasonCodes)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, opts.topReasons ?? 10)
    .map(([code, count]) => ({ code, count }));
  s.shadow.localWouldHaveBeenUsedRate = rate(s.shadow.localWouldHaveBeenUsed, s.shadow.count);
  s.shadow.meanIou = iouCount ? round(iou / iouCount, 4) : null;
  return s;
}

/** A compact copy of a record that "Retry with stronger model" is about to replace. */
export function supersededRun(p: Partial<ProcessingRecord>): SupersededRun {
  return {
    method: typeof p.method === "string" ? p.method : "unknown",
    route: p.route,
    final_status: p.final_status,
    gate: p.gate,
    ai_gate: p.ai_gate,
    reason_codes: p.reason_codes,
    replicate_calls: num(p.replicate_calls),
    replicate_attempts: p.replicate_attempts,
    estimated_cost_usd: num(p.estimated_cost_usd),
    duration_ms: p.duration_ms,
  };
}

/** Earlier runs to carry into a new record: the old record's own earlier runs, then the old record. */
export function carrySupersededRuns(previous: unknown): SupersededRun[] | undefined {
  const p = previous as Partial<ProcessingRecord> | null | undefined;
  if (!p || typeof p !== "object" || typeof p.method !== "string") return undefined;
  return [...(Array.isArray(p.superseded_runs) ? p.superseded_runs : []), supersededRun(p)].slice(-10);
}
