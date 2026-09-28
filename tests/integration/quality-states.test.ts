/**
 * Final statuses (READY / NEEDS_REVIEW / NO_CHANGE), "Retry with stronger model", READY-only
 * reuse and the metrics endpoint. Real worker task code, job logic and routes against
 * Postgres, Redis and MinIO; Shopify and the image service are mocked with undici's MockAgent,
 * and authentication is faked at authenticate.admin (a "Bearer test-session:<shop>" token).
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher, type Dispatcher } from "undici";
import prisma from "../../app/db.server";
import { getCreditSummary, InsufficientCreditsError } from "../../app/lib/credits.server";
import { resetEnvCache } from "../../app/lib/env.server";
import { resetGpuPipelineCache, type GpuFlag, type GpuProcessRequest } from "../../app/lib/gpu.server";
import {
  applyApproved,
  approveAllUnflagged,
  decideItems,
  finishJob,
  JobStateError,
  refreshJobState,
  retryStronger,
} from "../../app/lib/jobs.server";
import { DEFAULT_PRESET } from "../../app/lib/presets";
import { summarizeProcessing, type ProcessingRecord } from "../../app/lib/processing";
import { itemsQueue, jobsQueue } from "../../app/lib/queue.server";
import { redis } from "../../app/lib/redis.server";
import { deletePrefix, getObjectBuffer, keys, putObject } from "../../app/lib/storage.server";
import { loader as itemsLoader } from "../../app/routes/api.image-jobs.$jobId_.items";
import {
  action as retryStrongerAction,
  loader as retryStrongerLoader,
} from "../../app/routes/api.image-jobs.$jobId_.retry-stronger";
import { action as metricsAction, loader as metricsLoader } from "../../app/routes/internal.metrics";
import { runItemTask } from "../../worker/tasks/items";
import { captureLogs, flag, makeJob, makeShop, resetState, statusesOf } from "./helpers";

vi.mock("../../app/shopify.server", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../app/shopify.server")>();
  return {
    ...original,
    authenticate: {
      ...original.authenticate,
      admin: async (request: Request) => {
        const token = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
        if (!token.startsWith("test-session:")) {
          throw new Response(undefined, { status: 401, statusText: "Unauthorized" });
        }
        return { session: { shop: token.slice("test-session:".length) }, cors: (r: Response) => r };
      },
    },
  };
});

const SHOP = "quality-states.myshopify.com";
const GPU_URL = process.env.GPU_SERVICE_URL!;
const json = { headers: { "content-type": "application/json" } };
const ORIGINAL = Buffer.from("original-jpeg-bytes");
const HEALTH = {
  ok: true,
  backend: "local",
  device: "cpu",
  models_loaded: ["segmentation", "upscaler_x2", "text_detector"],
  text_detector: "east",
  fallback_backend: null,
  escalation_backend: "replicate",
  pipeline_version: "2026-09-28.1+test",
};

/** How the mocked image service answers: flags and processing overrides. */
interface Answer {
  flags?: GpuFlag[];
  processing?: Record<string, unknown>;
}

