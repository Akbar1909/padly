import type { LoaderFunctionArgs } from "react-router";
import { env } from "../lib/env.server";

const FORWARD_HEADERS = ["accept", "range", "if-none-match", "if-modified-since"];
const PASS_HEADERS = [
  "content-type",
  "content-length",
  "content-range",
  "accept-ranges",
  "etag",
  "last-modified",
  "cache-control",
];
const UPSTREAM_TIMEOUT_MS = 20_000;
/** The only formats the app writes. Never SVG, which runs script when opened directly. */
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

/**
 * Object keys the browser is ever sent (storage.server.ts keys.artifact and the
 * landing try-it): job previews and try-it results. Never backups, never other
 * buckets, never the store's own API.
 */
const ID = "[A-Za-z0-9_-]+";
const FILE = "[A-Za-z0-9_-]+\\.(?:jpg|jpeg|png|webp)";
const KEY_PATTERN = new RegExp(
  `^(?:shops/${ID}/jobs/${ID}/${ID}/${FILE}|public/try/[0-9a-fA-F-]{36}/${FILE})$`,
);
/** Presigned GET parameters only (X-Amz-Signature, x-amz-checksum-mode, x-id…), no sub-resources like ?acl. */
const QUERY_PARAM = /^(?:x-amz-[a-z0-9-]+|x-id)$/i;

const notFound = () => new Response(null, { status: 404, headers: { "X-Content-Type-Options": "nosniff" } });
/** Served from the app origin: even if something unexpected got through, it can't run or load anything. */
const IMAGE_CSP = "default-src 'none'; sandbox";

/**
 * With S3_BROWSER_PROXY=true (object store not publicly reachable): forwards a
 * presigned GET for a preview image to the object store so it loads in the
 * admin. The presigned signature is the authorization, exactly as with a
 * direct R2 link. Only image keys of the configured bucket, with a signature,
 * get through; anything else, and any answer that isn't a JPEG, PNG or WebP
 * image, is a plain 404.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const e = env();
  if (!e.S3_BROWSER_PROXY || !e.S3_ENDPOINT) return notFound();
  if (request.method !== "GET" && request.method !== "HEAD") return notFound();

  // Path-style presigned URL: /s3-proxy/<bucket>/<key>?X-Amz-…
  const incoming = new URL(request.url);
  const prefix = `/s3-proxy/${e.S3_BUCKET}/`;
  if (!incoming.pathname.startsWith(prefix)) return notFound();
  if (!KEY_PATTERN.test(incoming.pathname.slice(prefix.length))) return notFound();
  const params = incoming.searchParams;
  if (!params.get("X-Amz-Signature") || !params.get("X-Amz-Expires")) return notFound();
  for (const [name, value] of params) {
    if (!QUERY_PARAM.test(name) || (name === "x-id" && value !== "GetObject")) return notFound();
  }

  const origin = new URL(e.S3_ENDPOINT).origin;
  const upstream = new URL(`${origin}/${e.S3_BUCKET}/${incoming.pathname.slice(prefix.length)}${incoming.search}`);
  if (upstream.origin !== origin) return notFound();

  const headers = new Headers();
  for (const name of FORWARD_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  let res: Response;
  try {
    // Always GET: the signature is for GET, and HEAD bodies are dropped anyway.
    res = await fetch(upstream, {
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch {
    return new Response(null, { status: 502, headers: { "X-Content-Type-Options": "nosniff" } });
  }

  const type = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  const ok = res.status === 304 || ((res.status === 200 || res.status === 206) && IMAGE_TYPES.has(type));
  if (!ok) {
    // Never serve the store's XML errors (or anything else) from the app origin.
    await res.body?.cancel().catch(() => {});
    return notFound();
  }

  const out = new Headers({ "X-Content-Type-Options": "nosniff", "Content-Security-Policy": IMAGE_CSP });
  for (const name of PASS_HEADERS) {
    const value = res.headers.get(name);
    if (value) out.set(name, value);
  }
  if (request.method === "HEAD") {
    await res.body?.cancel().catch(() => {});
    return new Response(null, { status: res.status, headers: out });
  }
  return new Response(res.body, { status: res.status, headers: out });
};
