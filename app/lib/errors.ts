/**
 * An error retrying can't fix (deleted image, missing backup, bad input). `message` is written
 * for merchants; `code` is the machine-readable reason stored as JobItem.errorCode.
 */
export class PermanentError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = "PermanentError";
  }
}

/**
 * An error with separate wording for the merchant. `message` (logged) keeps the
 * technical detail; `merchantMessage` is what the job page shows.
 */
export class MerchantError extends Error {
  constructor(
    message: string,
    readonly merchantMessage: string,
    readonly retryable = true,
    readonly code?: string,
  ) {
    super(message);
    this.name = "MerchantError";
  }
}

/** Decide whether a failed task should be retried. Unknown errors are assumed transient. */
export function isRetryable(error: unknown): boolean {
  if (error instanceof PermanentError) return false;
  const flag = (error as { retryable?: unknown } | null)?.retryable;
  if (typeof flag === "boolean") return flag;
  return true;
}

export function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 1000);
}
