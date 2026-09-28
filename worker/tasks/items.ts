import { createHash } from "node:crypto";
import { Readable, Transform } from "node:stream";
import { Prisma, type Job, type JobItem, type Shop } from "@prisma/client";
import prisma from "../../app/db.server";
import { lockShop, recordLedger } from "../../app/lib/credits.server";
import { MerchantError, PermanentError } from "../../app/lib/errors";
import { GpuServiceError, gpuPipeline, processImage, type GpuFlag, type GpuSettings } from "../../app/lib/gpu.server";
import { refreshJobState, pumpShop, REVERT_STATUS } from "../../app/lib/jobs.server";
import {
  carrySupersededRuns,
  itemFinalStatus,
  processingLogFields,
  qualityLogFields,
  resultStatus,
  type ProcessingRecord,
} from "../../app/lib/processing";
import {
  applyCharge,
  reservationAfterProcessing,
  upscaleCovered,
  type PresetSettings,
} from "../../app/lib/presets";
import type { ItemTask } from "../../app/lib/queue.server";
import { findReusableResult, resultKeyFor, sha256Hex } from "../../app/lib/reuse.server";
import { shopifyClientFor } from "../../app/lib/shopify/client.server";
import {
  currentExtension,
  extensionForMime,
  writeImage,
} from "../../app/lib/shopify/files.server";
import { getLiveMedia, type LiveMedia } from "../../app/lib/shopify/media.server";
import {
  getObjectBuffer,
  headObject,
  keys,
  numericId,
  presignGet,
  presignPut,
  putObject,
} from "../../app/lib/storage.server";
import { log } from "../log";
import { itemFailureCode, itemFailureMessage, MESSAGES } from "../messages";

type OutputFormat = GpuSettings["output_format"];

/** Match the original's format so fileUpdate can replace in place (it requires the same extension). */
export function outputFormatFor(mime: string | null): OutputFormat {
  switch ((mime ?? "").toLowerCase()) {
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
    default:
      return "jpeg";
  }
}

const EXT_FOR_FORMAT: Record<OutputFormat, string> = { jpeg: "jpg", png: "png", webp: "webp" };

function formatFromKey(key: string): string {
  const ext = key.split(".").pop()!.toLowerCase();
  return ext === "jpg" ? "jpeg" : ext;
}

function basenameFor(item: Pick<JobItem, "productTitle" | "mediaId">): string {
  const slug = item.productTitle
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `${slug || "product"}-${numericId(item.mediaId)}`;
}

type LoadedItem = JobItem & { job: Job; shop: Shop };

async function loadItem(task: ItemTask): Promise<LoadedItem | null> {
  return prisma.jobItem.findUnique({
    where: { id: task.itemId },
    include: { job: true, shop: true },
  });
}

/** Put an item back where the pump found it (its job is no longer in the right phase). */
async function revert(item: JobItem): Promise<void> {
  const to = REVERT_STATUS[item.status];
  if (to) {
    await prisma.jobItem.updateMany({ where: { id: item.id, status: item.status }, data: { status: to } });
  }
}

/** What runItemTask knows about the BullMQ delivery. */
export interface ItemTaskContext {
  /** 1-based BullMQ attempt of this claim. */
  attempt?: number;
}

function started(item: LoadedItem, kind: ItemTask["kind"], attempt: number): void {
  log.info("IMAGE_JOB_STARTED", {
    itemId: item.id,
    jobId: item.jobId,
    shop: item.shop.domain,
    kind,
    claim: item.attempts,
    attempt,
  });
}

// ─── backup ─────────────────────────────────────────────────────────────────

interface Backup {
  backupKey: string;
  sourceSha256: string | null;
  /** MIME type of the backed-up original (what the image service will read). */
  mime: string | null;
}

