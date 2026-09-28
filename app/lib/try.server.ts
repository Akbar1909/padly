import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { env } from "./env.server";
import { GpuServiceError, processImage } from "./gpu.server";
import { log } from "./log.server";
import { processingLogFields } from "./processing";
import { redis, tryLock } from "./redis.server";
import {
  deleteOlderThan,
  presignGet,
  presignPut,
  putObject,
} from "./storage.server";

/**
 * "Try it with your own photo" on the public landing page: one image, no
 * account. Free previews are limited per visitor per day and across all
 * visitors, only one runs at a time (merchants' jobs share the image service),
 * and every upload and its results are deleted after 24 hours.
 */

export const TRY_PREFIX = "public/try/";
export const TRY_MAX_BYTES = 12 * 1024 * 1024;
/**
 * Decoding cost grows with pixels, not bytes: a 500 KB PNG can hold 120
 * megapixels. "12 MP" cameras shoot 4032×3024 (12.2 M pixels), which must fit.
 */
export const TRY_MAX_PIXELS = 12_600_000;
export const TRY_MAX_SIDE = 8000;
const TRY_TTL_MS = 24 * 3600_000;
/** How long one try may hold the image service slot; covers the GPU timeout below plus uploads. */
const TRY_SLOT_TTL_MS = 120_000;
const TRY_GPU_TIMEOUT_MS = 90_000;
/** How long reading the upload may take; a trickled upload mustn't hold the slot until it expires. */
export const TRY_UPLOAD_DEADLINE_MS = 30_000;
/** Our own failures give the try back, but only this often per visitor per day. */
const MAX_REFUNDS_PER_DAY = 2;

export class TryError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "TryError";
  }
}

export interface TryOptions {
  aspect: "1:1" | "4:5";
  keepBackground: boolean;
}

export interface TryResult {
  id: string;
  before: string;
  after: string;
  aspect: "1:1" | "4:5";
  width: number;
  height: number;
  notes: string[];
}

// ─── Owner mode: unlimited tries in the owner's browser ────────────────────

export const OWNER_COOKIE = "vio_owner";

function ownerCookieValue(token: string): string {
  return createHmac("sha256", token).update("vio-owner-v1").digest("hex");
}

const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/** True when `token` is the configured owner token. */
export function isOwnerToken(
  token: string | null,
  secret = env().TRY_OWNER_TOKEN,
): boolean {
  return Boolean(secret && token && safeEqual(token, secret));
}

/** Set-Cookie header value that marks this browser as the owner's (1 year). */
export function ownerCookie(secret = env().TRY_OWNER_TOKEN!): string {
  return `${OWNER_COOKIE}=${ownerCookieValue(secret)}; Path=/; Max-Age=31536000; HttpOnly; Secure; SameSite=Lax`;
}

/** Whether the request comes from the owner's unlocked browser. */
export function isOwner(
  request: Request,
  secret = env().TRY_OWNER_TOKEN,
): boolean {
  if (!secret) return false;
  const cookies = request.headers.get("cookie") ?? "";
  const value = cookies
    .split(";")
    .map((c) => c.trim().split("="))
    .find(([name]) => name === OWNER_COOKIE)?.[1];
  return Boolean(value && safeEqual(value, ownerCookieValue(secret)));
}

/** First hop in X-Forwarded-For (set by Caddy), else the direct peer. */
export function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]!.trim();
  return request.headers.get("x-real-ip") ?? "unknown";
}

const day = (now: Date) => now.toISOString().slice(0, 10);
const tryKey = (ip: string, now: Date) => `try:${day(now)}:${ip}`;
const globalKey = (now: Date) => `try:all:${day(now)}`;
const refundKey = (ip: string, now: Date) => `try:refund:${day(now)}:${ip}`;
const COUNTER_TTL_S = 2 * 24 * 3600;

async function increment(key: string): Promise<number> {
  const n = await redis().incr(key);
  if (n === 1) await redis().expire(key, COUNTER_TTL_S);
  return n;
}

/**
 * Use one of today's free tries. Returns how many the visitor has left; throws
 * 429 when the visitor, or everyone together, has used today's allowance.
 * A rejected call uses nothing.
 */
export async function takeTry(
  ip: string,
  limit = env().TRY_DAILY_LIMIT,
  now = new Date(),
  globalLimit = env().TRY_GLOBAL_DAILY_LIMIT,
): Promise<number> {
  const key = tryKey(ip, now);
  const used = await increment(key);
  if (used > limit) {
    await redis().decr(key);
    throw new TryError(
      `You've used today's ${limit} free tries. Come back tomorrow, or install the Shopify app to clean a whole catalog.`,
      429,
    );
  }
  const all = await increment(globalKey(now));
  if (all > globalLimit) {
    await redis().decr(globalKey(now));
    await redis().decr(key);
    throw new TryError(
      "The free demo has reached today's limit. Please come back tomorrow, or install the Shopify app to clean a whole catalog.",
      429,
    );
  }
  return limit - used;
}

