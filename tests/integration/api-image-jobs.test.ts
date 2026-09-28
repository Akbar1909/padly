/**
 * The /api/image-jobs resource routes, called through their loaders and actions the way React
 * Router calls them. Authentication is faked at authenticate.admin (a "Bearer test-session:<shop>"
 * token names the shop); requireShop, the routes and everything behind them are real, against
 * real Postgres and Redis. No Shopify or image-service calls.
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "../../app/db.server";
import { absoluteAppUrl, API_ACTIVE_MAX, apiError, shopifyThumbnail } from "../../app/lib/api.server";
import { ACTIVITY_QUERY, RECENT_LIMIT, toActivity } from "../../app/components/cleaning/activity";
import { APPLY_STOPPED_NOTICE } from "../../app/lib/jobs.server";
import { itemsQueue, jobsQueue } from "../../app/lib/queue.server";
import { redis } from "../../app/lib/redis.server";
import { action as bulkAction, loader as bulkLoader } from "../../app/routes/api.image-jobs.bulk";
import { action as jobAction, loader as jobLoader } from "../../app/routes/api.image-jobs.$jobId";
import { action as cancelAction, loader as cancelLoader } from "../../app/routes/api.image-jobs.$jobId_.cancel";
import { loader as itemsLoader } from "../../app/routes/api.image-jobs.$jobId_.items";
import {
  action as retryAction,
  loader as retryLoader,
} from "../../app/routes/api.image-jobs.$jobId_.retry-failed";
import { loader as jobPageLoader } from "../../app/routes/app.jobs.$jobId";
import { ageRows, makeJob, makeShop, resetState, statusesOf } from "./helpers";

// Hoisted above the imports: the token prefix is spelled out here, not shared with a const.
vi.mock("../../app/shopify.server", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../app/shopify.server")>();
  return {
    ...original,
    authenticate: {
      ...original.authenticate,
      admin: async (request: Request) => {
        const token = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
        if (token === "needs-reauth") {
          // What the library throws when the shop must authorize the app again.
          throw new Response(undefined, {
            status: 401,
            statusText: "Unauthorized",
            headers: new Headers({ "X-Shopify-API-Request-Failure-Reauthorize-Url": "https://vio.example.com/auth" }),
          });
        }
        if (!token.startsWith("test-session:")) {
          // What the library throws for a bad or expired session token on a fetch request.
          throw new Response(undefined, {
            status: 401,
            statusText: "Unauthorized",
            headers: { "X-Shopify-Retry-Invalid-Session-Request": "1" },
          });
        }
        return { session: { shop: token.slice("test-session:".length) }, cors: (r: Response) => r };
      },
    },
  };
});

const SHOP = "api-shop.myshopify.com";
const OTHER = "api-other.myshopify.com";
const ORIGIN = "https://vio.example.com";

beforeEach(resetState);
afterAll(async () => {
  await itemsQueue().close();
  await jobsQueue().close();
  await redis().quit();
  await prisma.$disconnect();
});

type Handler = (args: LoaderFunctionArgs & ActionFunctionArgs) => Response | Promise<Response>;

interface CallOptions {
  /** The shop whose session token is sent; null sends no Authorization header. */
  shop?: string | null;
  params?: Record<string, string>;
  /** JSON-encoded unless it's a string. */
  body?: unknown;
  headers?: Record<string, string>;
}

interface ApiResult {
  status: number;
  headers: Headers;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
  text: string;
}

/** Run a loader or action like React Router does; a thrown Response comes back as the result. */
async function call(handler: Handler, method: string, path: string, opts: CallOptions = {}): Promise<ApiResult> {
  const shop = opts.shop === undefined ? SHOP : opts.shop;
  const body = opts.body === undefined ? undefined : typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body);
  const request = new Request(`${ORIGIN}${path}`, {
    method,
    body,
    headers: {
      ...(shop ? { Authorization: `Bearer test-session:${shop}` } : {}),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...opts.headers,
    },
  });
  let response: Response;
  try {
    response = await handler({ request, params: opts.params ?? {}, context: {} } as LoaderFunctionArgs & ActionFunctionArgs);
  } catch (thrown) {
    if (!(thrown instanceof Response)) throw thrown;
    response = thrown;
  }
  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  return { status: response.status, headers: response.headers, body: parsed, text };
}

const bulk = (body: unknown, key: string | null = "key-1", shop: string | null = SHOP) =>
  call(bulkAction, "POST", "/api/image-jobs/bulk", { shop, body, headers: key === null ? {} : { "Idempotency-Key": key } });
const getJob = (jobId: string, shop: string | null = SHOP) =>
  call(jobLoader, "GET", `/api/image-jobs/${jobId}`, { shop, params: { jobId } });
const getItems = (jobId: string, query: Record<string, string> = {}, shop: string | null = SHOP) =>
  call(itemsLoader, "GET", `/api/image-jobs/${jobId}/items?${new URLSearchParams(query)}`, { shop, params: { jobId } });
const retry = (jobId: string, body?: unknown, shop: string | null = SHOP) =>
  call(retryAction, "POST", `/api/image-jobs/${jobId}/retry-failed`, { shop, params: { jobId }, body });
const cancel = (jobId: string, shop: string | null = SHOP) =>
  call(cancelAction, "POST", `/api/image-jobs/${jobId}/cancel`, { shop, params: { jobId } });

const jobRow = (id: string) => prisma.job.findUniqueOrThrow({ where: { id } });

