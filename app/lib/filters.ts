import { z } from "zod";

/**
 * Option value for "Any …" in the picker's selects. Polaris <s-option value="">
 * submits the option's label ("Any collection") instead of an empty string, so
 * "no filter" needs a real value.
 */
export const ANY = "__any__";

/** Most product or image ids one job can name (the API also caps it at MAX_ITEMS_PER_JOB). */
export const MAX_SELECTION_IDS = 5000;

const PRODUCT_GID = "gid://shopify/Product/";
const MEDIA_GID = "gid://shopify/MediaImage/";

/** "123" or "gid://shopify/Product/123" → the gid. */
export const productGid = (id: string) => (id.startsWith(PRODUCT_GID) ? id : `${PRODUCT_GID}${id}`);
/** "456" or "gid://shopify/MediaImage/456" → the gid. */
export const mediaGid = (id: string) => (id.startsWith(MEDIA_GID) ? id : `${MEDIA_GID}${id}`);

const idList = (pattern: RegExp, message: string, toGid: (id: string) => string) =>
  z
    .array(z.union([z.string(), z.number().int().positive()]))
    .max(MAX_SELECTION_IDS, `At most ${MAX_SELECTION_IDS} ids`)
    .transform((ids) => ids.map((id) => String(id).trim()))
    .pipe(z.array(z.string().regex(pattern, message)))
    .transform((ids) => [...new Set(ids.map(toGid))]);

/** Which products and images a job covers. Shared by UI and server. */
export const JobFilterSchema = z
  .object({
    collectionId: z
      .string()
      .trim()
      .regex(/^(gid:\/\/shopify\/Collection\/)?\d+$/, "Choose a collection from the list")
      .optional(),
    collectionTitle: z.string().trim().optional(),
    vendor: z.string().trim().max(255).optional(),
    productType: z.string().trim().max(255).optional(),
    tag: z.string().trim().max(255).optional(),
    imageScope: z.enum(["first", "all"]).default("first"),
    /**
     * Select products by id instead of by filter (the API). Read with nodes(ids:) in the worker.
     * Numeric ids or Product gids; stored as gids.
     */
    productIds: idList(/^(gid:\/\/shopify\/Product\/)?\d+$/, "Use product ids or Product gids", productGid)
      .pipe(z.array(z.string()).min(1, "Name at least one product"))
      .optional(),
    /**
     * Narrow an id selection to these images (MediaImage gids or numeric ids) of the named
     * products. When set, exactly these images are selected and imageScope is ignored.
     */
    mediaIds: idList(/^(gid:\/\/shopify\/MediaImage\/)?\d+$/, "Use MediaImage gids", mediaGid).optional(),
  })
  .superRefine((f, ctx) => {
    if (f.mediaIds?.length && !f.productIds?.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["mediaIds"], message: "Images need their products (productIds)" });
    }
    if (f.productIds?.length && (f.collectionId || f.vendor || f.productType || f.tag)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["productIds"],
        message: "Choose products either by id or by filter, not both",
      });
    }
  });

export type JobFilter = z.infer<typeof JobFilterSchema>;

/**
 * A filter without its id lists (up to thousands of ids), safe to send to the browser.
 * describeFilter accepts it too.
 */
export type ClientJobFilter = Omit<JobFilter, "productIds" | "mediaIds"> & {
  productCount?: number;
  mediaCount?: number;
};

export function filterForClient(filter: unknown): ClientJobFilter {
  const f = (filter ?? {}) as Partial<JobFilter>;
  const { productIds, mediaIds, ...rest } = f;
  return {
    ...rest,
    imageScope: rest.imageScope === "all" ? "all" : "first",
    ...(Array.isArray(productIds) ? { productCount: productIds.length } : {}),
    ...(Array.isArray(mediaIds) ? { mediaCount: mediaIds.length } : {}),
  };
}

export function parseFilterForm(form: FormData) {
  const val = (k: string) => {
    const v = form.get(k);
    return typeof v === "string" && v.trim() && v !== ANY ? v.trim() : undefined;
  };
  return JobFilterSchema.safeParse({
    collectionId: val("collectionId"),
    collectionTitle: val("collectionTitle"),
    vendor: val("vendor"),
    productType: val("productType"),
    tag: val("tag"),
    imageScope: val("imageScope"),
  });
}

/** Quote a value for Shopify search syntax. */
export function searchValue(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Build the `products(query:)` search string. Empty string means the whole catalog. */
export function buildProductSearchQuery(filter: JobFilter): string {
  const parts: string[] = [];
  if (filter.collectionId) {
    const numeric = filter.collectionId.split("/").pop()!;
    if (!/^\d+$/.test(numeric)) throw new Error("Invalid collection id");
    parts.push(`collection_id:${numeric}`);
  }
  if (filter.vendor) parts.push(`vendor:${searchValue(filter.vendor)}`);
  if (filter.productType) parts.push(`product_type:${searchValue(filter.productType)}`);
  if (filter.tag) parts.push(`tag:${searchValue(filter.tag)}`);
  return parts.join(" AND ");
}

const countOf = (n: number, word: string) => `${n.toLocaleString("en-US")} ${word}${n === 1 ? "" : "s"}`;

export function describeFilter(filter: JobFilter | ClientJobFilter): string {
  const products = "productIds" in filter ? filter.productIds?.length : (filter as ClientJobFilter).productCount;
  const media = "mediaIds" in filter ? filter.mediaIds?.length : (filter as ClientJobFilter).mediaCount;
  if (products) {
    const images = media ? countOf(media, "selected image") : filter.imageScope === "first" ? "first image" : "all images";
    return `${countOf(products, "selected product")} · ${images}`;
  }
  const parts: string[] = [];
  if (filter.collectionTitle || filter.collectionId)
    parts.push(`collection “${filter.collectionTitle ?? filter.collectionId}”`);
  if (filter.vendor) parts.push(`vendor “${filter.vendor}”`);
  if (filter.productType) parts.push(`type “${filter.productType}”`);
  if (filter.tag) parts.push(`tag “${filter.tag}”`);
  const scope = filter.imageScope === "first" ? "first image" : "all images";
  return `${parts.length ? parts.join(", ") : "All products"} · ${scope}`;
}
