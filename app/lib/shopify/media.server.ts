import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import type { JobFilter } from "../filters";
import { assertNoUserErrors, type ShopifyClient } from "./graphql";

/** One product image as read from Shopify, before anything is changed. */
export interface ReadItem {
  productId: string;
  productTitle: string;
  mediaId: string;
  /** Zero-based index among ALL the product's media (videos included), as productReorderMedia expects. */
  position: number;
  alt: string | null;
  originalUrl: string;
  /** Public Shopify CDN URL, for thumbnails. */
  thumbnailUrl: string | null;
  mimeType: string | null;
  width: number | null;
  height: number | null;
  fileSize: number | null;
}

interface MediaNode {
  id?: string;
  mediaContentType?: string;
  status?: string;
  alt?: string | null;
  mimeType?: string | null;
  image?: { url: string; width: number | null; height: number | null } | null;
  originalSource?: { url: string | null; fileSize: number | null } | null;
}

const MEDIA_FIELDS = `
  id
  mediaContentType
  status
  alt
  ... on MediaImage {
    mimeType
    image { url width height }
    originalSource { url fileSize }
  }
`;

export function toReadItem(
  product: { id: string; title: string },
  media: MediaNode,
  position: number,
): ReadItem | null {
  if (media.mediaContentType !== "IMAGE" || !media.id) return null;
  if (media.status && media.status !== "READY") return null;
  const url = media.originalSource?.url ?? media.image?.url;
  if (!url) return null;
  return {
    productId: product.id,
    productTitle: product.title,
    mediaId: media.id,
    position,
    alt: media.alt ?? null,
    originalUrl: url,
    thumbnailUrl: media.image?.url ?? null,
    mimeType: media.mimeType ?? null,
    width: media.image?.width ?? null,
    height: media.image?.height ?? null,
    fileSize: media.originalSource?.fileSize ?? null,
  };
}

/** Keep only what the image scope asks for from one product's media list. */
export function selectForScope(
  items: ReadItem[],
  scope: JobFilter["imageScope"],
): ReadItem[] {
  if (scope === "all") return items;
  const first = items.reduce<ReadItem | null>(
    (best, it) => (!best || it.position < best.position ? it : best),
    null,
  );
  return first ? [first] : [];
}

export async function countProducts(
  client: ShopifyClient,
  search: string,
): Promise<number> {
  const data = await client.request<{ productsCount: { count: number } }>(
    `#graphql
    query CountProducts($query: String) {
      productsCount(query: $query) { count }
    }`,
    { query: search || null },
    { cost: 2 },
  );
  return data.productsCount.count;
}

const PRODUCTS_PAGE = `#graphql
  query ReadProducts($query: String, $after: String, $first: Int!, $mediaFirst: Int!) {
    products(first: $first, after: $after, query: $query) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        title
        media(first: $mediaFirst) {
          pageInfo { hasNextPage endCursor }
          nodes { ${MEDIA_FIELDS} }
        }
      }
    }
  }`;

const PRODUCT_MEDIA_PAGE = `#graphql
  query ReadProductMedia($id: ID!, $after: String) {
    product(id: $id) {
      media(first: 50, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { ${MEDIA_FIELDS} }
      }
    }
  }`;

type Page<T> = { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: T[] };

/**
 * Read media with normal paginated queries (used for smaller selections).
 * Calls `onBatch` once per page so large reads don't sit in memory.
 */
export async function readProductsPaginated(
  client: ShopifyClient,
  search: string,
  scope: JobFilter["imageScope"],
  onBatch: (items: ReadItem[]) => Promise<void>,
  limit = Infinity,
): Promise<number> {
  // Keep requested cost well under the 1,000-point single query limit.
  const first = scope === "first" ? 50 : 10;
  const mediaFirst = scope === "first" ? 5 : 50;
  let after: string | null = null;
  let total = 0;

  do {
    const data: {
      products: Page<{ id: string; title: string; media: Page<MediaNode> }>;
    } = await client.request(
      PRODUCTS_PAGE,
      { query: search || null, after, first, mediaFirst },
      { cost: first * (mediaFirst + 3) },
    );

    const batch: ReadItem[] = [];
    for (const product of data.products.nodes) {
      const media = [...product.media.nodes];
      // Pull the rest of this product's media when it has more than one page.
      let mediaPage = product.media.pageInfo;
      while (scope === "all" && mediaPage.hasNextPage) {
        const more: { product: { media: Page<MediaNode> } | null } =
          await client.request(
            PRODUCT_MEDIA_PAGE,
            { id: product.id, after: mediaPage.endCursor },
            { cost: 60 },
          );
        if (!more.product) break;
        media.push(...more.product.media.nodes);
        mediaPage = more.product.media.pageInfo;
      }
      const items = media
        .map((m, i) => toReadItem(product, m, i))
        .filter((x): x is ReadItem => x !== null);
      batch.push(...selectForScope(items, scope));
    }

    const room = limit - total;
    const slice = batch.slice(0, Math.max(0, room));
    if (slice.length) await onBatch(slice);
    total += slice.length;
    if (total >= limit) break;

    after = data.products.pageInfo.hasNextPage
      ? data.products.pageInfo.endCursor
      : null;
  } while (after);

  return total;
}

