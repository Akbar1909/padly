import { createHmac } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher, type Dispatcher } from "undici";
import prisma from "../../app/db.server";
import { requireShop, shopFromSessionToken } from "../../app/lib/app-context.server";
import { redis, tryLock } from "../../app/lib/redis.server";
import {
  loadOfflineSession,
  ShopifyAuthError,
  ShopifyGraphqlError,
  shopifyClientFor,
} from "../../app/lib/shopify/client.server";
import { makeShop, resetState } from "./helpers";

const SHOP = "token-test.myshopify.com";
const GRAPHQL = "/admin/api/2026-07/graphql.json";
const TOKEN_URL = "/admin/oauth/access_token";
const json = { headers: { "content-type": "application/json" } };

let agent: MockAgent;
let previous: Dispatcher;

beforeAll(() => {
  previous = getGlobalDispatcher();
});
beforeEach(async () => {
  await resetState();
  agent = new MockAgent();
  agent.disableNetConnect();
  agent.enableNetConnect(/localhost|127\.0\.0\.1/);
  setGlobalDispatcher(agent);
});
afterEach(async () => {
  await agent.close();
  setGlobalDispatcher(previous);
});
afterAll(async () => {
  await redis().quit();
  await prisma.$disconnect();
});

const shopify = () => agent.get(`https://${SHOP}`);

async function storeSession(fields: {
  accessToken: string;
  expiresInMs?: number | null;
  refreshToken?: string | null;
  refreshExpiresInMs?: number;
}) {
  const data = {
    shop: SHOP,
    state: "",
    isOnline: false,
    scope: "write_products,write_files",
    accessToken: fields.accessToken,
    expires: fields.expiresInMs == null ? null : new Date(Date.now() + fields.expiresInMs),
    refreshToken: fields.refreshToken ?? null,
    refreshTokenExpires: fields.refreshToken ? new Date(Date.now() + (fields.refreshExpiresInMs ?? 30 * 86_400_000)) : null,
  };
  await prisma.session.upsert({ where: { id: `offline_${SHOP}` }, create: { id: `offline_${SHOP}`, ...data }, update: data });
}

/** GraphQL answers that record which token each request carried. */
interface Answer {
  status: number;
  body: object;
}

function graphqlReplies(answer: (token: string) => Answer) {
  const tokens: string[] = [];
  shopify()
    .intercept({ path: GRAPHQL, method: "POST" })
    .reply((opts) => {
      const token = String((opts.headers as Record<string, string>)["X-Shopify-Access-Token"]);
      tokens.push(token);
      const { status, body } = answer(token);
      return { statusCode: status, data: body, responseOptions: json };
    })
    .persist();
  return tokens;
}

function refreshReplies(answer: (refreshToken: string) => Answer) {
  const calls: string[] = [];
  shopify()
    .intercept({ path: TOKEN_URL, method: "POST" })
    .reply((opts) => {
      const body = JSON.parse(String(opts.body)) as { refresh_token: string; grant_type: string };
      expect(body.grant_type).toBe("refresh_token");
      calls.push(body.refresh_token);
      const { status, body: out } = answer(body.refresh_token);
      return { statusCode: status, data: out, responseOptions: json };
    })
    .persist();
  return calls;
}

const newTokens = { access_token: "shpat_new", scope: "write_products,write_files", expires_in: 3600, refresh_token: "shprt_new", refresh_token_expires_in: 7_776_000 };
const ok = { status: 200, body: { data: { shop: { id: "gid://shopify/Shop/1" } } } };
const QUERY = "query Probe { shop { id } }";

