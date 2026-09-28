/**
 * The quoted cost is a ceiling: processing may lower an image's reservation
 * (upscaling didn't run) but never raise it, and applying never charges more
 * than was reserved. Runs the real worker task code against Postgres, Redis
 * and MinIO; Shopify and the image service are mocked with undici's MockAgent.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher, type Dispatcher } from "undici";
import prisma from "../../app/db.server";
import { getCreditSummary } from "../../app/lib/credits.server";
import type { GpuProcessRequest } from "../../app/lib/gpu.server";
import { DEFAULT_PRESET } from "../../app/lib/presets";
import { itemsQueue, jobsQueue } from "../../app/lib/queue.server";
import { redis } from "../../app/lib/redis.server";
import { deletePrefix, keys, putObject } from "../../app/lib/storage.server";
import { runItemTask } from "../../worker/tasks/items";
import { makeJob, makeShop, resetState } from "./helpers";

const SHOP = "credits-test.myshopify.com";
const GPU_URL = process.env.GPU_SERVICE_URL!;
const json = { headers: { "content-type": "application/json" } };
const UPSCALING = { ...DEFAULT_PRESET, upscale: true, upscaleThresholdPx: 1200 };

let agent: MockAgent;
let previous: Dispatcher;
let gpuRequests: GpuProcessRequest[];
/** What the image service reports: null = upscale exactly when asked. */
let upscaleOutcome: boolean | null;
let shopId: string;

beforeEach(async () => {
  await resetState();
  previous = getGlobalDispatcher();
  agent = new MockAgent();
  agent.disableNetConnect();
  agent.enableNetConnect(/localhost/);
  setGlobalDispatcher(agent);
  gpuRequests = [];
  upscaleOutcome = null;

  // Shopify: the live image (800 px, under the upscaling threshold) and its original file.
  agent
    .get(`https://${SHOP}`)
    .intercept({ path: /\/admin\/api\/2026-07\/graphql\.json/, method: "POST" })
    .reply((opts) => {
      const { variables } = JSON.parse(String(opts.body)) as { variables: { id: string } };
      const node = {
        id: variables.id,
        alt: null,
        fileStatus: "READY",
        mimeType: "image/jpeg",
        image: { url: "https://cdn.test/p.jpg?v=1", width: 800, height: 800 },
        originalSource: { url: "https://cdn.test/p.jpg", fileSize: 5 },
        fileErrors: [],
      };
      return { statusCode: 200, data: { data: { node } }, responseOptions: json };
    })
    .persist();
  agent.get("https://cdn.test").intercept({ path: "/p.jpg", method: "GET" }).reply(200, "jpeg!").persist();

  // Image service: records what it was asked and reports upscaling as the test says.
  agent
    .get(new URL(GPU_URL).origin)
    .intercept({ path: "/v1/process", method: "POST" })
    .reply((opts) => {
      const req = JSON.parse(String(opts.body)) as GpuProcessRequest;
      gpuRequests.push(req);
      const applied = upscaleOutcome ?? req.settings.upscale;
      return {
        statusCode: 200,
        responseOptions: json,
        data: {
          request_id: req.request_id,
          output: { width: 2048, height: 2048, bytes: 1000, format: "JPEG", content_type: "image/jpeg" },
          source: { width: 800, height: 800, format: "JPEG", mode: "RGB", icc_converted: false },
          upscale: { eligible: true, applied, method: applied ? "ai" : "lanczos", scale: 2, reason: "" },
          flags: [],
          metrics: {},
          fidelity: null,
          models: {},
          timings_ms: {},
        },
      };
    })
    .persist();

  const shop = await makeShop(SHOP, 1);
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

async function processing(reserved: number) {
  const { job, items } = await makeJob(shopId, [{ status: "processing", reserved, eligible: reserved > 1 }], "processing", UPSCALING);
  const task = { kind: "process" as const, itemId: items[0].id, jobId: job.id, shopId };
  await runItemTask(task);
  return { job, item: await prisma.jobItem.findUniqueOrThrow({ where: { id: items[0].id } }) };
}

describe("credits never exceed the quote", () => {
  it("doesn't ask for AI upscaling the reservation doesn't cover", async () => {
    // Read at 1600 px (no upscaling, 1 credit); the live image is now 800 px.
    const { item } = await processing(1);
    expect(gpuRequests).toHaveLength(1);
    expect(gpuRequests[0].settings.upscale).toBe(false);
    expect(item).toMatchObject({ status: "ready", upscaleApplied: false, creditsReserved: 1 });
  });

  it("asks for upscaling when reserved, and keeps 2 credits only if it ran", async () => {
    let { item } = await processing(2);
    expect(gpuRequests[0].settings.upscale).toBe(true);
    expect(item).toMatchObject({ upscaleApplied: true, creditsReserved: 2 });

    upscaleOutcome = false; // e.g. text detected: Lanczos instead of AI
    ({ item } = await processing(2));
    expect(gpuRequests[1].settings.upscale).toBe(true);
    expect(item).toMatchObject({ upscaleApplied: false, creditsReserved: 1 });
  });

  it("charges at most the reservation on apply, so the balance never goes negative", async () => {
    // Even if upscaling ran anyway, the item keeps its 1-credit reservation…
    upscaleOutcome = true;
    const { job, item } = await processing(1);
    expect(item).toMatchObject({ upscaleApplied: true, creditsReserved: 1 });

    // …and applying charges 1, not 2. (appliedAt set: the Shopify write already
    // happened, as on a retry after a crash; only the bookkeeping runs.)
    await putObject(item.backupKey!, Buffer.from("jpeg!"), "image/jpeg");
    await prisma.job.update({ where: { id: job.id }, data: { status: "applying" } });
    await prisma.jobItem.update({
      where: { id: item.id },
      data: { status: "applying", outputFormat: "jpeg", appliedAt: new Date() },
    });
    await runItemTask({ kind: "apply", itemId: item.id, jobId: job.id, shopId });

    const applied = await prisma.jobItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(applied).toMatchObject({ status: "applied", creditsCharged: 1, creditsReserved: 0 });
    expect(await getCreditSummary(shopId)).toEqual({ balance: 0, reserved: 0, available: 0 });
  });
});
