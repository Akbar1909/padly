import { describe, expect, it, vi } from "vitest";
import { MerchantError, PermanentError } from "../../app/lib/errors";
import { describeFilter, filterForClient, JobFilterSchema } from "../../app/lib/filters";
import { GpuServiceError, pipelineFromHealth } from "../../app/lib/gpu.server";
import { appliedCopy, needsCreditsCopy, processedCopy } from "../../app/lib/notifications";
import { summarizeProcessing } from "../../app/lib/processing";
import {
  cappedNotice,
  creditsNotice,
  ETA_MIN_FINISHED,
  hasCreditsNotice,
  isPollingStatus,
  itemStatusFilter,
  jobNotices,
  jobProgress,
  needsAction,
  skippedNotice,
  toApiItemStatus,
  toApiJobStatus,
  withNotice,
  withoutCreditsNotice,
} from "../../app/lib/progress";
import { canonicalJson, madeAsIntended, resultKeyFor } from "../../app/lib/reuse.server";
import { DEFAULT_PRESET } from "../../app/lib/presets";
import { readProductsByIds, type ReadItem } from "../../app/lib/shopify/media.server";
import type { ShopifyClient } from "../../app/lib/shopify/graphql";
import { itemFailureCode, itemFailureMessage, MESSAGES } from "../../worker/messages";
import { backoffBaseMs, isFinalAttempt, retryDelayMs } from "../../worker/retries";

const T0 = Date.parse("2026-09-27T10:00:00Z");

describe("job progress (phase-scoped)", () => {
  it("counts only the current processing phase: (completed + failed) / total", () => {
    const p = jobProgress(
      { status: "processing", phaseTotal: 100, phaseFailedBase: 0, phaseStartedAt: new Date(T0) },
      { queued: 27, processing: 3, ready: 60, flagged: 7, failed: 3 },
      T0 + 1000,
    );
    expect(p).toMatchObject({
      phase: "processing",
      total: 100,
      completed: 67,
      failed: 3,
      processing: 3,
      queued: 27,
      remaining: 30,
      progress: 70,
    });
  });

  it("starts a reopened job (retry failed) from 0 %, ignoring earlier results and untried failures", () => {
    // 97 images were fine before; 2 of 3 failures were retried, 1 left failed (the base).
    const job = { status: "processing" as const, phaseTotal: 2, phaseFailedBase: 1, phaseStartedAt: new Date(T0) };
    expect(jobProgress(job, { ready: 97, queued: 1, processing: 1, failed: 1 })).toMatchObject({
      total: 2,
      completed: 0,
      failed: 0,
      progress: 0,
    });
    expect(jobProgress(job, { ready: 98, processing: 1, failed: 1 })).toMatchObject({ completed: 1, progress: 50 });
    expect(jobProgress(job, { ready: 98, failed: 2 })).toMatchObject({ completed: 1, failed: 1, progress: 100 });
  });

  it("scopes an apply round to the images it writes", () => {
    // 10 approved when Apply was pressed; 3 images had already failed during processing.
    const p = jobProgress(
      { status: "applying", phaseTotal: 10, phaseFailedBase: 3, phaseStartedAt: new Date(T0) },
      { approved: 4, applying: 2, applied: 3, failed: 4, rejected: 5, ready: 2 },
    );
    expect(p).toMatchObject({ total: 10, queued: 4, processing: 2, remaining: 6, failed: 1, completed: 3, progress: 40 });
  });

  it("never shows 100 % while an image is left", () => {
    const p = jobProgress({ status: "processing", phaseTotal: 1000, phaseFailedBase: 0 }, { ready: 999, processing: 1 });
    expect(p.progress).toBe(99);
  });

  it("falls back to lifetime counts before the phase snapshot existed, and outside a phase", () => {
    expect(jobProgress({ status: "processing", phaseTotal: 0 }, { queued: 1, ready: 2, failed: 1 })).toMatchObject({
      total: 4,
      completed: 2,
      failed: 1,
      progress: 75,
    });
    expect(jobProgress({ status: "review" }, { ready: 5, approved: 3, applied: 1, failed: 1 })).toMatchObject({
      total: 10,
      completed: 9,
      failed: 1,
      progress: 100,
    });
    expect(jobProgress({ status: "done" }, {}).progress).toBe(100); // matched nothing
    expect(jobProgress({ status: "reading" }, { queued: 40 })).toMatchObject({ total: 40, queued: 40, progress: 0 });
  });

  it("gives an ETA only after enough images finished, from the measured rate", () => {
    const job = { status: "processing" as const, phaseTotal: 100, phaseFailedBase: 0, phaseStartedAt: new Date(T0) };
    const four = { queued: 94, processing: 2, ready: ETA_MIN_FINISHED - 1 };
    expect(jobProgress(job, four, T0 + 40_000).etaSeconds).toBeNull();
    // 5 finished in 50 s → 10 s each; 95 left → 950 s.
    expect(jobProgress(job, { queued: 93, processing: 2, ready: 4, failed: 1 }, T0 + 50_000).etaSeconds).toBe(950);
    // Nothing left, no phase snapshot, or not in a phase: no ETA.
    expect(jobProgress(job, { ready: 100 }, T0 + 50_000).etaSeconds).toBeNull();
    expect(jobProgress({ ...job, phaseStartedAt: null }, { queued: 90, ready: 10 }, T0).etaSeconds).toBeNull();
    expect(jobProgress({ status: "review" }, { ready: 10 }, T0).etaSeconds).toBeNull();
  });
});