describe("offline token renewal", () => {
  it("renews an expiring token once, however many workers ask at the same moment", async () => {
    await makeShop(SHOP);
    await storeSession({ accessToken: "shpat_old", expiresInMs: 60_000, refreshToken: "shprt_old" });
    const refreshes = refreshReplies(() => ({ status: 200, body: newTokens }));
    const used = graphqlReplies(() => ok);

    const clients = await Promise.all(Array.from({ length: 5 }, () => shopifyClientFor(SHOP)));
    await Promise.all(clients.map((c) => c.request(QUERY, {}, { cost: 1 })));

    expect(refreshes).toEqual(["shprt_old"]);
    expect(used).toEqual(Array(5).fill("shpat_new"));
    const stored = await loadOfflineSession(SHOP);
    expect(stored).toMatchObject({ accessToken: "shpat_new", refreshToken: "shprt_new" });
    expect(stored!.expires!.getTime()).toBeGreaterThan(Date.now() + 50 * 60_000);
  });

  it("after a 401, picks up a token another process stored meanwhile", async () => {
    await makeShop(SHOP);
    await storeSession({ accessToken: "shpat_stale", expiresInMs: 30 * 60_000, refreshToken: "shprt_x" });
    const refreshes = refreshReplies(() => ({ status: 500, body: {} }));
    const client = await shopifyClientFor(SHOP);
    // The web app re-exchanged the token after the client was created.
    await storeSession({ accessToken: "shpat_fresh", expiresInMs: 60 * 60_000, refreshToken: "shprt_y" });
    const used = graphqlReplies((token) => (token === "shpat_fresh" ? ok : { status: 401, body: {} }));

    await client.request(QUERY, {}, { cost: 1 });
    expect(used).toEqual(["shpat_stale", "shpat_fresh"]);
    expect(refreshes).toEqual([]);
  });

  it("after a 401 with no newer token, refreshes once and retries", async () => {
    await makeShop(SHOP);
    await storeSession({ accessToken: "shpat_rejected", expiresInMs: 30 * 60_000, refreshToken: "shprt_ok" });
    const refreshes = refreshReplies(() => ({ status: 200, body: newTokens }));
    const used = graphqlReplies((token) => (token === "shpat_new" ? ok : { status: 401, body: {} }));

    const client = await shopifyClientFor(SHOP);
    await client.request(QUERY, {}, { cost: 1 });
    expect(used).toEqual(["shpat_rejected", "shpat_new"]);
    expect(refreshes).toEqual(["shprt_ok"]);
  });

  it("gives up with ShopifyAuthError when Shopify refuses the refresh token too", async () => {
    await makeShop(SHOP);
    await storeSession({ accessToken: "shpat_revoked", expiresInMs: 30 * 60_000, refreshToken: "shprt_revoked" });
    refreshReplies(() => ({ status: 400, body: { error: "invalid_grant" } }));
    graphqlReplies(() => ({ status: 401, body: {} }));

    const client = await shopifyClientFor(SHOP);
    const err = (await client.request(QUERY, {}, { cost: 1 }).catch((e) => e)) as ShopifyGraphqlError;
    expect(err).toBeInstanceOf(ShopifyAuthError);
    expect(err.retryable).toBe(false);
  });

  it("never mistakes our own bad API credentials or a Shopify outage for a revoked token", async () => {
    await makeShop(SHOP);
    await storeSession({ accessToken: "shpat_old", expiresInMs: 60_000, refreshToken: "shprt_old" });
    let answer: Answer = { status: 401, body: { error: "invalid_client" } };
    refreshReplies(() => answer);
    let err: ShopifyGraphqlError = await shopifyClientFor(SHOP).catch((e) => e);
    expect(err).toBeInstanceOf(ShopifyGraphqlError);
    expect(err).not.toBeInstanceOf(ShopifyAuthError);

    answer = { status: 503, body: {} };
    err = await shopifyClientFor(SHOP).catch((e) => e);
    expect(err).not.toBeInstanceOf(ShopifyAuthError);
    expect(err.retryable).toBe(true);
  });

  it("never mistakes a frozen or locked store, or our own bad request, for a revoked token", async () => {
    await makeShop(SHOP);
    await storeSession({ accessToken: "shpat_old", expiresInMs: 60_000, refreshToken: "shprt_old" });
    let answer: Answer = { status: 402, body: { errors: "Unavailable Shop" } };
    const refreshes = refreshReplies(() => answer);
    for (const next of [
      { status: 402, body: { errors: "Unavailable Shop" } },
      { status: 423, body: { errors: "Locked" } },
      { status: 400, body: { error: "unsupported_grant_type" } },
    ]) {
      answer = next;
      const err: ShopifyGraphqlError = await shopifyClientFor(SHOP).catch((e) => e);
      expect(err).toBeInstanceOf(ShopifyGraphqlError);
      expect(err).not.toBeInstanceOf(ShopifyAuthError);
      expect(err.retryable).toBe(false);
    }
    expect(refreshes).toHaveLength(3);

    // A clear refusal still is one, with or without an OAuth error code.
    for (const next of [
      { status: 400, body: { error: "invalid_request" } },
      { status: 401, body: { errors: "[API] Invalid API key or access token" } },
    ]) {
      answer = next;
      await expect(shopifyClientFor(SHOP)).rejects.toBeInstanceOf(ShopifyAuthError);
    }
  });

  it("has no client for a shop without an offline session", async () => {
    await expect(shopifyClientFor(SHOP)).rejects.toBeInstanceOf(ShopifyAuthError);
  });

  it("treats a cleared access token with nothing to refresh it as refused, not as a crash", async () => {
    await makeShop(SHOP);
    // What the library stores after Shopify answered 401 to a non-expiring token.
    await storeSession({ accessToken: "", expiresInMs: null, refreshToken: null });
    await expect(shopifyClientFor(SHOP)).rejects.toBeInstanceOf(ShopifyAuthError);
  });
});

