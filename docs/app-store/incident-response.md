# Incident response plan

For security incidents affecting Padly: unauthorized access to the server, database,
storage or secrets; a leaked secret; merchant images or data exposed, changed or lost; or
a bug that edits product images without a verified backup. Shopify's API License and Terms
(s6.2.10) require notifying Shopify of any actual or suspected breach of Merchant Data no
later than **24 hours** after becoming aware of it, so start the clock (T0) the moment you
suspect one, not when you're sure.

**Incident lead:** the owner (Akbar), who decides every step below. Contact for merchants
and Shopify: `dev.bobomurodov@gmail.com`.

Everything runs on one VPS (MVPS LTD, Netherlands): app, worker, image service, Postgres,
Redis and RustFS storage, from `/opt/visual-image-optimizer` with
`docker-compose.vps.yml`. Replicate receives image pixels only.

## 1. Detect (T0)

Signals: a merchant report to the support email; Shopify or MVPS abuse notices; an
unexpected login in `/var/log/auth.log` or `last`; unknown containers, cron jobs or users;
a secret in a place it shouldn't be (a log, a paste site, a commit); Replicate usage you
didn't cause; unexpected changes in the database (credits, purchases, jobs) or in product
images; `/healthz` failures you can't explain.

Open a private incident log (outside the repo) and write T0, what you saw and how.

## 2. Contain (first hour)

1. Keep evidence before changing anything:
   `docker compose -f docker-compose.vps.yml logs --no-color --timestamps > /root/incident-$(date +%F)-logs.txt`,
   plus copies of `/var/log/auth.log`, `last -F` and `docker ps -a`.
2. Stop the damage: `docker compose -f docker-compose.vps.yml stop app worker` takes the app
   and all image work offline while keeping Postgres, Redis and storage (and the backups)
   intact. If the host itself is compromised, also block inbound traffic except your IP
   with `ufw`, and take a snapshot from the MVPS panel if one is available.
3. Don't delete data: the backups under `shops/<id>/backups/` are merchants' only
   originals, and the database is the index to them.

## 3. Rotate secrets

Rotate everything that was on the affected system. All values live in the server `.env`
(`/opt/visual-image-optimizer/.env`, mode 600) unless noted. After editing it, restart with
`docker compose -f docker-compose.vps.yml up -d`.

| Secret | How to rotate | Side effects |
| --- | --- | --- |
| `SHOPIFY_API_SECRET` (client secret) | Dev Dashboard > Apps > Padly > Settings > client credentials: rotate the secret, put the new one in `.env`, restart, then revoke the old one. | Invalidates every store's access token (the stored tokens in the `Session` table become useless). Stores get new tokens when the merchant next opens the app; background work for a store resumes after that. |
| `GPU_SERVICE_SECRET` | `openssl rand -hex 32` into `.env`. | app, worker and gpu-service must restart together. |
| `STORAGE_ACCESS_KEY` / `STORAGE_SECRET_KEY` (the S3 keys, RustFS) | New random values in `.env`; restart storage, app and worker. | Old presigned URLs stop working (they're short-lived anyway). Open a job preview to check storage works. |
| `TRY_OWNER_TOKEN` | New random value (`openssl rand -hex 24`). | Unlock your browser again at `/try/unlock`. |
| `REPLICATE_API_TOKEN` | replicate.com > Account > API tokens: create a new one, delete the old one. | Restart gpu-service. |
| `POSTGRES_PASSWORD` | `docker compose -f docker-compose.vps.yml exec postgres psql -U vio`, then run `\password vio` at the prompt (it asks for the new password twice and doesn't echo it, so it never lands in shell history), `\q`, then put the same value in `.env`. | The env var alone does nothing on an existing volume. Restart app and worker. |
| Server access | Replace the SSH key in `/root/.ssh/authorized_keys`, change the MVPS panel password, remove unknown users and keys. | Update your deploy key on your Mac. |
| Accounts | Change the Partner, Replicate, MVPS and Gmail passwords; check 2FA; remove unknown Partner collaborators. | |

## 4. Notify (within 24 hours of T0)

- **Shopify:** the obligation is Shopify API Terms s6.2.10: notify Shopify of any actual
  or suspected breach of Merchant Data no later than 24 hours after becoming aware of it.
  Channel named in the Terms (checked 2026-09-27): "reporting an issue to Shopify Support
  via email at https://help.shopify.com/questions/partners". Use the subject "Security
  incident: Padly" and say what happened, when, which stores and data, what you've done,
  and a contact. The Terms also require you to remedy the breach promptly, investigate,
  mitigate future harm, answer Shopify's questions and report progress regularly.
- **Affected merchants:** the app stores shop domains, not emails. Get each affected
  store's contact email with the Admin API (`shop { contactEmail }` through
  `shopifyClientFor(shop)`) or ask Partner Support to relay, and email them the facts,
  what it means for their images, and what they should do. For a longer incident, add a
  banner in the app too.
- **Regulators:** if personal data of people in the EU or UK was involved (waitlist
  emails, photos showing people), a notification to the data protection authority may be
  due within 72 hours. Merchants also need your facts for their own duties.

## 5. Recover

1. Fix the cause (patch, close the port, remove the malicious change) before going back
   online, then redeploy from a clean checkout of the repo.
2. Restore data if needed from the most recent good backup: nightly database dumps and the
   storage mirror, kept on the server for 14 days (set up and test-restored in
   submission-checklist.md section 1; if they were never set up, write that in the
   incident log and work from what exists). Restore into a scratch database first,
   compare, then swap. These backups sit on the same server, so check they weren't
   touched too.
3. Merchants' product images: any image changed without their approval can be restored
   from `shops/<id>/backups/` with the app's restore (per item or per job).
4. Start the app and worker, run the live checks in submission-checklist.md (section 1),
   and watch the logs for a day.

## 6. Record and review

Keep the incident log with a timeline (T0, each action with its time, who was told and
when), the evidence files, and the rotated secrets (names only, never values). Within a
week, write down the cause and what changes so it doesn't happen again, and update this
plan.