describe("public status vocabulary", () => {
  it("maps job statuses at the edge; completed means processed, never written to Shopify", () => {
    expect(toApiJobStatus("reading", {})).toBe("queued");
    expect(toApiJobStatus("estimated", { queued: 3 })).toBe("queued");
    expect(toApiJobStatus("processing", { queued: 3 })).toBe("processing");
    expect(toApiJobStatus("applying", { approved: 3 })).toBe("processing");
    expect(toApiJobStatus("review", { ready: 3 })).toBe("completed");
    expect(toApiJobStatus("review", { ready: 3, failed: 1 })).toBe("completed_with_errors");
    expect(toApiJobStatus("done", { failed: 4 })).toBe("failed");
    expect(toApiJobStatus("done", { applied: 2, rejected: 1 })).toBe("completed");
    expect(toApiJobStatus("done", {})).toBe("completed"); // nothing matched: a notice, not a failure
    expect(toApiJobStatus("failed", {})).toBe("failed");
    expect(toApiJobStatus("cancelled", { queued: 5 })).toBe("cancelled");
  });

  it("maps item statuses, and ?status= filters accept both vocabularies", () => {
    expect(toApiItemStatus("queued")).toBe("queued");
    expect(toApiItemStatus("processing")).toBe("processing");
    expect(toApiItemStatus("failed")).toBe("failed");
    for (const s of ["ready", "flagged", "approved", "rejected", "applying", "applied", "restored"] as const) {
      expect(toApiItemStatus(s)).toBe("completed");
    }
    expect(itemStatusFilter("completed")).toEqual(expect.arrayContaining(["ready", "flagged", "applied", "restored"]));
    expect(itemStatusFilter("completed")).not.toContain("failed");
    expect(itemStatusFilter("approved")).toEqual(["approved"]);
    expect(itemStatusFilter("bogus")).toBeNull();
    for (const key of ["toString", "constructor", "__proto__", "hasOwnProperty"]) {
      expect(itemStatusFilter(key)).toBeNull();
    }
  });

  it("polls only while the app is working", () => {
    expect(["reading", "processing", "applying"].every((s) => isPollingStatus(s as never))).toBe(true);
    expect(["estimated", "review", "done", "failed", "cancelled"].some((s) => isPollingStatus(s as never))).toBe(false);
  });

  it("says what the merchant has to do", () => {
    expect(needsAction({ status: "processing" })).toBeNull();
    expect(needsAction({ status: "review" })).toBe("review");
    expect(needsAction({ status: "estimated" })).toBe("start");
    expect(needsAction({ status: "estimated" }, { needed: 10, available: 3 })).toBe("credits");
    expect(needsAction({ status: "estimated" }, { needed: 3, available: 3 })).toBe("start");
    const blocked = { status: "estimated" as const, autoStart: true, error: creditsNotice(12, 12, 3) };
    expect(needsAction(blocked)).toBe("credits");
    expect(needsAction({ ...blocked, autoStart: false })).toBe("start");
  });
});

