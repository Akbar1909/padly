/**
 * Public brand details, shared by the landing page, the legal pages and the embedded app.
 * The Shopify app names live in shopify.app*.toml ("Padly" / "Padly Dev"); App Store rule
 * 4.1.1 requires the listing name to share the brand word with them.
 */
export const BRAND = {
  name: "Padly",
  listingName: "Padly: Bulk Background Remover",
  tagline: "Make every product photo match, with originals kept safe",
  supportEmail: "dev.bobomurodov@gmail.com",
  site: "https://images.qancha.live",
} as const;

/** Public pages on the website, linked from the landing footer, the app and the listing. */
export const PAGES = {
  privacy: "/privacy",
  terms: "/terms",
  support: "/support",
} as const;

export const LEGAL_UPDATED = "September 27, 2026";
