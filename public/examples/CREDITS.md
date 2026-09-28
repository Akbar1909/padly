# Example image credits

All source photos are from [Pexels](https://www.pexels.com) and used under the
[Pexels License](https://www.pexels.com/license/) (free to use, attribution not required).
Every `*-after.jpg` and `story-*.jpg` is real output of Padly's image pipeline
(`gpu-service/scripts/make_landing_examples.py`, pipeline 2026-09-27.2, production CPU
configuration with escalation on), made from the photo listed. Nothing was retouched.
A `*-before.jpg` is a square crop of the source photo. When the product is wider or taller
than that crop, the whole photo is shown letterboxed on the page's paper colour instead of
being cut. An `*-after.jpg` is 1000 px wide, or the pipeline's own output size when that is
smaller (it is never enlarged).

Each page image also has WebP copies for `srcset`, `<name>-<width>.webp` (280, 480, 720 and
1000 px, capped at the image's own width), written by the same script
(`--variants-only` rewrites them for existing JPEGs).

`og.jpg` (the social preview) is the layout of `docs/app-store/brand-src/feature.html` at
1200 x 630 with the `leather-bag-*` pair in place of the headphones. Run the script with
`--og none` so it doesn't overwrite it.

Every photo in the first table was checked for visible brand names, logos and trademark
patterns before use.

| Files | Category | Source photo |
| --- | --- | --- |
| `derby-shoes-*` | Shoes | <https://www.pexels.com/photo/pair-of-black-leather-derby-shoes-placed-on-brown-surface-292998/> |
| `bridal-heels-*` | Shoes | <https://www.pexels.com/photo/beige-high-heeled-sandals-2085527/> |
| `leather-bag-*`, `og.jpg` | Bags & accessories | <https://www.pexels.com/photo/leather-messenger-bag-on-park-bench-in-autumn-29464416/> |
| `sunglasses-*` | Bags & accessories | <https://www.pexels.com/photo/two-eyewear-on-white-surface-1499477/> |
| `tassel-earrings-*` | Jewelry & watches | <https://www.pexels.com/photo/close-up-photography-of-blue-earrings-1413420/> |
| `minimal-watch-*` | Jewelry & watches | <https://www.pexels.com/photo/round-gold-analog-watch-with-brown-leather-strap-5058216/> |
| `gold-necklace-*` | Jewelry & watches | <https://www.pexels.com/photo/a-necklace-on-a-white-background-7134458/> |
| `rattan-chair-*` | Home & decor | <https://www.pexels.com/photo/potted-plant-and-chair-on-balcony-5028853/> |
| `cream-vases-*` | Home & decor | <https://www.pexels.com/photo/vases-on-a-white-background-5040767/> |
| `green-candle-*` | Home & decor | <https://www.pexels.com/photo/6311870/> |
| `story-candle-*` | Home & decor (quality-check story) | <https://www.pexels.com/photo/jar-sugar-sweet-wooden-surface-374681/> |
| `glass-perfume-*` | Beauty & fragrance | <https://www.pexels.com/photo/a-clear-glass-perfume-bottle-on-the-table-8450248/> |
| `amber-bottles-*` | Beauty & fragrance | <https://www.pexels.com/photo/amber-dispenser-and-dropper-bottle-7795400/> |
| `hoodie-model-*` | Apparel | <https://www.pexels.com/photo/black-man-in-hoodie-near-gray-wall-6311488/> |
| `polka-dot-dress-*` | Apparel | <https://www.pexels.com/photo/model-in-a-sun-hat-and-a-summer-dress-with-polka-dots-20478836/> |
| `rocket-*` | Kids & toys | <https://www.pexels.com/photo/7355365/> |
| `wooden-cars-*` | Kids & toys | <https://www.pexels.com/photo/yellow-and-blue-wooden-toy-cars-6865340/> |
| `glass-carafe-*` | Kitchen & tableware | <https://www.pexels.com/photo/coffee-in-a-glass-carafe-with-sunlit-shadows-29162416/> |
| `copper-teapot-*` | Kitchen & tableware | <https://www.pexels.com/photo/antique-teapot-in-a-kitchen-18500924/> |
| `stacked-bowls-*` | Kitchen & tableware | <https://www.pexels.com/photo/ceramic-decorative-bowls-and-plates-on-a-table-8251778/> |

## Not on the page

Kept only because other files still link to them; delete them once those links change:
`docs/app-store/reviewer-instructions.md` gives App Store reviewers
`headphones-before.jpg`, `mug-before.jpg` and `perfume-before.jpg` as test photos, and
`docs/app-store/brand-src/feature.html` renders the `/brand` images from `headphones-*`.
`headphones-*` and `perfume-before.jpg` show third-party brands, so they must never be
used on the page.

| Files | Source photo |
| --- | --- |
| `perfume-before.jpg` | <https://www.pexels.com/photo/clear-glass-perfume-bottle-on-wooden-table-11711813/> |
| `headphones-*` | Pexels (source page not recorded) |
| `mug-before.jpg` | Pexels (source page not recorded) |
