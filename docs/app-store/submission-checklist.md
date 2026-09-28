# App Store submission checklist: Padly

Everything between "the code is ready" and "Published", in order. Work top to bottom:
several steps depend on earlier ones (pricing method before billing tests, the released
Padly version before screenshots and the screencast, a real install before the automated
checks).

Legend:

- **[code]** handled by the code and config in this release. You only deploy it and check
  it on the live site.
- **[you]** something only you can do: Partner Dashboard, Dev Dashboard, the server, a dev
  store or a recording.

Paths: the **Partner Dashboard** (partners.shopify.com) holds the App Store listing,
pricing, distribution, registration, payouts and the emergency contact. The **Dev
Dashboard** holds the app's versions, configuration, installs, logs and the App Store
review page.

## 1. Code, deploy and release

- [ ] **[code]** Padly name in the app and on the website: app heading, landing, footer,
      legal pages and error screens take it from `app/lib/brand.ts`.
- [ ] **[code]** No `.myshopify.com` entry anywhere (requirement 2.3.1): the landing
      install form is gone, `/auth/login` doesn't show a shop field, and install buttons
      say "coming to the Shopify App Store" until `APP_STORE_URL` is set (section 7).
- [ ] **[code]** Public pages `/privacy`, `/terms` and `/support` (FAQ), linked from the
      landing footer and the app's help footer.
- [ ] **[code]** Credit copy says "Credits don't expire while the app is installed" (never
      "never expire"), prices are labelled USD, and the Credits page, landing pricing and
      listing Pricing (listing.md) say the same thing.
- [ ] **[code]** A failed charge shows a banner, not a 500 page (`BillingError`); a job that
      matches no images ends with a neutral notice, not "Failed".
