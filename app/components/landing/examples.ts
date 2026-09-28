/**
 * Landing-page before/after examples. Images live in public/examples and are real,
 * unretouched output of the production image pipeline (production CPU configuration with
 * escalation on), made from Pexels stock photos; sources are listed in
 * public/examples/CREDITS.md. Every photo here was checked for brand names and logos.
 *
 * `selection` is the product box in the square "before" frame, in percent.
 */

/** srcset widths that gpu-service/scripts/make_landing_examples.py writes (VARIANT_WIDTHS). */
const VARIANT_WIDTHS = [280, 480, 720, 1000];

/** A page image: the JPEG as the fallback, WebP variants for srcset. */
export interface Picture {
  src: string;
  srcSet: string;
}

/**
 * `<base>.jpg` plus its `<base>-<width>.webp` variants. `width` is the image's own width when
 * it's under 1000 px: the script never enlarges, so its largest variant is that width.
 */
export function picture(base: string, width = 1000): Picture {
  const widths = [...new Set(VARIANT_WIDTHS.map((w) => Math.min(w, width)))];
  return {
    src: `${base}.jpg`,
    srcSet: widths.map((w) => `${base}-${w}.webp ${w}w`).join(", "),
  };
}
export type Category =
  | "Shoes"
  | "Bags & accessories"
  | "Jewelry & watches"
  | "Home & decor"
  | "Beauty & fragrance"
  | "Apparel"
  | "Kids & toys"
  | "Kitchen & tableware";

/** Filter chip order. Only categories with at least one example are shown. */
export const CATEGORY_ORDER: Category[] = [
  "Shoes",
  "Bags & accessories",
  "Jewelry & watches",
  "Home & decor",
  "Beauty & fragrance",
  "Apparel",
  "Kids & toys",
  "Kitchen & tableware",
];

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Example {
  slug: string;
  category: Category;
  title: string;
  /** What the source photo looked like, and what came out. */
  caption: string;
  alt: string;
  before: Picture;
  after: Picture;
  selection?: Box;
  /** The first cut-out failed the automatic check and the stronger model redid it. */
  redone?: boolean;
  /** A merchant-facing flag the result carried (shown as it would be in review). */
  flag?: string;
}

/** `afterWidth`: the output's own width when the pipeline made it smaller than 1000 px. */
const pair = (slug: string, afterWidth?: number) => ({
  slug,
  before: picture(`/examples/${slug}-before`),
  after: picture(`/examples/${slug}-after`, afterWidth),
});

/** The hero pair: the busiest scene, cleaned. */
export const HERO: Example = {
  ...pair("leather-bag"),
  category: "Bags & accessories",
  title: "Leather messenger bag",
  caption: "Park bench and autumn leaves → white",
  alt: "Dark leather messenger bag",
  selection: { x: 14, y: 11.4, w: 77.7, h: 77.1 },
  redone: true,
};

/**
 * Gallery order for "All": varied categories first. The hero (leather bag) sits later so
 * the gallery doesn't open with the photo just above it. The amber bottles, the one result
 * with a visible miss, come last and say so: that is what review is for.
 */
