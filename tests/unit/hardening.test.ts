import type { ActionFunctionArgs } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { addSecurityHeaders } from "../../app/entry.server";
import { MerchantError, PermanentError } from "../../app/lib/errors";
import { GpuServiceError } from "../../app/lib/gpu.server";
import {
  applyCharge,
  creditsFor,
  reservationAfterProcessing,
  upscaleCovered,
} from "../../app/lib/presets";
import { FileProcessingError } from "../../app/lib/shopify/files.server";
import { ShopifyAuthError, ShopifyGraphqlError } from "../../app/lib/shopify/graphql";
import { imageSize, readTryForm, TRY_MAX_PIXELS } from "../../app/lib/try.server";
import { addDocumentResponseHeaders } from "../../app/shopify.server";
import { itemFailureMessage, MESSAGES, readFailureMessage } from "../../worker/messages";

// Unit tests have no database: keep shopify.server's session storage from polling one.
vi.mock("@shopify/shopify-app-session-storage-prisma", () => ({
  PrismaSessionStorage: class {
    isReady = async () => true;
  },
}));

// ── header fixtures (no pixel data needed: only the header is read) ─────────

/** A PNG chunk; the CRC is left zero because only the header is read. */
function pngChunk(type: string, data: number[]): number[] {
  const b = Buffer.alloc(12 + data.length);
  b.writeUInt32BE(data.length, 0);
  b.write(type, 4, "latin1");
  b.set(data, 8);
  return [...b];
}

function ihdr(width: number, height: number): number[] {
  const b = Buffer.alloc(13);
  b.writeUInt32BE(width, 0);
  b.writeUInt32BE(height, 4);
  b.set([8, 6, 0, 0, 0], 8);
  return [...b];
}

/** Signature, IHDR, then an (empty) IDAT: the header ends at the first IDAT. */
function pngHeader(width: number, height: number, before: number[][] = []): Uint8Array {
  return new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...before.flat(),
    ...pngChunk("IHDR", ihdr(width, height)),
    ...pngChunk("IDAT", []),
  ]);
}

const seg = (marker: number, data: number[]) => [0xff, marker, (data.length + 2) >> 8, (data.length + 2) & 0xff, ...data];
const frame = (w: number, h: number) => [8, h >> 8, h & 0xff, w >> 8, w & 0xff, 3, 1, 0x11, 0, 2, 0x11, 1, 3, 0x11, 1];
const sof = (w: number, h: number, marker = 0xc0) => seg(marker, frame(w, h));
const sos = seg(0xda, [1, 1, 0, 0, 63, 0]);
const jpeg = (...parts: number[][]) => new Uint8Array([0xff, 0xd8, ...parts.flat(), ...sos, 0xff, 0xd9]);

function jpegHeader(width: number, height: number, opts: { sof?: number; thumbnail?: boolean } = {}): Uint8Array {
  const jfif = seg(0xe0, [...Buffer.from("JFIF\0", "latin1"), 1, 1, 0, 0, 1, 0, 1, 0, 0]);
  // An EXIF block whose embedded thumbnail has its own (small) frame header.
  const exif = opts.thumbnail ? seg(0xe1, [...Buffer.from("Exif\0\0", "latin1"), 0xff, 0xd8, ...sof(160, 120)]) : [];
  const dht = seg(0xc4, [0, 0, 0]);
  return jpeg(jfif, exif, [0xff, 0xff], dht, sof(width, height, opts.sof)); // 0xff 0xff: a fill byte
}

function riff(chunk: string, data: number[]): Uint8Array {
  const b = Buffer.alloc(20 + data.length);
  b.write("RIFF", 0, "latin1");
  b.writeUInt32LE(12 + data.length, 4);
  b.write("WEBP", 8, "latin1");
  b.write(chunk, 12, "latin1");
  b.writeUInt32LE(data.length, 16);
  b.set(data, 20);
  return b;
}

const webpLossy = (w: number, h: number) =>
  riff("VP8 ", [0x9d, 0x01, 0x00, 0x9d, 0x01, 0x2a, w & 0xff, (w >> 8) & 0x3f, h & 0xff, (h >> 8) & 0x3f]);

function webpLossless(w: number, h: number) {
  const bits = ((w - 1) | ((h - 1) << 14)) >>> 0;
  return riff("VP8L", [0x2f, bits & 0xff, (bits >> 8) & 0xff, (bits >> 16) & 0xff, (bits >>> 24) & 0xff, 0, 0, 0, 0, 0]);
}

