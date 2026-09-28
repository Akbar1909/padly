import { createHmac } from "node:crypto";
import type { ActionFunctionArgs } from "react-router";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher, type Dispatcher } from "undici";
import prisma from "../../app/db.server";
import { jobsQueue } from "../../app/lib/queue.server";
import { redis } from "../../app/lib/redis.server";
import { ShopifyAuthError } from "../../app/lib/shopify/client.server";
import { deletePrefix, headObject, keys, putObject } from "../../app/lib/storage.server";
import { action as purchaseUpdate } from "../../app/routes/webhooks.app_purchases_one_time.update";
import { action as scopesUpdate } from "../../app/routes/webhooks.app.scopes_update";
import { action as uninstalled } from "../../app/routes/webhooks.app.uninstalled";
import { action as bulkFinish } from "../../app/routes/webhooks.bulk_operations.finish";
import { action as compliance } from "../../app/routes/webhooks.compliance";
import { maintenance, purgeShop, verifyInstalled } from "../../worker/tasks/jobs";
import { makeJob, makeShop, resetState } from "./helpers";

type Action = (args: ActionFunctionArgs) => Promise<Response>;

function signed(topic: string, shop: string, payload: unknown, opts: { secret?: string; triggeredAt?: Date } = {}) {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  const hmac = createHmac("sha256", opts.secret ?? process.env.SHOPIFY_API_SECRET!).update(body).digest("base64");
  return new Request("https://vio.example.com/webhooks", {
    method: "POST",
    body,
    headers: {
      "Content-Type": "application/json",
      "Content-Length": String(Buffer.byteLength(body)),
      "X-Shopify-Hmac-Sha256": hmac,
      "X-Shopify-Topic": topic,
      "X-Shopify-Shop-Domain": shop,
      "X-Shopify-API-Version": "2026-07",
      "X-Shopify-Webhook-Id": `wh-${Math.random()}`,
      ...(opts.triggeredAt ? { "X-Shopify-Triggered-At": opts.triggeredAt.toISOString() } : {}),
    },
  });
}

/** Run a route action; thrown Responses (401/400/405) come back as the response. */
async function call(fn: Action, request: Request): Promise<number> {
  try {
    return (await fn({ request, params: {}, context: {} } as ActionFunctionArgs)).status;
  } catch (thrown) {
    if (thrown instanceof Response) return thrown.status;
    throw thrown;
  }
}

const SHOP = "hooks.myshopify.com";

beforeEach(resetState);
afterAll(async () => {
  await jobsQueue().obliterate({ force: true });
  await jobsQueue().close();
  await redis().quit();
  await prisma.$disconnect();
});

describe("webhook verification", () => {
  it("rejects bad signatures with 401 and malformed requests with 400/405, never 500", async () => {
    await makeShop(SHOP);
    expect(await call(uninstalled, signed("app/uninstalled", SHOP, {}, { secret: "wrong" }))).toBe(401);
    const noHmac = signed("app/uninstalled", SHOP, {});
    noHmac.headers.delete("X-Shopify-Hmac-Sha256");
    expect(await call(uninstalled, noHmac)).toBe(401);
    expect(await call(uninstalled, signed("app/uninstalled", SHOP, "not json{"))).toBe(400);
    expect(await call(scopesUpdate, signed("app/scopes_update", SHOP, { nope: true }))).toBe(200);
    const get = new Request("https://vio.example.com/webhooks", { method: "GET" });
    expect(await call(uninstalled, get)).toBe(405);
  });

  it("refuses bodies over 1 MB, declared or not, and still accepts an unsized body", async () => {
    await makeShop(SHOP);
    const huge = signed("app/uninstalled", SHOP, {});
    huge.headers.set("Content-Length", String(2 * 1024 * 1024));
    expect(await call(uninstalled, huge)).toBe(413);
    // No Content-Length (a proxy re-chunked it): counted while reading.
    const unsizedHuge = signed("app/uninstalled", SHOP, { pad: "x".repeat(2 * 1024 * 1024) });
    unsizedHuge.headers.delete("Content-Length");
    expect(await call(uninstalled, unsizedHuge)).toBe(413);
    const forged = signed("app/uninstalled", SHOP, {}, { secret: "wrong" });
    forged.headers.delete("Content-Length");
    expect(await call(uninstalled, forged)).toBe(401);
    expect((await prisma.shop.findUniqueOrThrow({ where: { domain: SHOP } })).uninstalledAt).toBeNull();

    const unsized = signed("app/uninstalled", SHOP, {});
    unsized.headers.delete("Content-Length");
    expect(await call(uninstalled, unsized)).toBe(200);
    expect((await prisma.shop.findUniqueOrThrow({ where: { domain: SHOP } })).uninstalledAt).not.toBeNull();
  });
});