const READY: Answer = {
  processing: {
    route: "local",
    local_attempted: true,
    local_accepted: true,
    gate: "SAFE_LOCAL",
    ai_gate: null,
    reason_codes: [],
    replicate_attempts: 0,
    final_status: "READY",
  },
};
const NEEDS_REVIEW: Answer = {
  flags: [flag("cutout_check")],
  processing: {
    method: "replicate",
    route: "local_then_replicate",
    local_attempted: true,
    local_accepted: false,
    gate: "UNCERTAIN",
    ai_gate: "UNSAFE",
    reason_codes: ["LOW_SEGMENTATION_CONFIDENCE", "AI_RESULT_UNSAFE"],
    replicate_used: true,
    replicate_calls: 1,
    replicate_attempts: 1,
    estimated_cost_usd: 0.0011,
    final_status: "NEEDS_REVIEW",
  },
};
const NO_CHANGE: Answer = {
  processing: {
    method: "deterministic",
    route: "no_change",
    local_attempted: false,
    local_accepted: false,
    gate: null,
    ai_gate: null,
    reason_codes: [],
    replicate_attempts: 0,
    final_status: "NO_CHANGE",
    analysis: { already_acceptable: true, recommended_route: "no_change", analysis_confidence: 0.97 },
  },
};
const FORCED_READY: Answer = {
  processing: {
    method: "replicate",
    route: "replicate",
    local_attempted: false,
    local_accepted: false,
    gate: null,
    ai_gate: "PASS",
    reason_codes: ["FORCED_BY_MERCHANT"],
    replicate_used: true,
    replicate_calls: 1,
    replicate_attempts: 1,
    estimated_cost_usd: 0.0009,
    final_status: "READY",
    attempts: [
      { operation: "background_removal", method: "replicate", model: "birefnet", duration_ms: 800, cost_usd: 0.0009, outcome: "used" },
    ],
  },
};

let agent: MockAgent;
let previous: Dispatcher;
let gpuRequests: GpuProcessRequest[];
/** Per item id; `answer` for the rest. */
let answers: Map<string, Answer>;
let answer: Answer;
let shopId: string;

beforeEach(async () => {
  await resetState();
  previous = getGlobalDispatcher();
  agent = new MockAgent();
  agent.disableNetConnect();
  agent.enableNetConnect(/localhost|127\.0\.0\.1/);
  setGlobalDispatcher(agent);
  gpuRequests = [];
  answers = new Map();
  answer = READY;
  resetGpuPipelineCache();

  const gpu = agent.get(new URL(GPU_URL).origin);
  gpu
    .intercept({ path: "/healthz", method: "GET" })
    .reply(() => ({ statusCode: 200, data: HEALTH, responseOptions: json }))
    .persist();
  gpu
    .intercept({ path: "/v1/process", method: "POST" })
    .reply((opts) => {
      const req = JSON.parse(String(opts.body)) as GpuProcessRequest;
      gpuRequests.push(req);
      const a = answers.get(req.request_id) ?? answer;
      return {
        statusCode: 200,
        responseOptions: json,
        data: {
          request_id: req.request_id,
          output: { width: 2048, height: 2048, bytes: 100, format: "JPEG", content_type: "image/jpeg" },
          source: { width: 800, height: 800, format: "JPEG", mode: "RGB", icc_converted: false },
          upscale: { eligible: false, applied: false, method: "none", scale: 1, reason: "" },
          flags: a.flags ?? [],
          metrics: {},
          fidelity: null,
          models: { segmentation: "birefnet-lite" },
          timings_ms: { total: 1200 },
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
            quality_scores: { segmentation_confidence: 0.9, product_retention: 0.95, geometry: 1, artifact: 0.9, fidelity: null },
            shadow: null,
            ...a.processing,
          },
        },
      };
    })
    .persist();
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
        originalSource: { url: "https://cdn.test/p.jpg", fileSize: ORIGINAL.length },
        fileErrors: [],
      };
      return { statusCode: 200, data: { data: { node } }, responseOptions: json };
    })
    .persist();
  agent
    .get("https://cdn.test")
    .intercept({ path: "/p.jpg", method: "GET" })
    .reply(() => ({ statusCode: 200, data: ORIGINAL, responseOptions: { headers: { "content-type": "image/jpeg" } } }))
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
  delete process.env.METRICS_TOKEN;
  resetEnvCache();
});

afterAll(async () => {
  await itemsQueue().close();
  await jobsQueue().close();
  await redis().quit();
  await prisma.$disconnect();
});

const task = (item: { id: string; jobId: string }) => ({ kind: "process" as const, itemId: item.id, jobId: item.jobId, shopId });

