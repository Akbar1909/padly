/**
 * Result reuse, the true-original backup after an earlier apply, and the API's by-id read with
 * auto-start. Real worker task code against Postgres, Redis and MinIO; Shopify and the image
 * service are mocked with undici's MockAgent.
 */
import { createHash } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher, type Dispatcher } from "undici";
import prisma from "../../app/db.server";
import { JobFilterSchema } from "../../app/lib/filters";
import { resetGpuPipelineCache, type GpuProcessRequest } from "../../app/lib/gpu.server";
import { createJob } from "../../app/lib/jobs.server";
import { findReusableResult } from "../../app/lib/reuse.server";
import { DEFAULT_PRESET, type PresetSettings } from "../../app/lib/presets";
import { itemsQueue, jobsQueue } from "../../app/lib/queue.server";
import { redis } from "../../app/lib/redis.server";
import { deletePrefix, getObjectBuffer, keys, putObject } from "../../app/lib/storage.server";
import { runItemTask } from "../../worker/tasks/items";
import { readJob } from "../../worker/tasks/jobs";
import { captureLogs, makeJob, makeShop, resetState } from "./helpers";

const SHOP = "reuse-test.myshopify.com";
const GPU_URL = process.env.GPU_SERVICE_URL!;
const json = { headers: { "content-type": "application/json" } };
const MEDIA = "gid://shopify/MediaImage/777";
const ORIGINAL = Buffer.from("original-jpeg-bytes");
const OUTPUT = Buffer.from("our-processed-output-bytes");
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

let agent: MockAgent;
let previous: Dispatcher;
let gpuRequests: GpuProcessRequest[];
let cdnFetches: number;
/** What Shopify currently serves for the image (bytes and reported size). */
let live: { body: Buffer; fileSize: number; fileStatus: string };
let shopId: string;
let ops: string[];
/** What the image service's /healthz says (its pipeline), and how it answers. */
let health: { status: number; body: Record<string, unknown> };
/** Overrides for the `processing` record the mocked image service returns. */
let processing: Record<string, unknown>;
/** Flags the mocked image service returns (none: a READY result, the only kind reused). */
let flags: Array<{ code: string; severity: string; message: string }>;

const HEALTH = {
  ok: true,
  backend: "local",
  device: "cpu",
  models_loaded: ["segmentation", "upscaler_x2", "text_detector"],
  text_detector: "east",
  fallback_backend: null,
  escalation_backend: "replicate",
};

function graphql(body: { query: string; variables?: Record<string, unknown> }) {
  const op = /(?:query|mutation)\s+(\w+)/.exec(body.query)?.[1] ?? "anonymous";
  const v = body.variables ?? {};
  ops.push(op);
  switch (op) {
    case "LiveMedia":
      return {
        node: {
          id: v.id,
          alt: null,
          fileStatus: live.fileStatus,
          mimeType: "image/jpeg",
          image: { url: "https://cdn.test/p.jpg?v=1", width: 800, height: 800 },
          originalSource: { url: "https://cdn.test/p.jpg", fileSize: live.fileSize },
          fileErrors: [],
        },
      };
    case "ReadProductsByIds": {
      const image = (id: number) => ({
        id: `gid://shopify/MediaImage/${id}`,
        mediaContentType: "IMAGE",
        status: "READY",
        alt: null,
        mimeType: "image/jpeg",
        image: { url: `https://cdn.test/${id}.jpg`, width: 800, height: 800 },
        originalSource: { url: `https://cdn.test/${id}.jpg`, fileSize: 10 },
      });
      return {
        nodes: (v.ids as string[]).map((id) =>
          id === "gid://shopify/Product/100"
            ? {
                id,
                title: "Blue mug",
                media: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [{ id: "gid://shopify/Video/1", mediaContentType: "VIDEO", status: "READY" }, image(200), image(201)],
                },
              }
            : null,
        ),
      };
    }
    default:
      throw new Error(`Unmocked Shopify operation ${op}`);
  }
}