const API_JOB_KEYS = [
  "completed",
  "completedAt",
  "createdAt",
  "etaSeconds",
  "failed",
  "id",
  "needsAction",
  "notice",
  "phase",
  "processing",
  "progress",
  "queued",
  "remaining",
  "reviewUrl",
  "selection",
  "startedAt",
  "status",
  "total",
  "updatedAt",
  "waitingForEarlierJob",
];

const API_ITEM_KEYS = [
  "attemptCount",
  "bulkJobId",
  "durationMs",
  "errorCode",
  "errorMessage",
  "finalStatus",
  "flags",
  "id",
  "mediaId",
  "outputImageUrl",
  "position",
  "processingMethod",
  "productId",
  "productTitle",
  "reasonCodes",
  "reviewStatus",
  "route",
  "sourceImageUrl",
  "status",
  "strongerModel",
  "thumbnailUrl",
  "updatedAt",
];

// ─── Authentication ─────────────────────────────────────────────────────────

describe("authentication", () => {
  const every = (jobId: string) =>
    [
      () => bulk({ productIds: ["1"] }, "key-1", null),
      () => getJob(jobId, null),
      () => getItems(jobId, {}, null),
      () => retry(jobId, {}, null),
      () => cancel(jobId, null),
    ] as const;

  it("answers 401 JSON without an Authorization header, before doing anything", async () => {
    const shop = await makeShop(SHOP);
    const { job } = await makeJob(shop.id, [{ status: "failed" }], "processing");
    for (const request of every(job.id)) {
      const res = await request();
      expect(res.status).toBe(401);
      expect(res.headers.get("content-type")).toMatch(/application\/json/);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.body.error).toMatch(/Authorization/);
    }
    // Nothing was created, cancelled or retried.
    expect(await prisma.job.count()).toBe(1);
    expect((await jobRow(job.id)).status).toBe("processing");
    expect(await statusesOf(job.id)).toEqual(["failed"]);
  });

  it("passes the library's 401 through for a bad session token, as no-store JSON with its headers", async () => {
    const shop = await makeShop(SHOP);
    const { job } = await makeJob(shop.id, [{}], "processing");
    const res = await call(jobLoader, "GET", `/api/image-jobs/${job.id}`, {
      shop: null,
      params: { jobId: job.id },
      headers: { Authorization: "Bearer not-a-session-token" },
    });
    expect(res.status).toBe(401);
    // App Bridge retries with a fresh session token when it sees this header.
    expect(res.headers.get("x-shopify-retry-invalid-session-request")).toBe("1");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    expect(res.body).toEqual({ error: "Invalid or expired session token." });

    const reauth = await call(itemsLoader, "GET", `/api/image-jobs/${job.id}/items`, {
      shop: null,
      params: { jobId: job.id },
      headers: { Authorization: "Bearer needs-reauth" },
    });
    expect(reauth.status).toBe(401);
    expect(reauth.headers.get("x-shopify-api-request-failure-reauthorize-url")).toBe("https://vio.example.com/auth");
    expect(reauth.headers.get("cache-control")).toBe("no-store");
    expect(reauth.body.error).toMatch(/authorized again/);
  });

  it("keeps any other thrown Response as it is, adding no-store", async () => {
    const text = apiError(new Response("nope", { status: 403, headers: { "Content-Type": "text/plain", "X-Extra": "1" } }));
    expect(text.status).toBe(403);
    expect(await text.text()).toBe("nope");
    expect(text.headers.get("content-type")).toBe("text/plain");
    expect(text.headers.get("x-extra")).toBe("1");
    expect(text.headers.get("cache-control")).toBe("no-store");

    // Response.redirect has immutable headers: the copy still gets no-store.
    const redirect = apiError(Response.redirect("https://vio.example.com/auth/login", 302));
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get("location")).toBe("https://vio.example.com/auth/login");
    expect(redirect.headers.get("cache-control")).toBe("no-store");
    expect(redirect.body).toBeNull();
  });
});

// ─── POST /api/image-jobs/bulk ──────────────────────────────────────────────