export const EXAMPLES: Example[] = [
  {
    ...pair("rattan-chair", 811),
    category: "Home & decor",
    title: "Rattan hoop chair",
    caption: "Balcony deck and potted palm → white, thin metal legs kept",
    alt: "Rattan hoop chair with a cushion",
    selection: { x: 25.1, y: 34.8, w: 49.9, h: 65.2 },
    redone: true,
  },
  {
    ...pair("tassel-earrings"),
    category: "Jewelry & watches",
    title: "Tassel earrings",
    caption: "Blue wood → white, fine blue threads kept",
    alt: "Blue tassel earrings",
    selection: { x: 7, y: 12.7, w: 86, h: 76.3 },
  },
  {
    ...pair("copper-teapot"),
    category: "Kitchen & tableware",
    title: "Copper teapot and tea glass",
    caption: "Striped cloth in hard sun → white",
    alt: "Embossed copper teapot and a tea glass",
    selection: { x: 0, y: 11.6, w: 98.2, h: 76.7 },
  },
  {
    ...pair("polka-dot-dress"),
    category: "Apparel",
    title: "Polka-dot dress",
    caption:
      "Striped wall → white, hat brim and hair kept (cropped above the knee, as in the photo)",
    alt: "Model in a polka-dot dress and sun hat",
    selection: { x: 19.5, y: 4.1, w: 54.2, h: 95.9 },
    redone: true,
  },
  {
    ...pair("bridal-heels"),
    category: "Shoes",
    title: "Bridal sandals",
    caption: "White satin on white tulle → white, pearl straps and thin heels kept",
    alt: "White high-heeled sandals with pearl and crystal straps",
    selection: { x: 23.3, y: 12.6, w: 67.9, h: 74.7 },
    redone: true,
  },
  {
    ...pair("glass-perfume", 734),
    category: "Beauty & fragrance",
    title: "Glass perfume bottle",
    caption: "White table, a flower and a hard shadow → white",
    alt: "Clear glass perfume bottle",
    selection: { x: 23.3, y: 2.5, w: 53.4, h: 60.4 },
  },
  {
    ...pair("green-candle"),
    category: "Home & decor",
    title: "Candle with a blank label",
    caption:
      "Rough wood and a slatted wall → white, the label kept whole and uncut",
    alt: "Green glass candle with a blank white label on a marble coaster",
    selection: { x: 23.3, y: 17.9, w: 45.6, h: 64.2 },
  },
  {
    ...pair("glass-carafe"),
    category: "Kitchen & tableware",
    title: "Glass coffee carafe",
    caption: "Hard sunlight and a caustic shadow → white, glass kept clear",
    alt: "Glass coffee carafe",
    selection: { x: 21.7, y: 18.8, w: 64.4, h: 62.5 },
  },
  {
    ...pair("derby-shoes"),
    category: "Shoes",
    title: "Derby shoes",
    caption: "Light wood floor and loose laces → white",
    alt: "Pair of black leather derby shoes",
    selection: { x: 10.5, y: 7, w: 78.9, h: 86.3 },
  },
  {
    ...pair("minimal-watch"),
    category: "Jewelry & watches",
    title: "Leather-strap watch",
    caption:
      "Wooden bench in shallow focus → white. The strap stays soft, as in the photo.",
    alt: "Watch with a brown leather strap",
    selection: { x: 18.5, y: 16.3, w: 58.8, h: 67.5 },
  },
  {
    ...pair("hoodie-model"),
    category: "Apparel",
    title: "Hoodie on model",
    caption: "Concrete wall → white (cropped at the thigh, as in the photo)",
    alt: "Model in a cream hoodie, back view",
    selection: { x: 19.1, y: 6.9, w: 61.8, h: 93.1 },
  },
  {
    ...pair("sunglasses", 891),
    category: "Bags & accessories",
    title: "Sunglasses and clear glasses",
    caption: "White table with cast shadows → white, tinted lenses kept",
    alt: "Sunglasses and clear glasses",
    selection: { x: 10, y: 18.9, w: 53.8, h: 65.1 },
    redone: true,
  },
  HERO,
  {
    ...pair("rocket"),
    category: "Kids & toys",
    title: "Wooden toy rocket",
    caption: "White shelf and the edge of a book → white, the tall toy padded, not cropped",
    alt: "Red and cream wooden toy rocket",
    selection: { x: 26.3, y: 1.3, w: 48.2, h: 97.3 },
  },
  {
    ...pair("cream-vases"),
    category: "Home & decor",
    title: "Ceramic vases",
    caption:
      "Cream on off-white → white, dried flowers kept. It's a set, so 7 pieces is right.",
    alt: "Three cream ceramic vases with dried flowers",
    selection: { x: 14.9, y: 17.5, w: 68.1, h: 65 },
    flag: "Flagged: 7 separate pieces",
  },
  {
    ...pair("wooden-cars"),
    category: "Kids & toys",
    title: "Wooden toy cars",
    caption: "Black backdrop → white (two cars and a peg figure)",
    alt: "Yellow and green wooden toy cars with a peg figure",
    selection: { x: 1.3, y: 36.9, w: 97.3, h: 40.4 },
  },
  {
    ...pair("gold-necklace"),
    category: "Jewelry & watches",
    title: "Pendant necklace",
    caption: "Off-white surface → white, fine chain kept (it runs off the photo)",
    alt: "Gold pendant necklace",
    selection: { x: 4.2, y: 11.2, w: 95.8, h: 69 },
    redone: true,
  },
  {
    ...pair("stacked-bowls"),
    category: "Kitchen & tableware",
    title: "Bowls and plates",
    caption: "Wood table and wall art → white",
    alt: "Stacked ceramic bowls and plates",
    selection: { x: 1.3, y: 56.2, w: 97.4, h: 27 },
    redone: true,
  },
  {
    ...pair("amber-bottles"),
    category: "Beauty & fragrance",
    title: "Amber pump and dropper bottles",
    caption:
      "Linen, towels and a candle jar → white. A few flower specks stayed on the bottle where a sprig crossed it: our checks passed it, and it's the kind of result you'd reject or re-run in review.",
    alt: "Amber pump bottle and dropper bottle",
    selection: { x: 23.8, y: 2.5, w: 52.4, h: 94.3 },
  },
];

/**
 * The quality-check story: one real run where the first cut-out was rejected. All three
 * frames come from gpu-service/scripts/make_landing_examples.py --attempts.
 */
export const STORY = {
  original: picture("/examples/story-candle-original"),
  rejected: picture("/examples/story-candle-rejected"),
  final: picture("/examples/story-candle-final"),
};