/**
 * Give a try back when the failure was ours, not the visitor's. Capped per
 * visitor per day, so failures can't become unlimited free processing.
 * Returns whether the try was refunded.
 */
export async function refundTry(
  ip: string,
  now = new Date(),
): Promise<boolean> {
  if ((await increment(refundKey(ip, now))) > MAX_REFUNDS_PER_DAY) return false;
  const key = tryKey(ip, now);
  if (Number(await redis().get(key)) > 0) await redis().decr(key);
  return true;
}

/**
 * The image service is shared with merchants' jobs, so only one try runs at a
 * time. Returns the release function, or null when another try is running.
 * The slot expires on its own if a request dies without releasing it.
 */
export function takeTrySlot(
  ttlMs = TRY_SLOT_TTL_MS,
): Promise<(() => Promise<void>) | null> {
  return tryLock("try:inflight", ttlMs);
}

/**
 * Read the try-it form, giving up after `deadlineMs` (408). The caller holds
 * the only try slot while the body arrives, so a slow or deliberately trickled
 * upload must not keep every other visitor waiting.
 */
export async function readTryForm(
  request: Request,
  deadlineMs = TRY_UPLOAD_DEADLINE_MS,
): Promise<FormData> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new TryError("The upload took too long. Please try again.", 408),
        ),
      deadlineMs,
    );
  });
  const form = request.formData().catch(() => {
    throw new TryError("We couldn't read that upload. Please try again.");
  });
  try {
    return await Promise.race([form, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** Identify JPG/PNG/WebP by their magic bytes (never trust the file name or type). */
export function sniffImage(
  bytes: Uint8Array,
): { mime: string; ext: string } | null {
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return { mime: "image/jpeg", ext: "jpg" };
  }
  if (
    bytes.length >= 8 &&
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every(
      (b, i) => bytes[i] === b,
    )
  ) {
    return { mime: "image/png", ext: "png" };
  }
  const ascii = (from: number, to: number) =>
    String.fromCharCode(...bytes.subarray(from, to));
  if (bytes.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") {
    return { mime: "image/webp", ext: "webp" };
  }
  return null;
}

type Size = { width: number; height: number };

/**
 * Width and height from the file header (PNG IHDR, JPEG SOFn, WebP VP8/VP8L/VP8X),
 * without decoding. Null when the header can't be read, or when it's built so
 * that a decoder could read a different size from it than we do.
 */
export function imageSize(bytes: Uint8Array): Size | null {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const kind = sniffImage(bytes);
  if (!kind) return null;
  if (kind.ext === "png") return pngSize(b);
  if (kind.ext === "jpg") return jpegSize(b);
  return webpSize(b);
}

/**
 * Walk the chunks up to the first IDAT, the way decoders do. Decoders keep the
 * last IHDR they read, so there must be exactly one, and it must come first.
 */
function pngSize(b: Buffer): Size | null {
  let size: Size | null = null;
  let i = 8;
  while (i + 8 <= b.length) {
    const length = b.readUInt32BE(i);
    const type = b.toString("latin1", i + 4, i + 8);
    if (type === "IHDR") {
      if (size || length !== 13 || i + 16 > b.length) return null;
      size = sized(b.readUInt32BE(i + 8), b.readUInt32BE(i + 12));
      if (!size) return null;
    } else if (!size) {
      return null; // IHDR must be the first chunk
    }
    if (type === "IDAT") return size;
    i += 12 + length; // length, type, data, CRC
  }
  return null;
}

/**
 * Walk the segments up to the start of scan, the way decoders do, and use the
 * one frame header (SOFn) found there. Anything a decoder could read
 * differently from us is refused instead of guessed at: a second frame header
 * (Pillow keeps the last), stuffed or reserved bytes between segments (Pillow
 * and libjpeg skip them, which can reveal segments we stepped over), and the
 * markers Pillow reads without a length (JPG, JPGn) or as a frame (DHP).
 * libjpeg can't decode files with those anyway.
 */
function jpegSize(b: Buffer): Size | null {
  let size: Size | null = null;
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1]!;
    if (marker === 0xff) {
      i++; // fill byte
      continue;
    }
    if (marker >= 0xd0 && marker <= 0xd8) {
      i += 2; // RSTn and SOI have no length
      continue;
    }
    if (marker === 0xda) return size; // start of scan: every frame header has been seen
    if (
      marker < 0xc0 || // stuffed zero (FF 00), TEM or reserved
      marker === 0xc8 || // JPG
      marker === 0xd9 || // end of image before any scan
      marker === 0xde || // DHP (hierarchical)
      marker === 0xdf || // EXP (hierarchical)
      (marker >= 0xf0 && marker <= 0xfd) // JPGn
    ) {
      return null;
    }
    const length = b.readUInt16BE(i + 2);
    if (length < 2) return null;
    const isFrame =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xcc;
    if (isFrame) {
      if (size || i + 9 > b.length) return null;
      size = sized(b.readUInt16BE(i + 7), b.readUInt16BE(i + 5));
      if (!size) return null;
    }
    i += 2 + length;
  }
  return null;
}