- [ ] **[code]** Brand assets: `public/favicon.ico`, `public/apple-touch-icon.png`,
      `public/brand/*` (this folder's listing files use them).
- [ ] **[you]** Check the website uses them before deploying:
      `grep -n apple-touch-icon app/root.tsx` finds the `<link>`, and
      `grep -n og:image app/routes/_index/route.tsx` points at `/brand/og-1200x630.png`, not
      `/examples/og.jpg` (the sneakers photo shows a third-party brand). Both were still
      open when this checklist was written.
- [ ] **[code]** Data retention in the code: an uninstalled store is erased 25 days after
      uninstall at the latest (`RETENTION_AFTER_UNINSTALL_MS`, `worker/tasks/jobs.ts`);
      shop/redact for a store that still looks installed asks Shopify and erases it if the
      app is gone (`verify-uninstalled`, `app/routes/webhooks.compliance.tsx`); the owner
      token is only POSTed to `/try/unlock` (`?token=` is ignored).
- [x] **[done 2026-09-27, verified on the server]** Log caps. The privacy policy ("Server logs") says each service keeps
      at most three 10 MB log files. `docker-compose.vps.yml` now sets this (`x-logging`), but
      it only applies to containers created after the change, i.e. after the next `up -d`.
      Before submitting, check on the server (in `/opt/visual-image-optimizer`) that
      `docker compose -f docker-compose.vps.yml config | grep -c 'max-size'` prints 7 (app,
      worker, gpu-service, postgres, redis, storage, plus the `x-logging` block itself), and
      after the deploy that
      `docker inspect --format '{{.Name}} {{json .HostConfig.LogConfig.Config}}' $(docker compose -f docker-compose.vps.yml ps -q)`
      shows `"max-file":"3","max-size":"10m"` on every container (for example `/vio-app-1`).
- [ ] **[you] Nightly backups: installed 2026-09-27; do one test restore.** The privacy
      policy ("Server backups") and `incident-response.md` section 5 say nightly database
      dumps and a storage mirror are kept on the server for 14 days. `scripts/backup.sh` runs
      from the systemd timer `vio-backup.timer` (README "Backups (VPS)"); the first run by hand
      succeeded. Before submitting, check on the server: `/var/backups/vio` has last
      night's dump (`db/db-YYYYmmdd-HHMM.dump`) and storage mirror and nothing older than 14
      days, `/var/log/vio-backup.log` ends with an "ok" line, and one dump restores into a
      scratch database:
      `docker compose -f docker-compose.vps.yml exec -T postgres createdb -U vio vio_restore_test`,
      then `docker compose -f docker-compose.vps.yml exec -T postgres pg_restore -U vio -d vio_restore_test < <last-night>.dump`,
      then `... exec -T postgres psql -U vio -d vio_restore_test -c 'select count(*) from "Shop"'`
      prints a count, then `... exec -T postgres dropdb -U vio vio_restore_test`. If you
      decide not to keep backups after all, change the privacy policy's "Server backups"
      row and `incident-response.md` section 5 step 2 before submitting instead.
- [ ] **[you]** Server `.env` (`/opt/visual-image-optimizer/.env`): `SHOPIFY_API_SECRET` is
      set (the app now refuses to start in production without it),
      `GPU_MODEL_BACKEND=replicate`, `GPU_FALLBACK_BACKEND=local`, a working
      `REPLICATE_API_TOKEN` with credit, `DONATE_URL` unset, `APP_STORE_URL` unset for now.
- [ ] **[you]** Deploy to the VPS (README "Current production"), then confirm billing runs
      in live mode:
      `docker compose -f docker-compose.vps.yml exec -T app printenv NODE_ENV BILLING_TEST`
      prints `production` and nothing (or `false`) for BILLING_TEST. Development stores
      still get test charges automatically.
- [ ] **[you]** Rotate `TRY_OWNER_TOKEN` (the old one was written to request logs before the
      POST-only unlock), restart the app, and unlock your browser again at `/try/unlock`.
- [ ] **[you]** Check the app names before releasing:
      `grep '^name' shopify.app.production.toml shopify.app.toml` prints `"Padly"` and
      `"Padly Dev"`. When this checklist was written both files still had the old names
      ("Visual Image Optimizer Live" and "Visual Image Optimizer"); change them first if they
      still do. Releasing under the old name while the listing says "Padly: Bulk Background
      Remover" fails requirement 4.1.1 (the names must share words).
- [ ] **[you]** Release the Padly version of the app configuration:
      `npx shopify app deploy --config production`. It publishes the name, URLs, scopes,
      embedded flag, webhooks and compliance webhooks.
- [ ] **[you]** Dev Dashboard > Apps > Padly > Versions: the active version is named
      **Padly** and has App URL
      `https://images.qancha.live`, redirect URLs on `images.qancha.live`, "Embed app in
      Shopify admin" on, scopes `read_products,write_products,read_files,write_files`, the
      webhook subscriptions (`app/uninstalled`, `app/scopes_update`,
      `bulk_operations/finish`, `app_purchases_one_time/update`) and the compliance topics
      (`customers/data_request`, `customers/redact`, `shop/redact`).
- [ ] **[you]** Live checks from your laptop:
      `curl -s https://images.qancha.live/ | grep -c myshopify` prints 0;
      `/privacy`, `/terms` and `/support` return 200 and name Padly;
      `curl -sI https://images.qancha.live/auth/login` is a redirect, not a 200 form;
      `curl -s -o /dev/null -w "%{http_code}" -H 'Content-Type: application/json' -H 'X-Shopify-Hmac-Sha256: invalid' -d '{}' https://images.qancha.live/webhooks/compliance`
      returns 401 (a webhook with a bad signature is refused; the signed path is checked
      in section 4 by the webhook logs); the browser tab shows the new favicon.

## 2. Partner account

- [ ] **[you]** Partner Dashboard > Settings > **Shopify App Store registration**: pay the
      one-time $19 fee, declare any associated developer accounts, add a payment method.
- [ ] **[you]** **Payouts**: create the Hyperwallet account from the Partner Dashboard,
      check that a bank or wire transfer method exists for your country and currency, and
      fill in the tax information (a non-US individual usually submits a W-8BEN). Do this
      before the first real pack is sold.
- [ ] **[you]** Partner Dashboard > Settings > **Emergency developer contact**: an email you
      read daily and a phone number. Shopify sends critical technical updates here.
- [ ] **[you]** Dev Dashboard > Apps > Padly > Settings > **API contact email**: an address
      without the word "Shopify" (`dev.bobomurodov@gmail.com` works).
- [ ] **[you]** In Gmail, add a filter for `noreply@shopify.com` > "Never send it to Spam", so
      review and quality-check emails arrive.
- [ ] **[you]** Name check: a developer called "Pagly" exists on the App Store. You decided
      to keep Padly; if the listing form rejects the name, ask Shopify Support to review it.

## 3. Distribution, pricing and data access

- [ ] **[you]** Partner Dashboard > App distribution > All apps > Padly > **Distribution**:
      choose **Shopify App Store** (public). This can't be changed later.
- [ ] **[you]** **Pricing method = Manual pricing (legacy)**, before any billing test:
      Distribution > Manage listing (beside "Shopify App Store listing") > Published
      languages > Edit (English) > Pricing content > Manage > **Settings** > Pricing method >
      Manual pricing (legacy). Shopify App Pricing (the default) doesn't support one-time
      purchases, and the credit-pack Billing API calls fail under it.
- [ ] **[you]** App Store review page > **Protected customer data**: opt out. The app uses
      products and files only, never customers or orders. (Access can't be requested while
      the app is under review.)

## 4. End-to-end test on a development store

Use a dev store in the same organization. Stock it as in screenshots.md ("Before you
capture").

- [ ] **[you]** Dev Dashboard > Apps > Padly > Overview > Installs > **Install app**, pick
      the dev store. The app opens in the admin. A working install and first screen also
      prove `SHOPIFY_API_SECRET` is right on the server (token exchange depends on it).
- [ ] **[you]** Run every test case in `reviewer-instructions.md` yourself, exactly as
      written: new job, estimate, start, review with slider and mask, a flagged photo,
      approve, apply, product check, restore, Settings, help links.
- [ ] **[you]** On a product with variant images and alt text: after apply, the image keeps
      its gallery position, alt text and variant links; after restore, the original is
      back in the same place.
- [ ] **[you]** Billing, approve: Credits > Buy Starter > Shopify's page says it's a test
      charge > Approve > "Credits added" and +300; reload the page and check it isn't
      added twice.
- [ ] **[you]** Billing, decline: buy again > Decline > no credits added; the purchase ends
      as declined.
- [ ] **[you]** Billing, webhook only: buy, approve, and close the tab before it returns to
      the app. Reopen Padly: the credits are there (the `app_purchases_one_time/update`
      webhook added them).
- [ ] **[you]** Dev Dashboard > Apps > Padly > **Logs** (webhooks): the purchase webhook and
      `app/uninstalled` were delivered with 200.
- [ ] **[you]** Uninstall, then reinstall: Shopify's install and authorization run again and
      the app opens. Open the app in a Chrome incognito window too.
- [ ] **[you]** Click through Home, Jobs, New job, Credits and Settings a few times. The two
      embedded-app checks (App Bridge from Shopify's CDN, session tokens) turn green on
      the review page after real use; they re-run about every 2 hours.
- [ ] **[you]** Tick the matching lines in README "Before launch" (billing flow, in-place
      replacement).

## 5. Listing

Everything to paste is in `listing.md`, with character counts.

- [ ] **[you]** Manage listing > English: app name, icon, subtitle, introduction, details,
      five features, search terms, SEO title and meta description, categories (Image
      editor; secondary Bulk editor) and structured features.
- [ ] **[you]** Languages: English only. "Merchant must have online store": unticked.
      Geographic requirements: none. Integrations: none.
- [ ] **[you]** Pricing: Free to install plus the additional-charges text, exactly as in
      listing.md. Compare it once more with the live Credits page.
- [ ] **[you]** Links: privacy `https://images.qancha.live/privacy`, FAQ and support
      `https://images.qancha.live/support`, terms `https://images.qancha.live/terms`
      (if there is a field), website `https://images.qancha.live`, support email
      `dev.bobomurodov@gmail.com`, app submission contact email.
- [ ] **[you]** Media: feature image `public/brand/feature-1600x900.png`; 3 to 6 screenshots
      made with `screenshots.md` and `scripts/listing-screenshot.py`; alt text on every
      image.
- [ ] **[you]** Icon: `public/brand/icon-1200.png` in the listing **and** in the app's
      configuration on the App Store review page.

## 6. Review page and submission

- [ ] **[you]** Record the screencast (`screencast-script.md`) on the released Padly
      version, on a fresh dev store that has never had Padly installed (not the section 4
      test store), upload it unlisted, and paste the link in **Demo screencast**.
- [ ] **[you]** Paste `reviewer-instructions.md` into **Testing instructions**.
- [x] **[done]** Breach-notification channel from API Terms s6.2.10 (notify within 24 hours
      via https://help.shopify.com/questions/partners) is written into `incident-response.md`
      section 4 (checked 2026-09-27).
- [ ] **[you]** App Store review page > **Configuration**: URLs, compliance webhooks, app
      icon, API contact and emergency contact all complete.
- [ ] **[you]** Run the **automated checks**. Fix anything that fails, redeploy, and rerun
      until all pass. They need the recent real install from section 4.
- [ ] **[you]** Optional: run Shopify's AI self-review (`/shopify-app-store-review` from the
      Shopify AI Toolkit) against this repo.
- [ ] **[you]** Click **Submit your app**. The status goes Draft > Submitted (confirmation
      email) > Reviewed or Paused > Published. Answer the reviewer by email and fix every
      point in one pass: repeated failed rounds can lead to a temporary suspension.

## 7. After approval

- [ ] **[you]** Set `APP_STORE_URL=https://apps.shopify.com/<your-handle>` in the server
      `.env` and restart the app container. The website's install buttons then link to the
      listing (the code for this is already in place).
- [ ] **[you]** Answer Shopify's quality-check emails within 7 days, and make required
      fixes within 30 days.
- [ ] **[you]** Keep the support email, emergency contact and API contact current.
- [ ] **[you]** Keep Replicate funded. If it runs out or is down, images fall back to the
      same models on the server's CPU, which is slower; `/healthz` on the image service
      reports both backends.
- [ ] **[you]** Once a month, restore one nightly database dump into a scratch database to
      prove the backups work.
- [ ] **[you]** After a few days of real use, look at Web Vitals for the app in the Partner
      Dashboard (not needed for approval).
- [ ] **[you]** Keep `incident-response.md` at hand; Shopify must hear about a breach within
      24 hours.