function webpExtended(w: number, h: number) {
  const le24 = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff];
  return riff("VP8X", [0x10, 0, 0, 0, ...le24(w - 1), ...le24(h - 1)]);
}

describe("image header sizes (try-it pixel limit)", () => {
  it("reads PNG, JPEG and all three WebP flavours", () => {
    expect(imageSize(pngHeader(10000, 12000))).toEqual({ width: 10000, height: 12000 });
    expect(imageSize(jpegHeader(4032, 3024))).toEqual({ width: 4032, height: 3024 });
    expect(imageSize(jpegHeader(800, 600, { sof: 0xc2 }))).toEqual({ width: 800, height: 600 }); // progressive
    expect(imageSize(webpLossy(1600, 900))).toEqual({ width: 1600, height: 900 });
    expect(imageSize(webpLossless(16383, 16383))).toEqual({ width: 16383, height: 16383 });
    expect(imageSize(webpExtended(20000, 10000))).toEqual({ width: 20000, height: 10000 });
  });

  it("skips a JPEG's embedded EXIF thumbnail and uses the real frame", () => {
    expect(imageSize(jpegHeader(6000, 4000, { thumbnail: true }))).toEqual({ width: 6000, height: 4000 });
  });

  it("returns null for truncated or broken headers instead of guessing", () => {
    expect(imageSize(pngHeader(100, 100).subarray(0, 20))).toBeNull();
    expect(imageSize(pngHeader(0, 100))).toBeNull();
    expect(imageSize(new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02]))).toBeNull(); // scan before any frame
    expect(imageSize(jpegHeader(800, 600).subarray(0, 30))).toBeNull();
    expect(imageSize(riff("VP8 ", [0, 0, 0, 0, 0, 0, 1, 0, 1, 0]))).toBeNull(); // no start code
    expect(imageSize(new TextEncoder().encode("GIF89a...."))).toBeNull();
  });

  it("puts a phone photo under the limit and a decompression bomb over it", () => {
    const px = (s: { width: number; height: number } | null) => s!.width * s!.height;
    expect(px(imageSize(jpegHeader(4032, 3024)))).toBeLessThanOrEqual(TRY_MAX_PIXELS);
    expect(px(imageSize(pngHeader(10000, 12000)))).toBeGreaterThan(TRY_MAX_PIXELS);
  });

  it("refuses PNG headers a decoder would read differently", () => {
    // Pillow keeps the last IHDR: a small one in front of the real one hid a bomb.
    expect(imageSize(pngHeader(10000, 12000, [pngChunk("IHDR", ihdr(100, 100))]))).toBeNull();
    expect(imageSize(pngHeader(100, 100, [pngChunk("tEXt", [0x6b, 0, 0x76])]))).toBeNull(); // IHDR not first
    const longIhdr = new Uint8Array([...pngHeader(1, 1).subarray(0, 8), ...pngChunk("IHDR", [...ihdr(100, 100), 0])]);
    expect(imageSize(new Uint8Array([...longIhdr, ...pngChunk("IDAT", [])]))).toBeNull();
    expect(imageSize(pngHeader(100, 100).subarray(0, 33))).toBeNull(); // no IDAT
    // Chunks between IHDR and IDAT are fine.
    const withText = new Uint8Array([
      ...pngHeader(640, 480).subarray(0, 33),
      ...pngChunk("tEXt", [0x6b, 0, 0x76]),
      ...pngChunk("IDAT", []),
    ]);
    expect(imageSize(withText)).toEqual({ width: 640, height: 480 });
  });

  it("refuses JPEG headers a decoder would read differently", () => {
    // "FF 00" is skipped by decoders, but a naive parser reads a length after it
    // and steps over the real frame to a small one that decoders see inside APP2.
    const app2Body = [...sof(100, 100), 0, 0, 0, 0];
    const swallowed = [...sof(10000, 12000), 0xff, 0xe2, (app2Body.length + 2) >> 8, (app2Body.length + 2) & 0xff];
    const fake = [0xff, 0x00, (swallowed.length + 2) >> 8, (swallowed.length + 2) & 0xff];
    expect(imageSize(jpeg(fake, swallowed, app2Body))).toBeNull();
    // Pillow keeps the last frame header, libjpeg the first.
    expect(imageSize(jpeg(sof(100, 100), sof(10000, 12000, 0xc2)))).toBeNull();
    // Pillow reads JPGn with no length (revealing what we'd skip) and DHP as a frame.
    const hidden = sof(10000, 12000);
    expect(imageSize(jpeg([0xff, 0xf0, 0, hidden.length + 2], hidden, sof(100, 100)))).toBeNull();
    expect(imageSize(jpeg(sof(100, 100), seg(0xde, frame(10000, 12000))))).toBeNull();
    // Junk between segments, and a file that ends before any scan.
    expect(imageSize(jpeg([0x00], sof(100, 100)))).toBeNull();
    expect(imageSize(new Uint8Array([0xff, 0xd8, ...sof(100, 100), 0xff, 0xd9]))).toBeNull();
    // Restart markers and comments are fine.
    expect(imageSize(jpeg([0xff, 0xd0], seg(0xfe, [0x68, 0x69]), sof(100, 100)))).toEqual({ width: 100, height: 100 });
  });
});

