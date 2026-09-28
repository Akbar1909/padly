import { createHash } from "node:crypto";
import type { JobItemStatus } from "@prisma/client";
import prisma from "../db.server";
import type { GpuPipeline, GpuSettings } from "./gpu.server";
import type { ProcessingRecord } from "./processing";
import { headObject } from "./storage.server";

/**
 * Reusing identical results. An image processed again with the same source bytes, the same
 * settings and the same image-service setup gets the earlier result instead of another
 * image-service (and Replicate) call. This only saves processing cost: credits are still
 * charged per applied image, and the active-media check in startJob is what prevents double
 * charges across jobs.
 *
 * Only a result whose final status was READY is reused (every automatic check passed, nothing
 * flagged): never one that needed review, failed, or was already clean (NO_CHANGE), never one
 * the merchant rejected or restored, and never a degraded one (the paid model was wanted but
 * unavailable, capped or cooling down, or a fallback backend made it), so asking again for a
 * better result really asks again. The key includes force_escalation: a "Retry with stronger
 * model" result is only reused for another stronger-model request with identical settings,
 * and a stronger-model request never gets an ordinary result.
 *
 * Sharing storage keys between items is safe: an item's output is never rewritten once it has
 * one (retries only reprocess items without an output), and objects are only deleted with the
 * whole shop.
 */

/**
 * Bump to stop reusing results made before a change the pipeline fingerprint can't see (the
 * image service's code, not its models or backends). v2: the fingerprint joined the key. v3:
 * force_escalation joined the settings, and only READY results are reused.
 */
export const RESULT_KEY_VERSION = "v3"; // v3: force_escalation is always part of the settings hashed

export const sha256Hex = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

/** JSON with object keys sorted, so equal settings always hash the same. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * sha256(version | pipeline fingerprint | media | source bytes hash | sha256(settings)).
 * `pipeline` is GpuPipeline.fingerprint (the image service's backends and models). The settings
 * always include force_escalation (false when not sent), so an ordinary request and a "Retry
 * with stronger model" one never share a key.
 */
export function resultKeyFor(mediaId: string, sourceSha256: string, settings: GpuSettings, pipeline: string): string {
  const keyed = { ...settings, force_escalation: settings.force_escalation === true };
  return sha256Hex(`${RESULT_KEY_VERSION}|${pipeline}|${mediaId}|${sourceSha256}|${sha256Hex(canonicalJson(keyed))}`);
}

/** Item statuses of a result the merchant hasn't turned down: reusable when it was READY. */
export const REUSABLE_ITEM_STATUSES: JobItemStatus[] = ["ready", "approved", "applying", "applied"];

/**
 * Item statuses whose output rules out every item sharing it: the merchant kept the original
 * (rejected) or put it back after applying (restored).
 */
const TURNED_DOWN_ITEM_STATUSES: JobItemStatus[] = ["rejected", "restore_queued", "restoring", "restored"];

/**
 * Pure: was this result's final status READY? Nothing flagged, and the image service said READY
 * (or, from a service older than final statuses, said nothing). NEEDS_REVIEW, NO_CHANGE and
 * anything unknown are never reused.
 */
export function wasReady(flags: unknown, processing: unknown): boolean {
  if (!Array.isArray(flags) || flags.length > 0) return false;
  const p = processing as Partial<ProcessingRecord> | null;
  if (!p || typeof p !== "object") return true;
  return p.final_status === undefined || p.final_status === null || p.final_status === "READY";
}

/** Methods that don't depend on a backend (no AI model kept), plus our own copy of a result. */
const BACKEND_FREE_METHODS = new Set(["deterministic", "source_alpha", "reused"]);

/**
 * Pure: was this result made the intended way, so reusing it is as good as processing again?
 * False when the paid model was wanted but not used (a fallback_reason with no paid call, or
 * one saying Replicate was unavailable or not escalated), or when a backend other than the
 * service's primary or escalation one made it (FALLBACK_BACKEND stood in). A result without a
 * processing record (an older image service) is judged on the key alone.
 */
export function madeAsIntended(processing: unknown, pipeline: Pick<GpuPipeline, "backend" | "escalation">): boolean {
  const p = processing as Partial<ProcessingRecord> | null;
  if (!p || typeof p !== "object") return true;
  // The paid model was asked for (or needed) and couldn't be used: a later request should try again.
  if (Array.isArray(p.reason_codes) && p.reason_codes.includes("ESCALATION_UNAVAILABLE")) return false;
  const reason = typeof p.fallback_reason === "string" ? p.fallback_reason : "";
  if (reason) {
    if (/replicate_unavailable|not escalated/i.test(reason)) return false;
    if (!(p.replicate_calls ?? 0)) return false;
  }
  const method = typeof p.method === "string" ? p.method : "";
  if (!method || BACKEND_FREE_METHODS.has(method)) return true;
  const allowed = new Set([pipeline.backend, ...(pipeline.escalation ? [pipeline.escalation] : [])]);
  return method.split("+").every((kind) => allowed.has(kind));
}

/**
 * Another item of the shop with this result key whose output and preview still exist, whose
 * final status was READY (ready, or approved / applied since, with nothing flagged), made as
 * intended, and whose output no item of the shop was rejected or restored with (a reused copy
 * shares its source's output, so turning either down rules out both).
 */
export async function findReusableResult(
  shopId: string,
  itemId: string,
  resultKey: string,
  pipeline: Pick<GpuPipeline, "backend" | "escalation">,
) {
  const [candidates, rejected] = await Promise.all([
    prisma.jobItem.findMany({
      where: {
        shopId,
        resultKey,
        id: { not: itemId },
        status: { in: REUSABLE_ITEM_STATUSES },
        outputKey: { not: null },
        previewKey: { not: null },
        outputFormat: { not: null },
      },
      orderBy: { updatedAt: "desc" },
      take: 10,
      select: {
        id: true,
        outputKey: true,
        previewKey: true,
        beforeKey: true,
        maskKey: true,
        outputFormat: true,
        outputWidth: true,
        outputHeight: true,
        flags: true,
        metrics: true,
        fidelity: true,
        models: true,
        processing: true,
        upscaleApplied: true,
      },
    }),
    prisma.jobItem.findMany({
      where: { shopId, resultKey, status: { in: TURNED_DOWN_ITEM_STATUSES }, outputKey: { not: null } },
      select: { outputKey: true },
    }),
  ]);
  const rejectedOutputs = new Set(rejected.map((r) => r.outputKey));
  let checked = 0;
  for (const c of candidates) {
    if (rejectedOutputs.has(c.outputKey) || !wasReady(c.flags, c.processing) || !madeAsIntended(c.processing, pipeline)) {
      continue;
    }
    if (++checked > 3) break;
    const [output, preview] = await Promise.all([headObject(c.outputKey!), headObject(c.previewKey!)]);
    if (output && preview) return c;
  }
  return null;
}