/**
 * The first chunk after the RIFF header describes the image. libwebp checks
 * that later chunks agree with it, so a file that disagrees fails to decode.
 */
function webpSize(b: Buffer): Size | null {
  if (b.length < 30) return null;
  const chunk = b.toString("latin1", 12, 16);
  if (chunk === "VP8 ") {
    // Lossy: frame tag (3 bytes), start code 9d 01 2a, then 14-bit sizes.
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    return sized(b.readUInt16LE(26) & 0x3fff, b.readUInt16LE(28) & 0x3fff);
  }
  if (chunk === "VP8L") {
    // Lossless: signature 0x2f, then width-1 and height-1 as 14-bit fields.
    if (b[20] !== 0x2f) return null;
    const bits = b.readUInt32LE(21);
    return sized((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
  }
  if (chunk === "VP8X") {
    // Extended: canvas width-1 and height-1 as 24-bit fields.
    return sized(b.readUIntLE(24, 3) + 1, b.readUIntLE(27, 3) + 1);
  }
  return null;
}

function sized(width: number, height: number): Size | null {
  return width > 0 && height > 0 ? { width, height } : null;
}

export async function runTry(
  file: File,
  options: TryOptions,
): Promise<TryResult> {
  if (!file.size) throw new TryError("Choose a photo to upload.");
  if (file.size > TRY_MAX_BYTES)
    throw new TryError("That photo is over 12 MB. Try a smaller one.", 413);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const kind = sniffImage(bytes);
  if (!kind) throw new TryError("Upload a JPG, PNG or WebP photo.", 415);
  const size = imageSize(bytes);
  if (!size) {
    throw new TryError(
      "We couldn't read that image. Try a different photo.",
      415,
    );
  }
  if (
    size.width * size.height > TRY_MAX_PIXELS ||
    Math.max(size.width, size.height) > TRY_MAX_SIDE
  ) {
    throw new TryError("That photo is too large (max 12 megapixels).", 413);
  }

  const id = randomUUID();
  const base = `${TRY_PREFIX}${id}/`;
  await putObject(`${base}source.${kind.ext}`, Buffer.from(bytes), kind.mime);
  const put = async (name: string, type: string) => ({
    url: await presignPut(`${base}${name}`, type),
    headers: { "Content-Type": type },
  });

  let result;
  try {
    result = await processImage(
      {
        request_id: `try-${id}`,
        source_url: await presignGet(`${base}source.${kind.ext}`, {
          audience: "gpu",
          expiresIn: 900,
        }),
        source_mime_type: kind.mime,
        uploads: {
          output: await put("output.jpg", "image/jpeg"),
          preview: await put("preview.jpg", "image/jpeg"),
          before: await put("before.jpg", "image/jpeg"),
          mask: await put("mask.png", "image/png"),
        },
        settings: {
          aspect: options.aspect,
          margin_pct: 8,
          remove_bg: !options.keepBackground,
          bg_color: "#FFFFFF",
          upscale: false,
          upscale_threshold_px: 1200,
          target_px: 2048,
          output_format: "jpeg",
          jpeg_quality: 90,
          ai_metadata: true,
        },
      },
      { timeoutMs: TRY_GPU_TIMEOUT_MS },
    );
  } catch (error) {
    // Only the photo's own problems are the visitor's. Anything else (a bad
    // signature, the service unable to fetch our upload, an outage) is ours,
    // and a 5xx gives the try back.
    const code = error instanceof GpuServiceError ? error.code : undefined;
    if (code === "unsupported_image") {
      throw new TryError(
        "We couldn't read that image. Try a different photo.",
        415,
      );
    }
    if (code === "image_too_large") {
      throw new TryError("That photo is too large (max 12 megapixels).", 413);
    }
    console.error("try: image service failed", error);
    throw new TryError(
      "Our image service is busy right now. Please try again in a minute.",
      503,
    );
  }

  log.info("TRY_PROCESSING", {
    tryId: id,
    flags: result.flags.map((f) => f.code),
    ...processingLogFields(result.processing, result.timings_ms.total),
  });

  return {
    id,
    before: await presignGet(`${base}before.jpg`),
    after: await presignGet(`${base}preview.jpg`),
    aspect: options.aspect,
    width: result.output.width,
    height: result.output.height,
    notes: result.flags.map((f) => f.message),
  };
}

/** Delete try uploads older than 24 hours (called hourly from worker maintenance). */
export function cleanupTries(now = Date.now()): Promise<number> {
  return deleteOlderThan(TRY_PREFIX, new Date(now - TRY_TTL_MS));
}