describe("try-it upload deadline", () => {
  it("gives up on an upload that never finishes, with a 408", async () => {
    const stalled = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("--x\r\n")); // then nothing more, ever
      },
    });
    const request = new Request("https://images.example.com/try", {
      method: "POST",
      body: stalled,
      headers: { "content-type": "multipart/form-data; boundary=x" },
      duplex: "half",
    } as RequestInit);
    const started = Date.now();
    await expect(readTryForm(request, 100)).rejects.toMatchObject({
      name: "TryError",
      status: 408,
    });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("reads a normal upload, and words a malformed one as a 400", async () => {
    const form = new FormData();
    form.set("aspect", "4:5");
    const ok = new Request("https://images.example.com/try", { method: "POST", body: form });
    expect((await readTryForm(ok, 1000)).get("aspect")).toBe("4:5");
    const broken = new Request("https://images.example.com/try", {
      method: "POST",
      body: "not multipart",
      headers: { "content-type": "multipart/form-data; boundary=x" },
    });
    await expect(readTryForm(broken, 1000)).rejects.toMatchObject({ status: 400 });
  });
});

describe("credits never exceed the reservation", () => {
  const preset = { upscale: true };

  it("only asks for AI upscaling when the reservation covers it", () => {
    expect(upscaleCovered(preset, creditsFor(true))).toBe(true);
    expect(upscaleCovered(preset, creditsFor(false))).toBe(false); // image grew past the threshold at read time
    expect(upscaleCovered({ upscale: false }, 2)).toBe(false);
  });

  it("drops the reservation when upscaling didn't run, never raises it", () => {
    expect(reservationAfterProcessing(2, false)).toBe(1);
    expect(reservationAfterProcessing(2, true)).toBe(2);
    expect(reservationAfterProcessing(1, true)).toBe(1);
  });

  it("charges the price, capped at what was reserved", () => {
    expect(applyCharge(true, 2)).toBe(2);
    expect(applyCharge(false, 2)).toBe(1);
    expect(applyCharge(true, 1)).toBe(1);
    expect(applyCharge(true, 0)).toBe(2); // rows from before reservations existed
  });
});

describe("merchant-facing failure messages", () => {
  it("keeps messages already written for merchants", () => {
    expect(itemFailureMessage(new PermanentError("This image no longer exists in Shopify."))).toBe(
      "This image no longer exists in Shopify.",
    );
    expect(itemFailureMessage(new MerchantError("HTTP 404 from cdn", "We couldn't download it."))).toBe(
      "We couldn't download it.",
    );
  });

  it("hides image service and Shopify internals", () => {
    expect(itemFailureMessage(new GpuServiceError("GPU service unreachable: fetch failed", true))).toBe(MESSAGES.busy);
    expect(itemFailureMessage(new GpuServiceError("GPU service returned HTTP 502", true))).toBe(MESSAGES.busy);
    expect(itemFailureMessage(new GpuServiceError("cannot identify image", false, "unsupported_image"))).toBe(
      MESSAGES.unreadable,
    );
    expect(itemFailureMessage(new ShopifyGraphqlError("Staged upload failed: HTTP 503", null, true))).toBe(
      MESSAGES.shopify,
    );
    expect(itemFailureMessage(new FileProcessingError("Shopify failed to process the image: x"))).toBe(
      MESSAGES.shopify,
    );
    expect(itemFailureMessage(new ShopifyAuthError("HTTP 401"))).toBe(MESSAGES.access);
    expect(itemFailureMessage(new TypeError("Cannot read properties of undefined"))).toBe(MESSAGES.unknown);
    for (const message of Object.values(MESSAGES)) {
      expect(message).not.toMatch(/GPU|HTTP|GraphQL|undefined/);
    }
  });

  it("words product-read failures for the job page", () => {
    expect(readFailureMessage(new Error("Bulk result download failed: HTTP 500"))).toBe(MESSAGES.read);
    expect(readFailureMessage(new ShopifyAuthError("No offline session"))).toBe(MESSAGES.readAccess);
  });
});