describe("POST /api/image-jobs/bulk", () => {
  it("accepts a job with 202, and a replayed Idempotency-Key returns the same job", async () => {
    await makeShop(SHOP);
    const first = await bulk({ productIds: ["101", "gid://shopify/Product/102"], preset: { marginPct: 12 } }, "order-7");
    expect(first.status).toBe(202);
    expect(first.body).toEqual({ jobId: expect.any(String), status: "queued", total: 2 });
    expect(first.headers.get("cache-control")).toBe("no-store");
    expect(first.headers.get("location")).toBe(`/api/image-jobs/${first.body.jobId}`);
    expect(first.headers.get("idempotent-replayed")).toBeNull();

    const row = await jobRow(first.body.jobId);
    expect(row).toMatchObject({
      status: "reading",
      requestKey: "order-7",
      autoStart: true,
      filter: { productIds: ["gid://shopify/Product/101", "gid://shopify/Product/102"], imageScope: "first" },
      presetSnapshot: { marginPct: 12, removeBg: true, aspect: "1:1" },
    });
    // The worker reads the products; nothing else is enqueued yet.
    expect(await jobsQueue().getJob(`read-${row.id}`)).toBeTruthy();

    // A network retry (even with a different body) gets the first job back.
    const replay = await bulk({ productIds: ["999"] }, "order-7");
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual(first.body);
    expect(replay.headers.get("idempotent-replayed")).toBe("true");
    expect(await prisma.job.count()).toBe(1);
  });

  it("gives racing requests with one key one job", async () => {
    await makeShop(SHOP);
    const results = await Promise.all([1, 2, 3].map(() => bulk({ productIds: ["5"] }, "race")));
    expect(new Set(results.map((r) => r.body.jobId)).size).toBe(1);
    expect(results.map((r) => r.status).sort()).toEqual([200, 200, 202]);
    expect(await prisma.job.count()).toBe(1);
  });

  it("scopes keys by shop, and a new key makes a new job", async () => {
    await makeShop(SHOP);
    await makeShop(OTHER);
    const mine = await bulk({ productIds: ["1"] }, "same-key");
    const theirs = await bulk({ productIds: ["1"] }, "same-key", OTHER);
    const again = await bulk({ productIds: ["1"] }, "another-key");
    expect([mine.status, theirs.status, again.status]).toEqual([202, 202, 202]);
    expect(new Set([mine.body.jobId, theirs.body.jobId, again.body.jobId]).size).toBe(3);
    const other = await prisma.shop.findUniqueOrThrow({ where: { domain: OTHER } });
    expect((await jobRow(theirs.body.jobId)).shopId).toBe(other.id);
  });

  it("takes named images (imageIds is an alias of mediaIds), scope all, and autoStart false", async () => {
    await makeShop(SHOP);
    const named = await bulk(
      { productIds: [1], imageIds: ["gid://shopify/MediaImage/7", "8"], autoStart: false },
      "named",
    );
    expect(named).toMatchObject({ status: 202, body: { status: "queued", total: 2 } });
    expect(await jobRow(named.body.jobId)).toMatchObject({
      autoStart: false,
      filter: {
        productIds: ["gid://shopify/Product/1"],
        mediaIds: ["gid://shopify/MediaImage/7", "gid://shopify/MediaImage/8"],
      },
    });

    // Every image of each product: the count is unknown until the products are read.
    const all = await bulk({ productIds: ["1", "2"], imageScope: "all" }, "all");
    expect(all).toMatchObject({ status: 202, body: { total: null } });
    expect((await jobRow(all.body.jobId)).filter).toMatchObject({ imageScope: "all" });
  });

  it("rejects bad requests with 400 (or 413) and creates nothing", async () => {
    await makeShop(SHOP);
    const bad: Array<[string, () => Promise<ApiResult>, number, RegExp?]> = [
      ["no Idempotency-Key", () => bulk({ productIds: ["1"] }, null), 400, /Idempotency-Key/],
      ["empty Idempotency-Key", () => bulk({ productIds: ["1"] }, "  "), 400, /Idempotency-Key/],
      ["long Idempotency-Key", () => bulk({ productIds: ["1"] }, "k".repeat(201)), 400, /200 characters/],
      ["not JSON", () => bulk("{productIds:"), 400, /JSON/],
      ["no productIds", () => bulk({}), 400],
      ["empty productIds", () => bulk({ productIds: [] }), 400],
      ["unknown field", () => bulk({ productIds: ["1"], shop: "someone-else" }), 400],
      ["both mediaIds and imageIds", () => bulk({ productIds: ["1"], mediaIds: ["2"], imageIds: ["3"] }), 400, /not both/],
      ["mediaIds without productIds", () => bulk({ mediaIds: ["2"] }), 400],
      ["bad scope", () => bulk({ productIds: ["1"], imageScope: "some" }), 400],
      ["bad preset value", () => bulk({ productIds: ["1"], preset: { marginPct: 99 } }), 400],
      ["unknown preset field", () => bulk({ productIds: ["1"], preset: { colour: "red" } }), 400],
      ["autoStart not a boolean", () => bulk({ productIds: ["1"], autoStart: "yes" }), 400],
      ["a collection id", () => bulk({ productIds: ["gid://shopify/Collection/1"] }), 400],
      ["too many products", () => bulk({ productIds: Array.from({ length: 5001 }, (_, i) => String(i + 1)) }), 400],
      ["body over 1 MB", () => bulk(`{"productIds":["${"1".repeat(1_000_001)}"]}`), 413],
    ];
    for (const [name, request, status, message] of bad) {
      const res = await request();
      expect({ name, status: res.status }).toEqual({ name, status });
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(typeof res.body?.error, name).toBe("string");
      if (message) expect(res.body.error, name).toMatch(message);
    }
    // Zod problems say which field is wrong.
    expect((await bulk({ productIds: [] })).body.issues).toEqual([expect.objectContaining({ path: "productIds" })]);
    expect(await prisma.job.count()).toBe(0);
  });

  it("only answers POST", async () => {
    const res = await call(bulkLoader, "GET", "/api/image-jobs/bulk");
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
    const put = await call(bulkAction, "PUT", "/api/image-jobs/bulk", { body: { productIds: ["1"] } });
    expect(put.status).toBe(405);
    expect(await prisma.job.count()).toBe(0);
  });
});

// ─── GET /api/image-jobs/:jobId ─────────────────────────────────────────────

