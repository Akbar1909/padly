import { deflateSync } from "node:zlib";
import type { ActionFunctionArgs } from "react-router";
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher, type Dispatcher } from "undici";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { redis } from "../../app/lib/redis.server";
import {
  deleteOlderThan,
  deletePrefix,
  headObject,
  putObject,
} from "../../app/lib/storage.server";
import {
  ownerCookie,
  refundTry,
  takeTry,
  takeTrySlot,
  TRY_MAX_BYTES,
  TRY_PREFIX,
} from "../../app/lib/try.server";
import { action } from "../../app/routes/try";

const GPU_URL = process.env.GPU_SERVICE_URL!;
const gpuUp = await fetch(new URL("/healthz", GPU_URL))
  .then((r) => r.ok)
  .catch(() => false);

// Minimal PNG: an off-centre dark square on white.
function png(w: number, h: number): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const raw = Buffer.alloc((w * 3 + 1) * h, 255);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      if (x > 60 && x < 200 && y > 80 && y < 260)
        raw.set([40, 60, 120], y * (w * 3 + 1) + 1 + x * 3);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** A multipart POST the way a browser sends it: with its Content-Length. */
async function formRequest(form: FormData, headers: Record<string, string> = {}) {
  const encoded = new Response(form);
  const body = await encoded.arrayBuffer();
  return new Request("https://images.example.com/try", {
    method: "POST",
    body,
    headers: {
      "content-type": encoded.headers.get("content-type")!,
      "content-length": String(body.byteLength),
      ...headers,
    },
  });
}

async function post(
  ip: string,
  file: Blob | null,
  fields: Record<string, string> = {},
  headers: Record<string, string> = {},
) {
  const form = new FormData();
  if (file) form.set("photo", file, "photo.png");
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  return send(
    await formRequest(form, { "x-forwarded-for": `${ip}, 10.0.0.1`, ...headers }),
  );
}

async function send(request: Request) {
  const out = (await action({
    request,
    params: {},
    context: {},
  } as ActionFunctionArgs)) as
    | { data: { error: string }; init: { status: number } }
    | {
        result: {
          id: string;
          before: string;
          after: string;
          aspect: string;
          width: number;
          height: number;
        };
        remaining: number;
      };
  return "init" in out
    ? { status: out.init.status, error: out.data.error }
    : { status: 200, ...out };
}

beforeEach(async () => {
  await redis().flushdb();
});
afterAll(async () => {
  await deletePrefix(TRY_PREFIX);
  await redis().quit();
});

// A PNG header claiming 10000×12000 pixels in a few hundred bytes: the
// decompression bomb that used to OOM the image service.
function bombPng(): Buffer {
  const real = png(8, 8);
  real.writeUInt32BE(10000, 16);
  real.writeUInt32BE(12000, 20);
  return real;
}

// The same bomb with a small IHDR in front of the real one. Pillow keeps the
// last IHDR, so this decodes at full size while a first-IHDR reader sees 100×100.
function disguisedBombPng(): Buffer {
  const bomb = bombPng();
  const decoy = Buffer.from(bomb.subarray(8, 33)); // the IHDR chunk
  decoy.writeUInt32BE(100, 8);
  decoy.writeUInt32BE(100, 12);
  return Buffer.concat([bomb.subarray(0, 8), decoy, bomb.subarray(8)]);
}

const today = () => new Date().toISOString().slice(0, 10);

