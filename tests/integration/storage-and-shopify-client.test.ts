import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher, type Dispatcher } from "undici";
import { redis } from "../../app/lib/redis.server";
import { createShopifyClient, ShopifyGraphqlError } from "../../app/lib/shopify/client.server";
import {
  deletePrefix,
  getObjectBuffer,
  headObject,
  presignGet,
  presignPut,
  putObject,
} from "../../app/lib/storage.server";

describe("object storage (MinIO standing in for R2)", () => {
  const prefix = `shops/test-${Date.now()}/`;

  afterAll(async () => {
    await deletePrefix(prefix);
  });

  it("stores, presigns and deletes by prefix", async () => {
    const key = `${prefix}backups/1/a.jpg`;
    await putObject(key, Buffer.from("original-bytes"), "image/jpeg", { "media-id": "gid://shopify/MediaImage/1" });
    expect(await headObject(key)).toMatchObject({ size: 14, contentType: "image/jpeg" });
    expect((await getObjectBuffer(key)).toString()).toBe("original-bytes");

    // Browser URLs are stable within the hour so polling doesn't re-download images.
    const url = await presignGet(key);
    expect(await presignGet(key)).toBe(url);
    expect(await (await fetch(url)).text()).toBe("original-bytes");

    // The GPU service writes through presigned PUTs with the signed Content-Type.
    const out = `${prefix}jobs/j/i/output.jpg`;
    const put = await presignPut(out, "image/jpeg");
    const res = await fetch(put, { method: "PUT", body: "processed", headers: { "Content-Type": "image/jpeg" } });
    expect(res.status).toBe(200);
    expect((await getObjectBuffer(out)).toString()).toBe("processed");

    expect(await deletePrefix(prefix)).toBe(2);
    expect(await headObject(key)).toBeNull();
  });

  it("streams web ReadableStreams (fetch bodies) into storage", async () => {
    const key = `${prefix}stream.bin`;
    const body = new Response(Buffer.alloc(6 * 1024 * 1024, 7)).body!;
    await putObject(key, body, "application/octet-stream");
    expect((await headObject(key))?.size).toBe(6 * 1024 * 1024);
  });
});

describe("Shopify GraphQL client pacing", () => {
  const SHOP = "pacing-test.myshopify.com";
  let agent: MockAgent;
  let previous: Dispatcher;

  beforeAll(() => {
    previous = getGlobalDispatcher();
    agent = new MockAgent();
    agent.disableNetConnect();
    agent.enableNetConnect(/localhost|127\.0\.0\.1/);
    setGlobalDispatcher(agent);
  });
  afterEach(async () => {
    await redis().del(`shopify:throttle:${SHOP}`);
  });
  afterAll(async () => {
    setGlobalDispatcher(previous);
    await agent.close();
    await redis().quit();
  });

  const cost = (currentlyAvailable: number) => ({
    cost: {
      requestedQueryCost: 50,
      throttleStatus: { maximumAvailable: 1000, currentlyAvailable, restoreRate: 100 },
    },
  });
  const json = { headers: { "content-type": "application/json" } };
  const endpoint = () =>
    agent.get(`https://${SHOP}`).intercept({ path: "/admin/api/2026-07/graphql.json", method: "POST" });

  it("waits and retries when Shopify answers THROTTLED", async () => {
    endpoint().reply(200, {
      errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }],
      extensions: cost(10),
    }, json);
    endpoint().reply(200, { data: { shop: { name: "Pacing" } }, extensions: cost(960) }, json);

    const client = createShopifyClient(SHOP, "token");
    const started = Date.now();
    const data = await client.request<{ shop: { name: string } }>("query { shop { name } }", {}, { cost: 50 });
    expect(data.shop.name).toBe("Pacing");
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
  });

  it("paces before sending when the shared bucket is low", async () => {
    await redis().hset(`shopify:throttle:${SHOP}`, { available: 0, max: 1000, rate: 100, ts: Date.now() });
    endpoint().reply(200, { data: { ok: true }, extensions: cost(900) }, json);
    const client = createShopifyClient(SHOP, "token");
    const started = Date.now();
    await client.request("query { ok }", {}, { cost: 50 }); // 50 points at 100/s ≈ 500 ms
    expect(Date.now() - started).toBeGreaterThanOrEqual(450);
    expect(Number(await redis().hget(`shopify:throttle:${SHOP}`, "available"))).toBe(900);
  });

  it("fails fast on errors retrying can't fix", async () => {
    endpoint().reply(200, {
      errors: [{ message: "Access denied for fileUpdate field.", extensions: { code: "ACCESS_DENIED" } }],
      extensions: cost(990),
    }, json);
    const client = createShopifyClient(SHOP, "token");
    const err = await client.request("mutation { x }").catch((e) => e);
    expect(err).toBeInstanceOf(ShopifyGraphqlError);
    expect(err).toMatchObject({ retryable: false, message: "Access denied for fileUpdate field." });
  });
});
