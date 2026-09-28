import { PermanentError } from "../errors";
import {
  assertNoUserErrors,
  ShopifyGraphqlError,
  type ShopifyClient,
} from "./graphql";
import { getLiveMedia, type LiveMedia } from "./media.server";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type UserError = { field: string[] | null; message: string; code?: string | null };

export class FileProcessingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FileProcessingError";
  }
}

/** File extension of the image currently stored in Shopify (".jpg" → "jpg"). */
export function currentExtension(media: Pick<LiveMedia, "imageUrl" | "originalUrl" | "mimeType">): string | null {
  for (const url of [media.imageUrl, media.originalUrl]) {
    if (!url) continue;
    const path = new URL(url).pathname;
    const m = path.match(/\.([a-z0-9]{2,5})$/i);
    if (m) return m[1].toLowerCase();
  }
  return extensionForMime(media.mimeType);
}

export function extensionForMime(mime: string | null | undefined): string | null {
  switch ((mime ?? "").toLowerCase()) {
    case "image/jpeg":
    case "image/jpg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    case "image/heic":
      return "heic";
    case "image/avif":
      return "avif";
    default:
      return null;
  }
}

/** Whether a file with extension `ext` can take content of `format` in place. */
export function extensionMatchesFormat(ext: string | null, format: string): boolean {
  if (!ext) return false;
  const e = ext.toLowerCase();
  if (format === "jpeg") return e === "jpg" || e === "jpeg";
  return e === format;
}

export const MIME_FOR_FORMAT: Record<string, string> = {
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

/** Upload bytes to Shopify's staged storage; returns the resourceUrl to use as originalSource. */
export async function stagedUpload(
  client: ShopifyClient,
  file: { filename: string; mimeType: string; body: Buffer },
): Promise<string> {
  const data = await client.request<{
    stagedUploadsCreate: {
      stagedTargets: Array<{
        url: string;
        resourceUrl: string;
        parameters: Array<{ name: string; value: string }>;
      }>;
      userErrors: UserError[];
    };
  }>(
    `#graphql
    mutation StageUpload($input: [StagedUploadInput!]!) {
      stagedUploadsCreate(input: $input) {
        stagedTargets { url resourceUrl parameters { name value } }
        userErrors { field message }
      }
    }`,
    {
      input: [
        {
          resource: "IMAGE",
          filename: file.filename,
          mimeType: file.mimeType,
          httpMethod: "POST",
          fileSize: String(file.body.length),
        },
      ],
    },
  );
  assertNoUserErrors("stagedUploadsCreate", data.stagedUploadsCreate.userErrors);
  const target = data.stagedUploadsCreate.stagedTargets[0];

  const form = new FormData();
  for (const p of target.parameters) form.append(p.name, p.value);
  form.append(
    "file",
    new Blob([new Uint8Array(file.body)], { type: file.mimeType }),
    file.filename,
  );
  const res = await fetch(target.url, { method: "POST", body: form });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new ShopifyGraphqlError(
      `Staged upload failed: HTTP ${res.status} ${text.slice(0, 200)}`,
      null,
      res.status >= 500,
    );
  }
  return target.resourceUrl;
}

/**
 * Point an existing MediaImage at new content. Keeps the same ID, so gallery
 * position and variant links stay. Returns userErrors instead of throwing so
 * the caller can decide to fall back.
 */
export async function fileUpdateSource(
  client: ShopifyClient,
  fileId: string,
  originalSource: string,
  alt: string | null,
): Promise<UserError[]> {
  const data = await client.request<{
    fileUpdate: { files: Array<{ id: string; fileStatus: string }> | null; userErrors: UserError[] };
  }>(
    `#graphql
    mutation ReplaceFile($files: [FileUpdateInput!]!) {
      fileUpdate(files: $files) {
        files { id fileStatus alt }
        userErrors { field message code }
      }
    }`,
    { files: [{ id: fileId, originalSource, ...(alt != null ? { alt } : {}) }] },
  );
  return data.fileUpdate.userErrors;
}

/**
 * Shopify has no webhook for media processing, so poll until READY or FAILED.
 * Right after a replace the file can briefly still report the old content as
 * READY; pass `previousSize` to only accept READY once the content changed
 * (or after `changeGraceMs`, in case the new file is the same size).
 */