describe("job notices", () => {
  it("keeps one line per notice and drops the credits notice on start", () => {
    let error = withNotice(null, cappedNotice(5000));
    error = withNotice(error, cappedNotice(5000));
    expect(jobNotices(error)).toHaveLength(1);
    error = withNotice(error, creditsNotice(3, 3, 1));
    expect(hasCreditsNotice(error)).toBe(true);
    expect(withoutCreditsNotice(error)).toBe(cappedNotice(5000));
    expect(withoutCreditsNotice(creditsNotice(1))).toBeNull();
  });

  it("words counts properly", () => {
    expect(creditsNotice(1)).toBe("Not enough credits to start processing 1 image.");
    expect(creditsNotice(1200, 1300, 25)).toBe(
      "Not enough credits to start processing 1,200 images. This job needs 1,300 credits; 25 are available.",
    );
    expect(skippedNotice(1)).toBe("1 image is already in another job that hasn't finished, so it was skipped.");
    expect(skippedNotice(12)).toBe("12 images are already in another job that hasn't finished, so they were skipped.");
  });
});

describe("notification copy", () => {
  it("processing finished", () => {
    expect(processedCopy("j1", 100, 0)).toEqual({
      kind: "job_processed",
      tone: "success",
      title: "100 product images are ready.",
      url: "/app/jobs/j1",
    });
    expect(processedCopy("j1", 1, 0)?.title).toBe("1 product image is ready.");
    expect(processedCopy("j1", 97, 3)).toMatchObject({ tone: "warning", title: "97 images are ready. 3 need attention." });
    expect(processedCopy("j1", 1, 1)?.title).toBe("1 image is ready. 1 needs attention.");
    expect(processedCopy("j1", 0, 4)).toEqual({
      kind: "job_processed",
      tone: "critical",
      title: "4 images couldn't be processed.",
      url: "/app/jobs/j1?tab=failed",
    });
    expect(processedCopy("j1", 0, 0)).toBeNull();
  });

  it("applying finished, and a blocked auto-start", () => {
    expect(appliedCopy("j2", 12, 0)).toMatchObject({ tone: "success", title: "12 images were updated in your store." });
    expect(appliedCopy("j2", 1, 0)?.title).toBe("1 image was updated in your store.");
    expect(appliedCopy("j2", 10, 2)).toMatchObject({ tone: "warning", title: "10 images were updated. 2 couldn't be updated." });
    expect(appliedCopy("j2", 0, 2)).toMatchObject({ tone: "critical", url: "/app/jobs/j2?tab=failed" });
    expect(needsCreditsCopy("j3", 40)).toEqual({
      kind: "job_needs_credits",
      tone: "warning",
      title: "Not enough credits to start processing 40 images.",
      url: "/app/jobs/j3",
    });
    // The job's notice starts with the same sentence as the notification.
    expect(creditsNotice(40, 40, 2).startsWith(needsCreditsCopy("j3", 40).title)).toBe(true);
  });
});

describe("selection by id", () => {
  it("normalises product and image ids to gids and describes the selection", () => {
    const f = JobFilterSchema.parse({ productIds: ["123", 456, "gid://shopify/Product/123"], imageScope: "all" });
    expect(f.productIds).toEqual(["gid://shopify/Product/123", "gid://shopify/Product/456"]);
    expect(describeFilter(f)).toBe("2 selected products · all images");
    const g = JobFilterSchema.parse({ productIds: ["1"], mediaIds: ["gid://shopify/MediaImage/9", "10"] });
    expect(g.mediaIds).toEqual(["gid://shopify/MediaImage/9", "gid://shopify/MediaImage/10"]);
    expect(describeFilter(g)).toBe("1 selected product · 2 selected images");
  });

  it("rejects images without products, mixed selections and bad ids", () => {
    expect(JobFilterSchema.safeParse({ mediaIds: ["gid://shopify/MediaImage/9"] }).success).toBe(false);
    expect(JobFilterSchema.safeParse({ productIds: ["1"], vendor: "Acme" }).success).toBe(false);
    expect(JobFilterSchema.safeParse({ productIds: ["gid://shopify/Collection/1"] }).success).toBe(false);
    expect(JobFilterSchema.safeParse({ productIds: [] }).success).toBe(false);
    expect(JobFilterSchema.safeParse({ productIds: Array.from({ length: 5001 }, (_, i) => String(i + 1)) }).success).toBe(false);
  });

  it("strips id lists before a filter goes to the browser", () => {
    const f = JobFilterSchema.parse({ productIds: ["1", "2", "3"], mediaIds: ["7"] });
    const client = filterForClient(f);
    expect(client).toEqual({ imageScope: "first", productCount: 3, mediaCount: 1 });
    expect(JSON.stringify(client)).not.toContain("gid://");
    expect(describeFilter(client)).toBe(describeFilter(f));
    expect(filterForClient({ vendor: "Acme", imageScope: "all" })).toEqual({ vendor: "Acme", imageScope: "all" });
  });
});

