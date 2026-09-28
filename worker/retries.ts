import { isRetryable } from "../app/lib/errors";
import { GpuServiceError } from "../app/lib/gpu.server";

/**
 * Attempts at most for image-service errors where trying the same image again rarely helps,
 * below ITEM_TASK_ATTEMPTS:
 * - timeout: the call ran past GPU_TIMEOUT_MS. A started run isn't cancelled when the worker
 *   gives up, so each attempt holds the image service's slot for up to GPU_TIMEOUT_MS (8 min in
 *   docker-compose.vps.yml, where MAX_CONCURRENCY is 1) for every shop.
 * - out_of_memory: the same bytes run out of memory again.
 */
export const GPU_CODE_MAX_ATTEMPTS: Readonly<Record<string, number>> = { timeout: 2, out_of_memory: 2 };

/** No more retries after this (1-based) attempt: the failure is recorded on the image. */
export function isFinalAttempt(error: unknown, attempt: number, maxAttempts: number): boolean {
  if (!isRetryable(error) || attempt >= maxAttempts) return true;
  const cap = error instanceof GpuServiceError && error.code ? GPU_CODE_MAX_ATTEMPTS[error.code] : undefined;
  return cap !== undefined && attempt >= cap;
}

/** BullMQ's exponential backoff after attempt `attempt` fails: base × 2^(attempt − 1). */
export function retryDelayMs(attempt: number, baseMs: number): number {
  return Math.round(2 ** Math.max(0, attempt - 1) * baseMs);
}

/** The backoff base of a task (its own option, else the queue default from the environment). */
export function backoffBaseMs(backoff: unknown, fallbackMs: number): number {
  if (typeof backoff === "number" && Number.isFinite(backoff)) return backoff;
  const delay = (backoff as { delay?: unknown } | null | undefined)?.delay;
  return typeof delay === "number" && Number.isFinite(delay) ? delay : fallbackMs;
}