describe("GET /api/image-jobs/:jobId", () => {
  it("returns the job without its raw selection (no id lists)", async () => {
    await makeShop(SHOP);
    const created = await bulk({ productIds: Array.from({ length: 40 }, (_, i) => String(7_777_000 + i)) });
    const res = await getJob(created.body.jobId);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(Object.keys(res.body).sort()).toEqual(API_JOB_KEYS);
    expect(res.body).toMatchObject({
      id: created.body.jobId,
      status: "queued",
      phase: "reading",
      needsAction: null,
      notice: null,
      selection: "40 selected products · first image",
      reviewUrl: `/app/jobs/${created.body.jobId}`,
      completedAt: null,
    });
    expect(res.text).not.toContain("gid://shopify/Product");
    expect(res.text).not.toContain("7777");
    expect(res.body).not.toHaveProperty("filter");
  });

  it("maps every phase to the spec vocabulary", async () => {
    const shop = await makeShop(SHOP, 25);
    const cases = [
      { phase: "estimated", items: [{}, {}], status: "queued", needsAction: "start" },
      { phase: "processing", items: [{ status: "ready" }, { status: "processing" }, {}], status: "processing", needsAction: null },
      { phase: "applying", items: [{ status: "approved" }, { status: "applied" }], status: "processing", needsAction: null },
      { phase: "review", items: [{ status: "ready" }, { status: "flagged" }], status: "completed", needsAction: "review" },
      { phase: "review", items: [{ status: "ready" }, { status: "failed" }], status: "completed_with_errors", needsAction: "review" },
      { phase: "review", items: [{ status: "failed" }, { status: "failed" }], status: "failed", needsAction: "review" },
      { phase: "done", items: [{ status: "applied" }, { status: "rejected" }], status: "completed", needsAction: null },
      { phase: "failed", items: [], status: "failed", needsAction: null },
      { phase: "cancelled", items: [{}], status: "cancelled", needsAction: null },
    ] as const;
    for (const c of cases) {
      const { job } = await makeJob(shop.id, [...c.items], c.phase);
      const res = await getJob(job.id);
      expect({ phase: c.phase, status: res.status, body: res.body }).toMatchObject({
        phase: c.phase,
        status: 200,
        body: { phase: c.phase, status: c.status, needsAction: c.needsAction },
      });
    }

    // Short of credits: waiting for the merchant, not queued forever.
    const poor = await makeShop(OTHER, 1);
    const { job: big } = await makeJob(poor.id, [{}, {}, {}]);
    expect((await getJob(big.id, OTHER)).body).toMatchObject({ status: "queued", needsAction: "credits" });
  });

  it("counts the current phase, with a measured ETA only after 5 finished images", async () => {
    const shop = await makeShop(SHOP);
    const { job, items } = await makeJob(
      shop.id,
      [...Array.from({ length: 5 }, () => ({ status: "ready" as const })), { status: "processing" }, {}, {}, {}, {}],
      "processing",
    );
    await prisma.job.update({
      where: { id: job.id },
      data: { phaseTotal: 10, phaseFailedBase: 0, phaseStartedAt: new Date(Date.now() - 100_000) },
    });
    const res = await getJob(job.id);
    expect(res.body).toMatchObject({ total: 10, completed: 5, failed: 0, processing: 1, queued: 4, remaining: 5, progress: 50 });
    // 100 s for 5 images, 5 left: about 100 s more.
    expect(res.body.etaSeconds).toBeGreaterThanOrEqual(95);
    expect(res.body.etaSeconds).toBeLessThanOrEqual(110);

    // One fewer finished image: no ETA yet.
    await prisma.jobItem.update({ where: { id: items[0].id }, data: { status: "queued" } });
    expect((await getJob(job.id)).body).toMatchObject({ completed: 4, etaSeconds: null });
  });

  it("only answers GET", async () => {
    const shop = await makeShop(SHOP);
    const { job } = await makeJob(shop.id, [{}], "processing");
    const res = await call(jobAction, "POST", `/api/image-jobs/${job.id}`, { params: { jobId: job.id } });
    expect(res).toMatchObject({ status: 405, body: { error: expect.any(String) } });
    expect(res.headers.get("allow")).toBe("GET");
  });
});

// ─── GET /api/image-jobs/:jobId/items ───────────────────────────────────────