/** Pass a web stream through, hashing it on the way to storage. */
function hashingStream(body: ReadableStream<Uint8Array>) {
  const hash = createHash("sha256");
  const source = Readable.fromWeb(body as never);
  const pass = new Transform({
    transform(chunk, _encoding, done) {
      hash.update(chunk);
      done(null, chunk);
    },
  });
  source.on("error", (error) => pass.destroy(error));
  source.pipe(pass);
  return { stream: pass, digest: () => hash.digest("hex") };
}

/**
 * The live image is the output of an earlier applied item (same media, the live file's size is
 * exactly that item's output size, the check applyItem itself uses): its backup is the true
 * original, so reuse it instead of backing up our own output as the "original".
 */
async function appliedOriginal(item: LoadedItem, live: LiveMedia) {
  if (!live.fileSize) return null;
  const prior = await prisma.jobItem.findMany({
    where: {
      shopId: item.shopId,
      id: { not: item.id },
      status: "applied",
      appliedAt: { not: null },
      backupKey: { not: null },
      outputKey: { not: null },
      OR: [{ mediaId: item.mediaId, appliedMediaId: null }, { appliedMediaId: item.mediaId }],
    },
    orderBy: { appliedAt: "desc" },
    take: 3,
    select: { id: true, backupKey: true, outputKey: true, sourceSha256: true, mimeType: true },
  });
  for (const p of prior) {
    const output = await headObject(p.outputKey!);
    if (output?.size !== live.fileSize) continue;
    if (!(await headObject(p.backupKey!))) continue;
    return p;
  }
  return null;
}

/** 1. Permanent backup of the original. Never edit an image that has no backup. */
async function ensureBackup(item: LoadedItem, live: LiveMedia): Promise<Backup> {
  if (item.backupKey && (await headObject(item.backupKey))) {
    return { backupKey: item.backupKey, sourceSha256: item.sourceSha256, mime: item.mimeType };
  }
  const liveFields = {
    fileSize: live.fileSize,
    width: live.width,
    height: live.height,
    alt: live.alt,
    originalUrl: live.originalUrl ?? live.imageUrl!,
  };

  const prior = await appliedOriginal(item, live);
  if (prior) {
    const sourceSha256 = prior.sourceSha256 ?? sha256Hex(await getObjectBuffer(prior.backupKey!));
    const mime = prior.mimeType ?? live.mimeType ?? item.mimeType;
    await prisma.jobItem.update({
      where: { id: item.id },
      data: { backupKey: prior.backupKey, sourceSha256, mimeType: mime, ...liveFields },
    });
    log.info("backup reused: the live image is an applied result", { itemId: item.id, from: prior.id });
    return { backupKey: prior.backupKey!, sourceSha256, mime };
  }

  const res = await fetch((live.originalUrl ?? live.imageUrl)!);
  if (!res.ok || !res.body) {
    throw new MerchantError(
      `Downloading the original failed: HTTP ${res.status}`,
      "We couldn't download this image from Shopify. Retry failed images in a few minutes.",
      true,
      "source_download_failed",
    );
  }
  const mime = live.mimeType ?? res.headers.get("content-type") ?? "application/octet-stream";
  const ext = extensionForMime(mime) ?? currentExtension(live) ?? "bin";
  const backupKey = keys.backup(item.shopId, item.mediaId, item.id, ext);
  const hashed = hashingStream(res.body);
  await putObject(backupKey, hashed.stream, mime, {
    "media-id": item.mediaId,
    "product-id": item.productId,
    position: String(item.position),
    "job-item-id": item.id,
  });
  const sourceSha256 = hashed.digest();
  await prisma.jobItem.update({
    where: { id: item.id },
    data: { backupKey, sourceSha256, mimeType: mime, ...liveFields },
  });
  return { backupKey, sourceSha256, mime };
}

// ─── process ────────────────────────────────────────────────────────────────

const jsonOrNull = (v: Prisma.JsonValue | null) => (v === null ? Prisma.JsonNull : (v as Prisma.InputJsonValue));