describe("reading products by id", () => {
  const media = (id: number, type = "IMAGE") => ({
    id: type === "IMAGE" ? `gid://shopify/MediaImage/${id}` : `gid://shopify/Video/${id}`,
    mediaContentType: type,
    status: "READY",
    alt: null,
    mimeType: "image/jpeg",
    image: { url: `https://cdn.test/${id}.jpg`, width: 800, height: 800 },
    originalSource: { url: `https://cdn.test/${id}.jpg`, fileSize: 100 },
  });
  const page = (nodes: unknown[], more = false) => ({ pageInfo: { hasNextPage: more, endCursor: more ? "c1" : null }, nodes });

  function fakeClient() {
    const calls: Array<{ ids?: string[]; mediaFirst?: number; id?: string; cost?: number }> = [];
    const client: ShopifyClient = {
      shop: "t.myshopify.com",
      async request<T>(query: string, variables: Record<string, unknown> = {}, opts: { cost?: number } = {}) {
        calls.push({ ...(variables as object), cost: opts.cost });
        if (query.includes("ReadProductsByIds")) {
          const ids = variables.ids as string[];
          return {
            nodes: ids.map((id) =>
              id.endsWith("/404")
                ? null
                : {
                    id,
                    title: `P ${id.split("/").pop()}`,
                    media: id.endsWith("/2") ? page([media(20, "VIDEO"), media(21), media(22)], true) : page([media(11), media(12)]),
                  },
            ),
          } as T;
        }
        if (query.includes("ReadProductMedia")) return { product: { media: page([media(23)]) } } as T;
        throw new Error(`unexpected query ${query}`);
      },
    };
    return { client, calls };
  }

  it("keeps positions among all media, skips missing products, pages long media lists", async () => {
    const { client, calls } = fakeClient();
    const got: ReadItem[] = [];
    const ids = ["gid://shopify/Product/1", "gid://shopify/Product/2", "gid://shopify/Product/404"];
    const n = await readProductsByIds(client, ids, undefined, "all", async (b) => void got.push(...b));
    expect(n).toBe(5);
    expect(got.map((i) => [i.mediaId.split("/").pop(), i.position])).toEqual([
      ["11", 0],
      ["12", 1],
      ["21", 1], // after the video
      ["22", 2],
      ["23", 3], // second media page
    ]);
    expect(calls[0]).toMatchObject({ mediaFirst: 50, cost: 3 * 53 });
  });

  it("takes the first image per product, or exactly the named images, and stops at the limit", async () => {
    const { client } = fakeClient();
    const ids = ["gid://shopify/Product/1", "gid://shopify/Product/2"];
    const first: ReadItem[] = [];
    await readProductsByIds(client, ids, undefined, "first", async (b) => void first.push(...b));
    expect(first.map((i) => i.mediaId.split("/").pop())).toEqual(["11", "21"]);

    const named: ReadItem[] = [];
    await readProductsByIds(client, ids, ["gid://shopify/MediaImage/12", "gid://shopify/MediaImage/23"], "first", async (b) =>
      void named.push(...b),
    );
    expect(named.map((i) => [i.mediaId.split("/").pop(), i.position])).toEqual([
      ["12", 1],
      ["23", 3],
    ]);

    const capped: ReadItem[] = [];
    expect(await readProductsByIds(client, ids, undefined, "all", async (b) => void capped.push(...b), 3)).toBe(3);
    expect(capped).toHaveLength(3);
  });
});