describe("GET /api/image-jobs/:jobId/items", () => {
  async function reviewJob() {
    const shop = await makeShop(SHOP);
    return makeJob(
      shop.id,
      [
        { status: "ready" },
        { status: "flagged", flags: [{ code: "text_detected", severity: "warning", message: "Text" }] },
        { status: "failed", errorCode: "busy", error: "The image service is busy." },
        { status: "applied" },
        { status: "failed", outputKey: "out.jpg", error: "Shopify refused the image." },
      ],
      "review",
    );
  }

  it("pages through every image once", async () => {
    const { job, items } = await reviewJob();
    const pages = [];
    for (const page of ["1", "2", "3"]) {
      const res = await getItems(job.id, { limit: "2", page });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ page: Number(page), pages: 3, total: 5, limit: 2 });
      pages.push(res.body.items);
    }
    expect(pages.map((p) => p.length)).toEqual([2, 2, 1]);
    const ids = pages.flat().map((i: { id: string }) => i.id);
    expect([...ids].sort()).toEqual(items.map((i) => i.id).sort());

    const past = await getItems(job.id, { limit: "2", page: "9" });
    expect(past.body).toMatchObject({ items: [], total: 5, pages: 3, page: 9 });

    // Defaults, the 100 cap and junk numbers.
    expect((await getItems(job.id)).body).toMatchObject({ page: 1, limit: 50, total: 5 });
    expect((await getItems(job.id, { limit: "1000" })).body.limit).toBe(100);
    expect((await getItems(job.id, { limit: "-3", page: "abc" })).body).toMatchObject({ page: 1, limit: 1 });
  });

  it("filters by spec or internal status and shows each image in the spec vocabulary", async () => {
    const { job, items } = await reviewJob();
    const failed = await getItems(job.id, { status: "failed" });
    expect(failed.body.total).toBe(2);
    expect(failed.body.items.map((i: { status: string; errorCode: string }) => [i.status, i.errorCode]).sort()).toEqual([
      ["failed", "apply_unknown"],
      ["failed", "busy"],
    ]);

    // "completed" = processed and ready for review (or already applied), never "written to Shopify".
    const completed = await getItems(job.id, { status: "completed" });
    expect(completed.body.total).toBe(3);
    expect(completed.body.items.map((i: { status: string }) => i.status)).toEqual(["completed", "completed", "completed"]);
    expect(completed.body.items.map((i: { reviewStatus: string }) => i.reviewStatus).sort()).toEqual(["applied", "flagged", "ready"]);

    const flagged = await getItems(job.id, { status: "flagged" });
    expect(flagged.body.items).toHaveLength(1);
    const [item] = flagged.body.items;
    expect(Object.keys(item).sort()).toEqual(API_ITEM_KEYS);
    expect(item).toMatchObject({
      id: items[1].id,
      bulkJobId: job.id,
      productId: items[1].productId,
      mediaId: items[1].mediaId,
      status: "completed",
      reviewStatus: "flagged",
      flags: ["text_detected"],
      errorCode: null,
      outputImageUrl: null,
    });

    expect((await getItems(job.id, { status: "queued" })).body).toMatchObject({ items: [], total: 0 });
    const weird = await getItems(job.id, { status: "published" });
    expect(weird.status).toBe(400);
    expect(weird.body.error).toMatch(/published/);

    // Object.prototype keys are not statuses either (not a 500).
    for (const status of ["toString", "__proto__", "constructor", "hasOwnProperty", "valueOf"]) {
      const res = await getItems(job.id, { status });
      expect({ status, code: res.status }).toEqual({ status, code: 400 });
      expect(res.body.error).toMatch(/Unknown status/);
    }
  });

  it("gives an absolute preview URL, also through the app's image proxy (S3_BROWSER_PROXY)", async () => {
    const { job, items } = await reviewJob();
    const previewKey = `shops/api-test/jobs/${job.id}/${items[0].id}/preview.jpg`;
    await prisma.jobItem.update({ where: { id: items[0].id }, data: { previewKey } });

    const direct = await getItems(job.id, { status: "ready" });
    expect(direct.body.items[0].outputImageUrl).toMatch(new RegExp(`^https?://[^/]+/vio-test/${previewKey}\\?`));

    // With the proxy, presignGet answers a path on the app origin: the API makes it a full URL.
    process.env.S3_BROWSER_PROXY = "true";
    vi.resetModules();
    try {
      const { loader: proxiedItems } = await import("../../app/routes/api.image-jobs.$jobId_.items");
      const proxied = await call(proxiedItems, "GET", `/api/image-jobs/${job.id}/items?status=ready`, {
        params: { jobId: job.id },
      });
      const url: string = proxied.body.items[0].outputImageUrl;
      expect(url.startsWith(`https://vio.example.com/s3-proxy/vio-test/${previewKey}?`)).toBe(true);
      expect(url).toContain("X-Amz-Signature=");
    } finally {
      process.env.S3_BROWSER_PROXY = "false";
      vi.resetModules();
    }

    expect(absoluteAppUrl("/s3-proxy/b/k.jpg?X-Amz-Signature=ab", "https://app.example.com/")).toBe(
      "https://app.example.com/s3-proxy/b/k.jpg?X-Amz-Signature=ab",
    );
    expect(absoluteAppUrl("https://cdn.example.com/k.jpg", "https://app.example.com")).toBe("https://cdn.example.com/k.jpg");
    expect(absoluteAppUrl("/s3-proxy/b/k.jpg", "")).toBe("/s3-proxy/b/k.jpg");
  });

  it("lists the last changed first with sort=recent, and takes a comma-separated status list", async () => {
    const shop = await makeShop(SHOP);
    const { job, items } = await makeJob(
      shop.id,
      [{ status: "ready" }, { status: "flagged", flags: [{ code: "text_detected", severity: "warning", message: "Text" }] }, { status: "failed" }, { status: "processing" }, {}, { status: "applied" }],
      "processing",
    );
    const [ready, flagged, failed, processing, queued, applied] = items;
    // Finished 50 s, 10 s, 30 s and 90 s ago; the in-flight one was claimed 5 s ago.
    await ageRows("JobItem", [ready.id], 50_000);
    await ageRows("JobItem", [flagged.id], 10_000);
    await ageRows("JobItem", [failed.id], 30_000);
    await ageRows("JobItem", [applied.id], 90_000);
    await ageRows("JobItem", [processing.id], 5_000);
    await ageRows("JobItem", [queued.id], 120_000);

    const recent = await getItems(job.id, { status: "completed,failed", sort: "recent" });
    expect(recent.status).toBe(200);
    expect(recent.headers.get("cache-control")).toBe("no-store");
    expect(recent.body).toMatchObject({ total: 4, page: 1, pages: 1 });
    expect(recent.body.items.map((i: { id: string }) => i.id)).toEqual([flagged.id, failed.id, ready.id, applied.id]);
    expect(recent.body.items.map((i: { status: string }) => i.status)).toEqual(["completed", "failed", "completed", "completed"]);
    // No `active` unless asked for.
    expect(recent.body).not.toHaveProperty("active");

    // Pages follow the same order.
    const second = await getItems(job.id, { status: "completed,failed", sort: "recent", limit: "2", page: "2" });
    expect(second.body.items.map((i: { id: string }) => i.id)).toEqual([ready.id, applied.id]);

    // Every status, last changed first; a repeated or spec+internal overlap counts once.
    const all = await getItems(job.id, { sort: "recent" });
    expect(all.body.items.map((i: { id: string }) => i.id)).toEqual([
      processing.id,
      flagged.id,
      failed.id,
      ready.id,
      applied.id,
      queued.id,
    ]);
    expect((await getItems(job.id, { status: "failed, completed,flagged,failed" })).body.total).toBe(4);

    // sort=recent reads the (jobId, updatedAt) index backwards instead of sorting every finished row.
    const indexes = await prisma.$queryRaw<Array<{ indexdef: string }>>`
      SELECT indexdef FROM pg_indexes WHERE schemaname = current_schema() AND tablename = 'JobItem'`;
    expect(indexes.map((i) => i.indexdef)).toContainEqual(expect.stringContaining('("jobId", "updatedAt")'));

    // The default order is still by product.
    const byProduct = await getItems(job.id);
    expect(byProduct.body.items.map((i: { productTitle: string }) => i.productTitle)).toEqual(
      items.map((i) => i.productTitle).sort(),
    );
    expect((await getItems(job.id, { sort: "product" })).body.items).toEqual(byProduct.body.items);

    const bad: Array<[Record<string, string>, RegExp]> = [
      [{ sort: "oldest" }, /Unknown sort "oldest"/],
      [{ sort: "__proto__" }, /Unknown sort/],
      [{ sort: "constructor" }, /Unknown sort/],
      [{ status: "completed,published" }, /Unknown status "published"/],
      [{ status: "completed," }, /Unknown status/],
      [{ status: "toString,failed" }, /Unknown status "toString"/],
      [{ status: Array.from({ length: 21 }, () => "failed").join(",") }, /At most 20 statuses/],
      [{ include: "everything" }, /Unknown include "everything"/],
    ];
    for (const [query, message] of bad) {
      const res = await getItems(job.id, query);
      expect({ query, status: res.status }).toEqual({ query, status: 400 });
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.body.error).toMatch(message);
    }
  });

  it("include=active adds the images in flight, oldest claim first, not ones waiting out a retry", async () => {
    const shop = await makeShop(SHOP);
    const { job, items } = await makeJob(
      shop.id,
      [{ status: "processing" }, { status: "processing" }, { status: "processing" }, { status: "processing" }, {}, { status: "ready" }],
      "processing",
    );
    const [newer, older, backingOff, retrying] = items;
    await prisma.jobItem.update({ where: { id: backingOff.id }, data: { retryAt: new Date(Date.now() + 60_000) } });
    await prisma.jobItem.update({ where: { id: retrying.id }, data: { retryAt: new Date(Date.now() - 1_000) } });
    await ageRows("JobItem", [newer.id], 4_000);
    await ageRows("JobItem", [older.id], 20_000);
    await ageRows("JobItem", [retrying.id], 40_000);

    const res = await getItems(job.id, { status: "completed,failed", sort: "recent", limit: "6", include: "active" });
    expect(res.status).toBe(200);
    expect(res.body.active.map((i: { id: string }) => i.id)).toEqual([retrying.id, older.id, newer.id]);
    expect(res.body.active.every((i: { status: string }) => i.status === "processing")).toBe(true);
    expect(Object.keys(res.body.active[0]).sort()).toEqual(API_ITEM_KEYS);
    // The status filter and page apply to `items` only.
    expect(res.body.items.map((i: { id: string }) => i.id)).toEqual([items[5].id]);
    expect(res.body.total).toBe(1);

    // Nothing in flight: an empty list, still there.
    const { job: review } = await makeJob(shop.id, [{ status: "ready" }], "review");
    expect((await getItems(review.id, { include: "active" })).body.active).toEqual([]);

    // Capped.
    const { job: busy } = await makeJob(
      shop.id,
      Array.from({ length: API_ACTIVE_MAX + 3 }, () => ({ status: "processing" as const })),
      "processing",
    );
    expect((await getItems(busy.id, { include: "active" })).body.active).toHaveLength(API_ACTIVE_MAX);

    // Another shop's job stays a 404 with every parameter.
    await makeShop(OTHER);
    const theirs = await getItems(job.id, { status: "completed,failed", sort: "recent", include: "active" }, OTHER);
    expect(theirs).toMatchObject({ status: 404, body: { error: "Job not found" } });
    expect(theirs.headers.get("cache-control")).toBe("no-store");
  });

  it("gives each image a small Shopify thumbnail of the original and, once processed, a signed preview", async () => {
    const shop = await makeShop(SHOP);
    const { job, items } = await makeJob(shop.id, [{ status: "ready" }, { status: "processing" }, { status: "failed" }], "processing");
    const [ready, processing, failed] = items;
    const previewKey = `shops/api-test/jobs/${job.id}/${ready.id}/preview.jpg`;
    await prisma.jobItem.update({
      where: { id: ready.id },
      data: { previewKey, thumbnailUrl: "https://cdn.shopify.com/s/files/1/0001/files/shoe.jpg?v=12&width=2048" },
    });
    // No thumbnailUrl: the original's URL, when it is on Shopify's CDN.
    await prisma.jobItem.update({
      where: { id: processing.id },
      data: { thumbnailUrl: null, originalUrl: "https://cdn.shopify.com/s/files/1/0001/files/bag.png?v=3" },
    });

    const res = await getItems(job.id, { ...Object.fromEntries(new URLSearchParams(ACTIVITY_QUERY)) });
    expect(res.status).toBe(200);
    type Row = { id: string; thumbnailUrl: string | null; outputImageUrl: string | null; sourceImageUrl: string | null };
    const byId = new Map(([...res.body.items, ...res.body.active] as Row[]).map((i) => [i.id, i]));
    expect(byId.get(ready.id)).toMatchObject({
      thumbnailUrl: "https://cdn.shopify.com/s/files/1/0001/files/shoe.jpg?v=12&width=400",
      sourceImageUrl: "https://cdn.shopify.com/s/files/1/0001/files/shoe.jpg?v=12&width=2048",
    });
    expect(byId.get(ready.id)?.outputImageUrl).toMatch(new RegExp(`^https?://[^/]+/vio-test/${previewKey}\\?.*X-Amz-Signature=`));
    expect(byId.get(processing.id)).toMatchObject({
      thumbnailUrl: "https://cdn.shopify.com/s/files/1/0001/files/bag.png?v=3&width=400",
      outputImageUrl: null,
    });
    // Not on Shopify's CDN (the test rows use cdn.example.com): no thumbnail rather than a full-size or expiring URL.
    expect(byId.get(failed.id)).toMatchObject({ thumbnailUrl: null, outputImageUrl: null });

    // What the job page's strip makes of it.
    const activity = toActivity(res.body);
    expect(activity.active).toEqual([
      {
        id: processing.id,
        title: processing.productTitle,
        status: "processing",
        flagged: false,
        thumbnailUrl: "https://cdn.shopify.com/s/files/1/0001/files/bag.png?v=3&width=400",
        previewUrl: null,
      },
    ]);
    expect(activity.recent.map((i) => [i.id, i.status])).toEqual(
      expect.arrayContaining([
        [ready.id, "completed"],
        [failed.id, "failed"],
      ]),
    );
    expect(activity.recent.find((i) => i.id === ready.id)?.previewUrl).toBe(byId.get(ready.id)?.outputImageUrl);

    expect(shopifyThumbnail("https://cdn.shopify.com/a.jpg", 200)).toBe("https://cdn.shopify.com/a.jpg?width=200");
    expect(shopifyThumbnail("http://cdn.shopify.com/a.jpg")).toBeNull();
    expect(shopifyThumbnail("https://cdn.shopify.com.evil.example/a.jpg")).toBeNull();
    expect(shopifyThumbnail("not a url")).toBeNull();
    expect(shopifyThumbnail(null)).toBeNull();
  });

  it("gives the job page the strip's first data while the job processes, and none after", async () => {
    const shop = await makeShop(SHOP);
    const { job, items } = await makeJob(
      shop.id,
      [
        { status: "processing" },
        ...Array.from({ length: RECENT_LIMIT + 1 }, () => ({ status: "ready" as const })),
        { status: "failed" },
        {},
        // Changed later than anything processing finished (a retried job keeps its review
        // decisions and applies), but not what processing produces: never "just cleaned".
        { status: "approved" },
        { status: "rejected" },
        { status: "applied" },
      ],
      "processing",
    );
    // (makeJob lists items by productId as text: Product/10 comes before Product/2.)
    const inFlight = items.filter((i) => i.status === "processing");
    const failed = items.find((i) => i.status === "failed")!;
    const decided = items.filter((i) => ["approved", "rejected", "applied"].includes(i.status));
    await ageRows("JobItem", items.filter((i) => i.status === "ready").map((i) => i.id), 60_000);
    await ageRows("JobItem", [failed.id], 30_000);
    const load = async (jobId: string) => {
      const request = new Request(`${ORIGIN}/app/jobs/${jobId}`, { headers: { Authorization: `Bearer test-session:${SHOP}` } });
      return jobPageLoader({ request, params: { jobId }, context: {} } as unknown as LoaderFunctionArgs);
    };

    const data = await load(job.id);
    expect(data.activity?.active.map((i) => i.id)).toEqual(inFlight.map((i) => i.id));
    expect(data.activity?.recent).toHaveLength(RECENT_LIMIT);
    // The failure is the last change processing made: first.
    expect(data.activity?.recent[0]).toMatchObject({ id: failed.id, status: "failed", previewUrl: null });
    const shown = [...(data.activity?.recent ?? []), ...(data.activity?.active ?? [])].map((i) => i.id);
    for (const item of decided) expect(shown).not.toContain(item.id);
    // Its last change, to tell it from an older or newer answer.
    expect(data.activity?.asOf).toBe((await prisma.jobItem.findUniqueOrThrow({ where: { id: inFlight[0].id } })).updatedAt.toISOString());

    await prisma.job.update({ where: { id: job.id }, data: { status: "review" } });
    expect((await load(job.id)).activity).toBeNull();
  });
});

