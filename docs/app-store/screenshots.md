# Listing screenshots

The App Store listing needs 3 to 6 desktop screenshots at exactly 1600 x 900 (16:9), each
with alt text. They have to show the real app UI, each one a different feature or state,
with no browser chrome, desktop background, personal data, pricing, reviews, stats or
guarantees (App Store requirements 4.2.2, 4.3.4, 4.3.6, 4.4.3 to 4.4.5). This page lists
the six screens to capture from a development store, then how to turn the raw captures
into listing images with `scripts/listing-screenshot.py`.

## Before you capture

1. Use the **production** app ("Padly", `shopify.app.production.toml`) after the rename is
   released, so the title bar and icon say Padly. Install it on a development store.
2. Stock the store with 8 to 12 products that have ordinary photos: product on a table,
   shelf or floor, in different shapes (a mug, a bottle, a bag, shoes, a lamp). Use photos
   you own or that have a free licence (for example Pexels), with **no third-party logos or
   brand names** and no people's faces. Give products plain names ("Ceramic mug", "Canvas
   tote"). The landing examples in `public/examples` (headphones, mug, perfume) are fine;
   don't use the sneakers, which show a brand name.
3. Check the store has nothing personal on screen: no real customer names or emails.
4. Run one job on those products with the default style (square, white background) so you
   have a job in **Ready for review**. Approve and apply part of it later for screenshot 5.
5. Use Chrome on a Retina (2x) display at 100% browser zoom, with the window about 1600 x
   1000 CSS pixels or larger, so captures are sharp after scaling down.

## What never goes in a screenshot

- **Money**: skip the Credits page (it shows $ prices and cents per image). Don't show the
  "Not enough credits" banner or the landing page's pricing.
- **Credit costs and balances**: crop out the cost table on the "Ready to start" job page
  (the rows from "Clean & match" to "Available now"), the Credits section on the Home page
  and the Credits panel on the New job page. Credit rules belong only in the listing's
  Pricing section.
- **Shopify branding and personal data**: capture only the app area. The admin's top bar
  (Shopify logo, store name, your avatar) and left navigation must not be in the image.
- **Numbers used as claims**: no "fidelity" percentages or timings in close crops if you
  can avoid them. Image sizes such as 1200 x 1200 are fine.

## The six screenshots

Upload them in this order. Screenshot 1 is the one most merchants see first.

### 1. Review grid with before/after previews

- **Screen:** a job in **Ready for review**, tab **To review**, first page.
- **State:** 8 to 12 cards of different products. Drag the before/after slider about
  halfway on one or two cards so both sides show. At least one card has a **Flagged**
  badge. Nothing selected, no toast on screen.
- **Crop:** the app area: the page heading, the action buttons ("Apply N approved",
  "Approve all unflagged") and the card grid. Stop above the second row if the grid runs
  long.
- **Alt text:**

```text
Review screen with before and after previews of product photos, each ready to approve or reject
```

### 2. Flagged photo with the cut-out mask

- **Screen:** the same job, tab **Flagged** (or **To review** narrowed to a few cards), with
  **Show cut-out mask** ticked.
- **State:** a flagged card (a glass bottle often gets "Uncertain edges"; a small photo
  with printed text gets "Text on product" when AI upscaling is on) with its flag badge and
  explanation visible, next to one or two normal cards. The mask overlay is on.
- **Crop:** the tab row, the "Show cut-out mask" checkbox and 2 to 4 cards. Zoom the
  browser to 125% first if the cards look small.
- **Alt text:**

```text
Flagged product photo with the cut-out mask shown and a note on what to check before approving
```

### 3. New job: choose products and style

- **Screen:** **New job**.
- **State:** Collection set to a real collection, Images "First image of each product",
  Canvas "Square (1:1)", Margin 8%, Remove background ticked, Background colour white.
- **Crop:** the main column only, from the page heading down to the **Background colour**
  field. Leave out the Credits panel on the right and the AI upscaling note below (it
  mentions credits).
- **Alt text:**

```text
New job form for choosing products by collection, vendor, type or tag, and a square or 4:5 canvas style
```

### 4. Images found, ready to start

- **Screen:** a new job in **Ready to start** after "Find images".
- **State:** the **Images to process** grid with 10 or more thumbnails, two of them
  unticked (greyed out), and the "N of M selected" count. Tick AI upscaling in the job's
  style beforehand if you want the small photos to show "AI upscale".
- **Crop:** from the **Images to process** heading down. The cost table above it must not
  be in the image.