export async function waitForFileReady(
  client: ShopifyClient,
  fileId: string,
  opts: { previousSize?: number | null; timeoutMs?: number; changeGraceMs?: number } = {},
): Promise<LiveMedia> {
  const { previousSize = null, timeoutMs = 120_000, changeGraceMs = 30_000 } = opts;
  const started = Date.now();
  let delay = 1000;
  // Give Shopify a moment to flip the status to PROCESSING first.
  await sleep(delay);
  for (;;) {
    const media = await getLiveMedia(client, fileId);
    if (!media) throw new FileProcessingError("Image disappeared while processing");
    if (media.fileStatus === "READY") {
      const changed = previousSize == null || media.fileSize == null || media.fileSize !== previousSize;
      if (changed || Date.now() - started > changeGraceMs) return media;
    }
    if (media.fileStatus === "FAILED") {
      const reason = media.fileErrors.map((e) => e.message).join("; ") || "unknown error";
      throw new FileProcessingError(`Shopify failed to process the image: ${reason}`);
    }
    if (Date.now() - started > timeoutMs) {
      throw new ShopifyGraphqlError("Timed out waiting for Shopify to process the image", null, true);
    }
    await sleep(delay);
    delay = Math.min(delay * 1.5, 5000);
  }
}

async function productMediaIds(client: ShopifyClient, productId: string): Promise<string[]> {
  const ids: string[] = [];
  let after: string | null = null;
  do {
    const data: {
      product: {
        media: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: Array<{ id: string }> };
      } | null;
    } = await client.request(
      `#graphql
      query ProductMediaIds($id: ID!, $after: String) {
        product(id: $id) {
          media(first: 250, after: $after) { pageInfo { hasNextPage endCursor } nodes { id } }
        }
      }`,
      { id: productId, after },
      { cost: 255 },
    );
    if (!data.product) throw new PermanentError("This product no longer exists in Shopify.");
    ids.push(...data.product.media.nodes.map((n) => n.id));
    after = data.product.media.pageInfo.hasNextPage ? data.product.media.pageInfo.endCursor : null;
  } while (after);
  return ids;
}

async function variantsUsingMedia(
  client: ShopifyClient,
  productId: string,
  mediaId: string,
): Promise<string[]> {
  const variantIds: string[] = [];
  let after: string | null = null;
  do {
    const data: {
      product: {
        variants: {
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
          nodes: Array<{ id: string; media: { nodes: Array<{ id: string }> } }>;
        };
      } | null;
    } = await client.request(
      `#graphql
      query VariantMedia($id: ID!, $after: String) {
        product(id: $id) {
          variants(first: 100, after: $after) {
            pageInfo { hasNextPage endCursor }
            nodes { id media(first: 3) { nodes { id } } }
          }
        }
      }`,
      { id: productId, after },
      { cost: 600 },
    );
    if (!data.product) break;
    for (const v of data.product.variants.nodes) {
      if (v.media.nodes.some((m) => m.id === mediaId)) variantIds.push(v.id);
    }
    after = data.product.variants.pageInfo.hasNextPage ? data.product.variants.pageInfo.endCursor : null;
  } while (after);
  return variantIds;
}

async function waitForMediaReady(client: ShopifyClient, mediaId: string): Promise<void> {
  await waitForFileReady(client, mediaId);
}

/**
 * Fallback when an in-place replace isn't possible (format change) or fails:
 * attach the new image, move variant links and gallery position over from
 * the old one, copy alt text, then detach the old image from the product.
 * The old file stays in Shopify's Files library. Returns the new media id.
 */
