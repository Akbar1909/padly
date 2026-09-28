import { describe, expect, it } from "vitest";
import type { GpuProcessing } from "../../app/lib/gpu.server";
import { processingLogFields, summarizeProcessing } from "../../app/lib/processing";

function record(over: Partial<GpuProcessing> & { duration_ms?: number } = {}) {
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

describe("processing monitoring", () => {
  it("summarises method mix, Replicate share, cost, duration and fallback reasons", () => {
    const s = summarizeProcessing([
      { status: "ready", processing: record() },
      { status: "ready", processing: record({ duration_ms: 4000 }) },
      {
        status: "flagged",
        processing: record({
          method: "replicate",
          replicate_used: true,
          replicate_calls: 1,
          replicate_models: ["men1scus/birefnet"],
          estimated_cost_usd: 0.0009,
          fallback_reason: "background_artifacts",
          quality_score: 0.7,
          duration_ms: 9000,
        }),
      },
      {
        status: "ready",
        processing: record({
          method: "local",
          fallback_reason: "background_artifacts (not escalated: escalation_cooldown); replicate_unavailable",
        }),
      },
      { status: "failed", processing: null },
    ]);
    expect(s).toMatchObject({
      images: 4,
      failed: 1,
      byMethod: { local: 3, replicate: 1 },
      replicateImages: 1,
      replicateShare: 0.25,
      replicateCalls: 1,
      estimatedUsd: 0.0009,
      usdPerImage: 0.000225,
      avgDurationMs: 4250,
      avgQuality: 0.925,
      fallbackReasons: {
        background_artifacts: 1,
        "background_artifacts (not escalated: escalation_cooldown)": 1,
        replicate_unavailable: 1,
      },
    });
  });

  it("ignores items processed before monitoring existed", () => {
    expect(summarizeProcessing([{ status: "ready", processing: null }, { status: "ready", processing: {} }])).toMatchObject({
      images: 0,
      usdPerImage: 0,
      avgQuality: null,
    });
  });

  it("flattens a record into log fields", () => {
    expect(processingLogFields(record({ replicate_models: ["a", "b"] }) as GpuProcessing, 1234)).toEqual({
      operations: "decode,background_removal,canvas,export",
      method: "local",
      replicate_used: false,
      replicate_calls: 0,
      replicate_models: "a,b",
      estimated_usd: 0,
      fallback_reason: undefined,
      quality_score: 1,
      duration_ms: 1234,
    });
    expect(processingLogFields(null, 5)).toEqual({ method: "unknown", duration_ms: 5 });
  });
});