/** A processing job with one image per answer, each run through the real process task. */
async function processJob(list: Answer[], mediaIds?: string[], preset = DEFAULT_PRESET) {
  const { job, items } = await makeJob(
    shopId,
    list.map((_, i) => ({ status: "processing" as const, reserved: 1, ...(mediaIds ? { mediaId: mediaIds[i] } : {}) })),
    "processing",
    preset,
  );
  items.forEach((item, i) => answers.set(item.id, list[i]));
  const { lines } = await captureLogs(async () => {
    for (const item of items) await runItemTask(task(item));
  });
  await refreshJobState(job.id);
  const rows = await prisma.jobItem.findMany({ where: { jobId: job.id }, orderBy: { productId: "asc" } });
  return { job, items: rows, lines };
}

/** What the image service would have uploaded through its presigned URLs. */
async function storeArtifacts(item: { outputKey: string | null; previewKey: string | null }, body = "output") {
  await putObject(item.outputKey!, Buffer.from(body), "image/jpeg");
  await putObject(item.previewKey!, Buffer.from("preview"), "image/jpeg");
}

// ─── Route helpers ──────────────────────────────────────────────────────────

type Handler = (args: LoaderFunctionArgs & ActionFunctionArgs) => Response | Promise<Response>;

async function call(handler: Handler, method: string, path: string, opts: { auth?: string | null; params?: Record<string, string>; body?: unknown } = {}) {
  const auth = opts.auth === undefined ? `Bearer test-session:${SHOP}` : opts.auth;
  const request = new Request(`https://vio.example.com${path}`, {
    method,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    headers: { ...(auth ? { Authorization: auth } : {}), ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}) },
  });
  let response: Response;
  try {
    response = await handler({ request, params: opts.params ?? {}, context: {} } as LoaderFunctionArgs & ActionFunctionArgs);
  } catch (thrown) {
    if (!(thrown instanceof Response)) throw thrown;
    response = thrown;
  }
  const text = await response.text();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  return { status: response.status, headers: response.headers, body };
}

// ─── Final statuses ─────────────────────────────────────────────────────────