export async function replaceViaNewMedia(
  client: ShopifyClient,
  args: {
    productId: string;
    oldMediaId: string;
    originalSource: string;
    alt: string | null;
    position: number;
  },
): Promise<string> {
  const before = new Set(await productMediaIds(client, args.productId));
  const variantIds = await variantsUsingMedia(client, args.productId, args.oldMediaId);

  const added = await client.request<{ productUpdate: { userErrors: UserError[] } }>(
    `#graphql
    mutation AttachMedia($product: ProductUpdateInput!, $media: [CreateMediaInput!]) {
      productUpdate(product: $product, media: $media) {
        product { id }
        userErrors { field message }
      }
    }`,
    {
      product: { id: args.productId },
      media: [{ originalSource: args.originalSource, alt: args.alt ?? "", mediaContentType: "IMAGE" }],
    },
  );
  assertNoUserErrors("productUpdate(media)", added.productUpdate.userErrors);

  const after = await productMediaIds(client, args.productId);
  const newMediaId = after.find((id) => !before.has(id));
  if (!newMediaId) throw new ShopifyGraphqlError("New image did not appear on the product", null, true);
  await waitForMediaReady(client, newMediaId);

  // Detaching the old image from the product also clears it from variants.
  const detached = await client.request<{ fileUpdate: { userErrors: UserError[] } }>(
    `#graphql
    mutation DetachOld($files: [FileUpdateInput!]!) {
      fileUpdate(files: $files) { userErrors { field message code } }
    }`,
    { files: [{ id: args.oldMediaId, referencesToRemove: [args.productId] }] },
  );
  assertNoUserErrors("fileUpdate(referencesToRemove)", detached.fileUpdate.userErrors);

  if (variantIds.length) {
    const appended = await client.request<{ productVariantAppendMedia: { userErrors: UserError[] } }>(
      `#graphql
      mutation LinkVariants($productId: ID!, $variantMedia: [ProductVariantAppendMediaInput!]!) {
        productVariantAppendMedia(productId: $productId, variantMedia: $variantMedia) {
          userErrors { field message code }
        }
      }`,
      {
        productId: args.productId,
        variantMedia: variantIds.map((variantId) => ({ variantId, mediaIds: [newMediaId] })),
      },
    );
    assertNoUserErrors("productVariantAppendMedia", appended.productVariantAppendMedia.userErrors);
  }

  const reordered = await client.request<{ productReorderMedia: { mediaUserErrors: UserError[] } }>(
    `#graphql
    mutation Reorder($id: ID!, $moves: [MoveInput!]!) {
      productReorderMedia(id: $id, moves: $moves) {
        job { id }
        mediaUserErrors { field message code }
      }
    }`,
    { id: args.productId, moves: [{ id: newMediaId, newPosition: String(args.position) }] },
  );
  assertNoUserErrors("productReorderMedia", reordered.productReorderMedia.mediaUserErrors);

  return newMediaId;
}

/**
 * Write `body` into the Shopify image `targetId`: in place with fileUpdate when
 * the format allows, otherwise (or if the in-place replace is rejected) via
 * the new-media fallback. Returns the id of the media that now holds the content.
 */
export async function writeImage(
  client: ShopifyClient,
  args: {
    targetId: string;
    productId: string;
    position: number;
    alt: string | null;
    body: Buffer;
    format: string; // jpeg | png | webp | gif | ...
    basename: string;
  },
): Promise<{ mediaId: string; method: "in_place" | "fallback" }> {
  const live = await getLiveMedia(client, args.targetId);
  if (!live) throw new PermanentError("This image no longer exists in Shopify.");
  if (live.fileStatus !== "READY") {
    throw new ShopifyGraphqlError(`Image is ${live.fileStatus.toLowerCase()} in Shopify; will retry`, null, true);
  }
  const alt = args.alt ?? live.alt;
  const ext = currentExtension(live);
  const mimeType = MIME_FOR_FORMAT[args.format] ?? `image/${args.format}`;

  if (extensionMatchesFormat(ext, args.format)) {
    const resourceUrl = await stagedUpload(client, {
      filename: `${args.basename}.${ext}`,
      mimeType,
      body: args.body,
    });
    const errors = await fileUpdateSource(client, args.targetId, resourceUrl, alt);
    if (!errors.length) {
      try {
        await waitForFileReady(client, args.targetId, { previousSize: live.fileSize });
        return { mediaId: args.targetId, method: "in_place" };
      } catch (error) {
        if (!(error instanceof FileProcessingError)) throw error;
        // Shopify rejected the new content; fall through to the fallback.
      }
    }
  }

  const fallbackExt = args.format === "jpeg" ? "jpg" : args.format;
  const resourceUrl = await stagedUpload(client, {
    filename: `${args.basename}.${fallbackExt}`,
    mimeType,
    body: args.body,
  });
  const mediaId = await replaceViaNewMedia(client, {
    productId: args.productId,
    oldMediaId: args.targetId,
    originalSource: resourceUrl,
    alt,
    position: args.position,
  });
  return { mediaId, method: "fallback" };
}