// ── embedded requests ──────────────────────────────────────────────────────

function sessionToken(shop: string, secret = process.env.SHOPIFY_API_SECRET!) {
  const now = Math.floor(Date.now() / 1000);
  const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const head = enc({ alg: "HS256", typ: "JWT" });
  const body = enc({
    iss: `https://${shop}/admin`,
    dest: `https://${shop}`,
    aud: process.env.SHOPIFY_API_KEY,
    sub: "1",
    exp: now + 60,
    nbf: now - 5,
    iat: now - 5,
    jti: `jti-${Math.random()}`,
    sid: "sid",
  });
  const sig = createHmac("sha256", secret).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}

const appRequest = (token: string) =>
  new Request(`https://vio.example.com/app?shop=${SHOP}`, { headers: { Authorization: `Bearer ${token}` } });

describe("requireShop", () => {
  it("reads the shop from a session token only when the signature is ours", () => {
    expect(shopFromSessionToken(appRequest(sessionToken(SHOP)))).toBe(SHOP);
    expect(shopFromSessionToken(appRequest(sessionToken(SHOP, "someone-else")))).toBeNull();
    expect(shopFromSessionToken(new Request("https://vio.example.com/app"))).toBeNull();
  });

  it("treats a shop with a valid session as installed again (late uninstall webhook, redact while installed)", async () => {
    const shop = await makeShop(SHOP);
    await prisma.shop.update({
      where: { id: shop.id },
      data: { uninstalledAt: new Date(), redactRequestedAt: new Date() },
    });
    await storeSession({ accessToken: "shpat_live", expiresInMs: 50 * 60_000, refreshToken: "shprt_live" });

    const ctx = await requireShop(appRequest(sessionToken(SHOP)));
    expect(ctx.shop).toMatchObject({ id: shop.id, uninstalledAt: null, redactRequestedAt: null });
    expect(ctx.shop.installedAt.getTime()).toBeGreaterThan(shop.installedAt.getTime());
  });

  it("waits for a worker's token refresh instead of exchanging the token at the same time", async () => {
    await makeShop(SHOP);
    await storeSession({ accessToken: "shpat_expiring", expiresInMs: 2 * 60_000, refreshToken: "shprt_w" });
    // A worker holds the token lock and is mid-refresh. (No token endpoint is
    // mocked: an exchange from the web request would fail the test.)
    const release = await tryLock(`shopify:token:${SHOP}`, 5000);
    const started = Date.now();
    const pending = requireShop(appRequest(sessionToken(SHOP)));
    await new Promise((r) => setTimeout(r, 300));
    await storeSession({ accessToken: "shpat_refreshed", expiresInMs: 60 * 60_000, refreshToken: "shprt_w2" });
    await release!();

    const ctx = await pending;
    expect(Date.now() - started).toBeGreaterThanOrEqual(300);
    expect(ctx.session.accessToken).toBe("shpat_refreshed");
  });
});
