/**
 * Final statuses from the image service (READY / NEEDS_REVIEW / NO_CHANGE), what the worker
 * stores for each, what reuse accepts, how the job moves on, and the cost dashboard's numbers.
 */
import { describe, expect, it } from "vitest";
import { RESERVING_ITEM_STATUSES } from "../../app/lib/credits.server";
import { FINAL_STATUS, FLAG_HELP, FLAG_LABELS, ITEM_STATUS, UNCHANGED_TEXT } from "../../app/lib/format";
import type { GpuFlag, GpuProcessing } from "../../app/lib/gpu.server";
import { nextJobStatus, RETRY_STRONGER_STATUSES } from "../../app/lib/jobs.server";
import {
  carrySupersededRuns,
  itemFinalStatus,
  NEEDS_REVIEW_FLAG,
  processingLogFields,
  qualityLogFields,
  resultStatus,
  summarizeProcessing,
  type ProcessingRecord,
} from "../../app/lib/processing";
import { itemStatusFilter, PROCESSED_ITEM_STATUSES, toApiItemStatus, toApiJobStatus } from "../../app/lib/progress";
import { madeAsIntended, REUSABLE_ITEM_STATUSES, resultKeyFor, wasReady } from "../../app/lib/reuse.server";

const flag = (code: string): GpuFlag => ({ code, severity: "warning", message: code });

function record(over: Partial<ProcessingRecord> = {}): ProcessingRecord {
  return {
    operations: ["decode", "background_removal", "canvas", "export"],
    method: "local",
    replicate_used: false,
    replicate_calls: 0,
    replicate_models: [],
    estimated_cost_usd: 0,
    fallback_reason: null,
    quality_score: 1,
    quality_checks: {},
    attempts: [],
    duration_ms: 2000,
    ...over,
  };
}

const replicateCut = (cost: number, outcome = "used") => ({
  operation: "background_removal",
  method: "replicate",
  model: "men1scus/birefnet",
  duration_ms: 900,
  cost_usd: cost,
  outcome,
});
const localCut = (outcome = "used") => ({
  operation: "background_removal",
  method: "local",
  model: "birefnet-lite",
  duration_ms: 6000,
  cost_usd: 0,
  outcome,
});

describe("final status → item status (worker)", () => {
  it("READY without flags is ready; anything flagged is flagged", () => {
    expect(resultStatus([], { final_status: "READY" })).toEqual({ status: "ready", flags: [] });
    // Never claim more than the flags allow.
    expect(resultStatus([flag("text_detected")], { final_status: "READY" })).toEqual({
      status: "flagged",
      flags: [flag("text_detected")],
    });
  });

  it("NEEDS_REVIEW is flagged, and always carries a flag that says why", () => {
    expect(resultStatus([flag("cutout_check")], { final_status: "NEEDS_REVIEW" })).toEqual({
      status: "flagged",
      flags: [flag("cutout_check")],
    });
    expect(resultStatus([], { final_status: "NEEDS_REVIEW" })).toEqual({ status: "flagged", flags: [NEEDS_REVIEW_FLAG] });
    expect(FLAG_LABELS[NEEDS_REVIEW_FLAG.code]).toBeTruthy();
    expect(FLAG_HELP[NEEDS_REVIEW_FLAG.code]).toBeTruthy();
  });

  it("NO_CHANGE is unchanged (never applied, never charged)", () => {
    expect(resultStatus([], { final_status: "NO_CHANGE" })).toEqual({ status: "unchanged", flags: [] });
    expect(resultStatus([flag("upscale_capped")], { final_status: "NO_CHANGE" }).status).toBe("unchanged");
  });

  it("keeps today's rule without a final status (an older image service)", () => {
    expect(resultStatus([], undefined)).toEqual({ status: "ready", flags: [] });
    expect(resultStatus([], null)).toEqual({ status: "ready", flags: [] });
    expect(resultStatus([], {})).toEqual({ status: "ready", flags: [] });
    expect(resultStatus([flag("mask_low_confidence")], {}).status).toBe("flagged");
  });

  it("treats a final status it doesn't know as needing review", () => {
    expect(resultStatus([], { final_status: "MAYBE" as never })).toEqual({ status: "flagged", flags: [NEEDS_REVIEW_FLAG] });
  });
});