describe("app/uninstalled", () => {
  it("works even when the offline token has expired (no refresh attempt)", async () => {
    const shop = await makeShop(SHOP);
    await prisma.session.create({
      data: {
        id: `offline_${SHOP}`,
        shop: SHOP,
        state: "",
        accessToken: "revoked",
        expires: new Date(Date.now() - 2 * 3600_000),
        refreshToken: "shprt_revoked",
      },
    });
    const { job } = await makeJob(shop.id, [{}], "processing");

    expect(await call(uninstalled, signed("app/uninstalled", SHOP, { id: 1 }))).toBe(200);

    const after = await prisma.shop.findUniqueOrThrow({ where: { id: shop.id } });
    expect(after.uninstalledAt).not.toBeNull();
    expect(await prisma.session.count({ where: { shop: SHOP } })).toBe(0);
    expect((await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("cancelled");

    // Replays keep the original uninstall time.
    await call(uninstalled, signed("app/uninstalled", SHOP, { id: 1 }));
    expect((await prisma.shop.findUniqueOrThrow({ where: { id: shop.id } })).uninstalledAt).toEqual(after.uninstalledAt);
  });

  it("ignores a retry of an uninstall that happened before the latest install", async () => {
    const shop = await makeShop(SHOP);
    await prisma.session.create({ data: { id: `offline_${SHOP}`, shop: SHOP, state: "", accessToken: "fresh" } });
    const { job } = await makeJob(shop.id, [{}]);
    const before = new Date(shop.installedAt.getTime() - 3600_000);

    expect(await call(uninstalled, signed("app/uninstalled", SHOP, {}, { triggeredAt: before }))).toBe(200);

    expect((await prisma.shop.findUniqueOrThrow({ where: { id: shop.id } })).uninstalledAt).toBeNull();
    expect(await prisma.session.count({ where: { shop: SHOP } })).toBe(1);
    expect((await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("estimated");
  });
});

describe("shop/redact", () => {
  it("erases an uninstalled shop's rows and stored images, and nobody else's", async () => {
    const shop = await makeShop(SHOP);
    const other = await makeShop("other.myshopify.com");
    await prisma.shop.update({ where: { id: shop.id }, data: { uninstalledAt: new Date() } });
    await makeJob(shop.id, [{}, {}], "done");
    const mine = `${keys.shopPrefix(shop.id)}backups/1/a.jpg`;
    const theirs = `${keys.shopPrefix(other.id)}backups/1/b.jpg`;
    await putObject(mine, Buffer.from("x"), "image/jpeg");
    await putObject(theirs, Buffer.from("y"), "image/jpeg");

    expect(await call(compliance, signed("shop/redact", SHOP, { shop_domain: SHOP }))).toBe(200);
    const tasks = await jobsQueue().getJobs(["waiting", "prioritized", "delayed"]);
    const purge = tasks.find((t) => t.data.name === "purge-shop");
    expect(purge?.data).toEqual({ name: "purge-shop", shopId: shop.id });

    await purgeShop(shop.id);
    expect(await prisma.shop.findUnique({ where: { id: shop.id } })).toBeNull();
    expect(await prisma.jobItem.count({ where: { shopId: shop.id } })).toBe(0);
    expect(await headObject(mine)).toBeNull();
    expect(await headObject(theirs)).not.toBeNull();
    await deletePrefix(keys.shopPrefix(other.id));
  });

  it("never purges a shop that is installed, and maintenance retries once it is uninstalled", async () => {
    const shop = await makeShop(SHOP);
    expect(await call(compliance, signed("shop/redact", SHOP, {}))).toBe(200);
    expect((await prisma.shop.findUniqueOrThrow({ where: { id: shop.id } })).redactRequestedAt).not.toBeNull();
    const queued = await jobsQueue().getJobs(["waiting", "prioritized"]);
    expect(queued.filter((t) => t.data.name === "purge-shop")).toHaveLength(0);
    // Instead, the worker asks Shopify whether the app is really still installed.
    expect(queued.map((t) => t.data)).toContainEqual({ name: "verify-uninstalled", shopId: shop.id, reason: "redact" });
    await jobsQueue().obliterate({ force: true });

    await purgeShop(shop.id); // run anyway: must refuse
    expect(await prisma.shop.findUnique({ where: { id: shop.id } })).not.toBeNull();

    await prisma.shop.update({ where: { id: shop.id }, data: { uninstalledAt: new Date() } });
    await maintenance();
    const purges = (await jobsQueue().getJobs(["waiting", "prioritized"])).filter((t) => t.data.name === "purge-shop");
    expect(purges.map((t) => t.data)).toEqual([{ name: "purge-shop", shopId: shop.id }]);
  });

  it("answers the customer topics without touching anything", async () => {
    await makeShop(SHOP);
    expect(await call(compliance, signed("customers/data_request", SHOP, { customer: { id: 1 } }))).toBe(200);
    expect(await call(compliance, signed("customers/redact", SHOP, { customer: { id: 1 } }))).toBe(200);
    expect(await prisma.shop.count({ where: { domain: SHOP } })).toBe(1);
  });
});

describe("missed app/uninstalled: asking Shopify", () => {
  let agent: MockAgent;
  let previous: Dispatcher;
  const json = { headers: { "content-type": "application/json" } };

  beforeEach(() => {
    previous = getGlobalDispatcher();
    agent = new MockAgent();
    agent.disableNetConnect();
    agent.enableNetConnect(/localhost|127\.0\.0\.1/);
    setGlobalDispatcher(agent);
  });
  afterEach(async () => {
    await agent.close();
    setGlobalDispatcher(previous);
  });

  const shopify = () => agent.get(`https://${SHOP}`);
  const graphql = (status: number) =>
    shopify()
      .intercept({ path: "/admin/api/2026-07/graphql.json", method: "POST" })
      .reply(status, status === 200 ? { data: { shop: { id: "gid://shopify/Shop/1" } } } : {}, json)
      .persist();
  const refresh = (status: number, body: object) =>
    shopify().intercept({ path: "/admin/oauth/access_token", method: "POST" }).reply(status, body, json).persist();

  async function session(fields: { accessToken: string; expires: Date | null; refreshToken?: string }) {
    await prisma.session.create({
      data: {
        id: `offline_${SHOP}`,
        shop: SHOP,
        state: "",
        accessToken: fields.accessToken,
        expires: fields.expires,
        refreshToken: fields.refreshToken ?? null,
        refreshTokenExpires: fields.refreshToken ? new Date(Date.now() + 60 * 86_400_000) : null,
      },
    });
  }

  it("shop/redact for a shop whose token Shopify refuses: marks it uninstalled and erases it", async () => {
    const shop = await makeShop(SHOP);
    await session({ accessToken: "shpat_revoked", expires: new Date(Date.now() + 30 * 60_000), refreshToken: "shprt_revoked" });
    const { job } = await makeJob(shop.id, [{}], "processing");
    const mine = `${keys.shopPrefix(shop.id)}backups/1/a.jpg`;
    await putObject(mine, Buffer.from("x"), "image/jpeg");
    graphql(401);
    refresh(400, { error: "invalid_grant" });

    expect(await call(compliance, signed("shop/redact", SHOP, { shop_domain: SHOP }))).toBe(200);
    const [task] = (await jobsQueue().getJobs(["waiting", "prioritized"])).filter((t) => t.data.name === "verify-uninstalled");
    expect(task.data).toEqual({ name: "verify-uninstalled", shopId: shop.id, reason: "redact" });
    expect((await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("processing");

    await verifyInstalled(shop.id, "redact");
    expect(await prisma.shop.findUnique({ where: { id: shop.id } })).toBeNull();
    expect(await prisma.session.count({ where: { shop: SHOP } })).toBe(0);
    expect(await headObject(mine)).toBeNull();
  });

  it("shop/redact with no session left: erases too", async () => {
    const shop = await makeShop(SHOP);
    await call(compliance, signed("shop/redact", SHOP, {}));
    await verifyInstalled(shop.id, "redact");
    expect(await prisma.shop.findUnique({ where: { id: shop.id } })).toBeNull();
  });

  it("shop/redact for a shop that is really installed: keeps everything and clears the request", async () => {
    const shop = await makeShop(SHOP);
    await session({ accessToken: "shpat_live", expires: new Date(Date.now() + 30 * 60_000), refreshToken: "shprt_live" });
    await makeJob(shop.id, [{}], "review");
    graphql(200);

    await call(compliance, signed("shop/redact", SHOP, {}));
    await verifyInstalled(shop.id, "redact");
    const after = await prisma.shop.findUniqueOrThrow({ where: { id: shop.id } });
    expect(after).toMatchObject({ uninstalledAt: null, redactRequestedAt: null });
    expect(await prisma.session.count({ where: { shop: SHOP } })).toBe(1);
    expect(await prisma.job.count({ where: { shopId: shop.id } })).toBe(1);
  });

  it("keeps the request and retries when Shopify can't be reached", async () => {
    const shop = await makeShop(SHOP);
    await session({ accessToken: "shpat_old", expires: new Date(Date.now() - 60_000), refreshToken: "shprt_ok" });
    refresh(503, {});
    await call(compliance, signed("shop/redact", SHOP, {}));

    const err = await verifyInstalled(shop.id, "redact").catch((e) => e);
    expect(err.retryable).toBe(true);
    const after = await prisma.shop.findUniqueOrThrow({ where: { id: shop.id } });
    expect(after.uninstalledAt).toBeNull();
    expect(after.redactRequestedAt).not.toBeNull();

    // Maintenance keeps queueing the check until it gets an answer.
    await jobsQueue().obliterate({ force: true });
    await maintenance();
    const checks = (await jobsQueue().getJobs(["waiting", "prioritized"])).filter((t) => t.data.name === "verify-uninstalled");
    expect(checks.map((t) => t.data)).toEqual([{ name: "verify-uninstalled", shopId: shop.id, reason: "redact" }]);
  });

  it("checks shops with no token activity for days, once per period, and marks refused ones uninstalled", async () => {
    const shop = await makeShop(SHOP);
    const active = await makeShop("active.myshopify.com");
    const longAgo = new Date(Date.now() - 10 * 86_400_000);
    await prisma.shop.updateMany({ where: { id: { in: [shop.id, active.id] } }, data: { installedAt: longAgo } });
    await session({ accessToken: "shpat_idle", expires: longAgo, refreshToken: "shprt_idle" });
    await prisma.session.create({
      data: { id: "offline_active.myshopify.com", shop: "active.myshopify.com", state: "", accessToken: "a", expires: new Date(Date.now() + 3600_000) },
    });

    await maintenance();
    const checks = (await jobsQueue().getJobs(["waiting", "prioritized"])).filter((t) => t.data.name === "verify-uninstalled");
    expect(checks.map((t) => t.data)).toEqual([{ name: "verify-uninstalled", shopId: shop.id, reason: "inactive" }]);

    // Not again within the period, even when the hourly sweep runs again.
    await jobsQueue().obliterate({ force: true });
    await redis().del("shops:inactive-sweep");
    await maintenance();
    expect((await jobsQueue().getJobs(["waiting", "prioritized"])).filter((t) => t.data.name === "verify-uninstalled")).toHaveLength(0);

    refresh(400, { error: "invalid_grant" });
    const { job } = await makeJob(shop.id, [{}], "estimated");
    await verifyInstalled(shop.id, "inactive");
    const after = await prisma.shop.findUniqueOrThrow({ where: { id: shop.id } }); // kept: erased by retention or redact
    expect(after.uninstalledAt).not.toBeNull();
    expect(await prisma.session.count({ where: { shop: SHOP } })).toBe(0);
    expect((await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("cancelled");
  });

  it("never marks an idle shop uninstalled just because our own refresh token lapsed", async () => {
    const shop = await makeShop(SHOP);
    await prisma.session.create({
      data: {
        id: `offline_${SHOP}`,
        shop: SHOP,
        state: "",
        accessToken: "shpat_idle",
        expires: new Date(Date.now() - 40 * 86_400_000),
        refreshToken: "shprt_lapsed",
        refreshTokenExpires: new Date(Date.now() - 86_400_000),
      },
    });
    await verifyInstalled(shop.id, "inactive");
    expect((await prisma.shop.findUniqueOrThrow({ where: { id: shop.id } })).uninstalledAt).toBeNull();
  });

  it("shop/redact with a cleared token and nothing to refresh it: erases", async () => {
    const shop = await makeShop(SHOP);
    // What the library leaves after Shopify answered 401 to a non-expiring token.
    await session({ accessToken: "", expires: null });
    await call(compliance, signed("shop/redact", SHOP, {}));
    await verifyInstalled(shop.id, "redact");
    expect(await prisma.shop.findUnique({ where: { id: shop.id } })).toBeNull();
    expect(await prisma.session.count({ where: { shop: SHOP } })).toBe(0);
  });

  it.each([402, 423])("never marks an idle shop uninstalled when the refresh answers %i (frozen or locked store)", async (status) => {
    const shop = await makeShop(SHOP);
    await session({ accessToken: "shpat_idle", expires: new Date(Date.now() - 5 * 86_400_000), refreshToken: "shprt_idle" });
    refresh(status, { errors: "Unavailable Shop" });

    const err = await verifyInstalled(shop.id, "inactive").catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(ShopifyAuthError);
    expect((await prisma.shop.findUniqueOrThrow({ where: { id: shop.id } })).uninstalledAt).toBeNull();
    expect(await prisma.session.count({ where: { shop: SHOP } })).toBe(1);
  });

  it("retries an idle shop's check after 12 hours until it gets an answer, then waits the full period", async () => {
    const shop = await makeShop(SHOP);
    await prisma.shop.update({ where: { id: shop.id }, data: { installedAt: new Date(Date.now() - 10 * 86_400_000) } });
    await session({ accessToken: "shpat_idle", expires: new Date(Date.now() - 5 * 86_400_000), refreshToken: "shprt_idle" });
    const hold = `shops:inactive-check:${shop.id}`;

    await maintenance();
    expect(await redis().pttl(hold)).toBeGreaterThan(11 * 3600_000);
    expect(await redis().pttl(hold)).toBeLessThanOrEqual(12 * 3600_000);

    refresh(200, { access_token: "shpat_new", expires_in: 3600, refresh_token: "shprt_new", refresh_token_expires_in: 7_776_000 });
    graphql(200);
    await verifyInstalled(shop.id, "inactive");
    expect((await prisma.shop.findUniqueOrThrow({ where: { id: shop.id } })).uninstalledAt).toBeNull();
    expect(await redis().pttl(hold)).toBeGreaterThan(2 * 86_400_000);
  });

  it("walks every idle shop across sweeps, so shops that stay idle can't starve the rest", async () => {
    const a = await makeShop("idle-a.myshopify.com");
    const b = await makeShop("idle-b.myshopify.com");
    const longAgo = new Date(Date.now() - 10 * 86_400_000);
    await prisma.shop.updateMany({ where: { id: { in: [a.id, b.id] } }, data: { installedAt: longAgo } });
    const [first, second] = (
      await prisma.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "Shop" WHERE "id" IN (${a.id}, ${b.id}) ORDER BY "id"`
    ).map((r) => r.id);
    const sweep = async () => {
      await jobsQueue().obliterate({ force: true });
      await redis().del("shops:inactive-sweep");
      await maintenance();
      const tasks = await jobsQueue().getJobs(["waiting", "prioritized"]);
      return tasks.filter((t) => t.data.name === "verify-uninstalled").map((t) => (t.data as { shopId: string }).shopId);
    };

    // The previous sweep stopped at the first shop; this one carries on after it.
    await redis().set("shops:inactive-cursor", first!);
    expect(await sweep()).toEqual([second]);
    // It reached the end, so the next sweep starts over.
    expect(await sweep()).toEqual([first]);
  });
});

describe("retention after uninstall", () => {
  it("erases uninstalled shops after 25 days even without shop/redact", async () => {
    const old = await makeShop("old.myshopify.com");
    const recent = await makeShop("recent.myshopify.com");
    await prisma.shop.update({ where: { id: old.id }, data: { uninstalledAt: new Date(Date.now() - 26 * 86_400_000) } });
    await prisma.shop.update({ where: { id: recent.id }, data: { uninstalledAt: new Date(Date.now() - 24 * 86_400_000) } });
    await maintenance();
    const purges = (await jobsQueue().getJobs(["waiting", "prioritized"])).filter((t) => t.data.name === "purge-shop");
    expect(purges.map((t) => t.data)).toEqual([{ name: "purge-shop", shopId: old.id }]);
  });
});

describe("bulk_operations/finish and purchases", () => {
  it("only acts on the sending shop's own job", async () => {
    const shop = await makeShop(SHOP);
    const { job } = await makeJob(shop.id, [], "reading");
    await prisma.job.update({ where: { id: job.id }, data: { bulkOperationId: "gid://shopify/BulkOperation/1" } });
    const payload = { admin_graphql_api_id: "gid://shopify/BulkOperation/1", status: "completed" };

    await call(bulkFinish, signed("bulk_operations/finish", "someone-else.myshopify.com", payload));
    expect(await jobsQueue().getJob(`ingest-${job.id}`)).toBeUndefined();

    await call(bulkFinish, signed("bulk_operations/finish", SHOP, payload));
    expect((await jobsQueue().getJob(`ingest-${job.id}`))?.data).toEqual({ name: "ingest-bulk", jobId: job.id, url: null });
  });

  it("credits a purchase once, and only for the shop that owns it", async () => {
    const shop = await makeShop(SHOP, 0);
    await prisma.purchase.create({
      data: { shopId: shop.id, pack: "starter", credits: 300, amount: 9, shopifyChargeId: "gid://shopify/AppPurchaseOneTime/9" },
    });
    const payload = { app_purchase_one_time: { admin_graphql_api_id: "gid://shopify/AppPurchaseOneTime/9", status: "ACTIVE" } };

    await call(purchaseUpdate, signed("app_purchases_one_time/update", "someone-else.myshopify.com", payload));
    expect((await prisma.shop.findUniqueOrThrow({ where: { id: shop.id } })).creditBalance).toBe(0);

    await call(purchaseUpdate, signed("app_purchases_one_time/update", SHOP, payload));
    await call(purchaseUpdate, signed("app_purchases_one_time/update", SHOP, payload));
    expect((await prisma.shop.findUniqueOrThrow({ where: { id: shop.id } })).creditBalance).toBe(300);
  });
});