async function processItem(task: ItemTask, attempt: number): Promise<void> {
  const t0 = Date.now();
  const item = await loadItem(task);
  if (!item || item.status !== "processing") return;
  if (item.job.status !== "processing") return revert(item);
  started(item, "process", attempt);

  const preset = item.job.presetSnapshot as unknown as PresetSettings;
  const client = await shopifyClientFor(item.shop.domain);

  // Always look at the live image: the URL read earlier is signed and short-lived,
  // and the merchant may have changed the image since.
  const live = await getLiveMedia(client, item.mediaId);
  if (!live) throw new PermanentError("This image no longer exists in Shopify.", "source_deleted");
  if (live.fileStatus === "UPLOADED" || live.fileStatus === "PROCESSING") {
    // Shopify is still working on the file (just uploaded or replaced): try again later.
    throw new MerchantError(`Shopify file status is ${live.fileStatus}`, MESSAGES.notReady, true, "source_not_ready");
  }
  if (!live.originalUrl && !live.imageUrl) {
    throw new PermanentError("Shopify has no downloadable file for this image.", "no_source_file");
  }

  const backup = await ensureBackup(item, live);

  // 2. Run the pipeline on the GPU service. It reads the backup and writes
  //    artifacts straight to storage through presigned URLs.
  const format = outputFormatFor(live.mimeType ?? item.mimeType);
  const settings: GpuSettings = {
    aspect: preset.aspect,
    margin_pct: preset.marginPct,
    remove_bg: preset.removeBg,
    bg_color: preset.bgColor,
    // Only upscale if the reservation includes the upscaling credit, so an
    // image that shrank below the threshold since it was read can't cost more
    // than quoted.
    upscale: upscaleCovered(preset, item.creditsReserved),
    upscale_threshold_px: preset.upscaleThresholdPx,
    target_px: preset.targetPx,
    output_format: format,
    jpeg_quality: 90,
    ai_metadata: preset.aiMetadata,
    // "Retry with stronger model": the paid backend first (part of the result key).
    force_escalation: item.forceEscalation,
  };
  // No key (and no reuse) when the image service's setup can't be read: a result must never be
  // filed under a pipeline that may not have made it.
  const pipeline = backup.sourceSha256 ? await gpuPipeline() : null;
  const resultKey =
    backup.sourceSha256 && pipeline
      ? resultKeyFor(item.mediaId, backup.sourceSha256, settings, pipeline.fingerprint)
      : null;

  // The same source bytes with the same settings and pipeline were processed before: reuse that result.
  const reusable = resultKey && pipeline ? await findReusableResult(item.shopId, item.id, resultKey, pipeline) : null;
  if (reusable) {
    // Only READY results are reused (findReusableResult), so this is "ready"; mapped the same
    // way as a fresh result all the same.
    const from = (reusable.processing ?? null) as ProcessingRecord | null;
    const mapped = resultStatus(Array.isArray(reusable.flags) ? (reusable.flags as unknown as GpuFlag[]) : [], from);
    const { status, flags } = mapped;
    const record: ProcessingRecord = {
      operations: from?.operations ?? [],
      method: "reused",
      replicate_used: false,
      replicate_calls: 0,
      replicate_models: [],
      estimated_cost_usd: 0,
      fallback_reason: null,
      quality_score: from?.quality_score ?? null,
      quality_checks: from?.quality_checks ?? {},
      attempts: [],
      route: "reused",
      local_attempted: false,
      local_accepted: false,
      gate: null,
      ai_gate: null,
      reason_codes: [],
      replicate_attempts: 0,
      ...(from?.quality_scores ? { quality_scores: from.quality_scores } : {}),
      ...(from?.analysis ? { analysis: from.analysis } : {}),
      shadow: null,
      final_status: status === "ready" ? "READY" : status === "unchanged" ? "NO_CHANGE" : "NEEDS_REVIEW",
      duration_ms: Date.now() - t0,
      attempt,
      reused_from: reusable.id,
      superseded_runs: carrySupersededRuns(item.processing),
    };
    const finalStatus = itemFinalStatus({ status, flags, processing: record });
    const stored = await prisma.jobItem.updateMany({
      where: { id: item.id, status: "processing" },
      data: {
        status,
        resultKey,
        outputKey: reusable.outputKey,
        previewKey: reusable.previewKey,
        beforeKey: reusable.beforeKey,
        maskKey: reusable.maskKey,
        outputFormat: reusable.outputFormat,
        outputWidth: reusable.outputWidth,
        outputHeight: reusable.outputHeight,
        flags: flags as unknown as Prisma.InputJsonValue,
        metrics: jsonOrNull(reusable.metrics),
        fidelity: reusable.fidelity,
        models: jsonOrNull(reusable.models),
        processing: record as unknown as Prisma.InputJsonValue,
        upscaleApplied: reusable.upscaleApplied,
        creditsReserved: reservationAfterProcessing(item.creditsReserved, reusable.upscaleApplied),
        error: null,
        errorCode: null,
      },
    });
    log.info("PROCESSING_SUCCESS", {
      itemId: item.id,
      jobId: item.jobId,
      shop: item.shop.domain,
      status,
      flags: flags.map((f) => (f as { code?: string } | null)?.code),
      ...processingLogFields(record, record.duration_ms),
      final_status: finalStatus ?? undefined,
    });
    log.info("IMAGE_JOB_COMPLETED", {
      itemId: item.id,
      jobId: item.jobId,
      shop: item.shop.domain,
      kind: "process",
      status,
      durationMs: Date.now() - t0,
      method: "reused",
      ...qualityLogFields(record, finalStatus),
      replicate_calls: 0,
      estimated_usd: 0,
      attempt,
      reused: true,
      reusedFrom: reusable.id,
      stored: stored.count > 0,
    });
    return;
  }

  // A "Retry with stronger model" run writes to keys of its own (per claim): the earlier result
  // may be shared with items that reused it, and must never change under them.
  const run = item.forceEscalation ? `s${item.attempts}` : undefined;
  const outputKey = keys.artifact(item.shopId, item.jobId, item.id, "output", EXT_FOR_FORMAT[format], run);
  const previewKey = keys.artifact(item.shopId, item.jobId, item.id, "preview", "jpg", run);
  const beforeKey = keys.artifact(item.shopId, item.jobId, item.id, "before", "jpg", run);
  const maskKey = keys.artifact(item.shopId, item.jobId, item.id, "mask", "png", run);
  const outputMime = format === "jpeg" ? "image/jpeg" : `image/${format}`;
  const put = async (key: string, contentType: string) => ({
    url: await presignPut(key, contentType),
    headers: { "Content-Type": contentType },
  });

  const result = await processImage({
    request_id: item.id,
    source_url: await presignGet(backup.backupKey, { audience: "gpu", expiresIn: 1800 }),
    source_mime_type: backup.mime ?? live.mimeType ?? item.mimeType,
    uploads: {
      output: await put(outputKey, outputMime),
      preview: await put(previewKey, "image/jpeg"),
      before: await put(beforeKey, "image/jpeg"),
      mask: await put(maskKey, "image/png"),
    },
    settings,
  });

  // READY → ready, NEEDS_REVIEW → flagged (with at least one flag), NO_CHANGE → unchanged
  // (never applied or charged); without a final status (an older service): flags decide.
  const { status, flags } = resultStatus(result.flags, result.processing);
  const record: ProcessingRecord | undefined = result.processing
    ? {
        ...result.processing,
        duration_ms: result.timings_ms.total,
        attempt,
        superseded_runs: carrySupersededRuns(item.processing),
      }
    : undefined;
  const finalStatus = itemFinalStatus({ status, flags, processing: record ?? null });
  const stored = await prisma.jobItem.updateMany({
    where: { id: item.id, status: "processing" },
    data: {
      status,
      resultKey,
      outputKey,
      previewKey,
      beforeKey,
      maskKey,
      outputFormat: format,
      outputWidth: result.output.width,
      outputHeight: result.output.height,
      flags: flags as never,
      metrics: result.metrics as never,
      fidelity: result.fidelity,
      models: { ...result.models, upscale: result.upscale, timings_ms: result.timings_ms } as never,
      // The whole record, new fields included (route, gates, reason codes, analysis, shadow…).
      processing: record ? (record as never) : undefined,
      upscaleApplied: result.upscale.applied,
      // Only charge the upscaling credit if the AI model actually ran.
      creditsReserved: reservationAfterProcessing(item.creditsReserved, result.upscale.applied),
      error: null,
      errorCode: null,
    },
  });
  log.info("PROCESSING_SUCCESS", {
    itemId: item.id,
    jobId: item.jobId,
    shop: item.shop.domain,
    status,
    flags: flags.map((f) => f.code),
    ...processingLogFields(result.processing, result.timings_ms.total),
    final_status: finalStatus ?? undefined,
    force_escalation: item.forceEscalation || undefined,
  });
  log.info("IMAGE_JOB_COMPLETED", {
    itemId: item.id,
    jobId: item.jobId,
    shop: item.shop.domain,
    kind: "process",
    status,
    durationMs: Date.now() - t0,
    gpuMs: result.timings_ms.total,
    method: result.processing?.method ?? "unknown",
    ...qualityLogFields(result.processing, finalStatus),
    replicate_used: result.processing?.replicate_used ?? false,
    replicate_calls: result.processing?.replicate_calls ?? 0,
    estimated_usd: result.processing?.estimated_cost_usd ?? 0,
    attempt,
    reused: false,
    stored: stored.count > 0,
  });
}