const PRODUCTS_BY_ID = `#graphql
  query ReadProductsByIds($ids: [ID!]!, $mediaFirst: Int!) {
    nodes(ids: $ids) {
      ... on Product {
        id
        title
        media(first: $mediaFirst) {
          pageInfo { hasNextPage endCursor }
          nodes { ${MEDIA_FIELDS} }
        }
      }
    }
  }`;

/**
 * Read the images of named products (the API's id selection) with nodes(ids:), in chunks,
 * paced by the shared cost-based throttle. Positions are the index among ALL of a product's
 * media, as the paginated read computes them. With `mediaIds`, only those images are kept
 * (and the scope is ignored); ids that don't exist or aren't products are skipped. Never uses
 * a bulk operation: id lists are small enough to page.
 */
export async function readProductsByIds(
  client: ShopifyClient,
  productIds: string[],
  mediaIds: string[] | undefined,
  scope: JobFilter["imageScope"],
  onBatch: (items: ReadItem[]) => Promise<void>,
  limit = Infinity,
): Promise<number> {
  const wanted = mediaIds?.length ? new Set(mediaIds) : null;
  // Scope "first" needs only the first few media; anything else needs the whole list.
  const allMedia = scope === "all" || wanted !== null;
  const chunk = allMedia ? 10 : 50;
  const mediaFirst = allMedia ? 50 : 5;
  let total = 0;

  for (let i = 0; i < productIds.length && total < limit; i += chunk) {
    const ids = productIds.slice(i, i + chunk);
    const data: {
      nodes: Array<{ id?: string; title?: string; media?: Page<MediaNode> } | null>;
    } = await client.request(PRODUCTS_BY_ID, { ids, mediaFirst }, { cost: ids.length * (mediaFirst + 3) });

    const batch: ReadItem[] = [];
    for (const node of data.nodes) {
      if (!node?.id || !node.media) continue; // deleted, or not a product
      const product = { id: node.id, title: node.title ?? "" };
      const media = [...node.media.nodes];
      let mediaPage = node.media.pageInfo;
      while (allMedia && mediaPage.hasNextPage) {
        const more: { product: { media: Page<MediaNode> } | null } = await client.request(
          PRODUCT_MEDIA_PAGE,
          { id: product.id, after: mediaPage.endCursor },
          { cost: 60 },
        );
        if (!more.product) break;
        media.push(...more.product.media.nodes);
        mediaPage = more.product.media.pageInfo;
      }
      const items = media
        .map((m, index) => toReadItem(product, m, index))
        .filter((x): x is ReadItem => x !== null);
      batch.push(...(wanted ? items.filter((it) => wanted.has(it.mediaId)) : selectForScope(items, scope)));
    }

    const slice = batch.slice(0, Math.max(0, limit - total));
    if (slice.length) await onBatch(slice);
    total += slice.length;
  }
  return total;
}

/** Query text for a bulk read of the whole selection. */
export function bulkReadQuery(search: string): string {
  const q = search ? `(query: ${JSON.stringify(search)})` : "";
  return `{
    products${q} {
      edges { node {
        id
        title
        media { edges { node { ${MEDIA_FIELDS} } } }
      } }
    }
  }`;
}