describe("free tries", () => {
  it("allows the daily limit per visitor and refunds our own failures, at most twice a day", async () => {
    expect(await takeTry("1.1.1.1", 2)).toBe(1);
    expect(await takeTry("1.1.1.1", 2)).toBe(0);
    await expect(takeTry("1.1.1.1", 2)).rejects.toMatchObject({ status: 429 });
    expect(await refundTry("1.1.1.1")).toBe(true); // rejected calls use nothing, so one refund = one try
    expect(await takeTry("1.1.1.1", 2)).toBe(0);
    expect(await takeTry("2.2.2.2", 2)).toBe(1); // other visitors unaffected

    expect(await refundTry("1.1.1.1")).toBe(true); // second refund today
    expect(await takeTry("1.1.1.1", 2)).toBe(0);
    expect(await refundTry("1.1.1.1")).toBe(false); // third: refused
    await expect(takeTry("1.1.1.1", 2)).rejects.toMatchObject({ status: 429 });
  });

  it("caps tries across all visitors per day", async () => {
    expect(await takeTry("6.6.6.1", 3, new Date(), 2)).toBe(2);
    expect(await takeTry("6.6.6.2", 3, new Date(), 2)).toBe(2);
    await expect(takeTry("6.6.6.3", 3, new Date(), 2)).rejects.toMatchObject({
      status: 429,
      message: expect.stringMatching(/today's limit/),
    });
    // The refused visitor still has all their own tries.
    expect(await redis().get(`try:${new Date().toISOString().slice(0, 10)}:6.6.6.3`)).toBe("0");
  });

  it("refuses unsized and oversized uploads before reading them", async () => {
    const unsized = new Request("https://images.example.com/try", {
      method: "POST",
      body: "x",
      headers: { "x-forwarded-for": "7.7.7.7" },
    });
    expect(await send(unsized)).toMatchObject({ status: 411 });
    const huge = new Request("https://images.example.com/try", {
      method: "POST",
      body: "x",
      headers: {
        "x-forwarded-for": "7.7.7.7",
        "content-length": String(TRY_MAX_BYTES + 128 * 1024),
      },
    });
    expect(await send(huge)).toMatchObject({ status: 413 });
    expect(await redis().keys("try:*")).toEqual([]); // no try used, no slot left behind
  });

  it("runs one try at a time: a second visitor gets 'busy' and keeps their tries", async () => {
    const release = await takeTrySlot();
    expect(release).not.toBeNull();
    const busy = await post("8.8.8.8", new Blob([new Uint8Array(png(64, 64))]));
    expect(busy).toMatchObject({ status: 429, error: expect.stringMatching(/try again in a minute/) });
    expect(await redis().keys("try:*")).toEqual(["try:inflight"]); // no per-visitor or global count taken
    await release!();

    // The slot is released after every try, whatever the outcome.
    const fake = new Blob([Buffer.from("%PDF-1.7 not an image")]);
    expect((await post("8.8.8.8", fake)).status).toBe(415);
    expect(await redis().get("try:inflight")).toBeNull();
  });

  it("rejects decompression bombs by their header, and doesn't give the try back", async () => {
    const out = await post("9.9.9.9", new Blob([new Uint8Array(bombPng())]));
    expect(out).toMatchObject({ status: 413, error: "That photo is too large (max 12 megapixels)." });
    expect(await redis().get(`try:${new Date().toISOString().slice(0, 10)}:9.9.9.9`)).toBe("1");
    expect(await redis().keys("try:refund:*")).toEqual([]);
  });

  it("rejects a bomb disguised behind a decoy header as unreadable, without a refund", async () => {
    const out = await post("9.9.9.8", new Blob([new Uint8Array(disguisedBombPng())]));
    expect(out).toMatchObject({ status: 415, error: "We couldn't read that image. Try a different photo." });
    expect(await redis().get(`try:${today()}:9.9.9.8`)).toBe("1");
    expect(await redis().keys("try:refund:*")).toEqual([]);
    expect(await redis().get("try:inflight")).toBeNull();
  });

  it("rejects files that aren't images by their bytes, and stops after the limit", async () => {
    const fake = new Blob([Buffer.from("%PDF-1.7 not an image")], {
      type: "image/jpeg",
    });
    const first = await post("3.3.3.3", fake);
    expect(first).toMatchObject({
      status: 415,
      error: "Upload a JPG, PNG or WebP photo.",
    });
    await post("3.3.3.3", fake);
    await post("3.3.3.3", fake);
    const fourth = await post("3.3.3.3", fake);
    expect(fourth.status).toBe(429);
  });

  it("never limits the owner's unlocked browser, but the owner waits for the slot too", async () => {
    process.env.TRY_OWNER_TOKEN = "owner-secret-0123456789";
    vi.resetModules();
    const fresh = await import("../../app/routes/try");
    const cookie = ownerCookie("owner-secret-0123456789").split(";")[0];
    const fake = new Blob([new TextEncoder().encode("%PDF not an image")]);
    const ownerPost = async () => {
      const form = new FormData();
      form.set("photo", fake, "x.jpg");
      const request = await formRequest(form, {
        "x-forwarded-for": "5.5.5.5",
        cookie,
      });
      const out = (await fresh.action({
        request,
        params: {},
        context: {},
      } as ActionFunctionArgs)) as {
        init: { status: number };
      };
      return out.init.status;
    };
    for (let i = 0; i < 5; i++) {
      expect(await ownerPost()).toBe(415); // rejected for the file, never 429
    }
    const release = await takeTrySlot();
    expect(await ownerPost()).toBe(429);
    await release!();
    delete process.env.TRY_OWNER_TOKEN;
    vi.resetModules();
  });

  it("blames the visitor only for photos the image service can't use", async () => {
    // Answers from a stand-in image service; storage and Redis stay real.
    const previous: Dispatcher = getGlobalDispatcher();
    const agent = new MockAgent();
    agent.enableNetConnect();
    setGlobalDispatcher(agent);
    const answer = (status: number, code: string) =>
      agent
        .get(new URL(GPU_URL).origin)
        .intercept({ path: "/v1/process", method: "POST" })
        .reply(status, { error: { code, message: `${code} details` } }, { headers: { "content-type": "application/json" } });
    const photo = () => new Blob([new Uint8Array(png(64, 64))]);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // The visitor's photo: the try is used.
      answer(422, "unsupported_image");
      expect(await post("11.0.0.1", photo())).toMatchObject({ status: 415, error: expect.stringMatching(/couldn't read/) });
      answer(413, "image_too_large");
      expect(await post("11.0.0.2", photo())).toMatchObject({ status: 413, error: expect.stringMatching(/too large/) });
      expect(await redis().get(`try:${today()}:11.0.0.1`)).toBe("1");
      expect(await redis().get(`try:${today()}:11.0.0.2`)).toBe("1");

      // Ours (a signature mismatch, the service unable to fetch our upload, an
      // outage): "busy", and the try comes back.
      answer(401, "invalid_signature");
      answer(400, "source_download_failed");
      answer(503, "backend_unavailable");
      for (const ip of ["11.0.0.3", "11.0.0.4", "11.0.0.5"]) {
        expect(await post(ip, photo())).toMatchObject({ status: 503, error: expect.stringMatching(/busy/) });
        expect(await redis().get(`try:${today()}:${ip}`)).toBe("0");
      }
      expect(errors).toHaveBeenCalledWith("try: image service failed", expect.anything());
    } finally {
      errors.mockRestore();
      await agent.close();
      setGlobalDispatcher(previous);
      await deletePrefix(TRY_PREFIX); // the uploaded sources
    }
  });

  it("deletes uploads older than the cutoff only", async () => {
    await putObject(`${TRY_PREFIX}old/a.jpg`, Buffer.from("a"), "image/jpeg");
    expect(
      await deleteOlderThan(TRY_PREFIX, new Date(Date.now() - 60_000)),
    ).toBe(0);
    expect(await headObject(`${TRY_PREFIX}old/a.jpg`)).not.toBeNull();
    expect(
      await deleteOlderThan(TRY_PREFIX, new Date(Date.now() + 60_000)),
    ).toBe(1);
    expect(await headObject(`${TRY_PREFIX}old/a.jpg`)).toBeNull();
  });
});

describe.skipIf(!gpuUp)(
  "try-it end to end (GPU service at " + GPU_URL + ")",
  () => {
    it("cleans one photo and returns before/after previews", async () => {
      const out = await post(
        "4.4.4.4",
        new Blob([new Uint8Array(png(400, 320))], { type: "image/png" }),
        { aspect: "4:5" },
      );
      expect(out.status).toBe(200);
      if (!("result" in out)) throw new Error("expected a result");
      expect(out.remaining).toBe(2);
      expect(out.result.aspect).toBe("4:5");
      expect(out.result.height / out.result.width).toBeCloseTo(1.25, 2);
      for (const name of [
        "source.png",
        "output.jpg",
        "preview.jpg",
        "before.jpg",
      ]) {
        expect(
          await headObject(`${TRY_PREFIX}${out.result.id}/${name}`),
        ).not.toBeNull();
      }
      expect(await (await fetch(out.result.after)).arrayBuffer()).toBeTruthy();
    });
  },
);