describe("final statuses from the image service", () => {
  it("stores READY as ready, NEEDS_REVIEW as flagged, NO_CHANGE as unchanged, and logs route, gate and reasons", async () => {
    const needsReviewNoFlag: Answer = { processing: { ...NEEDS_REVIEW.processing } };
    const legacy: Answer = { flags: [flag("text_detected")], processing: {} };
    const { job, items, lines } = await processJob([READY, NEEDS_REVIEW, NO_CHANGE, needsReviewNoFlag, legacy]);
    const [ready, review, unchanged, reviewNoFlag, older] = items;

    expect(ready).toMatchObject({ status: "ready", flags: [] });
    expect(review).toMatchObject({ status: "flagged", flags: [flag("cutout_check")] });
    expect(unchanged).toMatchObject({ status: "unchanged", flags: [] });
    // A flagged image always says why.
    expect(reviewNoFlag.status).toBe("flagged");
    expect(reviewNoFlag.flags).toEqual([expect.objectContaining({ code: "needs_review" })]);
    // An older image service (no final_status): flags decide, as before.
    expect(older).toMatchObject({ status: "flagged" });
    // The whole record is stored, new fields included.
    expect(review.processing).toMatchObject({
      route: "local_then_replicate",
      gate: "UNCERTAIN",
      ai_gate: "UNSAFE",
      reason_codes: ["LOW_SEGMENTATION_CONFIDENCE", "AI_RESULT_UNSAFE"],
      final_status: "NEEDS_REVIEW",
      quality_scores: { segmentation_confidence: 0.9 },
      duration_ms: 1200,
    });
    expect(unchanged.processing).toMatchObject({ final_status: "NO_CHANGE", analysis: { already_acceptable: true } });
    // Nothing forced: the request says so explicitly.
    expect(gpuRequests.every((r) => r.settings.force_escalation === false)).toBe(true);

    const completed = lines.filter((l) => l.msg === "IMAGE_JOB_COMPLETED");
    expect(completed.find((l) => l.itemId === review.id)).toMatchObject({
      route: "local_then_replicate",
      gate: "UNCERTAIN",
      ai_gate: "UNSAFE",
      final_status: "NEEDS_REVIEW",
      reason_codes: ["LOW_SEGMENTATION_CONFIDENCE", "AI_RESULT_UNSAFE"],
    });
    expect(completed.find((l) => l.itemId === unchanged.id)).toMatchObject({ status: "unchanged", route: "no_change", final_status: "NO_CHANGE" });
    expect(completed.find((l) => l.itemId === older.id)).toMatchObject({ final_status: "NEEDS_REVIEW" });
    const success = lines.filter((l) => l.msg === "PROCESSING_SUCCESS");
    expect(success.find((l) => l.itemId === ready.id)).toMatchObject({ route: "local", gate: "SAFE_LOCAL", final_status: "READY" });
    expect(success.find((l) => l.itemId === review.id)).toMatchObject({ reason_codes: ["LOW_SEGMENTATION_CONFIDENCE", "AI_RESULT_UNSAFE"] });

    // The job waits in review; the processing summary log has the verdicts.
    expect((await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("review");
  });

  it("never approves, applies or charges an unchanged image, and holds no reservation for it", async () => {
    const { job, items } = await processJob([NO_CHANGE, NO_CHANGE]);
    expect(items.map((i) => i.status)).toEqual(["unchanged", "unchanged"]);
    const job1 = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(job1.status).toBe("review"); // "Retry with stronger model" stays possible
    expect(job1).toMatchObject({ done: 2, failed: 0 }); // counted as processed
    expect(await getCreditSummary(shopId)).toEqual({ balance: 25, reserved: 0, available: 25 });

    expect(await approveAllUnflagged(shopId, job.id)).toBe(0);
    expect(await decideItems(shopId, job.id, items.map((i) => i.id), "approve")).toBe(0);
    expect(await decideItems(shopId, job.id, items.map((i) => i.id), "reject")).toBe(0);
    await expect(applyApproved(shopId, job.id)).rejects.toThrow("Approve at least one image first.");
    await finishJob(shopId, job.id);
    expect(await statusesOf(job.id)).toEqual(["unchanged", "unchanged"]);
    expect(await prisma.creditLedger.count({ where: { shopId, reason: "apply" } })).toBe(0);
    expect(await getCreditSummary(shopId)).toEqual({ balance: 25, reserved: 0, available: 25 });
  });

  it("bulk approve takes READY images only: never NEEDS_REVIEW or unchanged ones", async () => {
    const { job, items } = await processJob([READY, NEEDS_REVIEW, NO_CHANGE, READY]);
    expect(await approveAllUnflagged(shopId, job.id)).toBe(2);
    expect(items.map((i) => i.id)).toHaveLength(4);
    expect(await statusesOf(job.id)).toEqual(["approved", "flagged", "unchanged", "approved"]);
    // A second click finds nothing more; the flagged image needs the merchant's own decision.
    expect(await approveAllUnflagged(shopId, job.id)).toBe(0);
    expect(await statusesOf(job.id)).toEqual(["approved", "flagged", "unchanged", "approved"]);
    // Reserved: the approved and the flagged ones, not the unchanged one.
    expect((await getCreditSummary(shopId)).reserved).toBe(3);

    // Even a row that says ready but carries a flag, or a NEEDS_REVIEW verdict, is left alone.
    const { job: odd, items: oddItems } = await processJob([READY, READY, READY]);
    await prisma.jobItem.update({ where: { id: oddItems[0].id }, data: { flags: [flag("cutout_check")] } });
    await prisma.jobItem.update({
      where: { id: oddItems[1].id },
      data: { processing: { ...(oddItems[1].processing as object), final_status: "NEEDS_REVIEW" } },
    });
    expect(await approveAllUnflagged(shopId, odd.id)).toBe(1);
    expect(await statusesOf(odd.id)).toEqual(["ready", "ready", "approved"]);
  });

  it("shows finalStatus, route and reason codes on GET /api/image-jobs/:jobId/items", async () => {
    const { job, items } = await processJob([READY, NEEDS_REVIEW, NO_CHANGE]);
    await prisma.jobItem.create({
      data: {
        jobId: job.id,
        shopId,
        productId: "gid://shopify/Product/9",
        productTitle: "Product 9",
        mediaId: "gid://shopify/MediaImage/failed9",
        position: 0,
        originalUrl: "https://cdn.example.com/9.jpg",
        status: "failed",
        errorCode: "busy",
      },
    });
    const res = await call(itemsLoader, "GET", `/api/image-jobs/${job.id}/items`, { params: { jobId: job.id } });
    expect(res.status).toBe(200);
    const byId = new Map(res.body.items.map((i: { id: string }) => [i.id, i]));
    expect(byId.get(items[0].id)).toMatchObject({ status: "completed", reviewStatus: "ready", finalStatus: "READY", route: "local", reasonCodes: [], strongerModel: false });
    expect(byId.get(items[1].id)).toMatchObject({
      status: "completed",
      reviewStatus: "flagged",
      finalStatus: "NEEDS_REVIEW",
      flags: ["cutout_check"],
      reasonCodes: ["LOW_SEGMENTATION_CONFIDENCE", "AI_RESULT_UNSAFE"],
    });
    expect(byId.get(items[2].id)).toMatchObject({ status: "completed", reviewStatus: "unchanged", finalStatus: "NO_CHANGE", route: "no_change" });
    expect(res.body.items.find((i: { reviewStatus: string }) => i.reviewStatus === "failed")).toMatchObject({ status: "failed", finalStatus: "FAILED" });
    // ?status= takes the new internal status too.
    const clean = await call(itemsLoader, "GET", `/api/image-jobs/${job.id}/items?status=unchanged`, { params: { jobId: job.id } });
    expect(clean.body.items.map((i: { id: string }) => i.id)).toEqual([items[2].id]);
  });
});

// ─── Retry with stronger model ──────────────────────────────────────────────

describe("retry with stronger model", () => {
  it("sends ready, needs-review and unchanged images back with force_escalation, and processes them again", async () => {
    const { job, items } = await processJob([READY, NEEDS_REVIEW, NO_CHANGE, READY]);
    const [ready, review, unchanged, keep] = items;
    await decideItems(shopId, job.id, [keep.id], "approve");
    expect((await getCreditSummary(shopId)).reserved).toBe(3); // ready, flagged, approved
    const before = new Map(items.map((i) => [i.id, i]));

    const result = await retryStronger(shopId, job.id, [ready.id, review.id, unchanged.id, keep.id, "not-an-item"]);
    expect(result).toEqual({ retried: 3, skipped: 0, status: "processing" });
    const row = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(row).toMatchObject({ status: "processing", phaseTotal: 3, done: 0, failed: 0, completedAt: null });
    // The approved image keeps its decision; the unchanged one is reserved again at its price.
    expect((await getCreditSummary(shopId)).reserved).toBe(4);
    const queued = await prisma.jobItem.findMany({ where: { id: { in: [ready.id, review.id, unchanged.id] } } });
    for (const q of queued) {
      expect(["queued", "processing"]).toContain(q.status); // the pump claims them right away
      expect(q).toMatchObject({ forceEscalation: true, outputKey: null, previewKey: null, resultKey: null, flags: [], creditsReserved: 1 });
    }
    expect((await prisma.jobItem.findUniqueOrThrow({ where: { id: keep.id } })).status).toBe("approved");
    // Handed to the queue (pumpShop).
    const tasks = await itemsQueue().getJobs(["waiting", "prioritized"]);
    expect(tasks.map((t) => t.data.itemId).sort()).toEqual([ready.id, review.id, unchanged.id].sort());

    // A repeat is a no-op, not an error.
    expect(await retryStronger(shopId, job.id, [ready.id, review.id, unchanged.id])).toEqual({
      retried: 0,
      skipped: 0,
      status: "processing",
    });

    // The worker asks for the paid model first.
    answers.clear();
    answer = FORCED_READY;
    gpuRequests = [];
    for (const t of tasks) await runItemTask(t.data);
    expect(gpuRequests).toHaveLength(3);
    expect(gpuRequests.every((r) => r.settings.force_escalation === true)).toBe(true);
    await refreshJobState(job.id);
    expect((await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("review");

    const after = await prisma.jobItem.findMany({ where: { id: { in: [ready.id, review.id, unchanged.id] } } });
    for (const a of after) {
      expect(a.status).toBe("ready");
      // New files of its own: an earlier result another item may have reused is never overwritten.
      expect(a.outputKey).not.toBe(before.get(a.id)!.outputKey);
      expect(a.outputKey).toMatch(/\/output-s\d+\.jpg$/);
      const p = a.processing as unknown as ProcessingRecord;
      expect(p).toMatchObject({ reason_codes: ["FORCED_BY_MERCHANT"], final_status: "READY" });
      // The replaced run's cost still counts.
      expect(p.superseded_runs).toEqual([expect.objectContaining({ final_status: (before.get(a.id)!.processing as unknown as ProcessingRecord).final_status })]);
    }
    const s = summarizeProcessing(await prisma.jobItem.findMany({ where: { jobId: job.id } }));
    expect(s).toMatchObject({ forcedByMerchant: 3, supersededRuns: 3 });
    expect(s.estimatedUsd).toBeCloseTo(0.0011 + 3 * 0.0009, 8);
    // Nothing was charged: credits are only charged on apply.
    expect((await getCreditSummary(shopId)).balance).toBe(25);
  });

  it("works only in review, checks credits for already clean images, and skips images another job has", async () => {
    // Not in review (done): 409.
    const { job: done } = await makeJob(shopId, [{ status: "ready", reserved: 1 }], "done");
    const doneItem = await prisma.jobItem.findFirstOrThrow({ where: { jobId: done.id } });
    await expect(retryStronger(shopId, done.id, [doneItem.id])).rejects.toBeInstanceOf(JobStateError);
    // Nothing matching: nothing to do, whatever the job's status.
    expect(await retryStronger(shopId, done.id, ["nope"])).toMatchObject({ retried: 0 });
    // Another shop's job: not found.
    const other = await makeShop("quality-other.myshopify.com", 25);
    await expect(retryStronger(other.id, done.id, [doneItem.id])).rejects.toBeInstanceOf(JobStateError);

    // An already clean image holds no reservation: bringing it back needs a credit. This shop
    // has 1, and another job in review holds it.
    const poor = await makeShop("quality-poor.myshopify.com", 1);
    await makeJob(poor.id, [{ status: "ready", reserved: 1 }], "review");
    const { job, items } = await makeJob(
      poor.id,
      [{ status: "unchanged", reserved: 1, mediaId: "gid://shopify/MediaImage/shared" }],
      "review",
    );
    await expect(retryStronger(poor.id, job.id, [items[0].id])).rejects.toMatchObject({ needed: 1, available: 0 });
    await expect(retryStronger(poor.id, job.id, [items[0].id])).rejects.toBeInstanceOf(InsufficientCreditsError);
    expect(await statusesOf(job.id)).toEqual(["unchanged"]);
    expect((await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("review");

    // Another unfinished job took the image meanwhile: skipped, nothing moves.
    await makeJob(poor.id, [{ status: "queued", reserved: 1, mediaId: "gid://shopify/MediaImage/shared" }], "processing");
    expect(await retryStronger(poor.id, job.id, [items[0].id])).toEqual({ retried: 0, skipped: 1, status: "review" });
    expect(await statusesOf(job.id)).toEqual(["unchanged"]);
  });

  it("POST /api/image-jobs/:jobId/retry-stronger", async () => {
    const { job, items } = await processJob([NEEDS_REVIEW, READY]);
    const path = `/api/image-jobs/${job.id}/retry-stronger`;
    const post = (body: unknown, auth?: string | null, jobId = job.id) =>
      call(retryStrongerAction, "POST", `/api/image-jobs/${jobId}/retry-stronger`, { params: { jobId }, body, auth });

    expect((await call(retryStrongerLoader, "GET", path, { params: { jobId: job.id } })).status).toBe(405);
    expect((await post({ itemIds: [items[0].id] }, null)).status).toBe(401);
    expect((await post({})).status).toBe(400);
    expect((await post({ itemIds: [] })).status).toBe(400);
    expect((await post({ itemIds: [items[0].id], extra: true })).status).toBe(400);
    expect((await post({ itemIds: [items[0].id] }, `Bearer test-session:someone-else.myshopify.com`)).status).toBe(404);

    const res = await post({ itemIds: [items[0].id, items[0].id] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ retried: 1, skipped: 0, status: "processing", phase: "processing" });
    const again = await post({ itemIds: [items[0].id] });
    expect(again.body).toMatchObject({ retried: 0, phase: "processing" });

    // The items API says the stronger model was asked for; no verdict while it runs.
    const listed = await call(itemsLoader, "GET", `/api/image-jobs/${job.id}/items`, { params: { jobId: job.id } });
    expect(listed.body.items.find((i: { id: string }) => i.id === items[0].id)).toMatchObject({
      strongerModel: true,
      finalStatus: null,
      processingMethod: null,
    });

    // A job no longer in review with images to take: 409.
    const { job: done, items: doneItems } = await makeJob(shopId, [{ status: "flagged", reserved: 1 }], "done");
    expect((await post({ itemIds: [doneItems[0].id] }, undefined, done.id)).status).toBe(409);
  });
});

// ─── Reuse ──────────────────────────────────────────────────────────────────

describe("reuse: READY results only", () => {
  const MEDIA = "gid://shopify/MediaImage/reuse-1";

  async function once(a: Answer, preset = DEFAULT_PRESET) {
    const { items } = await processJob([a], [MEDIA], preset);
    await storeArtifacts(items[0]);
    return items[0];
  }

  it("never reuses a NEEDS_REVIEW or NO_CHANGE result; reuses a READY one, also once approved", async () => {
    await once(NEEDS_REVIEW);
    await once(NO_CHANGE);
    expect(gpuRequests).toHaveLength(2);

    const ready = await once(READY);
    expect(gpuRequests).toHaveLength(3);
    await prisma.jobItem.update({ where: { id: ready.id }, data: { status: "approved" } });
    const copy = await once(NEEDS_REVIEW); // the service isn't asked: the READY result is reused
    expect(gpuRequests).toHaveLength(3);
    expect(copy).toMatchObject({ status: "ready", outputKey: ready.outputKey, flags: [] });
    expect(copy.processing).toMatchObject({ method: "reused", route: "reused", final_status: "READY", reused_from: ready.id });
  });

  it("never reuses a result the merchant kept the original over or restored", async () => {
    const ready = await once(READY);
    await prisma.jobItem.update({ where: { id: ready.id }, data: { status: "restored" } });
    await once(READY);
    expect(gpuRequests).toHaveLength(2);
  });

  it("keeps stronger-model results and ordinary ones apart", async () => {
    const plain = await once(READY);
    // A stronger-model request never gets the ordinary result.
    const { items } = await makeJob(shopId, [{ status: "processing", reserved: 1, mediaId: MEDIA }], "processing");
    await prisma.jobItem.update({ where: { id: items[0].id }, data: { forceEscalation: true } });
    answers.set(items[0].id, FORCED_READY);
    await runItemTask(task(items[0]));
    expect(gpuRequests).toHaveLength(2);
    const forced = await prisma.jobItem.findUniqueOrThrow({ where: { id: items[0].id } });
    expect(forced.resultKey).not.toBe(plain.resultKey);
    await storeArtifacts(forced, "forced-output");

    // An ordinary request never gets the stronger-model result: it reuses the ordinary one.
    const ordinary = await once(READY);
    expect(gpuRequests).toHaveLength(2);
    expect(ordinary.outputKey).toBe(plain.outputKey);

    // Another stronger-model request with identical settings reuses the stronger-model result.
    const { items: again } = await makeJob(shopId, [{ status: "processing", reserved: 1, mediaId: MEDIA }], "processing");
    await prisma.jobItem.update({ where: { id: again[0].id }, data: { forceEscalation: true } });
    await runItemTask(task(again[0]));
    expect(gpuRequests).toHaveLength(2);
    const reused = await prisma.jobItem.findUniqueOrThrow({ where: { id: again[0].id } });
    expect(reused.outputKey).toBe(forced.outputKey);
    expect((await getObjectBuffer(reused.outputKey!)).toString()).toBe("forced-output");
  });
});

// ─── Metrics endpoint ───────────────────────────────────────────────────────

describe("GET /internal/metrics", () => {
  const TOKEN = "metrics-token-0123456789abcdef";
  const get = (query = "", auth: string | null = `Bearer ${TOKEN}`) =>
    call(metricsLoader as Handler, "GET", `/internal/metrics${query}`, { auth });

  it("doesn't exist without METRICS_TOKEN", async () => {
    delete process.env.METRICS_TOKEN;
    resetEnvCache();
    expect((await get()).status).toBe(404);
  });

  it("needs the token, and answers the processing summary", async () => {
    process.env.METRICS_TOKEN = TOKEN;
    resetEnvCache();
    expect((await get("", null)).status).toBe(401);
    expect((await get("", "Bearer wrong-token-0123456789abcdef")).status).toBe(401);
    expect((await get("", `Bearer ${TOKEN}x`)).status).toBe(401);
    expect((await get("", TOKEN)).status).toBe(401); // not a Bearer header
    const unauthorized = await get("", "Bearer nope");
    expect(unauthorized.headers.get("www-authenticate")).toMatch(/Bearer/);
    expect((await get("?days=0")).status).toBe(400);
    expect((await get("?days=91")).status).toBe(400);
    expect((await get("?days=abc")).status).toBe(400);
    expect((await call(metricsAction as Handler, "POST", "/internal/metrics", { auth: `Bearer ${TOKEN}` })).status).toBe(405);

    await processJob([READY, NEEDS_REVIEW, NO_CHANGE, FORCED_READY]);
    const res = await get("?days=7");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.body).toMatchObject({ days: 7, since: expect.any(String), generatedAt: expect.any(String) });
    expect(res.body.overall).toMatchObject({
      images: 4,
      analyzed: 4,
      noChange: 1,
      localAttempted: 2,
      localAccepted: 1,
      localRejected: 1,
      sentToReplicate: 2,
      replicatePassed: 1,
      replicateRejected: 1,
      localAcceptanceRate: 0.5,
      replicateUsage: 0.5,
      avgReplicateCutoutUsd: 0.0009, // observed (the FORCED_READY attempt)
      avgReplicateCutoutUsdSource: "observed",
      spendAvoidedUsd: 0.0018, // (1 local accepted + 1 no change) × 0.0009
      estimatedUsd: 0.002,
      forcedByMerchant: 1,
      finalStatuses: { READY: 2, NEEDS_REVIEW: 1, NO_CHANGE: 1, FAILED: 0 },
    });
    expect(res.body.overall.topReasonCodes).toEqual(
      expect.arrayContaining([{ code: "LOW_SEGMENTATION_CONFIDENCE", count: 1 }, { code: "FORCED_BY_MERCHANT", count: 1 }]),
    );
    expect(res.body.byDay).toHaveLength(1);
    expect(res.body.byDay[0]).toMatchObject({ day: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), images: 4 });
    // No shop is named.
    expect(JSON.stringify(res.body)).not.toContain(SHOP);
  });
});