describe("final status of an item (API, job page)", () => {
  it("maps each item status", () => {
    expect(itemFinalStatus({ status: "queued" })).toBeNull();
    expect(itemFinalStatus({ status: "processing", processing: record({ final_status: "READY" }) })).toBeNull();
    expect(itemFinalStatus({ status: "ready", flags: [], processing: record({ final_status: "READY" }) })).toBe("READY");
    expect(itemFinalStatus({ status: "ready", flags: [], processing: record() })).toBe("READY"); // older service
    expect(itemFinalStatus({ status: "ready", flags: [], processing: null })).toBe("READY");
    expect(itemFinalStatus({ status: "flagged", flags: [flag("x")], processing: record() })).toBe("NEEDS_REVIEW");
    expect(itemFinalStatus({ status: "unchanged", flags: [], processing: record({ final_status: "NO_CHANGE" }) })).toBe(
      "NO_CHANGE",
    );
    expect(itemFinalStatus({ status: "failed", outputKey: null })).toBe("FAILED");
    expect(itemFinalStatus({ status: "failed" })).toBe("FAILED");
  });

  it("keeps the processing verdict after a decision, or an apply failure", () => {
    const ready = { flags: [], processing: record({ final_status: "READY" }) };
    const needsReview = { flags: [flag("cutout_check")], processing: record({ final_status: "NEEDS_REVIEW" }) };
    expect(itemFinalStatus({ status: "approved", ...ready })).toBe("READY");
    expect(itemFinalStatus({ status: "applied", ...ready })).toBe("READY");
    expect(itemFinalStatus({ status: "approved", ...needsReview })).toBe("NEEDS_REVIEW");
    expect(itemFinalStatus({ status: "rejected", ...needsReview })).toBe("NEEDS_REVIEW");
    expect(itemFinalStatus({ status: "failed", outputKey: "out.jpg", ...ready })).toBe("READY");
  });

  it("has merchant wording for each verdict that never promises certainty", () => {
    expect(FINAL_STATUS.NO_CHANGE.label).toBe(UNCHANGED_TEXT);
    expect(UNCHANGED_TEXT).toBe("Already clean — no change needed");
    expect(ITEM_STATUS.unchanged.label).toBe("Already clean");
    expect(ITEM_STATUS.rejected.label).toBe("Original kept");
    for (const v of Object.values(FINAL_STATUS)) expect(v.label).not.toMatch(/guarantee|perfect|100%/i);
  });
});

describe("unchanged (NO_CHANGE) images in jobs and credits", () => {
  it("counts as processed, is 'completed' in the API, and is never reserved", () => {
    expect(PROCESSED_ITEM_STATUSES).toContain("unchanged");
    expect(toApiItemStatus("unchanged")).toBe("completed");
    expect(itemStatusFilter("completed")).toContain("unchanged");
    expect(itemStatusFilter("unchanged")).toEqual(["unchanged"]);
    expect(toApiJobStatus("review", { unchanged: 3 })).toBe("completed");
    expect(RESERVING_ITEM_STATUSES).not.toContain("unchanged");
  });

  it("keeps the job in review so the merchant can retry with the stronger model; applying doesn't reopen it", () => {
    expect(nextJobStatus("processing", { unchanged: 3 })).toBe("review");
    expect(nextJobStatus("processing", { unchanged: 1, failed: 2 })).toBe("review");
    expect(nextJobStatus("applying", { applied: 2, unchanged: 1 })).toBe("done");
    expect(RETRY_STRONGER_STATUSES).toEqual(["ready", "flagged", "unchanged"]);
  });
});

describe("reuse: READY results only", () => {
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

  it("keys on force_escalation: a stronger-model result never serves an ordinary request", () => {
    const plain = resultKeyFor("m", "sha", settings, "p");
    expect(resultKeyFor("m", "sha", { ...settings, force_escalation: false }, "p")).toBe(plain);
    const forced = resultKeyFor("m", "sha", { ...settings, force_escalation: true }, "p");
    expect(forced).not.toBe(plain);
    expect(resultKeyFor("m", "sha", { ...settings, force_escalation: true }, "p")).toBe(forced);
  });

  it("reuses READY results only: never NEEDS_REVIEW, NO_CHANGE, flagged or unknown", () => {
    expect(wasReady([], record({ final_status: "READY" }))).toBe(true);
    expect(wasReady([], record())).toBe(true); // older service, nothing flagged
    expect(wasReady([], null)).toBe(true);
    expect(wasReady([flag("x")], record({ final_status: "READY" }))).toBe(false);
    expect(wasReady([], record({ final_status: "NEEDS_REVIEW" }))).toBe(false);
    expect(wasReady([], record({ final_status: "NO_CHANGE" }))).toBe(false);
    expect(wasReady([], record({ final_status: "WHO_KNOWS" as never }))).toBe(false);
    expect(wasReady(null, record())).toBe(false);
    expect(REUSABLE_ITEM_STATUSES).toEqual(["ready", "approved", "applying", "applied"]);
  });

  it("never reuses a result the paid model was wanted for but couldn't make", () => {
    const pipeline = { backend: "local", escalation: "replicate" };
    expect(madeAsIntended(record({ reason_codes: ["ESCALATION_UNAVAILABLE"] }), pipeline)).toBe(false);
    expect(madeAsIntended(record({ reason_codes: ["FORCED_BY_MERCHANT"], method: "replicate", replicate_calls: 1 }), pipeline)).toBe(
      true,
    );
  });
});

