# Shopify App Store listing: Padly

Final copy for every field of the listing form (Partner Dashboard > App distribution > All
apps > Padly > Distribution > Manage listing > English). Paste the text inside each code
block exactly. Character counts were measured with Python `len()` on the exact text, and
the limits come from Shopify's app store requirements and best practices.

Rules this copy follows (App Store requirements 4.1 to 4.4):

- No statistics, data, guarantees or "the best / first / only" anywhere outside Pricing.
- No prices, "free", credit amounts or "per image" anywhere except the **Pricing** section.
  That includes the icon, feature image, screenshots, video, subtitle, introduction,
  details and features.
- No model names (BiRefNet, Real-ESRGAN). "AI upscaling" is the only technical term.
- No other products or services: leave out the website's API, WooCommerce/Etsy/Amazon
  plans, waitlist and donate band.
- The brand word "Padly" must match the app name in `shopify.app.production.toml`
  ("Padly") and the Dev Dashboard, as rule 4.1.1 requires. The TOML rename is checked in
  submission-checklist.md section 1 before the release.

Spelling follows the app's own labels (British: "colour", "centred").

## Basic information

### App name (max 30)

```text
Padly: Bulk Background Remover
```

30 / 30. Brand first, then what it does. The TOML name must be "Padly" to share the brand
word (check it before releasing; submission-checklist.md section 1). A similar developer
name exists: "Pagly" (see submission-checklist.md section 2).

### App icon

Upload `public/brand/icon-1200.png`: 1200 x 1200 PNG, full-bleed square. Shopify rounds the
corners, and the mark stays well inside the safe area. No text, no Shopify bag, no pricing.
Source: `public/brand/icon.svg`. Render steps: `docs/app-store/brand-src/icon.html`.

Upload it in both places Shopify asks for it: the listing form and the app's configuration
on the App Store review page (Dev Dashboard).

Alt text (65):

```text
Padly logo: a product bottle centred inside a dashed orange frame
```

### App card subtitle (max 62)

```text
Make every product photo match, with originals kept safe
```

56 / 62. A benefit, not a feature list. No keywords added for search and no numbers.

## App store listing content

### Feature media: feature image (1600 x 900)

Upload `public/brand/feature-1600x900.png` (exactly 1600 x 900). It shows one focal point:
an everyday photo of headphones on a wooden table becomes a clean, evenly padded product
shot inside the Padly frame. Solid ink background (orange and paper on ink both pass the
4.5:1 contrast ratio), no Shopify logos, no pricing, no stats, and the subtitle is not
repeated. The headphones photo is the landing example (Pexels, free licence) and shows no
brand logo. Source: `docs/app-store/brand-src/feature.html`.

If you record a promotional video later (2 to 3 minutes, at most 25% screencast), it can
replace the image. The demo screencast for reviewers is a separate field (see
screencast-script.md).

Alt text (117):

```text
A photo of headphones on a wooden table next to the same photo on a clean white background, centred with even margins
```

### Screenshots (3 to 6, 1600 x 900)

Capture and prepare them with `docs/app-store/screenshots.md` and
`scripts/listing-screenshot.py`. Upload in this order, each with its alt text (the alt
texts are in screenshots.md):

1. Review grid with before/after previews
2. Before/after with the cut-out mask
3. New job: choose products and style
4. Images found, ready to start (cost table cropped out)
5. Applied images with restore
6. Settings: default style and data notice (optional)

Don't upload the Credits page: it shows prices.

### Demo store URL

Leave empty. Results show up on product images in the Shopify admin, which a public demo
store can't show well. The screencast and screenshots cover it.

### App introduction (max 100)

```text
Clean up product photos in bulk. A consistent catalog looks professional and is easier to shop.
```

95 / 100. A merchant benefit tied to an outcome, in complete sentences, with no numbers.

### App details (max 500)

```text
Padly cleans up product photos in bulk. Pick products by collection, vendor, type or tag, and choose a style: remove the background onto white or a brand colour, or keep it. Every photo is padded to a square or 4:5 canvas with even margins, so products are centred, never cropped. Small photos can be upscaled with AI. Nothing changes until you approve the previews. Images are replaced in place, keeping order, alt text and variant links, and each original is backed up so you can restore it.
```

493 / 500. It explains how the app works and what's different (in-place replacement that
keeps order, alt text and variant links; permanent backups; approval before anything
changes). No pricing, links, support details or testimonials: those have their own fields.

### Features (max 80 each; 5 used)

```text
Remove backgrounds in bulk onto white or a brand colour, or keep the original
```

77 / 80

```text
Pad every photo to square or 4:5 with even margins, so nothing gets cropped
```

75 / 80

```text
Upscale small photos with AI; photos with text get a safe resize instead
```

72 / 80

```text
Preview every before and after, and check flagged photos before you approve
```

75 / 80

```text
Replace images in place, and restore any original with one click
```

64 / 80

Each is a merchant outcome, with no model names and no keyword lists. All five are shown in
the screencast (screencast-script.md), as requirement 4.5.3 asks.

### Integrations

Leave empty. The app works with Shopify product media only, and Shopify itself must not be
listed.

## Pricing

Shopify App Pricing is the default for new apps and doesn't support one-time purchases, so
switch the method first (submission-checklist.md, section 3):

- **Pricing method:** Manual pricing (legacy). Set this under Pricing content > Manage >
  Settings **before** testing billing on the production app.
- **Primary billing method:** Free to install. No payment is needed to install and use the
  app: 25 free credits come with it.
- **Plan name** (if the form asks for one): `Free`
- **Plan features** (if the form asks for a list):
  - `25 free credits on install`
  - `Buy one-time credit packs when you need more`
  - `Restores are always free`
