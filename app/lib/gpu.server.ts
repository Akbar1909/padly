import { createHash, createHmac } from "node:crypto";
import { env } from "./env.server";
import { log } from "./log.server";

/** Types mirror docs/gpu-service-contract.md. */
export interface GpuSettings {
  aspect: "1:1" | "4:5";
  margin_pct: number;
  remove_bg: boolean;
  bg_color: string;
  upscale: boolean;
  upscale_threshold_px: number;
  target_px: number;
  output_format: "jpeg" | "png" | "webp";
  jpeg_quality: number;
  ai_metadata: boolean;
  /**
   * "Retry with stronger model": skip the local model and use the escalation (paid)
   * backend first for the cut-out; if it is unavailable the service falls back to local and says so
   * (reason_codes ESCALATION_UNAVAILABLE). Applies to the cut-out only: AI upscaling runs the same
   * Real-ESRGAN either way. Older services ignore it. Default false.
   */
  force_escalation?: boolean;
}

export interface GpuUpload {
  url: string;
  headers: Record<string, string>;
}

export interface GpuProcessRequest {
  request_id: string;
  source_url: string;
  source_mime_type?: string | null;
  uploads: { output: GpuUpload; preview: GpuUpload; before: GpuUpload; mask: GpuUpload };
  settings: GpuSettings;
}

export interface GpuFlag {
  code: string;
  severity: string;
  message: string;
}

/** How an image was made: methods, paid (Replicate) calls, estimated cost, quality. */
export interface GpuProcessingAttempt {
  operation: string; // "background_removal" | "upscale"
  method: string; // "local" | "local_zoom" | "local_refine" | "replicate" | "lanczos" | "source_alpha"
  model: string | null;
  duration_ms: number;
  cost_usd: number;
  outcome: string; // "used" | "rejected" | "failed"
  reason?: string | null;
  quality_score?: number | null;
}

/** What produced the kept result ("reused" is the worker's own: an earlier item's result was copied). */
export type ProcessingRoute = "no_change" | "deterministic" | "local" | "replicate" | "local_then_replicate" | "reused";
/** The image service's verdict on the local cut-out (null when no local AI step ran). */
export type LocalGate = "SAFE_LOCAL" | "UNCERTAIN" | "FAILED";
/** The verdict on the paid (escalation) result. */
export type AiGate = "PASS" | "UNSAFE";
/**
 * READY: every check confidently passed, no flags. NEEDS_REVIEW: a result exists but automatic
 * validation can't vouch for it (at least one flag says why). NO_CHANGE: the source already
 * satisfies the request; the output bytes are the unmodified source.
 */
export type GpuFinalStatus = "READY" | "NEEDS_REVIEW" | "NO_CHANGE";

export interface GpuQualityScores {
  segmentation_confidence: number | null;
  product_retention: number | null;
  geometry: number | null;
  artifact: number | null;
  fidelity: number | null;
}

/** What the service found before processing (docs/gpu-service-contract.md). */
export interface GpuAnalysis {
  already_acceptable: boolean;
  needs_resize: boolean;
  needs_centering: boolean;
  needs_background_removal: boolean;
  background_complexity: "clean" | "low" | "medium" | "high";
  product_coverage: number | null;
  product_touches_edge: boolean | null;
  has_transparency: boolean;
  recommended_route: "no_change" | "local" | "replicate";
  analysis_confidence: number;
}

/** LOCAL_PROCESSING_SHADOW: local ran and was judged, but the paid result was used. */
export interface GpuShadow {
  mode: "shadow";
  local_gate: LocalGate | null;
  local_would_have_been_used: boolean;
  iou_local_vs_final: number | null;
}

export interface GpuProcessing {
  operations: string[];
  method: string; // "deterministic" | "source_alpha" | "local" | "replicate" | "local+replicate"
  replicate_used: boolean;
  replicate_calls: number;
  replicate_models: string[];
  estimated_cost_usd: number;
  fallback_reason: string | null;
  quality_score: number | null;
  quality_checks: Record<string, number | boolean | null>;
  attempts: GpuProcessingAttempt[];
  // ── Additive fields (image service 2026-09-28 on). Absent from older services' records. ──
  route?: ProcessingRoute;
  local_attempted?: boolean;
  local_accepted?: boolean;
  gate?: LocalGate | null;
  ai_gate?: AiGate | null;
  /** Structured reasons (LOW_SEGMENTATION_CONFIDENCE, FORCED_BY_MERCHANT, SHADOW_MODE, …). */
  reason_codes?: string[];
  replicate_attempts?: number;
  quality_scores?: Partial<GpuQualityScores>;
  analysis?: Partial<GpuAnalysis>;
  shadow?: GpuShadow | null;
  final_status?: GpuFinalStatus;
}

export interface GpuProcessResponse {
  request_id: string;
  output: { width: number; height: number; bytes: number; format: string; content_type: string };
  source: { width: number; height: number; format: string; mode: string; icc_converted: boolean };
  upscale: { eligible: boolean; applied: boolean; method: string; scale: number; reason: string };
  flags: GpuFlag[];
  metrics: Record<string, number | boolean | null>;
  fidelity: number | null;
  models: Record<string, string | null>;
  timings_ms: Record<string, number>;
  /** Present from image service 2026-09-27 on. */
  processing?: GpuProcessing | null;
}

/**
 * Error codes about one image, not the service, even when the answer is a 5xx: the service
 * stays up and other images go through. `out_of_memory` is the service's 503 for an image that
 * ran out of memory (docs/gpu-service-contract.md); `timeout` is ours (the call took longer
 * than GPU_TIMEOUT_MS).
 */
export const IMAGE_SPECIFIC_GPU_CODES: ReadonlySet<string> = new Set(["out_of_memory", "timeout"]);