describe("log fields", () => {
  it("adds route, gates, final status and reason codes", () => {
    const p = record({
      route: "local_then_replicate",
      gate: "UNCERTAIN",
      ai_gate: "PASS",
      final_status: "READY",
      reason_codes: ["LOW_SEGMENTATION_CONFIDENCE"],
      local_attempted: true,
      local_accepted: false,
      replicate_attempts: 1,
    }) as GpuProcessing;
    expect(processingLogFields(p, 10)).toMatchObject({
      route: "local_then_replicate",
      gate: "UNCERTAIN",
      ai_gate: "PASS",
      final_status: "READY",
      reason_codes: ["LOW_SEGMENTATION_CONFIDENCE"],
      local_attempted: true,
      local_accepted: false,
      replicate_attempts: 1,
    });
    expect(qualityLogFields(p, "READY")).toEqual({
      route: "local_then_replicate",
      gate: "UNCERTAIN",
      ai_gate: "PASS",
      final_status: "READY",
      reason_codes: ["LOW_SEGMENTATION_CONFIDENCE"],
    });
    // An older service's record: nothing invented.
    expect(qualityLogFields(record(), "READY")).toEqual({
      route: undefined,
      gate: undefined,
      ai_gate: undefined,
      final_status: "READY",
      reason_codes: undefined,
    });
  });
});