// ─── apply ──────────────────────────────────────────────────────────────────

async function applyItem(task: ItemTask, attempt: number): Promise<void> {
  const t0 = Date.now();
  const item = await loadItem(task);
  if (!item || item.status !== "applying") return;
  if (item.job.status !== "applying") return revert(item);
  started(item, "apply", attempt);

  if (!item.backupKey || !(await headObject(item.backupKey))) {
    throw new PermanentError("No backup of the original was found, so this image was not changed.", "backup_missing");
  }
  if (!item.outputKey || !item.outputFormat) {
    throw new PermanentError("There is no processed image to apply.", "no_output");
  }

  const client = await shopifyClientFor(item.shop.domain);

  // appliedAt is set right after Shopify accepts the write, so a retry after a
  // crash goes straight to bookkeeping instead of writing twice.
  let method = "already_written";
  if (!item.appliedAt) {
    const live = await getLiveMedia(client, item.mediaId);
    if (!live) throw new PermanentError("This image was deleted in Shopify.", "source_deleted");
    const output = await headObject(item.outputKey);
    if (item.fileSize && live.fileSize && live.fileSize !== item.fileSize && live.fileSize !== output?.size) {
      throw new PermanentError(
        "This image was changed in Shopify after it was processed. Run a new job to process the current version.",
        "changed_in_shopify",
      );
    }

    const body = await getObjectBuffer(item.outputKey);
    const written = await writeImage(client, {
      targetId: item.mediaId,
      productId: item.productId,
      position: item.position,
      alt: item.alt,
      body,
      format: item.outputFormat,
      basename: basenameFor(item),
    });
    await prisma.jobItem.update({
      where: { id: item.id },
      data: {
        appliedAt: new Date(),
        appliedMediaId: written.mediaId === item.mediaId ? null : written.mediaId,
      },
    });
    method = written.method;
    log.info("applied", { itemId: item.id, method: written.method });
  }

  // Charge only now, when the image is actually live in the store, and never
  // more than was reserved (the balance was checked against the reservation).
  const charge = applyCharge(item.upscaleApplied, item.creditsReserved);
  await prisma.$transaction(async (tx) => {
    await lockShop(tx, item.shopId);
    await recordLedger(tx, {
      shopId: item.shopId,
      delta: -charge,
      reason: "apply",
      idempotencyKey: `apply:${item.id}`,
      jobItemId: item.id,
    });
    await tx.jobItem.update({
      where: { id: item.id },
      data: { status: "applied", creditsCharged: charge, creditsReserved: 0, error: null, errorCode: null },
    });
  });
  log.info("IMAGE_JOB_COMPLETED", {
    itemId: item.id,
    jobId: item.jobId,
    shop: item.shop.domain,
    kind: "apply",
    status: "applied",
    durationMs: Date.now() - t0,
    method,
    charged: charge,
    attempt,
  });
}