// ─── POST /api/image-jobs/:jobId/retry-failed ───────────────────────────────

describe("POST /api/image-jobs/:jobId/retry-failed", () => {
  it("retries only the failed images named, and a repeat retries nothing", async () => {
    const shop = await makeShop(SHOP, 25);
    const { job, items } = await makeJob(
      shop.id,
      [{ status: "ready", reserved: 1 }, { status: "failed" }, { status: "failed" }, { status: "applied" }],
      "review",
    );
    const [ready, failedA, failedB, applied] = items;

    const first = await retry(job.id, { itemIds: [failedA.id, ready.id, applied.id, failedA.id] });
    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toBe("no-store");
    expect(first.body).toEqual({ retried: 1, skipped: 0, status: "processing", phase: "processing" });
    const after = await prisma.jobItem.findMany({ where: { jobId: job.id } });
    const byId = new Map(after.map((i) => [i.id, i.status]));
    expect(["queued", "processing"]).toContain(byId.get(failedA.id)); // the pump may have claimed it
    expect(byId.get(ready.id)).toBe("ready");
    expect(byId.get(failedB.id)).toBe("failed");
    expect(byId.get(applied.id)).toBe("applied");

    const repeat = await retry(job.id, { itemIds: [failedA.id] });
    expect(repeat).toMatchObject({ status: 200, body: { retried: 0, status: "processing" } });

    // failedB is still failed, but the job is processing again: that's for later.
    const busy = await retry(job.id);
    expect(busy.status).toBe(409);
    expect(busy.body.error).toMatch(/review or done/);
  });

  it("retries every failed image when no ids are sent (reprocess and reapply), then nothing", async () => {
    const shop = await makeShop(SHOP, 25);
    const { job, items } = await makeJob(
      shop.id,
      [{ status: "failed" }, { status: "failed", outputKey: "out.jpg" }, { status: "applied" }],
      "done",
    );
    const res = await retry(job.id);
    expect(res.body).toEqual({ retried: 2, skipped: 0, status: "processing", phase: "processing" });
    const statuses = await prisma.jobItem.findMany({ where: { jobId: job.id } });
    const byId = new Map(statuses.map((i) => [i.id, i.status]));
    expect(["queued", "processing"]).toContain(byId.get(items[0].id));
    expect(byId.get(items[1].id)).toBe("approved"); // failed while applying: back to approved
    expect(byId.get(items[2].id)).toBe("applied");

    expect((await retry(job.id)).body).toMatchObject({ retried: 0, skipped: 0 });
  });

  it("answers 402 with the numbers when credits are short", async () => {
    const shop = await makeShop(SHOP, 0);
    const { job } = await makeJob(shop.id, [{ status: "failed" }, { status: "failed" }], "review");
    const res = await retry(job.id);
    expect(res.status).toBe(402);
    expect(res.body).toMatchObject({ error: expect.any(String), needed: 2, available: 0 });
    expect(await statusesOf(job.id)).toEqual(["failed", "failed"]);
  });

  it("rejects a bad body with 400 and GET with 405", async () => {
    const shop = await makeShop(SHOP, 25);
    const { job } = await makeJob(shop.id, [{ status: "failed" }], "review");
    for (const body of [{ itemIds: "all" }, { itemIds: [1] }, { itemIds: [""] }, { force: true }, "[not json"]) {
      const res = await retry(job.id, body);
      expect({ body, status: res.status }).toEqual({ body, status: 400 });
    }
    expect(await statusesOf(job.id)).toEqual(["failed"]);
    const get = await call(retryLoader, "GET", `/api/image-jobs/${job.id}/retry-failed`, { params: { jobId: job.id } });
    expect(get.status).toBe(405);
  });
});

