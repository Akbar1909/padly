import { describe, expect, it } from "vitest";
import { bulkReadQuery, parseBulkJsonl, selectForScope, toReadItem, type ReadItem } from "../../app/lib/shopify/media.server";

async function* lines(rows: unknown[]) {
  for (const r of rows) yield JSON.stringify(r);
}

async function collect(gen: AsyncGenerator<ReadItem>) {
  const out: ReadItem[] = [];
  for await (const x of gen) out.push(x);
  return out;
}

const image = (id: string, parent: string, extra: Record<string, unknown> = {}) => ({
  id: `gid://shopify/MediaImage/${id}`,
  mediaContentType: "IMAGE",
  status: "READY",
  alt: `alt ${id}`,
  mimeType: "image/jpeg",
  image: { url: `https://cdn.shopify.com/${id}.jpg`, width: 800, height: 600 },
  originalSource: { url: `https://storage/${id}.jpg`, fileSize: 1234 },
  __parentId: parent,
  ...extra,
});

const P1 = "gid://shopify/Product/1";
const P2 = "gid://shopify/Product/2";

const rows = [
  { id: P1, title: "Red shoe" },
  { id: "gid://shopify/Video/9", mediaContentType: "VIDEO", status: "READY", alt: null, __parentId: P1 },
  image("11", P1),
  image("12", P1),
  { id: P2, title: "Blue hat" },
  image("21", P2, { status: "PROCESSING" }),
  image("22", P2),
];

describe("bulk JSONL parsing", () => {
  it("keeps images only, with positions counted across all media", async () => {
    const items = await collect(parseBulkJsonl(lines(rows), "all"));
    expect(items.map((i) => [i.mediaId.split("/").pop(), i.position, i.productTitle])).toEqual([
      ["11", 1, "Red shoe"],
      ["12", 2, "Red shoe"],
      ["22", 1, "Blue hat"], // 21 is still processing in Shopify and is skipped
    ]);
    expect(items[0]).toMatchObject({
      productId: P1,
      alt: "alt 11",
      originalUrl: "https://storage/11.jpg",
      thumbnailUrl: "https://cdn.shopify.com/11.jpg",
      width: 800,
      height: 600,
      fileSize: 1234,
    });
  });

  it("takes the first image per product for the 'first' scope", async () => {
    const items = await collect(parseBulkJsonl(lines(rows), "first"));
    expect(items.map((i) => i.mediaId.split("/").pop())).toEqual(["11", "22"]);
  });

  it("builds a bulk query with an escaped search string", () => {
    const q = bulkReadQuery('vendor:"A \\"B\\""');
    expect(q).toContain('products(query: "vendor:\\"A \\\\\\"B\\\\\\"\\"")');
    expect(bulkReadQuery("")).toContain("products {");
  });
});

describe("paginated read helpers", () => {
  it("drops non-images and picks the lowest position for 'first'", () => {
    const product = { id: P1, title: "Red shoe" };
    const items = [
      toReadItem(product, image("12", P1), 3),
      toReadItem(product, { id: "v", mediaContentType: "VIDEO" }, 0),
      toReadItem(product, image("11", P1), 1),
    ].filter((x): x is ReadItem => x !== null);
    expect(items).toHaveLength(2);
    expect(selectForScope(items, "first").map((i) => i.position)).toEqual([1]);
    expect(selectForScope(items, "all")).toHaveLength(2);
  });
});