- **Description of additional charges** (full version, 516 characters):

```text
25 free credits when you install. Optional one-time credit packs, billed through Shopify in USD: Starter 300 credits $9, Growth 1,500 credits $29, Catalog 5,000 credits $79. 1 credit per image you apply to your store, +1 when AI upscaling runs on it. Credits are deducted only when an image is applied; rejected, failed and unapplied images cost nothing. Restores are free (they don't refund the credit). Credits don't expire while the app is installed; unused credits are deleted with your data after you uninstall.
```

- If the form limits the description, use the short version (259 characters):

```text
25 free credits on install. One-time packs billed through Shopify (USD): Starter 300 credits $9, Growth 1,500 $29, Catalog 5,000 $79. 1 credit per applied image, +1 with AI upscaling. Charged only on apply. Restores free. Credits don't expire while installed.
```

- **Pricing page link** (optional): `https://images.qancha.live/#pricing`. Only add it once
  the landing pricing section says the same thing as above (no "credits never expire").

This must match the in-app Credits page (`app/routes/app.billing.tsx`) and the landing
pricing section exactly: the same packs, prices, credit rules and wording on expiry. Never
write "credits never expire": unused credits are erased with the shop's data after
uninstall.

Facts behind the text: packs in `app/lib/billing.server.ts` (`CREDIT_PACKS`), free credits
`FREE_CREDITS=25`, charges only in `applyItem`, restore is free, dev stores get test charges
(`shop.plan.partnerDevelopment`).

## App discovery

### Categories

- **Primary:** Store design > Images and media > **Image editor** ("Apps that help merchants
  edit and optimize images").
- **Secondary:** Store management > Operations > **Bulk editor** ("Apps that update multiple
  products at once for pricing, images, etc.").

Structured features: tick only what the app really does, for example background removal,
resizing to a fixed canvas, bulk editing and AI upscaling (use the closest names in the
form's list). Don't tick compression, image SEO or alt-text generation, cropping, watermarks
or storefront galleries: Padly doesn't do them.

### Search terms (max 5; complete words, one idea each)

```text
background remover
```

```text
image resizer
```

```text
white background
```

```text
image upscaler
```

```text
bulk image editor
```

### SEO title tag

```text
Padly: Bulk Background Remover for Product Photos
```

49 characters (keep it under about 60 so Google doesn't cut it).

### SEO meta description

```text
Remove backgrounds and pad product photos to square or 4:5 in bulk. Preview and approve every change; originals are backed up so you can restore them.
```

150 characters (keep it under about 160).

## Languages and install requirements

- **Languages:** English only. The app UI has no translations (`<html lang="en">`, en-US
  formatting). Shopify auto-translates the listing text; that's fine and doesn't mean the app
  supports those languages.
- **Sales channel requirements:** leave "Merchant must have online store" **unticked**. The
  app edits product media in the admin and adds nothing to the storefront, so it works with
  any sales channel or headless storefront.
- **Geographic requirements:** none. Don't restrict countries, shipping or currency.
  Charges are in USD through Shopify billing, which converts for the merchant.
- **Required API permissions / plans:** none beyond the app's scopes (`read_products`,
  `write_products`, `read_files`, `write_files`).

## Contact, support and links

| Field | Value |
| --- | --- |
| Support email (public) | `dev.bobomurodov@gmail.com` |
| App submission contact email | `dev.bobomurodov@gmail.com` (add `noreply@shopify.com` to allowed senders) |
| Website | `https://images.qancha.live` |
| Privacy policy URL | `https://images.qancha.live/privacy` |
| Terms of service URL (if the form has it; otherwise under additional resources) | `https://images.qancha.live/terms` |
| FAQ URL | `https://images.qancha.live/support` |
| Support portal URL | `https://images.qancha.live/support` |
| Changelog, tutorial, documentation | leave empty (link only to dedicated pages, never the landing page or a cloud document) |
| Phone | leave empty (optional, display only) |

Before submitting, open each URL in a private window and check it loads (200) with the
Padly name and the same support email.

The emergency developer contact (email and phone) and the API contact email are set in the
Partner Dashboard and Dev Dashboard, not in the listing: see submission-checklist.md.

## Protected customer data

Opt out. The app reads and writes products and files only (`read_products`,
`write_products`, `read_files`, `write_files`) and never touches customers or orders.

## Testing instructions and screencast

- Testing instructions: paste the block from `docs/app-store/reviewer-instructions.md`.
- Demo screencast: an unlisted YouTube (or Loom/Drive with "anyone with the link") link to
  the recording made with `docs/app-store/screencast-script.md`.

## Alt text summary

| Asset | Alt text |
| --- | --- |
| Icon | Padly logo: a product bottle centred inside a dashed orange frame |
| Feature image | A photo of headphones on a wooden table next to the same photo on a clean white background, centred with even margins |
| Screenshots 1 to 6 | See `docs/app-store/screenshots.md` |

## Assets in the repo

| File | Size | Use |
| --- | --- | --- |
| `public/brand/icon.svg` | vector | Source of the mark; also the SVG favicon |
| `public/brand/icon-1200.png` | 1200 x 1200 | App Store icon (listing and app configuration) |
| `public/brand/feature-1600x900.png` | 1600 x 900 | Listing feature image |
| `public/brand/og-1200x630.png` | 1200 x 630 | Social preview for the website (og:image) |
| `public/apple-touch-icon.png` | 180 x 180 | iOS home-screen icon for the website |
| `public/favicon.ico` | 16, 32, 48 | Browser tab icon |
| `docs/app-store/brand-src/*.html` | | Render sources with the exact headless Chrome commands (kept out of `public/` so they aren't served) |