- **Alt text:**

```text
Grid of product photos found for a job, with checkboxes to leave out any photo before processing
```

### 5. Applied photos with restore

- **Screen:** a job after **Apply**, tab **Applied** (status Completed, or Ready for review with
  some applied).
- **State:** cards with the **Applied** badge and a **Restore original** button, the
  "Restore all applied" action at the top, and the note that the storefront can show the
  old image for a few minutes.
- **Crop:** the app area with the heading, actions and the first row or two of cards.
- **Alt text:**

```text
Finished job with applied product photos, each with a button to restore the original image
```

### 6. Settings: default style and your data (optional)

- **Screen:** **Settings**.
- **State:** the default "Clean & match" style and the **Your data** panel (originals backed
  up and kept while installed, what happens after uninstall, no orders or customer data).
- **Crop:** from the heading down to the **Background colour** field on the left, plus the
  Your data panel. Leave out the AI upscaling note (it mentions credits).
- **Alt text:**

```text
Settings page with the default photo style and a note that every original is backed up for restoring
```

Optional alternative for 6: the product in the Shopify admin after apply, cropped to the
product's **Media** card only (the new photo in the same first position). It isn't app UI,
so keep at most one such image, and never include the admin top bar.

Skip mobile screenshots: the listing doesn't claim a mobile or POS experience.

## Capturing the app area

The cleanest capture is the app's iframe on its own:

1. Open the screen in the Shopify admin and set up the state above.
2. Open Chrome DevTools (Cmd+Option+I), click the element picker, and click anywhere in the
   app. In the Elements panel, select the `<iframe>` that holds the app (its `src` starts
   with `https://images.qancha.live`).
3. Right-click the `<iframe>` node > **Capture node screenshot**. Chrome saves a PNG of
   exactly the app area at 2x resolution.

If the page title bar (heading and buttons) is drawn by the admin above the iframe, capture
with macOS Cmd+Shift+4 instead and drag from the title bar's left edge to the bottom right
of the app area, keeping the admin's top bar and left navigation out. Use `--crop` in the
script to trim anything left over.

Name the files in upload order, e.g. `01-review.png` ... `06-settings.png`.

## Fitting captures to 1600 x 900

`scripts/listing-screenshot.py` crops (optional), converts to sRGB, scales **down only**
to fit inside the canvas with a margin, centres it on a solid palette colour, optionally
adds a subtle frame, and writes `<name>-1600x900.png`, checking the size is exact. It needs
only Pillow, which the GPU service virtualenv already has.

```bash
# all captures at once, paper background, subtle frame
gpu-service/.venv/bin/python scripts/listing-screenshot.py ~/Desktop/raw/*.png \
  --frame --out ~/Desktop/listing

# one capture that still has 140 raw pixels of browser bar at the top, on ink
gpu-service/.venv/bin/python scripts/listing-screenshot.py ~/Desktop/raw/01-review.png \
  --crop 0,140,0,0 --bg ink --frame --out ~/Desktop/listing
```

| Option | Default | Meaning |
| --- | --- | --- |
| `--out DIR` | `listing-screenshots` | Output folder (created if missing). |
| `--crop L,T,R,B` | none | Raw pixels to cut from the left, top, right and bottom before fitting. Retina captures are 2x, so 70 CSS px of browser bar is 140 raw px. |
| `--bg` | `paper` | Background: `paper` (#f3efe6), `ink` (#16130f), `card` (#fffdf8), `white` or any `#rrggbb`. |
| `--margin N` | `48` | Minimum space around the screenshot in output pixels. `0` fills edge to edge when the capture is exactly 16:9. |
| `--frame` | off | Rounded corners, a hairline border and a soft shadow. |

Use the same `--bg` and `--frame` for all six so the set looks consistent (paper with a
frame suits the light admin UI; ink matches the feature image). The script never enlarges
a capture: if it prints "capture is only ... left at 100%", recapture larger rather than
upscale. It also warns when the screenshot fills less than 60% of the canvas; crop
tighter with `--crop` in that case.

## Final check before uploading

- [ ] 3 to 6 PNGs, each exactly 1600 x 900 (the script checks; `file *.png` shows it too).
- [ ] Each shows a different screen or state.
- [ ] No $, cents, "free", credit costs or balances, no Credits page.
- [ ] No Shopify logo, admin top bar, store name, email or avatar.
- [ ] No third-party brand logos on the product photos.
- [ ] Alt text pasted for each, from this page.
