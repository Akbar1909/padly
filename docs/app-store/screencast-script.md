# Demo screencast script (for App Store review)

Requirement 4.5.3: a screencast that shows the app's onboarding and every feature in the
listing, step by step, in English (or with English subtitles). This is the **Demo
screencast** field of the submission form, for reviewers only. It isn't the listing's
promotional feature video.

Target length: about 4 minutes (3 to 5 is fine). Record it on the **production** app named
Padly, after the rename, icon and landing fixes are deployed, on a development store
stocked as described in `screenshots.md` ("Before you capture"): 8 to 12 products with
ordinary photos, including a glass bottle and a mug with printed text, and no third-party
logos.

## Before recording

- [ ] Record on a development store that has never had Padly installed (create a fresh dev
      store just for the recording and stock it as above), so Home shows the "Start with
      25 free credits" banner and no jobs. A reinstall within 48 hours keeps the old jobs,
      and free credits are only granted once per store. A store Padly was uninstalled from
      also works once shop/redact has erased its data (more than 48 hours later).
- [ ] Before each re-take, set Settings back to Square (1:1) and Save. Re-taking the
      install and Home shots (2 and 3) needs another fresh store.
- [ ] Create a collection (for example "Demo") with 6 to 8 of the products.
- [ ] Screen: 1920 x 1080 (or record a 1920 x 1080 region), Chrome at 100% zoom, bookmarks
      bar hidden, only one tab open, notifications off (macOS Focus mode).
- [ ] Hide personal information: use a dev store whose name isn't personal, sign in as a
      staff account without your personal email showing, and close anything with
      customer data. Don't open Orders or Customers.
- [ ] Prices appear only in the billing step (the Credits page and Shopify's test charge
      page). Don't show the landing page's pricing.
- [ ] Record the voice separately or in one take; either way, add English subtitles
      (YouTube's auto-captions, checked and corrected, are enough).
- [ ] Upload as **Unlisted** on YouTube (or Loom / Google Drive with "anyone with the link
      can view") and open the link in a private window to check it plays.

Processing waits: cut or speed up the waits for processing and applying (say "a few
seconds per image" when you cut), but keep the moment the status changes.

## Shot list and narration

| # | Time | On screen | Narration |
| --- | --- | --- | --- |
| 1 | 0:00-0:15 | The dev store admin, Home. | "This is Padly, a Shopify app that cleans up product photos in bulk: it removes or keeps the background, pads every photo to the same canvas without cropping, and replaces the images in place, with the originals kept safe." |
| 2 | 0:15-0:35 | Install: open the install link from the Dev Dashboard (or the App Store listing once live), choose the store, show Shopify's permission screen (products and files only), click **Install**. | "Installing goes through Shopify. Padly only asks to read and write products and files. It never touches orders or customers." |
| 3 | 0:35-0:55 | Padly opens on **Home**: the "Start with 25 free credits" banner, credit balance, recent jobs (empty), "How it works", help links at the bottom. | "The app opens inside the Shopify admin. New stores start with free credits. A credit is only used when an image is applied to the store." |
| 4 | 0:55-1:20 | **New job**: pick the "Demo" collection, show the vendor, type and tag filters and "First image of each product" vs "All images". Style: Square (1:1), margin 8%, Remove background, white. Tick **AI upscaling for small images**. Click **Find images**. | "A job starts with a selection: a collection, vendor, product type or tag. Then the style: square or 4:5, the margin around the product, a white or brand-colour background or the original one, and optional AI upscaling for small photos." |
| 5 | 1:20-1:40 | Job page, **Ready to start**: images found, the thumbnail grid, untick one image, show the credits to reserve and the available balance. Click **Start processing**. | "Padly finds every matching image and shows the exact credit cost before anything runs. Untick any photo you want to leave out. Credits are reserved now but only charged when you apply." |
| 6 | 1:40-2:00 | Progress bar, cards filling in (sped up), status becomes **Ready for review**. | "Each original is backed up first, then processed. This takes a few seconds per image, and nothing in the store changes yet." |
| 7 | 2:00-2:30 | **To review** tab: drag the before/after slider on two cards. Tick **Show cut-out mask** on a glass product. | "Every result is a preview. Drag to compare before and after. The mask shows exactly what was cut out; products are centred with even margins and never cropped." |
| 8 | 2:30-2:50 | **Flagged** tab: the mug with "Text on product" (and a glass bottle with "Uncertain edges" if flagged). Hover or read the explanation. Approve one flagged image on its card, reject another. | "Photos that need a closer look are flagged, with the reason. This mug has printed text, so it was resized without AI to keep the lettering sharp. Flagged photos are never approved automatically." |
| 9 | 2:50-3:10 | Click **Approve all unflagged**, then **Apply N approved** > confirm **Apply N images** in the dialog (it shows the credits used). Progress bar, cards turn **Applied**. | "Approve all the unflagged ones in one click, then apply. Padly replaces each image in place." |
| 10 | 3:10-3:30 | Open **Products** > an applied product in a new tab: the new image in the same gallery position, alt text unchanged, a variant still linked. | "In the product, the new photo sits in the same position, with the same alt text and variant links." |
| 11 | 3:30-3:45 | Back in the job, **Applied** tab: **Restore original** on one image; reload the product to show the original is back. | "Changed your mind? Restore any original with one click, or the whole job. Restores are free." |
| 12 | 3:45-4:10 | **Credits**: balance and history. Click **Buy** on the Starter pack, show Shopify's approval page marked as a test charge, click **Approve**, return to Credits with "Credits added" and the new balance. | "More credits are one-time packs billed through Shopify. On a development store this is a test charge. After approving, the credits are added straight away." |
| 13 | 4:10-4:30 | **Settings**: change the default canvas to Portrait (4:5), **Save**, show the "Your data" panel. Click **Support & FAQ** in the footer (opens the website in a new tab). | "Settings saves your default style for new jobs, and explains how backups are kept while the app is installed. Help, privacy and terms are linked at the bottom of the pages." |
| 14 | 4:30-4:40 | Back on Home, the finished job in Recent jobs. | "That's Padly: consistent product photos across the whole catalog, with every original kept safe." |

## Features covered

Every listing feature (listing.md) appears on screen:

| Listing feature | Shot |
| --- | --- |
| Remove backgrounds in bulk onto white or a brand colour, or keep the original | 4, 7 |
| Pad every photo to square or 4:5 with even margins, so nothing gets cropped | 4, 7, 13 |
| Upscale small photos with AI; photos with text get a safe resize instead | 4, 8 |
| Preview every before and after, and check flagged photos before you approve | 7, 8, 9 |
| Replace images in place, and restore any original with one click | 9, 10, 11 |

Onboarding (install, permissions, first screen) is shots 2 and 3; billing is shot 12.

## After recording

- Watch it once with sound off: every step should be clear from the screen and subtitles.
- Check no frame shows a personal email, a real customer, or the admin's notification
  popups.
- Paste the link into the **Demo screencast** field, and keep the video up until the app is
  approved (reviewers may come back to it).
- Re-record if the UI changes visibly before submission (button names, the Padly name or
  icon).