beforeEach(async () => {
  await resetState();
  previous = getGlobalDispatcher();
  agent = new MockAgent();
  agent.disableNetConnect();
  agent.enableNetConnect(/localhost|127\.0\.0\.1/);
  setGlobalDispatcher(agent);
  gpuRequests = [];
  cdnFetches = 0;
  ops = [];
  live = { body: ORIGINAL, fileSize: ORIGINAL.length, fileStatus: "READY" };
  health = { status: 200, body: HEALTH };
  processing = {};
  flags = [];
  resetGpuPipelineCache();

  agent
    .get(new URL(GPU_URL).origin)
    .intercept({ path: "/healthz", method: "GET" })
    .reply(() => ({ statusCode: health.status, data: health.body, responseOptions: json }))
    .persist();
  agent
    .get(`https://${SHOP}`)
    .intercept({ path: /\/admin\/api\/2026-07\/graphql\.json/, method: "POST" })
    .reply((opts) => ({ statusCode: 200, data: { data: graphql(JSON.parse(String(opts.body))) }, responseOptions: json }))
    .persist();
  agent
    .get("https://cdn.test")
    .intercept({ path: "/p.jpg", method: "GET" })
    .reply(() => {
      cdnFetches++;
      return { statusCode: 200, data: live.body, responseOptions: { headers: { "content-type": "image/jpeg" } } };
    })
    .persist();
  agent
    .get(new URL(GPU_URL).origin)
    .intercept({ path: "/v1/process", method: "POST" })
    .reply((opts) => {
      const req = JSON.parse(String(opts.body)) as GpuProcessRequest;
      gpuRequests.push(req);
      return {
        statusCode: 200,
        responseOptions: json,
        data: {
          request_id: req.request_id,
          output: { width: 2048, height: 2048, bytes: OUTPUT.length, format: "JPEG", content_type: "image/jpeg" },
          source: { width: 800, height: 800, format: "JPEG", mode: "RGB", icc_converted: false },
          upscale: { eligible: false, applied: false, method: "none", scale: 1, reason: "" },
          flags,
          metrics: { coverage: 0.4 },
          fidelity: null,
          models: { segmentation: "birefnet-lite" },
          timings_ms: { total: 1500 },
          processing: {
            operations: ["decode", "background_removal", "canvas", "export"],
            method: "local",
            replicate_used: false,
            replicate_calls: 0,
            replicate_models: [],
            estimated_cost_usd: 0,
            fallback_reason: null,
            quality_score: 0.9,
            quality_checks: {},
            attempts: [],
            ...processing,
          },
        },
      };
    })
    .persist();

  const shop = await makeShop(SHOP, 25);
  shopId = shop.id;
  await prisma.session.create({
    data: { id: `offline_${SHOP}`, shop: SHOP, state: "", accessToken: "shpat_test", expires: new Date(Date.now() + 3600_000) },
  });
});

afterEach(async () => {
  await agent.close();
  setGlobalDispatcher(previous);
  await deletePrefix(keys.shopPrefix(shopId));
});

afterAll(async () => {
  await itemsQueue().close();
  await jobsQueue().close();
  await redis().quit();
  await prisma.$disconnect();
});

/** One image of MEDIA in a processing job, run through the real process task. */
async function processMedia(preset: PresetSettings = DEFAULT_PRESET) {
  const { job, items } = await makeJob(shopId, [{ status: "processing", reserved: 1, mediaId: MEDIA }], "processing", preset);
  const { lines } = await captureLogs(() =>
    runItemTask({ kind: "process", itemId: items[0].id, jobId: job.id, shopId }, { attempt: 2 }),
  );
  const item = await prisma.jobItem.findUniqueOrThrow({ where: { id: items[0].id } });
  return { job, item, lines };
}

/** What the image service would have uploaded through its presigned URLs. */
async function storeArtifacts(item: { outputKey: string | null; previewKey: string | null }) {
  await putObject(item.outputKey!, OUTPUT, "image/jpeg");
  await putObject(item.previewKey!, Buffer.from("preview"), "image/jpeg");
}