describe("result reuse keys", () => {
  const settings = {
    aspect: "1:1" as const,
    margin_pct: 8,
    remove_bg: true,
    bg_color: "#FFFFFF",
    upscale: false,
    upscale_threshold_px: 1200,
    target_px: 2048,
    output_format: "jpeg" as const,
    jpeg_quality: 90,
    ai_metadata: true,
  };

  it("is the same for equal settings in any key order, and differs for any change", () => {
    expect(canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe('{"a":[2,{"c":2,"d":1}],"b":1}');
    const reversed = Object.fromEntries(Object.entries(settings).reverse()) as typeof settings;
    const key = resultKeyFor("gid://shopify/MediaImage/1", "abc", settings, "p1");
    expect(resultKeyFor("gid://shopify/MediaImage/1", "abc", reversed, "p1")).toBe(key);
    expect(resultKeyFor("gid://shopify/MediaImage/1", "abd", settings, "p1")).not.toBe(key);
    expect(resultKeyFor("gid://shopify/MediaImage/2", "abc", settings, "p1")).not.toBe(key);
    expect(resultKeyFor("gid://shopify/MediaImage/1", "abc", { ...settings, margin_pct: 9 }, "p1")).not.toBe(key);
    // Another image-service pipeline (backends, models) never shares a key.
    expect(resultKeyFor("gid://shopify/MediaImage/1", "abc", settings, "p2")).not.toBe(key);
    expect(DEFAULT_PRESET.marginPct).toBe(8);
  });

  it("fingerprints the image service's setup from /healthz", () => {
    const health = {
      ok: true,
      backend: "local",
      device: "cpu",
      models_loaded: ["segmentation", "upscaler_x2", "text_detector"],
      text_detector: "east",
      fallback_backend: null,
      escalation_backend: "replicate",
    };
    const p = pipelineFromHealth(health)!;
    expect(p).toMatchObject({ backend: "local", escalation: "replicate", fallback: null });
    // Model order doesn't matter; a model, backend or escalation change does.
    expect(pipelineFromHealth({ ...health, models_loaded: [...health.models_loaded].reverse() })!.fingerprint).toBe(p.fingerprint);
    expect(pipelineFromHealth({ ...health, models_loaded: ["segmentation"] })!.fingerprint).not.toBe(p.fingerprint);
    expect(pipelineFromHealth({ ...health, escalation_backend: null })!.fingerprint).not.toBe(p.fingerprint);
    expect(pipelineFromHealth({ ...health, backend: "replicate" })!.fingerprint).not.toBe(p.fingerprint);
    // A new image-service version or output-affecting setting stops reuse of older results.
    expect(pipelineFromHealth({ ...health, pipeline_version: "2026-09-27.2+abc" })!.fingerprint).not.toBe(
      pipelineFromHealth({ ...health, pipeline_version: "2026-09-27.3+abc" })!.fingerprint,
    );
    expect(pipelineFromHealth({ ok: true })).toBeNull();
    expect(pipelineFromHealth(null)).toBeNull();
  });

  it("reuses only results made the intended way", () => {
    const pipeline = { backend: "local", escalation: "replicate" };
    const rec = (over: Record<string, unknown>) => ({
      method: "local",
      replicate_calls: 0,
      fallback_reason: null,
      ...over,
    });
    expect(madeAsIntended(rec({}), pipeline)).toBe(true);
    expect(madeAsIntended(null, pipeline)).toBe(true); // an older image service: the key decides
    expect(madeAsIntended(rec({ method: "deterministic" }), pipeline)).toBe(true);
    expect(madeAsIntended(rec({ method: "reused" }), pipeline)).toBe(true);
    // Escalated and the paid model ran: as intended.
    expect(madeAsIntended(rec({ method: "local+replicate", replicate_calls: 1, fallback_reason: "background_artifacts" }), pipeline)).toBe(true);
    expect(madeAsIntended(rec({ method: "replicate", replicate_calls: 1, fallback_reason: "too_slow_on_cpu" }), pipeline)).toBe(true);
    // Wanted the paid model but didn't get it: degraded.
    expect(madeAsIntended(rec({ fallback_reason: "replicate_unavailable", replicate_calls: 1 }), pipeline)).toBe(false);
    expect(madeAsIntended(rec({ fallback_reason: "background_artifacts (not escalated: daily_cap)" }), pipeline)).toBe(false);
    expect(madeAsIntended(rec({ fallback_reason: "too_slow_on_cpu (not escalated: escalation_cooldown)" }), pipeline)).toBe(false);
    expect(madeAsIntended(rec({ fallback_reason: "some_future_reason" }), pipeline)).toBe(false);
    // Made by a backend that isn't the primary or the escalation one (FALLBACK_BACKEND stood in).
    expect(madeAsIntended(rec({ method: "local" }), { backend: "replicate", escalation: null })).toBe(false);
    expect(madeAsIntended(rec({ method: "classic" }), pipeline)).toBe(false);
  });
});

describe("failure codes", () => {
  it("mirrors the merchant messages with machine-readable codes", () => {
    expect(itemFailureCode(new PermanentError("gone", "source_deleted"))).toBe("source_deleted");
    expect(itemFailureCode(new PermanentError("x"))).toBe("permanent");
    expect(itemFailureCode(new MerchantError("x", "y", true, "source_not_ready"))).toBe("source_not_ready");
    expect(itemFailureCode(new GpuServiceError("x", false, "unsupported_image", 415))).toBe("unreadable");
    expect(itemFailureCode(new GpuServiceError("x", false, "image_too_large", 413))).toBe("too_large");
    expect(itemFailureCode(new GpuServiceError("x", true, undefined, 502))).toBe("busy");
    expect(itemFailureCode(new GpuServiceError("slow", true, "timeout"))).toBe("timeout");
    expect(itemFailureCode(new GpuServiceError("oom", true, "out_of_memory", 503))).toBe("out_of_memory");
    expect(itemFailureMessage(new GpuServiceError("slow", true, "timeout"))).toBe(MESSAGES.timeout);
    expect(itemFailureMessage(new GpuServiceError("oom", true, "out_of_memory", 503))).toBe(MESSAGES.outOfMemory);
    expect(itemFailureCode(new Error("?"))).toBe("unknown");
  });

  it("treats only an unreachable or overloaded image service as down, never one image's error", () => {
    expect(new GpuServiceError("unreachable", true).serviceDown).toBe(true);
    expect(new GpuServiceError("proxy 503", true, undefined, 503).serviceDown).toBe(true);
    expect(new GpuServiceError("starting", true, "not_ready", 503).serviceDown).toBe(true);
    // One oversized image running out of memory is not an outage for every shop.
    expect(new GpuServiceError("oom", true, "out_of_memory", 503).serviceDown).toBe(false);
    expect(new GpuServiceError("slow", true, "timeout").serviceDown).toBe(false);
    expect(new GpuServiceError("bad gateway", true, "upload_failed", 502).serviceDown).toBe(false);
    expect(new GpuServiceError("bad image", false, "unsupported_image", 415).serviceDown).toBe(false);
  });

  it("gives up on timeouts and out-of-memory after two attempts, other retryable errors after all", () => {
    const timeout = new GpuServiceError("slow", true, "timeout");
    const oom = new GpuServiceError("oom", true, "out_of_memory", 503);
    const busy = new GpuServiceError("busy", true, undefined, 502);
    expect([1, 2].map((a) => isFinalAttempt(timeout, a, 5))).toEqual([false, true]);
    expect([1, 2].map((a) => isFinalAttempt(oom, a, 5))).toEqual([false, true]);
    expect([1, 2, 3, 4, 5].map((a) => isFinalAttempt(busy, a, 5))).toEqual([false, false, false, false, true]);
    expect(isFinalAttempt(timeout, 1, 1)).toBe(true);
    expect(isFinalAttempt(new PermanentError("gone"), 1, 5)).toBe(true);
    expect(isFinalAttempt(new Error("network"), 1, 5)).toBe(false);
    // BullMQ's exponential backoff: 30 s, 1 min, 2 min, 4 min.
    expect([1, 2, 3, 4].map((a) => retryDelayMs(a, 30_000))).toEqual([30_000, 60_000, 120_000, 240_000]);
    expect(backoffBaseMs({ type: "exponential", delay: 1000 }, 30_000)).toBe(1000);
    expect(backoffBaseMs(500, 30_000)).toBe(500);
    expect(backoffBaseMs(undefined, 30_000)).toBe(30_000);
  });
});

describe("processing summary", () => {
  it("counts automatic retries behind processed images", () => {
    const rec = (attempt?: number) => ({ method: "local", replicate_calls: 0, estimated_cost_usd: 0, attempt });
    expect(summarizeProcessing([{ status: "ready", processing: rec(1) }, { status: "ready", processing: rec(3) }, { status: "ready", processing: rec() }]).retries).toBe(2);
  });
});

describe("environment", () => {
  it("accepts IMAGE_WORKER_CONCURRENCY as an alias that wins over WORKER_CONCURRENCY", async () => {
    const saved = { ...process.env };
    try {
      process.env.WORKER_CONCURRENCY = "8";
      process.env.IMAGE_WORKER_CONCURRENCY = "2";
      vi.resetModules();
      const { env } = await import("../../app/lib/env.server");
      expect(env()).toMatchObject({ WORKER_CONCURRENCY: 2, ITEM_TASK_ATTEMPTS: 5, ITEM_RETRY_BASE_MS: 30_000 });
      expect(env().EMAIL_PROVIDER).toBeUndefined();
    } finally {
      process.env = saved;
      vi.resetModules();
    }
  });
});
