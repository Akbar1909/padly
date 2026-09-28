/** Shopify GraphQL types and errors with no runtime dependencies (safe to import anywhere, incl. tests). */

export class ShopifyGraphqlError extends Error {
  constructor(
    message: string,
    readonly details: unknown,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "ShopifyGraphqlError";
  }
}

/**
 * Shopify refused the shop's credentials: no offline session, a token it
 * answers 401/403 to, or a refresh token it won't exchange. Usually means the
 * app was uninstalled. Never retried.
 */
export class ShopifyAuthError extends ShopifyGraphqlError {
  constructor(message: string, details: unknown = null) {
    super(message, details, false);
    this.name = "ShopifyAuthError";
  }
}

export interface ShopifyClient {
  shop: string;
  /**
   * Run a query or mutation. `cost` is the expected query cost, used to pace
   * requests against the shop's bucket before sending.
   */
  request<T>(
    query: string,
    variables?: Record<string, unknown>,
    opts?: { cost?: number },
  ): Promise<T>;
}

/** Throw if a mutation payload returned userErrors. */
export function assertNoUserErrors(
  what: string,
  userErrors: Array<{ field?: string[] | null; message: string; code?: string | null }> | undefined | null,
): void {
  if (userErrors && userErrors.length) {
    const msg = userErrors
      .map((e) => (e.field?.length ? `${e.field.join(".")}: ` : "") + e.message)
      .join("; ");
    throw new ShopifyGraphqlError(`${what}: ${msg}`, userErrors, false);
  }
}