// ─── restore ────────────────────────────────────────────────────────────────

async function restoreItem(task: ItemTask, attempt: number): Promise<void> {
  const t0 = Date.now();
  const item = await loadItem(task);
  if (!item || item.status !== "restoring") return;
  started(item, "restore", attempt);
  if (!item.backupKey) throw new PermanentError("No backup exists for this image.", "backup_missing");

  const client = await shopifyClientFor(item.shop.domain);
  const body = await getObjectBuffer(item.backupKey);
  const written = await writeImage(client, {
    targetId: item.appliedMediaId ?? item.mediaId,
    productId: item.productId,
    position: item.position,
    alt: item.alt,
    body,
    format: formatFromKey(item.backupKey),
    basename: basenameFor(item),
  });
  await prisma.jobItem.update({
    where: { id: item.id },
    data: {
      status: "restored",
      restoredAt: new Date(),
      appliedMediaId: written.mediaId === item.mediaId ? null : written.mediaId,
      error: null,
      errorCode: null,
    },
  });
  log.info("IMAGE_JOB_COMPLETED", {
    itemId: item.id,
    jobId: item.jobId,
    shop: item.shop.domain,
    kind: "restore",
    status: "restored",
    durationMs: Date.now() - t0,
    method: written.method,
    attempt,
  });
}

