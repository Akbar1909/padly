import type { LoaderFunctionArgs } from "react-router";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// The proxy is opt-in; load the modules fresh with it switched on.
let presignGet: typeof import("../../app/lib/storage.server").presignGet;
let putObject: typeof import("../../app/lib/storage.server").putObject;
let deletePrefix: typeof import("../../app/lib/storage.server").deletePrefix;
let loader: typeof import("../../app/routes/s3-proxy.$").loader;

const shopPrefix = `shops/proxytest${Date.now()}/`;
const preview = `${shopPrefix}jobs/job1/item1/preview.jpg`;
const backup = `${shopPrefix}backups/1/item1.jpg`;
const notImage = `${shopPrefix}jobs/job1/item1/notes.jpg`;
const svg = `${shopPrefix}jobs/job1/item1/vector.png`;

beforeAll(async () => {
  process.env.S3_BROWSER_PROXY = "true";
  vi.resetModules();
  ({ presignGet, putObject, deletePrefix } = await import("../../app/lib/storage.server"));
  ({ loader } = await import("../../app/routes/s3-proxy.$"));
  await putObject(preview, Buffer.from("jpeg-bytes"), "image/jpeg");
  await putObject(backup, Buffer.from("original"), "image/jpeg");
  await putObject(notImage, Buffer.from("<html>"), "text/html");
  await putObject(svg, Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>"), "image/svg+xml");
});
afterAll(async () => {
  await deletePrefix(shopPrefix);
  process.env.S3_BROWSER_PROXY = "false";
});

async function get(path: string, method = "GET"): Promise<Response> {
  return loader({
    request: new Request(`https://tunnel.example.com${path}`, { method }),
    params: {},
    context: {},
  } as LoaderFunctionArgs);
}

describe("dev image proxy (S3_BROWSER_PROXY)", () => {
  it("serves presigned preview images through the app origin", async () => {
    const url = await presignGet(preview);
    expect(url.startsWith("/s3-proxy/vio-test/")).toBe(true);
    const res = await get(url);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(await res.text()).toBe("jpeg-bytes");

    const head = await get(url, "HEAD");
    expect(head.status).toBe(200);
    expect(head.body).toBeNull();
  });

  it("answers 404 for bad signatures, never the store's own error", async () => {
    const url = await presignGet(preview);
    const res = await get(url.replace(/X-Amz-Signature=[0-9a-f]{4}/, "X-Amz-Signature=0000"));
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("");
  });

  it("only forwards image keys of the configured bucket, with a signature", async () => {
    const signed = new URL(await presignGet(preview), "https://x.test");
    const query = signed.search;
    // Backups are never sent to browsers, even with a valid-looking query.
    expect((await get(`/s3-proxy/vio-test/${backup}${query}`)).status).toBe(404);
    // Unsigned, other buckets, the store's own endpoints, traversal.
    expect((await get(`/s3-proxy/vio-test/${preview}`)).status).toBe(404);
    expect((await get(`/s3-proxy/other-bucket/${preview}${query}`)).status).toBe(404);
    expect((await get(`/s3-proxy/health`)).status).toBe(404);
    expect((await get(`/s3-proxy/rustfs/admin/v3/info${query}`)).status).toBe(404);
    expect((await get(`/s3-proxy/vio-test/shops/x/jobs/..%2F..%2Fbackups/a/b.jpg${query}`)).status).toBe(404);
    expect((await get("/s3-proxy//example.com/secret")).status).toBe(404);
    expect((await get("/s3-proxy/@example.com/x")).status).toBe(404);
    // Sub-resources the signature wouldn't cover anyway.
    expect((await get(`${signed.pathname}${query}&acl=`)).status).toBe(404);
  });

  it("never passes on a non-image answer, even for an allowed key", async () => {
    const url = await presignGet(notImage);
    expect((await get(url)).status).toBe(404);
  });

  it("only passes on the formats the app writes: never SVG, which can run script", async () => {
    expect((await get(await presignGet(svg))).status).toBe(404);
  });
});