export class GpuServiceError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly code?: string,
    /** HTTP status of the service's answer; undefined when it never answered. */
    readonly status?: number,
  ) {
    super(message);
    this.name = "GpuServiceError";
  }

  /**
   * The service is down or overloaded, not just this image: unreachable, or a 503 without an
   * image-specific code (a proxy's or a starting service's 503). The worker then pauses new
   * processing claims for every shop, so one image's error must never count.
   */
  get serviceDown(): boolean {
    if (!this.retryable || (this.code && IMAGE_SPECIFIC_GPU_CODES.has(this.code))) return false;
    return this.status === undefined || this.status === 503;
  }
}

// ─── Pipeline fingerprint (for result reuse) ────────────────────────────────

/** What the image service says it runs (GET /healthz, docs/gpu-service-contract.md). */
export interface GpuPipeline {
  /** sha256 of the fields below: results made by another setup are never reused. */
  fingerprint: string;
  /** MODEL_BACKEND kind, e.g. "local". */
  backend: string;
  /** ESCALATION_BACKEND kind, e.g. "replicate"; null when none. */
  escalation: string | null;
  /** FALLBACK_BACKEND kind; null when none. */
  fallback: string | null;
}

interface HealthBody {
  backend?: unknown;
  device?: unknown;
  models_loaded?: unknown;
  text_detector?: unknown;
  fallback_backend?: unknown;
  escalation_backend?: unknown;
  /** Image-service code version + output-affecting config hash; changes stop result reuse. */
  pipeline_version?: unknown;
}

const str = (v: unknown) => (typeof v === "string" && v ? v : null);

/** Pure: the pipeline identity from a /healthz body, or null when it doesn't look like one. */
export function pipelineFromHealth(body: unknown): GpuPipeline | null {
  const h = (body ?? {}) as HealthBody;
  const backend = str(h.backend);
  if (!backend) return null;
  const identity = {
    backend,
    device: str(h.device),
    models: Array.isArray(h.models_loaded) ? h.models_loaded.map(String).sort() : [],
    text_detector: str(h.text_detector),
    escalation: str(h.escalation_backend),
    fallback: str(h.fallback_backend),
    pipeline_version: str(h.pipeline_version),
  };
  return {
    fingerprint: createHash("sha256").update(JSON.stringify(identity)).digest("hex").slice(0, 32),
    backend,
    escalation: identity.escalation,
    fallback: identity.fallback,
  };
}

/** Re-read this often, so a redeployed image service is noticed without restarting workers. */
const PIPELINE_TTL_MS = 60_000;
/** A failed read is tried again this soon (not once per image while the service is away). */
const PIPELINE_RETRY_MS = 10_000;
let pipelineCache: { at: number; value: GpuPipeline | null } | undefined;

/**
 * The image service's current pipeline, cached for a minute. Null when /healthz can't be read:
 * the caller then neither reuses nor records a result key (processing itself goes on).
 */
export async function gpuPipeline(now = Date.now()): Promise<GpuPipeline | null> {
  if (pipelineCache && now - pipelineCache.at < (pipelineCache.value ? PIPELINE_TTL_MS : PIPELINE_RETRY_MS)) {
    return pipelineCache.value;
  }
  let value: GpuPipeline | null = null;
  let problem: string | null = null;
  try {
    const res = await fetch(new URL("/healthz", env().GPU_SERVICE_URL), { signal: AbortSignal.timeout(5_000) });
    value = res.ok ? pipelineFromHealth(await res.json()) : null;
    if (!value) problem = res.ok ? "unexpected /healthz body" : `HTTP ${res.status}`;
  } catch (error) {
    problem = (error as Error).message;
  }
  if (problem) log.warn("image-service pipeline unknown; results are neither reused nor keyed", { problem });
  pipelineCache = { at: now, value };
  return value;
}

/** Tests: forget the cached pipeline. */
export function resetGpuPipelineCache(): void {
  pipelineCache = undefined;
}

/** `t=<unix>,v1=<hex hmac_sha256(secret, "<t>.<body>")>` */
export function signBody(secret: string, body: string, t = Math.floor(Date.now() / 1000)): string {
  const sig = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
  return `t=${t},v1=${sig}`;
}

/** `timeoutMs` overrides GPU_TIMEOUT_MS (the landing-page try-it waits less than the worker). */
export async function processImage(
  req: GpuProcessRequest,
  opts: { timeoutMs?: number } = {},
): Promise<GpuProcessResponse> {
  const e = env();
  const body = JSON.stringify(req);
  let res: Response;
  try {
    res = await fetch(new URL("/v1/process", e.GPU_SERVICE_URL), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Signature": signBody(e.GPU_SERVICE_SECRET, body),
      },
      body,
      signal: AbortSignal.timeout(opts.timeoutMs ?? e.GPU_TIMEOUT_MS),
    });
  } catch (error) {
    // Network errors, timeouts, cold starts that took too long.
    const timedOut = (error as Error).name === "TimeoutError";
    throw new GpuServiceError(
      `GPU service ${timedOut ? "timed out" : "unreachable"}: ${(error as Error).message}`,
      true,
      timedOut ? "timeout" : undefined,
    );
  }

  if (res.ok) return (await res.json()) as GpuProcessResponse;

  let code: string | undefined;
  let message = `GPU service returned HTTP ${res.status}`;
  try {
    const payload = (await res.json()) as { error?: { code?: string; message?: string } };
    code = payload.error?.code;
    if (payload.error?.message) message = payload.error.message;
  } catch {
    // non-JSON error body
  }
  // 4xx: the input is bad (or our signature is), retrying won't help. 5xx: transient.
  const retryable = res.status >= 500 || res.status === 429 || res.status === 408;
  throw new GpuServiceError(message, retryable, code, res.status);
}
