# Testing instructions for the App Store review

Paste the block below into the **Testing instructions** field of the App Store submission
form. It has no credentials on purpose: Padly has no login of its own and authenticates
through Shopify (session tokens and token exchange), so requirement 4.5.4/4.5.5 is met by
saying so.

Before pasting, check against the deployed app:

- the button and tab names below still match the UI (they were taken from
  `app/routes/app.jobs.$jobId.tsx`, `app.jobs.new.tsx`, `app.billing.tsx` and
  `app.settings.tsx`);
- the three sample photo URLs open (they're served from `public/examples`);
- a Starter purchase works on a development store (submission-checklist.md, section 4).

## Paste this

```text
PADLY: TESTING INSTRUCTIONS

No login or credentials are needed. Padly is an embedded app and signs in through Shopify when you open it from the admin.

SETUP (about 2 minutes)
1. Use a development store with 5 to 10 products that have photos. Any product photos work. If the store has none, create a few products and add a photo to each with Products > Add product > Media > Add from URL, using these sample photos:
   https://images.qancha.live/examples/headphones-before.jpg
   https://images.qancha.live/examples/mug-before.jpg
   https://images.qancha.live/examples/perfume-before.jpg
   (or any free product photos, e.g. from pexels.com).
2. Install Padly. The store starts with 25 free credits: 1 credit per image applied to the store, +1 when AI upscaling runs. Credits are only used when an image is applied.

PROCESSING TIME: usually 5 to 15 seconds per image. Images are processed one after another, so 5 to 10 images are normally ready within 1 to 3 minutes; the first job after a quiet period can take a little longer. Job pages refresh by themselves.

TEST CASES
1. Home. Open Padly from Apps. Expected: your credit balance, recent jobs and a short "How it works".
2. New job. Click "New job". Pick a collection (or vendor, type or tag) with 5 to 10 products, keep "First image of each product" and the default style (Square 1:1, margin 8%, Remove background, white). Click "Find images". Expected: the job reads your products, then shows "Ready to start" with the number of images found, a thumbnail grid and the credits that will be reserved. Untick one thumbnail: the count updates. If the selection needs more than 25 credits, untick images until it fits.
   If nothing matches, the job ends with the note "No product images matched this selection." and buttons to change the selection or open products.
3. Start. Click "Start processing". Expected: a progress bar, results appear as images finish, then the job moves to "Ready for review". Nothing in the store has changed yet.
4. Review. On the "To review" tab, drag the slider on a card to compare before and after, and tick "Show cut-out mask" to see the cut-out. Flagged images carry a badge and a short explanation. To see a flag: start a second job with "AI upscaling for small images" ticked, click "Find images", then click "Deselect all" and tick only the mug sample photo (printed text, under 1,200 px) before "Start processing". AI upscaling reserves 2 credits per small image, so a full second selection won't fit in the free credits while the first job is in review. The mug is flagged "Text on product" and resized without AI to keep the text sharp.
5. Approve. Click "Approve all unflagged" (flagged images are never included). Approve or reject a flagged image on its card, and reject one other image. Expected: badges change to Approved or Rejected, and the main button shows how many will be applied.
6. Apply. Click "Apply N approved" and confirm in the dialog. Expected: a progress bar, then the images show "Applied". Each applied image uses 1 credit (+1 where AI upscaling ran); rejected and unapplied images cost nothing.
7. Check the product. Open Products and one of the applied products. Expected: its image is replaced in the same gallery position, with the same alt text and variant links, centred on a white square with even margins. The storefront can show the old image for a few minutes because of Shopify's CDN cache.
8. Restore. In the job, open the "Applied" tab and click "Restore original" on one image (or "Restore all applied" and confirm). Expected: within a few seconds the original photo is back on the product in the same position. Restoring is free; the credit used by the apply is not refunded.
9. Buy credits. Open "Credits" and click "Buy" on the Starter pack. Development stores always get test charges, so nothing is billed. Expected: Shopify's charge approval page, marked as a test. Approve: you return to Credits with a "Credits added" banner, the balance goes up by 300 and History lists the purchase (reloading doesn't add it twice). Decline instead: no credits are added.
10. Settings. Change the default style (e.g. Portrait 4:5 and a background colour) and click "Save". Expected: a "Default preset saved" message, and the next New job starts with these settings. The page also explains how original backups are kept.
11. Failed images. If an image fails (e.g. it was deleted from the product while the job ran), it shows a plain-language reason, costs nothing, and "Retry failed" puts it back into work.
12. Help. The links at the bottom of the app's pages open Support & FAQ, Privacy and Terms on our website in a new tab.
13. Uninstall. Uninstall Padly from Settings > Apps. Expected: the app is removed; applied images stay on the products (restore first to get originals back). Backups and job data are erased when Shopify sends shop/redact, 48 hours after uninstalling (within 30 days at the latest). Reinstalling runs Shopify's install and authorization again; within those 48 hours your jobs and backups are still there.

The app uses products and files only (read/write products and files). It never reads orders or customer data.

Questions: dev.bobomurodov@gmail.com
```

## Notes for the owner

- The paste block is plain text (the form doesn't render Markdown) and about 5,200
  characters. If the form has a lower limit, drop test cases 11 and 12 first.
- Test case 4's second job holds only the mug on purpose. The sample photos are 1000 x 1000,
  under the 1,200 px upscaling threshold, so each reserves 2 credits with AI upscaling on,
  and the first job keeps its reservation while it is in review: a full second selection
  would run past the 25 free credits.
- Test case 4's flag depends on text detection finding the mug's lettering. Run it once on
  your dev store before submitting; if it isn't flagged there, change the sentence to
  "Flags depend on the photo (glass, hair, text or very small photos are typical)".
- Test case 9 relies on `test: true` for development stores
  (`shop.plan.partnerDevelopment`, `app/lib/billing.server.ts`) and on the listing's
  Pricing method being **Manual pricing (legacy)**. With Shopify App Pricing selected, the
  Billing API call fails (billing-manual-pricing-setting).
- After a decline, Shopify usually returns the merchant to the admin with its own "charge
  declined" notice rather than to the app, so the expected result only says that no
  credits are added.
- If a reviewer's store has no products at all, a job ends with the neutral "No product
  images matched this selection." notice (status "No images", not Failed), which the setup step
  and test case 2 explain.
- Give reviewers the same contact address as the listing's support email.