describe("reusing identical results", () => {
  it("copies an earlier result for the same source bytes and settings instead of calling the image service", async () => {
    const first = await processMedia();
    expect(gpuRequests).toHaveLength(1);
    expect(first.item).toMatchObject({ status: "ready", sourceSha256: sha(ORIGINAL) });
    expect(first.item.resultKey).toMatch(/^[0-9a-f]{64}$/);
    expect(first.item.processing).toMatchObject({ method: "local", attempt: 2, duration_ms: 1500 });
    expect((await getObjectBuffer(first.item.backupKey!)).equals(ORIGINAL)).toBe(true);
    const completed = first.lines.find((l) => l.msg === "IMAGE_JOB_COMPLETED");
    expect(completed).toMatchObject({ kind: "process", method: "local", reused: false, gpuMs: 1500, attempt: 2 });
    expect(first.lines.find((l) => l.msg === "IMAGE_JOB_STARTED")).toMatchObject({ itemId: first.item.id, attempt: 2 });
    await storeArtifacts(first.item);

    const second = await processMedia();
    expect(gpuRequests).toHaveLength(1); // no second image-service call
    expect(second.item).toMatchObject({
      status: "ready",
      resultKey: first.item.resultKey,
      sourceSha256: first.item.sourceSha256,
      outputKey: first.item.outputKey,
      previewKey: first.item.previewKey,
      outputFormat: "jpeg",
      outputWidth: 2048,
      creditsReserved: 1,
      errorCode: null,
    });
    expect(second.item.flags).toEqual(first.item.flags);
    expect(second.item.processing).toMatchObject({
      method: "reused",
      reused_from: first.item.id,
      estimated_cost_usd: 0,
      replicate_calls: 0,
    });
    expect(second.lines.find((l) => l.msg === "IMAGE_JOB_COMPLETED")).toMatchObject({
      reused: true,
      method: "reused",
      estimated_usd: 0,
      reusedFrom: first.item.id,
    });

    // Different settings: a new result.
    const third = await processMedia({ ...DEFAULT_PRESET, marginPct: 12 });
    expect(gpuRequests).toHaveLength(2);
    expect(third.item.resultKey).not.toBe(first.item.resultKey);
  });

  it("never reuses a flagged result (it needed the merchant's review)", async () => {
    flags = [{ code: "text_detected", severity: "warning", message: "text" }];
    const first = await processMedia();
    expect(first.item.status).toBe("flagged");
    await storeArtifacts(first.item);
    const second = await processMedia();
    expect(gpuRequests).toHaveLength(2);
    expect(second.item.processing).toMatchObject({ method: "local" });
  });

  it("doesn't reuse a result whose files are gone", async () => {
    await processMedia(); // artifacts never uploaded
    await processMedia();
    expect(gpuRequests).toHaveLength(2);
  });

  it("never reuses a result the merchant rejected, or a copy of it", async () => {
    const first = await processMedia();
    await storeArtifacts(first.item);
    const copy = await processMedia();
    expect(copy.item.processing).toMatchObject({ method: "reused", reused_from: first.item.id });
    expect(gpuRequests).toHaveLength(1);

    // Rejecting the copy rules out its source too: they share the output.
    await prisma.jobItem.update({ where: { id: copy.item.id }, data: { status: "rejected" } });
    const fresh = await processMedia();
    expect(gpuRequests).toHaveLength(2);
    expect(fresh.item.resultKey).toBe(first.item.resultKey);
    expect(fresh.item.outputKey).not.toBe(first.item.outputKey);

    // The fresh result, never rejected, is reusable again.
    await storeArtifacts(fresh.item);
    const again = await processMedia();
    expect(gpuRequests).toHaveLength(2);
    expect(again.item.processing).toMatchObject({ method: "reused", reused_from: fresh.item.id });
  });

  it("never reuses a degraded result (the paid model was wanted but unavailable or capped)", async () => {
    processing = { fallback_reason: "background_artifacts (not escalated: daily_cap)" };
    const capped = await processMedia();
    await storeArtifacts(capped.item);
    processing = { fallback_reason: "replicate_unavailable", replicate_used: true, replicate_calls: 1 };
    const unavailable = await processMedia();
    await storeArtifacts(unavailable.item);
    expect(gpuRequests).toHaveLength(2);

    // A good result (escalated, and the paid model ran) is reused.
    processing = { method: "local+replicate", fallback_reason: "background_artifacts", replicate_used: true, replicate_calls: 1 };
    const escalated = await processMedia();
    await storeArtifacts(escalated.item);
    expect(gpuRequests).toHaveLength(3);
    const next = await processMedia();
    expect(gpuRequests).toHaveLength(3);
    expect(next.item.processing).toMatchObject({ method: "reused", reused_from: escalated.item.id });
  });

  it("never reuses a result made by another image-service pipeline", async () => {
    const first = await processMedia();
    await storeArtifacts(first.item);
    health = { status: 200, body: { ...HEALTH, models_loaded: ["segmentation_v2", "upscaler_x2", "text_detector"] } };
    resetGpuPipelineCache();
    const second = await processMedia();
    expect(gpuRequests).toHaveLength(2);
    expect(second.item.resultKey).toMatch(/^[0-9a-f]{64}$/);
    expect(second.item.resultKey).not.toBe(first.item.resultKey);
  });

  it("processes without a result key while the pipeline can't be read", async () => {
    health = { status: 503, body: {} };
    const first = await processMedia();
    expect(first.item).toMatchObject({ status: "ready", resultKey: null, sourceSha256: sha(ORIGINAL) });
    await storeArtifacts(first.item);
    await processMedia();
    expect(gpuRequests).toHaveLength(2);
  });

  it("never reuses another shop's result", async () => {
    const first = await processMedia();
    await storeArtifacts(first.item);
    const other = await makeShop("reuse-other.myshopify.com", 25);
    const { items } = await makeJob(other.id, [{ status: "processing", mediaId: MEDIA }], "processing");
    const pipeline = { backend: "local", escalation: "replicate" };
    expect(await findReusableResult(other.id, items[0].id, first.item.resultKey!, pipeline)).toBeNull();
    expect((await findReusableResult(shopId, items[0].id, first.item.resultKey!, pipeline))?.id).toBe(first.item.id);
  });
});