// ─── entry points ───────────────────────────────────────────────────────────

export async function runItemTask(task: ItemTask, ctx: ItemTaskContext = {}): Promise<void> {
  const attempt = ctx.attempt ?? 1;
  switch (task.kind) {
    case "process":
      return processItem(task, attempt);
    case "apply":
      return applyItem(task, attempt);
    case "restore":
      return restoreItem(task, attempt);
  }
}

/**
 * Last attempt failed: record it in words the merchant can act on (the raw
 * error was logged by the caller), with a machine-readable code. Failed items
 * drop out of the credit reservation automatically.
 */
export async function markItemFailed(task: ItemTask, error: unknown): Promise<void> {
  const message = itemFailureMessage(error);
  const code = itemFailureCode(error);
  if (task.kind === "process") {
    log.warn("PROCESSING_FAILURE", {
      itemId: task.itemId,
      jobId: task.jobId,
      code: error instanceof GpuServiceError ? error.code : undefined,
      errorCode: code,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  if (task.kind === "restore") {
    // The processed image is still live; let the merchant try the restore again.
    await prisma.jobItem.updateMany({
      where: { id: task.itemId, status: "restoring" },
      data: { status: "applied", error: `Restore failed: ${message}`, errorCode: `restore_${code}` },
    });
    return;
  }
  const from = task.kind === "process" ? "processing" : "applying";
  await prisma.jobItem.updateMany({
    where: { id: task.itemId, status: from },
    data: { status: "failed", error: message, errorCode: task.kind === "apply" ? `apply_${code}` : code },
  });
}

/** After any item task settles: advance the job phase and hand the shop's free slot to the next item. */
export async function afterItemTask(task: ItemTask): Promise<void> {
  await refreshJobState(task.jobId);
  await pumpShop(task.shopId);
}