describe("cost dashboard", () => {
  const rows = [
    // 1. Already clean.
    {
      status: "unchanged",
      flags: [],
      processing: record({ method: "deterministic", route: "no_change", local_attempted: false, gate: null, final_status: "NO_CHANGE", reason_codes: [] }),
    },
    // 2. Local accepted.
    {
      status: "ready",
      flags: [],
      processing: record({
        route: "local",
        local_attempted: true,
        local_accepted: true,
        gate: "SAFE_LOCAL",
        final_status: "READY",
        attempts: [localCut()],
      }),
    },
    // 3. Local uncertain → Replicate passed.
    {
      status: "approved",
      flags: [],
      processing: record({
        method: "replicate",
        route: "local_then_replicate",
        local_attempted: true,
        local_accepted: false,
        gate: "UNCERTAIN",
        ai_gate: "PASS",
        replicate_calls: 1,
        replicate_attempts: 1,
        estimated_cost_usd: 0.0012,
        reason_codes: ["LOW_SEGMENTATION_CONFIDENCE"],
        final_status: "READY",
        attempts: [localCut("rejected"), replicateCut(0.0012)],
      }),
    },
    // 4. Local failed → two paid attempts, still unsafe: needs review.
    {
      status: "flagged",
      flags: [flag("cutout_check")],
      processing: record({
        method: "replicate",
        route: "local_then_replicate",
        local_attempted: true,
        gate: "FAILED",
        ai_gate: "UNSAFE",
        replicate_calls: 2,
        replicate_attempts: 2,
        estimated_cost_usd: 0.0018,
        reason_codes: ["PRODUCT_PART_MISSING", "AI_RESULT_UNSAFE", "PRODUCT_PART_MISSING"],
        final_status: "NEEDS_REVIEW",
        attempts: [localCut("rejected"), replicateCut(0.0006, "rejected"), replicateCut(0.0012, "rejected")],
      }),
    },
    // 5. Shadow mode: local was safe, the paid result was used.
    {
      status: "ready",
      flags: [],
      processing: record({
        method: "replicate",
        route: "replicate",
        local_attempted: true,
        local_accepted: false,
        gate: "SAFE_LOCAL",
        ai_gate: "PASS",
        replicate_calls: 1,
        replicate_attempts: 1,
        estimated_cost_usd: 0.0006,
        reason_codes: ["SHADOW_MODE"],
        final_status: "READY",
        shadow: { mode: "shadow", local_gate: "SAFE_LOCAL", local_would_have_been_used: true, iou_local_vs_final: 0.96 },
        attempts: [localCut("rejected"), replicateCut(0.0006)],
      }),
    },
    // 6. Retried with the stronger model: an earlier local run was replaced.
    {
      status: "ready",
      flags: [],
      processing: record({
        method: "replicate",
        route: "replicate",
        local_attempted: false,
        gate: null,
        ai_gate: "PASS",
        replicate_calls: 1,
        replicate_attempts: 1,
        estimated_cost_usd: 0.0009,
        reason_codes: ["FORCED_BY_MERCHANT"],
        final_status: "READY",
        attempts: [replicateCut(0.0009)],
        superseded_runs: [{ method: "local", route: "local", final_status: "NEEDS_REVIEW", estimated_cost_usd: 0.0003, replicate_calls: 1 }],
      }),
    },
    // 7. Reused.
    { status: "ready", flags: [], processing: record({ method: "reused", route: "reused", final_status: "READY" }) },
    // 8. Failed, no record.
    { status: "failed", flags: [], outputKey: null, processing: null },
    // 9. An older service's record: local, kept without escalation.
    { status: "ready", flags: [], processing: record({ attempts: [localCut()] }) },
    // Still queued: no verdict yet.
    { status: "queued", flags: [], processing: null },
  ];

  it("counts the local-first funnel, cost and spend avoided", () => {
    const s = summarizeProcessing(rows);
    expect(s).toMatchObject({
      images: 8,
      failed: 1,
      analyzed: 7,
      reused: 1,
      noChange: 1,
      localAttempted: 5,
      localAccepted: 2,
      localRejected: 2,
      localSafeNotUsed: 1,
      sentToReplicate: 4,
      replicatePassed: 3,
      replicateRejected: 1,
      localAcceptanceRate: 0.4,
      replicateUsage: 0.5714,
      avgReplicateUsdPerImage: 0.001125,
      // 0.0012 + 0.0006 + 0.0012 + 0.0006 + 0.0009 over 5 paid cut-outs
      avgReplicateCutoutUsd: 0.0009,
      avgReplicateCutoutUsdSource: "observed",
      spendAvoidedUsd: 0.0027, // (2 local accepted + 1 no change) × 0.0009
      estimatedUsd: 0.0048, // 0.0045 now + 0.0003 in the run the stronger model replaced
      replicateCalls: 6, // 5 now + 1 in the replaced run
      supersededRuns: 1,
      forcedByMerchant: 1,
      finalStatuses: { READY: 6, NEEDS_REVIEW: 1, FAILED: 1, NO_CHANGE: 1 },
      byRoute: { no_change: 1, local: 2, local_then_replicate: 2, replicate: 2, reused: 1 },
      shadow: { count: 1, localWouldHaveBeenUsed: 1, localWouldHaveBeenUsedRate: 1, meanIou: 0.96 },
    });
    expect(s.reasonCodes).toEqual({
      LOW_SEGMENTATION_CONFIDENCE: 1,
      PRODUCT_PART_MISSING: 1, // once per image
      AI_RESULT_UNSAFE: 1,
      SHADOW_MODE: 1,
      FORCED_BY_MERCHANT: 1,
    });
    expect(s.topReasonCodes[0]).toEqual({ code: "AI_RESULT_UNSAFE", count: 1 });
    expect(s.topReasonCodes).toHaveLength(5);
  });

  it("falls back to the configured paid cut-out cost when none was observed", () => {
    const s = summarizeProcessing(rows.slice(0, 2), { fallbackCutoutUsd: 0.002 });
    expect(s).toMatchObject({
      localAccepted: 1,
      noChange: 1,
      sentToReplicate: 0,
      avgReplicateUsdPerImage: null,
      replicateUsage: 0,
      avgReplicateCutoutUsd: 0.002,
      avgReplicateCutoutUsdSource: "configured",
      spendAvoidedUsd: 0.004,
    });
    expect(summarizeProcessing([]).avgReplicateCutoutUsd).toBe(0.0009);
    expect(summarizeProcessing([])).toMatchObject({ localAcceptanceRate: null, replicateUsage: null, spendAvoidedUsd: 0 });
  });

  it("keeps the replaced run's cost when a stronger-model run replaces a record", () => {
    const first = record({ route: "local", gate: "UNCERTAIN", final_status: "NEEDS_REVIEW", estimated_cost_usd: 0.0004 });
    const carried = carrySupersededRuns(first)!;
    expect(carried).toEqual([
      expect.objectContaining({ method: "local", route: "local", final_status: "NEEDS_REVIEW", estimated_cost_usd: 0.0004 }),
    ]);
    const second = record({ superseded_runs: carried, estimated_cost_usd: 0.001 });
    expect(carrySupersededRuns(second)).toHaveLength(2);
    expect(carrySupersededRuns(null)).toBeUndefined();
    expect(carrySupersededRuns({})).toBeUndefined();
  });
});