describe("backing up the true original", () => {
  it("reuses the backup of the applied job when the live image is our own output", async () => {
    const first = await processMedia();
    await storeArtifacts(first.item);
    // The first job applied its result: Shopify now serves our output.
    await prisma.jobItem.update({ where: { id: first.item.id }, data: { status: "applied", appliedAt: new Date() } });
    await prisma.job.update({ where: { id: first.job.id }, data: { status: "done" } });
    live = { body: OUTPUT, fileSize: OUTPUT.length, fileStatus: "READY" };
    cdnFetches = 0;

    const second = await processMedia({ ...DEFAULT_PRESET, marginPct: 12 });
    expect(cdnFetches).toBe(0); // our output was not downloaded as an "original"
    expect(second.item).toMatchObject({
      backupKey: first.item.backupKey,
      sourceSha256: sha(ORIGINAL),
      fileSize: OUTPUT.length, // the live file, for apply's "changed in Shopify" check
    });
    // The image service works from the true original.
    expect(gpuRequests.at(-1)!.source_url).toContain(new URL(`http://x/${first.item.backupKey}`).pathname);
  });

  it("backs up the live image when the merchant replaced it since", async () => {
    const first = await processMedia();
    await storeArtifacts(first.item);
    await prisma.jobItem.update({ where: { id: first.item.id }, data: { status: "applied", appliedAt: new Date() } });
    const replaced = Buffer.from("merchant-uploaded-a-new-photo");
    live = { body: replaced, fileSize: replaced.length, fileStatus: "READY" };

    const second = await processMedia();
    expect(second.item.backupKey).not.toBe(first.item.backupKey);
    expect(second.item.sourceSha256).toBe(sha(replaced));
    expect((await getObjectBuffer(second.item.backupKey!)).equals(replaced)).toBe(true);
    expect(gpuRequests).toHaveLength(2); // different source: no reuse
  });

  it("retries later while Shopify is still processing the file", async () => {
    live = { ...live, fileStatus: "PROCESSING" };
    const { job, items } = await makeJob(shopId, [{ status: "processing", reserved: 1, mediaId: MEDIA }], "processing");
    const error = await runItemTask({ kind: "process", itemId: items[0].id, jobId: job.id, shopId }).catch((e: unknown) => e);
    expect(error).toMatchObject({ retryable: true, code: "source_not_ready" });
    expect(gpuRequests).toHaveLength(0);
  });
});

describe("API jobs: named products, auto-start", () => {
  it("reads the named products by id and starts processing on its own", async () => {
    const filter = JobFilterSchema.parse({ productIds: ["100", "404"], imageScope: "all" });
    const job = await createJob(shopId, filter, DEFAULT_PRESET, { requestKey: "api-1", autoStart: true, source: "api" });
    await readJob(job.id);
    expect(ops).toEqual(["ReadProductsByIds"]); // no product search, no bulk operation
    const items = await prisma.jobItem.findMany({ where: { jobId: job.id }, orderBy: { position: "asc" } });
    expect(items.map((i) => [i.mediaId, i.position, i.productTitle])).toEqual([
      ["gid://shopify/MediaImage/200", 1, "Blue mug"],
      ["gid://shopify/MediaImage/201", 2, "Blue mug"],
    ]);
    const row = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(row).toMatchObject({ status: "processing", autoStart: true, phaseTotal: 2, requestKey: "api-1" });
    const tasks = await itemsQueue().getJobs(["waiting", "prioritized"]);
    expect(tasks.map((t) => t.data.kind)).toEqual(["process", "process"]);
  });
});