export async function startBulkRead(
  client: ShopifyClient,
  search: string,
): Promise<string> {
  const data = await client.request<{
    bulkOperationRunQuery: {
      bulkOperation: { id: string; status: string } | null;
      userErrors: Array<{ field: string[] | null; message: string; code?: string }>;
    };
  }>(
    `#graphql
    mutation StartBulkRead($query: String!) {
      bulkOperationRunQuery(query: $query) {
        bulkOperation { id status }
        userErrors { field message code }
      }
    }`,
    { query: bulkReadQuery(search) },
  );
  assertNoUserErrors("bulkOperationRunQuery", data.bulkOperationRunQuery.userErrors);
  return data.bulkOperationRunQuery.bulkOperation!.id;
}

export interface BulkOperationInfo {
  id: string;
  status: string;
  errorCode: string | null;
  url: string | null;
  partialDataUrl: string | null;
  objectCount: string | null;
}

export async function getBulkOperation(
  client: ShopifyClient,
  id: string,
): Promise<BulkOperationInfo | null> {
  const data = await client.request<{ bulkOperation: BulkOperationInfo | null }>(
    `#graphql
    query BulkOperation($id: ID!) {
      bulkOperation(id: $id) { id status errorCode url partialDataUrl objectCount }
    }`,
    { id },
    { cost: 1 },
  );
  return data.bulkOperation;
}

/**
 * Stream a bulk operation's JSONL result into ReadItems. Product lines come
 * before their media lines; media lines carry `__parentId`.
 */
export async function* parseBulkJsonl(
  lines: AsyncIterable<string>,
  scope: JobFilter["imageScope"],
): AsyncGenerator<ReadItem> {
  const titles = new Map<string, string>();
  const positions = new Map<string, number>();
  const firstTaken = new Set<string>();

  for await (const line of lines) {
    if (!line.trim()) continue;
    const row = JSON.parse(line) as MediaNode & { __parentId?: string; title?: string };
    if (!row.__parentId) {
      if (row.id) titles.set(row.id, row.title ?? "");
      continue;
    }
    const parentId = row.__parentId;
    const position = positions.get(parentId) ?? 0;
    positions.set(parentId, position + 1);
    if (scope === "first" && firstTaken.has(parentId)) continue;
    const item = toReadItem(
      { id: parentId, title: titles.get(parentId) ?? "" },
      row,
      position,
    );
    if (!item) continue;
    if (scope === "first") firstTaken.add(parentId);
    yield item;
  }
}

/** Download a JSONL result file line by line. */
export async function* fetchJsonlLines(url: string): AsyncGenerator<string> {
  const res = await fetch(url);
  if (!res.ok || !res.body) {
    throw new Error(`Bulk result download failed: HTTP ${res.status}`);
  }
  const rl = createInterface({
    input: Readable.fromWeb(res.body as never),
    crlfDelay: Infinity,
  });
  for await (const line of rl) yield line;
}

/** Current state of one image, fetched right before we touch it. */
export interface LiveMedia {
  id: string;
  alt: string | null;
  fileStatus: string;
  mimeType: string | null;
  imageUrl: string | null;
  width: number | null;
  height: number | null;
  originalUrl: string | null;
  fileSize: number | null;
  fileErrors: Array<{ code: string; message: string; details: string | null }>;
}

export async function getLiveMedia(
  client: ShopifyClient,
  mediaId: string,
): Promise<LiveMedia | null> {
  const data = await client.request<{
    node: {
      id: string;
      alt: string | null;
      fileStatus: string;
      mimeType: string | null;
      image: { url: string; width: number | null; height: number | null } | null;
      originalSource: { url: string | null; fileSize: number | null } | null;
      fileErrors: LiveMedia["fileErrors"];
    } | null;
  }>(
    `#graphql
    query LiveMedia($id: ID!) {
      node(id: $id) {
        ... on MediaImage {
          id
          alt
          fileStatus
          mimeType
          image { url width height }
          originalSource { url fileSize }
          fileErrors { code message details }
        }
      }
    }`,
    { id: mediaId },
    { cost: 2 },
  );
  const n = data.node;
  if (!n || !n.id) return null;
  return {
    id: n.id,
    alt: n.alt,
    fileStatus: n.fileStatus,
    mimeType: n.mimeType,
    imageUrl: n.image?.url ?? null,
    width: n.image?.width ?? null,
    height: n.image?.height ?? null,
    originalUrl: n.originalSource?.url ?? null,
    fileSize: n.originalSource?.fileSize ?? null,
    fileErrors: n.fileErrors ?? [],
  };
}
