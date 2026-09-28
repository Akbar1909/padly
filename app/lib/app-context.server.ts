import { createHmac, timingSafeEqual } from "node:crypto";
import { authenticate } from "../shopify.server";
import { env } from "./env.server";
import { loadOfflineSession, tokenExpiresSoon, withTokenLock } from "./shopify/client.server";
import { getShopByDomain, recordInstall } from "./shops.server";

/** authenticate.admin plus our Shop row. Use in every /app loader and action. */
export async function requireShop(request: Request) {
  const ctx = await authenticateAdmin(request);
  let shop = await getShopByDomain(ctx.session.shop);
  // A valid session token proves the app is installed. If our row says
  // otherwise (a late app/uninstalled, or shop/redact while installed), the
  // merchant is back: never let maintenance purge them.
  if (shop.uninstalledAt || shop.redactRequestedAt) {
    shop = await recordInstall(ctx.session.shop);
  }
  return { ...ctx, shop };
}

/**
 * authenticate.admin renews the offline token (token exchange) when it's
 * about to expire, possibly while a worker is refreshing the same token.
 * In that window, take the per-shop token lock first; the library then
 * re-reads the session and skips the exchange if the worker already renewed it.
 */
async function authenticateAdmin(request: Request) {
  const shop = shopFromSessionToken(request);
  if (shop && tokenExpiresSoon(await loadOfflineSession(shop))) {
    return withTokenLock(shop, () => authenticate.admin(request));
  }
  return authenticate.admin(request);
}

/** The shop named by the request's session token, if the token carries our signature. */
export function shopFromSessionToken(
  request: Request,
  secret = env().SHOPIFY_API_SECRET,
): string | null {
  const token =
    request.headers.get("authorization")?.replace(/^Bearer /, "") ||
    new URL(request.url).searchParams.get("id_token");
  if (!token || !secret) return null;
  const [header, payload, signature] = token.split(".");
  if (!header || !payload || !signature) return null;
  const expected = createHmac("sha256", secret).update(`${header}.${payload}`).digest();
  const given = Buffer.from(signature, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const { dest } = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { dest?: unknown };
    return typeof dest === "string" ? new URL(dest).hostname : null;
  } catch {
    return null;
  }
}