describe("owner unlock page", () => {
  const secret = "owner-secret-0123456789";

  async function unlockRoute() {
    process.env.TRY_OWNER_TOKEN = secret;
    vi.resetModules();
    return import("../../app/routes/try.unlock");
  }

  const post = (body: string, length = String(Buffer.byteLength(body))) =>
    new Request("https://images.example.com/try/unlock", {
      method: "POST",
      body,
      headers: { "content-type": "application/x-www-form-urlencoded", "content-length": length },
    });
  const run = (route: Awaited<ReturnType<typeof unlockRoute>>, request: Request) =>
    route.action({ request, params: {}, context: {} } as ActionFunctionArgs);

  it("GET shows a noindex password form and never unlocks from the URL", async () => {
    const route = await unlockRoute();
    const res = route.loader();
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.headers.get("x-robots-tag")).toMatch(/noindex/);
    const html = await res.text();
    expect(html).toContain('method="post"');
    expect(html).toContain('type="password"');
    expect(html).toContain('name="robots" content="noindex');
  });

  it("POST with the token sets the owner cookie and goes back to the demo", async () => {
    const route = await unlockRoute();
    const res = await run(route, post(`token=${encodeURIComponent(secret)}`));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/#try");
    expect(res.headers.get("set-cookie")).toMatch(/^vio_owner=[0-9a-f]{64}; .*HttpOnly; Secure/);
  });

  it("POST with a wrong token is a slow 404 without a cookie", async () => {
    const route = await unlockRoute();
    const started = Date.now();
    const res = await run(route, post("token=owner-secret-0123456788"));
    expect(res.status).toBe(404);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(Date.now() - started).toBeGreaterThanOrEqual(700);
  });

  it("refuses bodies over 4 KB or without a length before reading them", async () => {
    const route = await unlockRoute();
    const big = `token=${"a".repeat(5000)}`;
    expect((await run(route, post(big))).status).toBe(413);
    const unsized = new Request("https://images.example.com/try/unlock", { method: "POST", body: "token=x" });
    expect((await run(route, unsized)).status).toBe(413);
    delete process.env.TRY_OWNER_TOKEN;
  });
});

describe("addSecurityHeaders", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("keeps the library's per-shop frame-ancestors on embedded documents", () => {
    const headers = new Headers();
    addDocumentResponseHeaders(new Request("https://vio.example.com/app?shop=test-shop.myshopify.com"), headers);
    const libraryCsp = headers.get("Content-Security-Policy");
    expect(libraryCsp).toContain("https://test-shop.myshopify.com");
    addSecurityHeaders(headers);
    expect(headers.get("Content-Security-Policy")).toBe(libraryCsp);
    expect(headers.get("Content-Security-Policy")).not.toContain("'none'");
  });

  it("forbids framing everywhere else", () => {
    const headers = new Headers();
    addDocumentResponseHeaders(new Request("https://vio.example.com/privacy"), headers);
    addSecurityHeaders(headers);
    expect(headers.get("Content-Security-Policy")).toBe("frame-ancestors 'none';");
  });

  it("always sets nosniff and Referrer-Policy, HSTS only in production", () => {
    const dev = new Headers();
    addSecurityHeaders(dev);
    expect(dev.get("X-Content-Type-Options")).toBe("nosniff");
    expect(dev.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
    expect(dev.has("Strict-Transport-Security")).toBe(false);

    vi.stubEnv("NODE_ENV", "production");
    const prod = new Headers();
    addSecurityHeaders(prod);
    expect(prod.get("Strict-Transport-Security")).toBe("max-age=31536000");
    expect(prod.get("X-Content-Type-Options")).toBe("nosniff");
  });
});
