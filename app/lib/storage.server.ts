import { Readable } from "node:stream";
import {
  CreateBucketCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "./env.server";

type Audience = "server" | "browser" | "gpu";

const clients = new Map<Audience, S3Client>();

function client(audience: Audience = "server"): S3Client {
  let c = clients.get(audience);
  if (!c) {
    const e = env();
    const endpoint =
      (audience === "browser" && e.S3_BROWSER_ENDPOINT) ||
      (audience === "gpu" && e.S3_GPU_ENDPOINT) ||
      e.S3_ENDPOINT;
    c = new S3Client({
      region: e.S3_REGION,
      endpoint,
      forcePathStyle: e.S3_FORCE_PATH_STYLE,
      credentials: {
        accessKeyId: e.S3_ACCESS_KEY_ID,
        secretAccessKey: e.S3_SECRET_ACCESS_KEY,
      },
    });
    clients.set(audience, c);
  }
  return c;
}

const bucket = () => env().S3_BUCKET;

// Object layout. Everything for a shop lives under one prefix so shop/redact
// can delete it in one sweep.
export const keys = {
  shopPrefix: (shopId: string) => `shops/${shopId}/`,
  backup: (shopId: string, mediaId: string, itemId: string, ext: string) =>
    `shops/${shopId}/backups/${numericId(mediaId)}/${itemId}.${ext}`,
  /**
   * `run` names a reprocessing of an item that already had a result ("Retry with stronger
   * model"): its artifacts get their own keys, so an earlier result another item reused (they
   * share storage keys) is never overwritten.
   */
  artifact: (
    shopId: string,
    jobId: string,
    itemId: string,
    name: "output" | "preview" | "before" | "mask",
    ext: string,
    run?: string,
  ) => `shops/${shopId}/jobs/${jobId}/${itemId}/${name}${run ? `-${run}` : ""}.${ext}`,
};

export function numericId(gid: string): string {
  return gid.split("/").pop() ?? gid;
}

let bucketChecked = false;

/** Dev convenience: create the bucket on first use when S3_CREATE_BUCKET=true. */
async function ensureBucket(): Promise<void> {
  if (bucketChecked || !env().S3_CREATE_BUCKET) return;
  try {
    await client().send(new HeadBucketCommand({ Bucket: bucket() }));
  } catch {
    await client().send(new CreateBucketCommand({ Bucket: bucket() }));
  }
  bucketChecked = true;
}

export async function putObject(
  key: string,
  body: Buffer | Uint8Array | Readable | ReadableStream,
  contentType: string,
  metadata?: Record<string, string>,
): Promise<void> {
  await ensureBucket();
  const stream =
    body instanceof ReadableStream ? Readable.fromWeb(body as never) : body;
  // lib-storage handles unknown-length streams via multipart upload.
  await new Upload({
    client: client(),
    params: {
      Bucket: bucket(),
      Key: key,
      Body: stream,
      ContentType: contentType,
      Metadata: metadata,
    },
  }).done();
}

export async function getObjectBuffer(key: string): Promise<Buffer> {
  const res = await client().send(
    new GetObjectCommand({ Bucket: bucket(), Key: key }),
  );
  const bytes = await res.Body!.transformToByteArray();
  return Buffer.from(bytes);
}

export async function headObject(
  key: string,
): Promise<{ size: number; contentType?: string } | null> {
  try {
    const res = await client().send(
      new HeadObjectCommand({ Bucket: bucket(), Key: key }),
    );
    return { size: res.ContentLength ?? 0, contentType: res.ContentType };
  } catch (error) {
    const status = (error as { $metadata?: { httpStatusCode?: number } })
      .$metadata?.httpStatusCode;
    if (status === 404 || (error as Error).name === "NotFound") return null;
    throw error;
  }
}

const HOUR = 3600_000;

export async function presignGet(
  key: string,
  opts: { audience?: Audience; expiresIn?: number } = {},
): Promise<string> {
  await ensureBucket();
  if ((opts.audience ?? "browser") === "browser") {
    // Sign as of the start of the hour so the URL is identical across page
    // polls and the browser can cache the image; valid for at least an hour.
    const url = await getSignedUrl(
      client("browser"),
      new GetObjectCommand({ Bucket: bucket(), Key: key }),
      { expiresIn: 2 * 3600, signingDate: new Date(Math.floor(Date.now() / HOUR) * HOUR) },
    );
    if (!env().S3_BROWSER_PROXY) return url;
    const signed = new URL(url);
    return `/s3-proxy${signed.pathname}${signed.search}`;
  }
  return getSignedUrl(
    client(opts.audience),
    new GetObjectCommand({ Bucket: bucket(), Key: key }),
    { expiresIn: opts.expiresIn ?? 3600 },
  );
}

export async function presignPut(
  key: string,
  contentType: string,
  opts: { audience?: Audience; expiresIn?: number } = {},
): Promise<string> {
  await ensureBucket();
  return getSignedUrl(
    client(opts.audience ?? "gpu"),
    new PutObjectCommand({
      Bucket: bucket(),
      Key: key,
      ContentType: contentType,
    }),
    { expiresIn: opts.expiresIn ?? 1800 },
  );
}

/** Delete objects under a prefix last modified before `olderThan`. Returns the number removed. */
export async function deleteOlderThan(prefix: string, olderThan: Date): Promise<number> {
  let removed = 0;
  let token: string | undefined;
  do {
    const page = await client().send(
      new ListObjectsV2Command({ Bucket: bucket(), Prefix: prefix, ContinuationToken: token }),
    );
    const stale = (page.Contents ?? [])
      .filter((o) => o.LastModified && o.LastModified < olderThan)
      .map((o) => ({ Key: o.Key! }));
    if (stale.length) {
      await client().send(
        new DeleteObjectsCommand({ Bucket: bucket(), Delete: { Objects: stale, Quiet: true } }),
      );
      removed += stale.length;
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return removed;
}

/** Delete every object under a prefix. Returns the number of objects removed. */
export async function deletePrefix(prefix: string): Promise<number> {
  let removed = 0;
  let token: string | undefined;
  do {
    const page = await client().send(
      new ListObjectsV2Command({
        Bucket: bucket(),
        Prefix: prefix,
        ContinuationToken: token,
      }),
    );
    const objects = (page.Contents ?? []).map((o) => ({ Key: o.Key! }));
    if (objects.length) {
      await client().send(
        new DeleteObjectsCommand({
          Bucket: bucket(),
          Delete: { Objects: objects, Quiet: true },
        }),
      );
      removed += objects.length;
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return removed;
}
