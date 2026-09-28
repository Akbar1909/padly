import { createAdminApiClient } from "@shopify/admin-api-client";
import { Session } from "@shopify/shopify-app-react-router/server";
import { apiVersion, sessionStorage } from "../../shopify.server";
import { env } from "../env.server";
import { redis, withLock } from "../redis.server";
import { ShopifyAuthError, ShopifyGraphqlError, type ShopifyClient } from "./graphql";
import {
  fromThrottleStatus,
  waitMsFor,
  type ThrottleState,
  type ThrottleStatus,
} from "./throttle";

export { assertNoUserErrors, ShopifyAuthError, ShopifyGraphqlError, type ShopifyClient } from "./graphql";

const MAX_ATTEMPTS = 6;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const throttleKey = (shop: string) => `shopify:throttle:${shop}`;

async function loadThrottle(shop: string): Promise<ThrottleState | null> {
  const raw = await redis().hgetall(throttleKey(shop));
  if (!raw.max) return null;
  return {
    available: Number(raw.available),
    max: Number(raw.max),
    rate: Number(raw.rate),
    ts: Number(raw.ts),
  };
}

async function saveThrottle(shop: string, state: ThrottleState): Promise<void> {
  await redis()
    .multi()
    .hset(throttleKey(shop), {
      available: state.available,
      max: state.max,
      rate: state.rate,
      ts: state.ts,
    })
    .expire(throttleKey(shop), 600)
    .exec();
}

export interface ShopifyClientOptions {
  /**
   * Called once per request when Shopify answers 401. Returns a working token
   * (someone refreshed it meanwhile, or a refresh succeeded) or null if there
   * is none.
   */
  onUnauthorized?: (failedToken: string) => Promise<string | null>;
}

/**
 * Admin GraphQL client for background work. Shares throttle state per shop in
 * Redis so every worker process paces against the same bucket.
 */
export function createShopifyClient(
  shop: string,
  accessToken: string,
  options: ShopifyClientOptions = {},
): ShopifyClient {
  const connect = (token: string) =>
    createAdminApiClient({
      storeDomain: shop,
      apiVersion,
      accessToken: token,
      retries: 2, // network errors / 429 / 503 at the HTTP layer
    });
  let token = accessToken;
  let client = connect(token);

  return {
    shop,
    async request<T>(
      query: string,
      variables?: Record<string, unknown>,
      opts: { cost?: number } = {},
    ): Promise<T> {
      const cost = opts.cost ?? 10;
      let lastError: unknown;
      let recovered = false;

      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        const state = await loadThrottle(shop);
        const wait = waitMsFor(state, cost, Date.now());
        if (wait > 0) await sleep(wait);
        if (state) {
          // Reserve our share so concurrent workers don't all see the same balance.
          await redis().hincrbyfloat(throttleKey(shop), "available", -cost);
        }

        const res = await client.request<T>(query, { variables });
        const throttle = (
          res.extensions as { cost?: { throttleStatus?: ThrottleStatus } }
        )?.cost?.throttleStatus;
        if (throttle) {
          await saveThrottle(shop, fromThrottleStatus(throttle, Date.now()));
        }

        if (!res.errors) return res.data as T;

        const gqlErrors = res.errors.graphQLErrors ?? [];
        const throttled = gqlErrors.some(
          (e) => (e.extensions as { code?: string })?.code === "THROTTLED",
        );
        const status = res.errors.networkStatusCode ?? 0;
        lastError = res.errors;

        if (throttled) {
          const current = throttle
            ? fromThrottleStatus(throttle, Date.now())
            : null;
          await sleep(Math.max(1000, waitMsFor(current, cost, Date.now())));
          continue;
        }
        if (status === 401 && !recovered && options.onUnauthorized) {
          // The token may have been refreshed or re-exchanged by another
          // process since we loaded it. Try once more with a working one.
          recovered = true;
          const next = await options.onUnauthorized(token);
          if (next) {
            token = next;
            client = connect(next);
            continue;
          }
        }
        if (status === 401 || status === 403) {
          throw new ShopifyAuthError(`Shopify refused the access token (HTTP ${status})`, res.errors);
        }
        if (status === 429 || status >= 500 || status === 0) {
          await sleep(1000 * 2 ** attempt);
          continue;
        }
        const message =
          gqlErrors.map((e) => e.message).join("; ") ||
          res.errors.message ||
          `Shopify GraphQL request failed (${status})`;
        // 404 and query errors won't fix themselves.
        throw new ShopifyGraphqlError(message, res.errors, false);
      }

      throw new ShopifyGraphqlError(
        "Shopify GraphQL request kept failing after retries",
        lastError,
        true,
      );
    },
  };
}

// ─── Offline tokens ─────────────────────────────────────────────────────────
//
// Expiring offline tokens last an hour and each refresh replaces the refresh
// token. The web app (token exchange in authenticate.admin) and every worker
// may renew the same shop's token at the same moment, and the loser ends up
// holding a dead token. All renewals take one Redis lock per shop and re-read
// the stored session once they hold it, so only one of them talks to Shopify.

/** Renew a little earlier than the library (5 min) so its own check never fires outside the lock. */
export const TOKEN_REFRESH_MARGIN_MS = 6 * 60_000;
const TOKEN_LOCK_TTL_MS = 15_000;
const REFRESH_TIMEOUT_MS = 10_000;

export const offlineSessionId = (shop: string) => `offline_${shop}`;

export function loadOfflineSession(shop: string): Promise<Session | undefined> {
  return sessionStorage.loadSession(offlineSessionId(shop));
}