// ─── POST /api/image-jobs/:jobId/cancel ─────────────────────────────────────

describe("POST /api/image-jobs/:jobId/cancel", () => {
  it("cancels a processing job once; a second cancel is 409", async () => {
    const shop = await makeShop(SHOP);
    const { job } = await makeJob(shop.id, [{ status: "ready" }, { status: "processing" }, {}], "processing");
    const res = await cancel(job.id);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.body).toEqual({ status: "cancelled", phase: "cancelled" });
    expect((await jobRow(job.id)).status).toBe("cancelled");

    const again = await cancel(job.id);
    expect(again.status).toBe(409);
    expect(again.body.error).toMatch(/cancelled/);
  });

  it("cancels a job that is still being read (created through the API)", async () => {
    await makeShop(SHOP);
    const created = await bulk({ productIds: ["1"] });
    expect((await cancel(created.body.jobId)).body).toEqual({ status: "cancelled", phase: "cancelled" });
  });

  it("stops an apply: back to review, nothing undone", async () => {
    const shop = await makeShop(SHOP);
    const { job } = await makeJob(shop.id, [{ status: "approved" }, { status: "applied" }], "applying");
    const res = await cancel(job.id);
    expect(res).toMatchObject({ status: 200, body: { status: "completed", phase: "review" } });
    const row = await jobRow(job.id);
    expect(row.status).toBe("review");
    expect(row.error).toContain(APPLY_STOPPED_NOTICE);
    expect((await getJob(job.id)).body.notice).toContain(APPLY_STOPPED_NOTICE);
    expect(await statusesOf(job.id)).toEqual(["approved", "applied"]);
  });

  it("answers 409 for jobs in review, done or failed", async () => {
    const shop = await makeShop(SHOP);
    for (const phase of ["review", "done", "failed"] as const) {
      const { job } = await makeJob(shop.id, [{ status: "ready" }], phase);
      const res = await cancel(job.id);
      expect({ phase, status: res.status }).toEqual({ phase, status: 409 });
      expect((await jobRow(job.id)).status).toBe(phase);
    }
    const get = await call(cancelLoader, "GET", "/api/image-jobs/x/cancel", { params: { jobId: "x" } });
    expect(get.status).toBe(405);
  });
});

// ─── Scoping ────────────────────────────────────────────────────────────────

describe("another shop's job", () => {
  it("is 404 on every route, and stays untouched", async () => {
    const shop = await makeShop(SHOP, 25);
    await makeShop(OTHER, 25);
    const { job } = await makeJob(shop.id, [{ status: "ready" }, { status: "failed" }], "review");
    const { job: running } = await makeJob(shop.id, [{}], "processing");

    for (const res of [
      await getJob(job.id, OTHER),
      await getItems(job.id, {}, OTHER),
      await retry(job.id, {}, OTHER),
      await retry(job.id, { itemIds: [] }, OTHER),
      await cancel(running.id, OTHER),
    ]) {
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: "Job not found" });
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
    expect((await jobRow(job.id)).status).toBe("review");
    expect((await jobRow(running.id)).status).toBe("processing");
    expect(await statusesOf(job.id)).toEqual(["ready", "failed"]);
  });

  it("is indistinguishable from a job that doesn't exist", async () => {
    await makeShop(SHOP);
    for (const res of [await getJob("nope"), await getItems("nope"), await retry("nope"), await cancel("nope")]) {
      expect(res).toMatchObject({ status: 404, body: { error: "Job not found" } });
    }
  });
});