/** Run token work for one shop, one process at a time (waiting up to ~15 s for the holder). */
export function withTokenLock<T>(shop: string, fn: () => Promise<T>): Promise<T> {
  return withLock(`shopify:token:${shop}`, { ttlMs: TOKEN_LOCK_TTL_MS, waitMs: TOKEN_LOCK_TTL_MS + 1000 }, fn);
}

/** Whether the stored token should be renewed before use. */
export function tokenExpiresSoon(session: Session | undefined): boolean {
  return !session?.accessToken || session.isExpired(TOKEN_REFRESH_MARGIN_MS);
}

const canRefresh = (session: Session) =>
  Boolean(session.refreshToken) &&
  (!session.refreshTokenExpires || session.refreshTokenExpires.getTime() > Date.now());

/** Refresh answers that mean "this token is no longer valid" (OAuth 2.0 error codes). */
const REFUSED_STATUSES = new Set([400, 401, 403]);
const REFUSED_ERRORS = new Set(["invalid_grant", "invalid_token", "invalid_request"]);

/**
 * The library clears a session's access token after Shopify answers 401. With
 * no refresh token either there is nothing left to try: that is a refusal, not
 * a crash in the API client.
 */
function assertUsable(shop: string, session: Session): Session {
  if (!session.accessToken && !canRefresh(session)) {
    throw new ShopifyAuthError(`No usable access token for ${shop}`);
  }
  return session;
}

/**
 * Exchange the refresh token for a new access token and store it. Call with the
 * token lock held. Throws ShopifyAuthError when Shopify refuses the refresh token
 * (revoked on uninstall), a retryable error for network trouble and 5xx.
 */
async function refreshOfflineSession(session: Session): Promise<Session> {
  const e = env();
  let res: Response;
  try {
    res = await fetch(`https://${session.shop}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        client_id: e.SHOPIFY_API_KEY,
        client_secret: e.SHOPIFY_API_SECRET,
        grant_type: "refresh_token",
        refresh_token: session.refreshToken,
      }),
      signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
    });
  } catch (error) {
    throw new ShopifyGraphqlError(`Token refresh failed: ${(error as Error).message}`, error, true);
  }
  const body = (await res.json().catch(() => null)) as {
    access_token?: string;
    scope?: string;
    expires_in?: number;
    refresh_token?: string;
    refresh_token_expires_in?: number;
    error?: string;
  } | null;

  if (!res.ok || !body?.access_token) {
    const detail = `HTTP ${res.status}${body?.error ? `, ${body.error}` : ""}`;
    // Only a clear refusal of the token counts: it is what makes an idle shop
    // look uninstalled (and later erased). A frozen or locked store (402/423),
    // our own API key/secret being wrong (invalid_client) or any other answer
    // must never look like an uninstall.
    const refused =
      REFUSED_STATUSES.has(res.status) &&
      (typeof body?.error !== "string" || REFUSED_ERRORS.has(body.error));
    if (refused) throw new ShopifyAuthError(`Shopify refused the refresh token (${detail})`, body);
    throw new ShopifyGraphqlError(`Token refresh failed (${detail})`, body, res.status >= 500 || res.status === 429);
  }

  const inMs = (seconds: number) => new Date(Date.now() + seconds * 1000);
  const fresh = new Session({
    id: session.id,
    shop: session.shop,
    state: session.state ?? "",
    isOnline: false,
    accessToken: body.access_token,
    scope: body.scope ?? session.scope,
    expires: body.expires_in ? inMs(body.expires_in) : undefined,
    refreshToken: body.refresh_token ?? session.refreshToken,
    refreshTokenExpires: body.refresh_token_expires_in
      ? inMs(body.refresh_token_expires_in)
      : session.refreshTokenExpires,
  });
  await sessionStorage.storeSession(fresh);
  return fresh;
}

/** The shop's offline session with a usable token, renewed first if it's about to expire. */
export async function currentOfflineSession(shop: string): Promise<Session> {
  const stored = await loadOfflineSession(shop);
  if (!stored) throw new ShopifyAuthError(`No offline session for ${shop}`);
  if (!tokenExpiresSoon(stored) || !canRefresh(stored)) return assertUsable(shop, stored);

  return withTokenLock(shop, async () => {
    // Someone else may have renewed it while we waited for the lock.
    const session = await loadOfflineSession(shop);
    if (!session) throw new ShopifyAuthError(`No offline session for ${shop}`);
    if (!tokenExpiresSoon(session) || !canRefresh(session)) return assertUsable(shop, session);
    return refreshOfflineSession(session);
  });
}

/**
 * After a 401: return a token that differs from the failed one (renewed by
 * another process), else try one explicit refresh. Null when neither works.
 */
async function recoverAccessToken(shop: string, failedToken: string): Promise<string | null> {
  return withTokenLock(shop, async () => {
    const session = await loadOfflineSession(shop);
    if (!session?.accessToken) return null;
    if (session.accessToken !== failedToken) return session.accessToken;
    if (!canRefresh(session)) return null;
    try {
      return (await refreshOfflineSession(session)).accessToken ?? null;
    } catch (error) {
      if (error instanceof ShopifyAuthError) return null;
      throw error;
    }
  });
}

/** Client backed by the shop's offline session (renewed under the per-shop token lock). */
export async function shopifyClientFor(shop: string): Promise<ShopifyClient> {
  const session = await currentOfflineSession(shop);
  return createShopifyClient(shop, session.accessToken!, {
    onUnauthorized: (failed) => recoverAccessToken(shop, failed),
  });
}
