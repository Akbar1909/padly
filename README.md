# Padly

Padly is a Shopify embedded app that standardises product photos in bulk: remove the background
(or keep it), pad to a square or 4:5 canvas without cropping, centre every product with the
same margin, and optionally AI-upscale small images. Merchants preview every change,
approve it, and can restore any original at any time. Credits are only charged when an
image is applied.

Implements the "Visual Image Optimizer — Build Plan" (Sep 26, 2026): GraphQL Admin API only,
Shopify's React Router template, Postgres + Prisma, Redis + BullMQ workers, a separate
Python GPU service, Cloudflare R2.

## Architecture

```text
Merchant (Shopify admin)
   │
   ▼
Embedded app ── React Router + Polaris web components (app/routes)
   │   │
   │   ├── Postgres (Prisma): shops, presets, jobs, items, notifications, credit ledger, purchases
   │   └── Redis (BullMQ): vio-items / vio-jobs queues
   │                │
   ▼                ▼
Node workers (worker/) ──GraphQL Admin API──▶ Shopify
   │  └──signed HTTPS (presigned URLs)──▶ GPU service (gpu-service/, FastAPI)
   │                                          │
   └──────────────▶ R2 / S3 ◀──────────────────┘   originals, outputs, previews
```

| Piece | Where | Notes |
| --- | --- | --- |
| Embedded app | `app/` | Auth, product picker, presets, review UI, billing, webhooks |
| Shared server logic | `app/lib/` | Used by both the web app and the worker |
| Worker | `worker/` | Reads media, backs up originals, calls the GPU service, applies, restores |
| GPU service | `gpu-service/` | BiRefNet cut-out, Real-ESRGAN upscaling, canvas, checks. See its README |
| GPU contract | `docs/gpu-service-contract.md` | The HTTP API between worker and GPU service |

### How a job flows

1. **Reading.** The merchant picks products (collection, vendor, type, tag; first image or
   all). The worker counts matching products: up to `BULK_READ_THRESHOLD` it pages through
   `products`, above that it runs a `bulkOperationRunQuery` and ingests the JSONL when the
   `bulk_operations/finish` webhook arrives (with a polling fallback). A job created through
   the API names products by id (optionally exact images) and is read with `nodes(ids:)`
   instead (see [Bulk jobs](#bulk-jobs)). One job holds at most `MAX_ITEMS_PER_JOB` images;
   the job page says so when a read stopped there.
2. **Estimated.** The page shows images found, the credit cost (1 per image, +1 per
   upscale-eligible image) and the available balance. Nothing is reserved yet.
3. **Processing.** Start reserves the credits under a row lock. Images that are already in
   another unfinished job of the shop are skipped (a notice on the job says how many), so the
   same image is never processed or charged twice at once. For each image the worker
   re-reads the live media, **backs up the original to R2 (never edits without a backup)**,
   then calls the GPU service with a presigned GET for the backup and presigned PUTs for
   the output, preview, before-image and mask overlay. When the live image is Padly's own
   output from an earlier applied job (same media, same file size), that job's backup of the
   true original is reused, so a restore always brings back the real original. An image
   whose source bytes, settings and image-service setup match an earlier READY result of the
   shop reuses that result instead of calling the service again (`processing.method =
   "reused"`). The service's final status sets the image's status: `READY` → `ready`,
   `NEEDS_REVIEW` → `flagged` (always with at least one flag saying why), `NO_CHANGE` →
   `unchanged` ("Already clean — no change needed": never applied, never charged).
4. **Review.** Before/after slider, mask overlay, flags. Per image: Approve, Keep original
   (a rejection) or Retry with stronger model (see [Final statuses and review](#final-statuses-and-review)).
   "Approve all that passed checks" takes READY images only, never flagged or unchanged ones.
5. **Applying.** Staged upload, then `fileUpdate` on the same media ID (keeps position, alt
   text and variant links), then poll `fileStatus` until `READY`. If the format can't match
   or Shopify rejects the replace, fall back to: attach new media → detach old from the
   product → relink variants → reorder → copy alt text. The old file stays in Shopify Files.
   Credits are charged once per item (idempotent ledger key) only after Shopify accepts it.
6. **Restore.** Same write path with the backup as the source. Free.

### Credits

- `CreditLedger` holds real movements only (free grant, purchases, charges on apply) and is
  never edited. `Shop.creditBalance` caches the sum, updated in the same transaction.
- A reservation is `JobItem.creditsReserved` on an item still in play in an active job.
  Rejecting, failing, finishing or cancelling simply drops it out of the sum, so there's
  nothing to "release" and nothing to leak. Reviews untouched for `REVIEW_EXPIRY_DAYS` (every
  approve, reject or reset counts as a touch) are closed automatically.
- If AI upscaling didn't actually run (e.g. text detected → Lanczos), the reservation drops
  from 2 to 1 before apply.
- An `unchanged` (already clean) image is never applied or charged, and holds no
  reservation (it isn't in `RESERVING_ITEM_STATUSES`). "Retry with stronger model" reserves
  it again at its quoted price, under the shop lock.

### Fairness and rate limits

- **Per-shop concurrency** without BullMQ Pro groups: `pumpShop()` claims at most
  `SHOP_CONCURRENCY` items per shop into the queue (advisory lock + `SKIP LOCKED`), and every
  finished item pumps the next one. A 10,000-image store can't starve a 20-image store.
- **Shopify cost pacing**: every response's `extensions.cost.throttleStatus` is stored per
  shop in Redis and all workers wait before overdrawing the bucket. `THROTTLED` responses
  are retried after the computed wait.
- A maintenance task (every minute) requeues items whose queue task was lost (and fails, for
  good, the ones BullMQ gave up on after they stalled twice), re-enqueues reads that stopped
  making progress, ends phases that have nothing left to do, nudges shops with pending work,
  and closes stale reviews. Details in [Bulk jobs](#bulk-jobs).

## Bulk jobs

A bulk job is one `Job` with one `JobItem` per image. Every status lives in Postgres; Redis
only holds the queue. Each image is its own BullMQ task, but the backlog waits as `queued`
rows: `pumpShop()` is the only producer of image tasks and feeds a shop `SHOP_CONCURRENCY` at a
time (restores first, then the oldest job). A worker restart, a closed browser tab or a
deploy loses nothing: the next worker picks up where the database says.

### Lifecycle

Internal statuses are unchanged. The API and the UI map them at the edges:

| Internal status | API `status` | What happens |
| --- | --- | --- |
| `reading` | `queued` | The worker reads the products and inserts one item per image. |
| `estimated` | `queued` (`needsAction: "start"` or `"credits"`) | App jobs wait for the merchant to tick images and press Start. API jobs with `autoStart` start themselves; if credits are short they wait here with a notice and a notification. |
| `processing` | `processing` | Credits are reserved (not charged). Images are processed and previews stored. |
| `review` | `completed`, `completed_with_errors` or `failed` (`needsAction: "review"`) | The merchant approves or rejects previews. |
| `applying` | `processing` (`phase: "applying"`) | Approved images are written to Shopify. Each one is charged only when Shopify accepts it. |
| `done` | `completed`, `completed_with_errors` or `failed` | Closed. Unapplied images drop out of the reservation. |
| `failed`, `cancelled` | `failed`, `cancelled` | Closed. |

`completed` means **processed and ready for review**, never "written to Shopify". Nothing is
written to a store before the merchant approves and applies, and the bulk API can't apply.
For `review` and `done`, the status is judged on all of the job's images: none processed and
some failed is `failed`, some failed is `completed_with_errors`. Items use `queued`,
`processing`, `completed` or `failed`, their `reviewStatus` holds the internal status
(`ready`, `flagged`, `unchanged`, `approved`, `applied`…) and `finalStatus` the automatic
verdict (`READY`, `NEEDS_REVIEW`, `FAILED`, `NO_CHANGE`; null while queued or processing).
In the app, a job in review reads "Ready for review" and only shows "Completed" once images
have reached the store.

### Final statuses and review

The image service gives every processed image a final status (`processing.final_status`,
docs/gpu-service-contract.md); the worker stores the whole `processing` record on the item
and maps the status:

| Final status | Item status | Merchant sees | Approve all | Applied / charged |
| --- | --- | --- | --- | --- |
| `READY`: every check confidently passed, no flags | `ready` | "Ready" | yes | when applied |
| `NEEDS_REVIEW`: a result the checks can't vouch for | `flagged` (≥ 1 flag; `needs_review` is added if the service sent none) | "Needs review" + what to check | never | only if approved one by one |
| `NO_CHANGE`: the photo already meets the preset | `unchanged` | "Already clean — no change needed" | never | never |
| (processing failed) | `failed` | the failure reason | never | never |

- Without a `final_status` (an older image service) the rule is as before: `flagged` when
  anything is flagged, else `ready`. A `READY` that comes with a flag is `flagged`, and a
  final status the app doesn't know is treated as `NEEDS_REVIEW`.
- `unchanged` counts as processed in progress, keeps the job in review (so the merchant can
  still retry it), and is `completed` in the API with `finalStatus: "NO_CHANGE"`.
- **Retry with stronger model** (job page, or `POST /api/image-jobs/:jobId/retry-stronger`):
  `ready`, `flagged` or `unchanged` images of a job in review go back to `queued` with
  `JobItem.forceEscalation`, the job goes back to processing for them, and the worker sends
  `settings.force_escalation: true` (the paid backend first; the service falls back to local
  and says so, `ESCALATION_UNAVAILABLE`, when it can't). The run gets new storage keys (an
  earlier result may be shared with an item that reused it), and the replaced run's record is
  kept in `processing.superseded_runs` so its cost still counts. Nothing is charged; the
  images are reserved again at their quoted price. Compare-and-set and batched: a repeat
  answers `retried: 0`; images another unfinished job has now are skipped.
- **Reuse** takes only results whose final status was READY (`ready`, or `approved` /
  `applying` / `applied` since, with no flags and `final_status` READY or absent), never
  NEEDS_REVIEW, NO_CHANGE or failed ones, nor any whose output was kept-original (rejected) or
  restored. `force_escalation` is part of the result key, so a stronger-model result only
  serves another stronger-model request with identical settings.

### Progress

- Numbers belong to the current phase. When processing or applying starts, the job stores how
  many images the phase has (`phaseTotal`, `phaseFailedBase`, `phaseStartedAt`), so "Retry
  failed" starts again at 0 % of what it retries, and an apply round counts only the images
  it writes. `progress = floor((completed + failed) / total × 100)`, so the bar never reads
  100 % while work is left.
- The ETA uses the measured rate of this phase (`elapsed / finished × remaining`). It only
  appears once 5 images have finished and is never simulated. On the production VPS
  (`MAX_CONCURRENCY=1`, about 6–9 s per image), 1,000 images take roughly 2–2.5 hours.
- The job page polls `GET /api/image-jobs/:jobId` every 3 s while the tab is visible and the
  job is reading, processing or applying. It reloads the page only when something it shows
  has changed, and stops when the merchant has to act or the job is closed. Leaving the page
  doesn't stop anything.
- Home shows a banner with x / y for each running job. The job page says "Waiting for your
  earlier job to finish." while an older job of the same shop has the shop's slots.

### Notifications

When a phase ends, one `Notification` row is created in the same transaction as the status
change (a unique `dedupeKey` per job, phase and phase start makes repeats no-ops):

| Event | Title |
| --- | --- |
| Processing ended | "{n} product images are ready." / "{ok} images are ready. {failed} need attention." / "{failed} images couldn't be processed." |
| Applying ended | "{n} images were updated in your store." / "{ok} images were updated. {failed} couldn't be updated." |
| Auto-start blocked | "Not enough credits to start processing {n} images." |

Home and the Jobs list show unread ones as banners. Each banner has "Review results", which
opens `/app/jobs/<id>`, or `?tab=failed` when nothing succeeded. Opening the job page marks
its notifications read, and a banner can be dismissed. The rows hold no personal data and are
deleted with the job or the shop.

Email is an interface only. `emailSender()` in `app/lib/notifications.server.ts` returns null
unless `EMAIL_PROVIDER` names a registered provider, and none is implemented. So nothing is
sent, no email address is stored, and the "Email me when a job finishes" setting
(`Shop.settings.notifyEmail`) stays hidden. A provider would read `shop.email` from Shopify at
send time. Update the privacy policy (`/privacy`) before enabling one.

### Retries and failures

- **Automatic, per image.** Up to `ITEM_TASK_ATTEMPTS` (5) tries, with exponential backoff
  from `ITEM_RETRY_BASE_MS` (30 s, 1 min, 2 min, 4 min). While it waits, the image gives its
  shop slot back (`JobItem.retryAt`), so the shop's other work keeps going.
  - `timeout` and `out_of_memory` are tried at most twice. A run the worker gave up on keeps
    the image service busy.
  - Permanent errors are not retried: the image was deleted or changed in Shopify, the file
    is unreadable or too large, or the backup is missing.
- **Image service down.** When the service is unreachable, or answers a service-wide 503,
  `gpu:down` is set for 60 s. During that time the pump claims no new images to process
  (applies and restores continue), so an outage doesn't burn every queued image's retries.
- **Crash loops.** Item tasks hold a 120 s lock, so a short Redis blip doesn't run a task
  twice. BullMQ fails a task that stalls twice (for example, the image kills the worker every
  time). Maintenance then marks that image `failed` (`crashed`) instead of requeueing it
  forever.
- **Stuck jobs.** Every minute, maintenance:
  - re-enqueues a read that has made no progress for 5 minutes (a read older than 6 h fails
    the job);
  - ends a processing or applying phase that has nothing left to do;
  - puts back in-flight images whose task is gone.
- **Manual.** "Retry failed" works on the whole job, selected images or one image, in review
  or done.
  - Processing failures are processed again. Apply failures go back to approved.
  - A repeat matches nothing and does nothing.
  - Images that are now in another unfinished job are skipped (`in_another_job`).
  - Credits are checked again (402 through the API).

Every failed item has a merchant-facing `error` and a machine-readable `errorCode`:

- From the image service or Shopify: `busy`, `timeout`, `out_of_memory`, `shopify`,
  `access`, `unreadable`, `too_large` or `unknown`.
- Where the worker knows the cause: `source_deleted`, `no_source_file`, `source_not_ready`,
  `source_download_failed`, `backup_missing`, `no_output`, `changed_in_shopify`, `crashed`,
  `task_failed` or `in_another_job`.

Apply failures are prefixed `apply_` and restore failures `restore_`.

### Idempotency

- **New job form:** one key per visit, sent with the form. **API:** the `Idempotency-Key`
  header, required, at most 200 characters.
  - Keys are unique per shop (`Job.requestKey`). A replay returns the first job, with 200 and
    `Idempotent-Replayed: true`, whatever its body says.
- Start, apply, retry, cancel and finish are compare-and-set writes on the job status.
  - Start and retry also run under the shop's row lock.
  - A second click fails with 409 ("This job changed meanwhile") or does nothing.
- Other safeguards:
  - Image tasks have deterministic ids (`<kind>-<itemId>-<attempts>`).
  - Each image is charged at most once (ledger key `apply:<itemId>`).
  - An image with an identical earlier result reuses it instead of calling the image service.

### Cancellation

- **Reading, estimated or processing → cancelled.** Queued images are never picked up.
  Images already at the image service finish (their previews are kept, but the job stays
  closed). The job's reservation is released.
- **Applying → "Stop applying".** The job goes back to review. Writes that are already under
  way finish and are charged. The rest stay approved, so Apply can resume.
- **Review** closes with Finish. Done, failed and cancelled jobs can't be cancelled (409).

### API

Resource routes under `/api/image-jobs`, authenticated with a Shopify session token
(`Authorization: Bearer <token>`). Inside the embedded app, App Bridge adds the token to
same-origin `fetch`. Details:

- Without the header, the API answers 401 JSON.
- Everything is scoped to the token's shop, and responses are `Cache-Control: no-store`.
- Errors are `{error}` JSON: 400 for validation (with `issues`), 402 `{needed, available}`
  when credits are short, 404 for a job that isn't found or belongs to another shop, 405,
  409 when the job's state doesn't allow the request, and 413 for a body over 1 MB.

| Method and path | Body / query | Answer |
| --- | --- | --- |
| `POST /api/image-jobs/bulk` | Header `Idempotency-Key`. `{productIds: string[]` (numeric or `gid://shopify/Product/…`, required), `mediaIds?: string[]` (MediaImage gids; alias `imageIds`), `imageScope?: "first" \| "all"` (default first), `preset?:` partial preset, `autoStart?: boolean` (default true)`}` | 202 `{jobId, status: "queued", total}`. `total` is null until the products are read when it can't be known up front. A replay gets 200 with the same body. |
| `GET /api/image-jobs/:jobId` | | `{id, status, phase, total, completed, failed, processing, queued, remaining, progress, etaSeconds, createdAt, startedAt, completedAt, updatedAt, needsAction, notice, waitingForEarlierJob, selection, reviewUrl}` |
| `GET /api/image-jobs/:jobId/items` | `?status=` (queued, processing, completed, failed, or an internal status such as ready, flagged, unchanged, approved, applied; or a comma-separated list of up to 20, their union, e.g. `completed,failed`), `&sort=` (`product`, the default: by product title then image position; or `recent`: last changed first), `&include=active`, `&page=1&limit=50` (max 100). 400 for an unknown status, sort or include. | `{items: [{id, bulkJobId, productId, productTitle, mediaId, position, status, reviewStatus, finalStatus, route, reasonCodes, strongerModel, attemptCount, processingMethod, errorCode, errorMessage, sourceImageUrl, thumbnailUrl, outputImageUrl, flags, durationMs, updatedAt}], page, pages, total, limit}`. `finalStatus` is READY, NEEDS_REVIEW, FAILED or NO_CHANGE (null while queued or processing); `route` what produced the result (no_change, deterministic, local, replicate, local_then_replicate, reused). `thumbnailUrl` is the original at 400 px wide on Shopify's CDN, or null when the original isn't on it. With `include=active`, also `active`: the images in flight (claimed for processing, whatever `status` and `page` say), at most 12, longest-running first, without the ones waiting out an automatic retry. |
| `POST /api/image-jobs/:jobId/retry-failed` | `{itemIds?: string[]}` (all failed images when omitted) | `{retried, skipped, status, phase}` |
| `POST /api/image-jobs/:jobId/retry-stronger` | `{itemIds: string[]}` (required; ready, flagged or unchanged images of a job in review) | `{retried, skipped, status, phase}`. 409 when the job isn't in review, 402 when an already clean image can't be reserved again. Others are ignored, so a repeat answers `retried: 0`. |
| `POST /api/image-jobs/:jobId/cancel` | | `{status, phase}` |

Selection is by product: a MediaImage has no link back to its product, and apply needs the
product and the image's position. `mediaIds` narrows the named products to exactly those
images. At most `MAX_ITEMS_PER_JOB` ids of each kind. `preset` overrides the shop's default
preset (`aspect`, `marginPct`, `removeBg`, `bgColor`, `upscale`, `upscaleThresholdPx`,
`targetPx`, `aiMetadata`).

```js
// In the embedded app (App Bridge adds the session token).
const res = await fetch("/api/image-jobs/bulk", {
  method: "POST",
  headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
  body: JSON.stringify({
    productIds: ["8123456789", "gid://shopify/Product/8123456790"],
    imageScope: "all",
    preset: { aspect: "4:5", removeBg: true },
  }),
});
const { jobId } = await res.json(); // 202 {"jobId":"cm…","status":"queued","total":null}
```

```bash
# Elsewhere: a session token from shopify.idToken() in the embedded app.
curl -X POST "$APP_URL/api/image-jobs/bulk" \
  -H "Authorization: Bearer $TOKEN" -H "Idempotency-Key: 5d0f6c1e-7d1b-4a5e-9d55-0c2f5c7b8a11" \
  -H "Content-Type: application/json" \
  -d '{"productIds":["8123456789"],"mediaIds":["gid://shopify/MediaImage/3012345678"]}'
curl -H "Authorization: Bearer $TOKEN" "$APP_URL/api/image-jobs/$JOB_ID"
# {"id":"…","status":"processing","phase":"processing","total":100,"completed":67,"failed":3,
#  "processing":2,"queued":28,"remaining":30,"progress":70,"etaSeconds":240,
#  "needsAction":null,"reviewUrl":"/app/jobs/…",…}
curl -H "Authorization: Bearer $TOKEN" "$APP_URL/api/image-jobs/$JOB_ID/items?status=failed&limit=100"
# The last 6 finished images and the ones in flight (what the job page's cleaning strip shows).
curl -H "Authorization: Bearer $TOKEN" \
  "$APP_URL/api/image-jobs/$JOB_ID/items?status=ready,flagged,unchanged,failed&sort=recent&limit=6&include=active"
curl -X POST -H "Authorization: Bearer $TOKEN" "$APP_URL/api/image-jobs/$JOB_ID/retry-failed"
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"itemIds":["cm…"]}' "$APP_URL/api/image-jobs/$JOB_ID/retry-stronger"
curl -X POST -H "Authorization: Bearer $TOKEN" "$APP_URL/api/image-jobs/$JOB_ID/cancel"
```

Poll `GET /api/image-jobs/:jobId` every few seconds while `status` is `queued` or
`processing` and `needsAction` is null. After that, the merchant has to act (start, buy
credits, review) or the job is closed.

### Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `WORKER_CONCURRENCY` | 8 | Image tasks one worker process runs at once. |
| `IMAGE_WORKER_CONCURRENCY` | unset | Alias of `WORKER_CONCURRENCY`; wins when set. |
| `SHOP_CONCURRENCY` | 3 | Images one shop can have in flight, so one catalog can't starve the others. |
| `ITEM_TASK_ATTEMPTS` | 5 | Tries per image before it fails (timeouts and out-of-memory: 2). |
| `ITEM_RETRY_BASE_MS` | 30000 | First retry delay; doubles each time. |
| `GPU_TIMEOUT_MS` | 180000 | How long the worker waits for one image, queueing included (480000 on the VPS). |
| `MAX_ITEMS_PER_JOB` | 5000 | Images one job can hold. The read stops there and the job says so. |
| `BULK_READ_THRESHOLD` | 250 | Above this many matching products, filters are read with a bulk operation. |
| `REVIEW_EXPIRY_DAYS` | 14 | Untouched reviews are closed and their reservation released. |
| `EMAIL_PROVIDER` | unset | Completion emails. No provider exists yet, so nothing is sent. |
| `METRICS_TOKEN` | unset | Bearer token for `GET /internal/metrics` (at least 16 characters). Unset: the endpoint answers 404. |
| `REPLICATE_AVG_CUTOUT_USD` | 0.0009 | Average paid cut-out cost for "estimated spend avoided" when the summarised records show no paid cut-out to average. |

Worker concurrency doesn't set throughput. The image service's `MAX_CONCURRENCY` (1 on the
VPS) and `SHOP_CONCURRENCY` do, and extra worker slots only wait on the service. Set
`ITEM_TASK_ATTEMPTS` and `ITEM_RETRY_BASE_MS` for both the app and the worker: both enqueue
image tasks.

### Running the worker

- **Locally:** run `npm run worker:dev` (`tsx watch` with `.env`) next to `npm run dev`. It
  needs the `docker-compose.dev.yml` services and an image service (see
  [Local development](#local-development)). Without a worker, new jobs stay in "reading".
- **Production:** the `worker` service in `docker-compose.vps.yml` runs `npm run worker` with
  `WORKER_CONCURRENCY=3`, `SHOP_CONCURRENCY=2` and `GPU_TIMEOUT_MS=480000`. It has a 3-minute
  stop grace period, so in-flight images can finish during a deploy.
- **Scaling:** run more worker containers (`--scale worker=N` with `docker-compose.yml`).
  Maintenance is a single BullMQ job scheduler, so it runs once a minute however many workers
  there are.

### Logs

One JSON line per event (`app/lib/log.server.ts`). `PROCESSING_SUCCESS` also carries
`route`, `gate`, `ai_gate`, `final_status`, `reason_codes`, `local_attempted`,
`local_accepted` and `replicate_attempts` when the image service reports them, and
`JOB_PROCESSING_SUMMARY` the cost dashboard's fields (below). Other events:

| Event | When | Main fields |
| --- | --- | --- |
| `BULK_JOB_CREATED` | A job was inserted (not on a replay) | `jobId`, `shopId`, `source` (ui or api), `selection`, `autoStart` |
| `IMAGE_JOB_STARTED` | A worker picked up an image task | `itemId`, `jobId`, `kind`, `claim`, `attempt` |
| `IMAGE_JOB_COMPLETED` | An image was processed, applied or restored | `durationMs`, `method`, `route`, `gate`, `ai_gate`, `final_status`, `reason_codes` (processing), `replicate_calls`, `estimated_usd`, `reused`, `attempt` |
| `IMAGE_JOB_FAILED` | Every failed attempt | `reason` (errorCode), `attempt`, `retryable`, `final` |
| `BULK_JOB_PROGRESS` | Each 10 % step of a phase | `phase`, `total`, `completed`, `failed`, `remaining`, `progress`, `etaSeconds` |
| `BULK_JOB_COMPLETED` | Once per phase end | `phase`, `durationMs`, `avgMsPerImage`, `completed`, `failed`, `retries`, `methods`, `replicateCalls`, `estimatedUsd`, `finalStatuses`, `routes`, `localAccepted`, `sentToReplicate`, `noChange` |
| `RETRY_STRONGER` | "Retry with stronger model" sent images back | `jobId`, `retried`, `skipped`, `selected` |
| `NOTIFICATION_CREATED` | A notification row was created | `jobId`, `kind`, `tone` |

## Local development

Prerequisites: Node 22 (`.nvmrc`), Docker, Python 3.11 (GPU service), the
[Shopify CLI](https://shopify.dev/docs/apps/tools/cli) and a Partner account with a dev store.

```bash
nvm use
npm install
cp .env.example .env            # then switch the storage block to the commented MinIO values
docker compose -p vio-dev -f docker-compose.dev.yml up -d          # Postgres, Redis, MinIO
npx prisma migrate deploy

# GPU service (CPU "classic" backend, no ML models). Either in docker:
docker compose -p vio-dev -f docker-compose.dev.yml --profile gpu up -d   # → http://localhost:58000
#   (then set S3_GPU_ENDPOINT=http://minio:9000 so it can reach MinIO)
# …or natively, see gpu-service/README.md.

npm run worker:dev              # terminal 1
npm run dev                     # terminal 2: shopify app dev (tunnel, auth, env)
```

Dev ports are deliberately unusual (Postgres 55432, Redis 56379, MinIO 59000/59001, GPU
service 58000) so they don't clash with other projects.

`shopify app dev` asks you to link or create the app and fills in `client_id`. Install on
the dev store, open the app, create a job.

## Tests

```bash
npm test                                          # unit tests, no services
npx vitest run -c vitest.integration.config.ts    # needs docker-compose.dev.yml services
```

Integration tests use a separate Postgres schema (`vitest`) and Redis DB 15. The end-to-end
pipeline test (`tests/integration/pipeline-e2e.test.ts`) also needs the GPU service on
`http://127.0.0.1:58123` and skips itself otherwise:

```bash
cd gpu-service && MODEL_BACKEND=classic GPU_SERVICE_SECRET=test-gpu-secret ALLOW_HTTP_URLS=1 \
  .venv/bin/uvicorn app.main:app --port 58123
```

It runs read → backup → GPU processing → approve → in-place apply → restore, plus the
fallback path and the "no backup, no edit" rule, against real Postgres, Redis, MinIO and
the GPU service, with only Shopify mocked. It is also the only end-to-end check of the source
hash, the result key, the notifications and the `apply_backup_missing` path, so in CI set
`REQUIRE_GPU_E2E=1`: the suite then fails instead of skipping when the service isn't up.

GPU service tests: `cd gpu-service && .venv/bin/pytest`.

## Deployment

### Current production: shared VPS behind Caddy (`docker-compose.vps.yml`)

Live at **<https://images.qancha.live>** as the Shopify app "Padly" (App Store listing
"Padly: Bulk Background Remover", `shopify.app.production.toml`; the dev app is "Padly Dev"
in `shopify.app.toml`). The VPS (MVPS LTD, Netherlands) already runs other sites behind Caddy,
so this stack publishes only the web app on `127.0.0.1:3500` and Caddy proxies to it.
Everything else (worker, image service, Postgres, Redis, RustFS storage) stays on the internal
Docker network with per-container memory caps.

```bash
# from this repo on your Mac: ship code, rebuild, restart
# <deploy-key>, <user> and <server-ip> are your own (kept out of this public repo)
rsync -az --delete -e "ssh -i <deploy-key>" --exclude node_modules --exclude .git \
  --exclude '.env' --exclude '.env.*' --exclude build --exclude .react-router --exclude .shopify \
  --exclude 'gpu-service/.venv' ./ <user>@<server-ip>:/opt/visual-image-optimizer/
ssh -i <deploy-key> <user>@<server-ip> \
  'cd /opt/visual-image-optimizer && docker compose -f docker-compose.vps.yml up -d --build'
# Shopify config (app name, URLs, scopes, webhooks) for the production app:
npx shopify app deploy --config production --allow-updates
```

The server's `.env` (`/opt/visual-image-optimizer/.env`, mode 600) holds the production
Shopify keys and generated secrets.

**Caddy.** `deploy/Caddyfile.images` is the complete site block for images.qancha.live:
request body limits (13 MB for the try-it upload on `/try` and `/try.data`, 2 MB for everything
else, so no request can make the 512 MB app container buffer a huge body), HSTS, `nosniff`,
`Referrer-Policy`, no `Via` header, gzip. Its header lists the steps: back up
`/etc/caddy/Caddyfile`, diff the live site block against it and keep any extra directives
(`log`, `tls`), replace only that site block, `caddy validate`, `systemctl reload caddy`.
Don't add `X-Frame-Options` or a CSP in Caddy: the app sets `frame-ancestors` itself (the
shop's admin for embedded pages, `'none'` everywhere else). Don't add `trusted_proxies`
either without changing `clientIp()` in `app/lib/try.server.ts`: the try-it per-IP limit
relies on Caddy replacing `X-Forwarded-For` with the real client IP.

**Logs.** Every container uses Docker's json-file driver capped at 10 MB × 3 files
(`x-logging` in the compose file; it applies to containers created after the change, i.e. the
next `up -d`). Logs survive restarts but not a rebuild. The build cache grows with every
deploy: `docker builder prune --filter until=168h` now and then.

**Image models and processing cost.** The pipeline uses the cheapest safe method first and
pays for Replicate only when the free result isn't confidently good (quality > trust > data
safety > reliability > cost > speed; cost never overrides the first four):

| Step | Where it runs | Replicate? |
|------|---------------|------------|
| Analysis: does the photo already meet the preset? | Image service, deterministic; if so the source comes back unmodified (`NO_CHANGE`, never applied or charged) | Never |
| Decode, EXIF/ICC, canvas, aspect, padding, centring, resizing, JPEG/PNG/WebP export | Image service (Pillow/OpenCV), deterministic | Never |
| Product box for centring | From the cut-out, or the background colour when the background is kept | Never |
| Background removal | BiRefNet-lite on the VPS CPU (~6–9 s), zoomed in for small products, re-run mirrored as a stability check | Unless the quality gate says `SAFE_LOCAL` (below) |
| AI upscaling (opt-in) | Real-ESRGAN ×2 on the CPU for inputs ≤ 0.25 MP | Everything bigger (CPU ×4 takes minutes) |
| Text/labels during upscaling | Lanczos + light sharpening, deterministic | Never |

**The quality gate.** Each local cut-out is judged `SAFE_LOCAL` (every check passed with
margin and a second opinion, the same model on the photo padded to a square, reproduces it),
`UNCERTAIN` (passed, but a measurement is within 70% of its limit, fine structure like spokes
or lace, or the second opinion disagrees) or `FAILED` (nothing found, undecided edges, a label
cut through, a dropped part, or a cut-out that changes when the photo is mirrored). Only `SAFE_LOCAL` skips Replicate; if uncertain, escalate.
Replicate's full BiRefNet result is checked the same way (`ai_gate` `PASS` / `UNSAFE`); an
unsafe one is retried once on a zoomed crop. An image is `READY` only when nothing is flagged,
the kept cut-out passed with margin, an independent model agrees with it, and the background
is plain (in busy scenes both models often keep a prop or a shadow as the product); otherwise
it is `NEEDS_REVIEW` with a flag saying why, and only `READY` images can be bulk-approved.
Measured on 117 hand-graded eval photos (gpu-service/eval): see the eval report. Rollout:
`GPU_LOCAL_PROCESSING_ENABLED` (kill switch), `GPU_LOCAL_PROCESSING_PERCENTAGE` and
`GPU_LOCAL_PROCESSING_SHADOW` (judge local, always use Replicate's result) in the server
`.env`. Details: docs/gpu-service-contract.md "Routing and the quality gate"; the offline
evaluation set and its report: gpu-service/eval. Output checks (aspect, size, centring,
margins, nothing cut off, never enlarged by interpolation) run on every image. Measured
Replicate cost: BiRefNet ≈ $0.0003–0.0015 per call (0.2–1.0 s on an A100), Real-ESRGAN ≈
$0.003–0.011 per upscale (price assumed A100; set `REPLICATE_ESRGAN_USD_PER_S` if the model
page says otherwise).

Server `.env`: `GPU_MODEL_BACKEND=local`, `GPU_ESCALATION_BACKEND=replicate`,
`GPU_FALLBACK_BACKEND=none` (optional `GPU_ESCALATION_DAILY_MAX_CALLS` caps paid calls per
day). After a failed Replicate call (no credit, outage, slower than `REPLICATE_TIMEOUT_S`)
Replicate is skipped for 2 minutes and images keep their local result; nothing fails because
of Replicate. The gpu-service `/healthz` shows `"backend":"local","escalation_backend":"replicate"`.

**Measuring it.** Every image stores how it was made on its job item (`JobItem.processing`:
method, Replicate calls and models, estimated USD, fallback reason, quality score and checks,
each attempt with its duration). Logs: the gpu-service writes `IMAGE_PROCESSING` per attempt,
`AI_FALLBACK` / `AI_FALLBACK_SKIPPED`, `REPLICATE_CALL` (model, predict time, USD) and
`PROCESSING_COST` / `PROCESSING_SUCCESS` / `PROCESSING_FAILURE`; the worker writes
`PROCESSING_SUCCESS` / `PROCESSING_FAILURE` per item and one `JOB_PROCESSING_SUMMARY` per
processing phase (again after "Retry failed"), plus the bulk-job events listed under
[Bulk jobs](#bulk-jobs); try-it writes `TRY_PROCESSING`. The report:

```bash
docker compose -f docker-compose.vps.yml exec worker npm run report:processing -- --days 7
#   options: --shop <domain>  --job <id>  --json
docker compose -f docker-compose.vps.yml logs --since 24h gpu-service | grep -E 'AI_FALLBACK|REPLICATE_CALL'
```

It prints images, the share that used Replicate, calls, estimated USD (total and per image),
average duration and quality, failures, the method mix, and why Replicate was used, overall,
per day and for the latest jobs, plus the cost dashboard (`summarizeProcessing` in
app/lib/processing.ts):

| Line | Meaning |
|------|---------|
| Images analyzed | Items with a processing record from the image service (reused copies counted apart) |
| No processing required | Final status `NO_CHANGE` (already clean) |
| Local attempted / accepted / rejected | A local AI step ran / its result was kept with gate `SAFE_LOCAL` (route `local`) / its gate said `UNCERTAIN` or `FAILED`; "safe but paid result used" is shadow mode, rollout or a merchant's stronger-model retry |
| Sent to Replicate, passed / rejected | Images with a paid attempt; `ai_gate` `PASS` / `UNSAFE` |
| Local acceptance rate, Replicate usage | accepted ÷ attempted; sent to Replicate ÷ analyzed |
| Avg Replicate cost / image | Estimated USD per image that used Replicate |
| Total estimated cost | All estimated USD, runs replaced by "Retry with stronger model" included |
| Estimated spend avoided | (local accepted + no change) × the average paid cut-out cost observed (else `REPLICATE_AVG_CUTOUT_USD`, default $0.0009): an estimate, not a measurement |
| Top reason codes, final status breakdown, reused, shadow stats | Reason codes counted once per image; READY / NEEDS_REVIEW / NO_CHANGE / FAILED; results copied from an identical earlier one; shadow-mode images, how often local would have been used, mean IoU local vs final |

Records from before these fields existed are mapped from their method and attempts (route
from method; local accepted = local kept without escalation). The same summary, overall and
per UTC day, is served as JSON for a future dashboard:

```bash
curl -H "Authorization: Bearer $METRICS_TOKEN" "https://images.qancha.live/internal/metrics?days=7"
# {"since":"…","days":7,"generatedAt":"…","overall":{"analyzed":…,"localAccepted":…,…},"byDay":[…]}
```

`METRICS_TOKEN` unset → 404; a missing or wrong token → 401; `days` from 1 to 90.

The worker waits up to 8 min per image, queueing included (`GPU_TIMEOUT_MS`, 480000 in the
compose file), and a request whose caller already gave up is dropped instead of taking the
only slot (`MAX_CONCURRENCY=1`). A run the worker gave up on isn't cancelled in the service,
so a timed-out image is tried at most twice, not `ITEM_TASK_ATTEMPTS` times. The compose file also caps what one image can cost (30 MP
sources, 16 MP working size, 128 px upscale tiles) so the 2 GB container isn't OOM-killed.
Keep credit on the Replicate account: below $5 it throttles to 6 predictions a minute (the
service waits and retries).

**Landing page "Try it":** free single-photo previews, `TRY_DAILY_LIMIT` per visitor per day
(default 3) and `TRY_GLOBAL_DAILY_LIMIT` across all visitors (default 300); uploads are
deleted after 24 h by worker maintenance. Only one try runs at a time across all visitors
(others get "busy, try again in a minute"), photos over 12 megapixels are refused by their
header (the page shrinks bigger photos in the browser before uploading), and a visitor gets at
most 2 refunds a day for our own errors. Owner mode: open `/try/unlock` and enter
`TRY_OWNER_TOKEN` in the form (it is sent in the POST body, never in a URL); it sets a cookie
that lifts the per-visitor limit in that browser. Change the token in the server `.env` to
revoke it. `DONATE_URL` shows the donate band (unset in production). Waitlist emails are
deleted after 12 months by worker maintenance.

Storage is RustFS (S3-compatible; MinIO no longer publishes images) until Cloudflare R2 is set up.

### Backups (VPS)

`scripts/backup.sh` runs nightly from a systemd timer (`deploy/systemd/vio-backup.timer`, ~03:17 UTC; the host has no cron) and keeps, on the server:

- `/var/backups/vio/db/db-YYYYmmdd-HHMM.dump`: `pg_dump -Fc` (UTC time), mode 600, checked
  with `pg_restore --list`, kept 14 days.
- `/var/backups/vio/storage/vio-images/`: a mirror of the object store (originals, outputs,
  previews), without the try-it uploads (`public/try/`, which are deleted after 24 h anyway).
- `/var/backups/vio/storage/.deleted/YYYYmmdd/`: what that night's run dropped from the
  mirror because it was erased or overwritten in the bucket, kept 13 days. So a lost and
  recreated storage volume, or an app bug that deletes the wrong objects, can't take the
  only copy with it.

Safety checks: the script refuses to sync when the bucket is empty but the mirror isn't. It
stops with an error after `BACKUP_MAX_DELETE` deletions in one run (default: half the
mirror, at least 100). It also stops when less than 5 GB (`MIN_FREE_GB`) would be left on the
disk, which also holds the Docker volumes. Expired files are pruned first, so retention holds
even on nights when a later step fails. An erased object leaves the mirror on the next
nightly run and `.deleted` 13 days later, and dumps go after 14 days, so backup copies of
erased shop data are gone within 14 days of erasure (the privacy policy relies on this).
That holds only while the nightly runs succeed, so check the log. The script prints one line
per run and exits non-zero on any failure.

If a legitimate large erasure (a big shop's `shop/redact`) hits the delete limit, check that
the bucket is intact (the app loads recent previews) and run once with a higher limit:
`BACKUP_MAX_DELETE=100000 /opt/visual-image-optimizer/scripts/backup.sh`.

```bash
# on the VPS, once (installed 2026-09-27)
chmod +x /opt/visual-image-optimizer/scripts/backup.sh
cp /opt/visual-image-optimizer/deploy/systemd/vio-backup.{service,timer} /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now vio-backup.timer
/opt/visual-image-optimizer/scripts/backup.sh     # first run by hand; check the "ok" line
systemctl list-timers vio-backup.timer           # next run
tail -n 5 /var/log/vio-backup.log                # later: one line per night
```

**Off-host copy.** Both copies above live on the same disk as the data, so they protect
against mistakes and a broken database, not against losing the server. For that, create a
bucket on Cloudflare R2 or Backblaze B2, define an rclone remote for it in
`/root/.config/rclone/rclone.conf` (preferably wrapped in an rclone `crypt` remote so the copy
is encrypted), and set `RCLONE_REMOTE=<remote>:<path>` for the service (`systemctl edit vio-backup.service`,
then `[Service]` / `Environment=RCLONE_REMOTE=vio-offsite:vio`). The script then syncs `db/` and
`storage/` (the mirror and `.deleted`) there with the same 14-day policy, also after a failed
run, so the prune reaches the remote too. Don't enable object versioning on that bucket
(or expire old versions within 14 days; B2 keeps them by default), or erased data lingers.

**Restore the database.** Check a dump in a scratch database first:

```bash
cd /opt/visual-image-optimizer
C="docker compose -f docker-compose.vps.yml"
$C exec -T postgres createdb -U vio vio_restore
$C exec -T postgres pg_restore -U vio -d vio_restore --no-owner < /var/backups/vio/db/db-YYYYmmdd-HHMM.dump
$C exec -T postgres psql -U vio -d vio_restore -c 'select count(*) from "Shop";'
$C exec -T postgres dropdb -U vio vio_restore
```

To replace production with a dump: `$C stop app worker`, then
`$C exec -T postgres pg_restore -U vio -d vio --clean --if-exists --no-owner < <dump>`,
then `$C up -d`. A dump can bring back shops that uninstalled or were erased after it was
taken: check the app and worker logs since the dump's time (`shop purged`, `app/uninstalled`)
and erase those shops again.

**Restore images.** `scripts/backup.sh restore-storage` copies the mirror back into the bucket
(it adds missing or changed objects and never deletes). `restore-storage YYYYmmdd` copies
one day of `.deleted` back, and `restore-storage YYYYmmdd shops/<shop id>/` only one shop's
objects (the id is `Shop.id` in the database). After a lost storage volume, restore the
mirror, then every `.deleted` day since the loss (a run that hit the delete limit moved part
of the mirror there). A day of `.deleted` also holds shops that were erased on purpose, so
restore per shop where you can and don't bring an erased shop back. With an off-host copy
only, first bring it back with `rclone copy <remote>:<path>/storage /var/backups/vio/storage`.

### Dedicated server (`docker-compose.yml`)

**VPS (app, workers, Postgres, Redis, Nginx):**

```bash
cp .env.example .env     # production values, BILLING_TEST=false, R2 credentials, GPU URL
docker compose up -d --build
docker compose up -d --scale worker=3
```

**TLS.** nginx needs the certificate before it can start, so issue the first one in
standalone mode (nothing may be listening on :80 yet), then renew through the webroot
that nginx serves:

```bash
sudo certbot certonly --standalone -d "$APP_DOMAIN"            # once, before the first `up`
sudo mkdir -p /var/www/certbot
# renewal (certbot's timer), reloading nginx afterwards:
sudo certbot renew --webroot -w /var/www/certbot \
  --deploy-hook "docker compose -f $PWD/docker-compose.yml exec nginx nginx -s reload"
```

The web container runs `prisma migrate deploy` on start; workers wait for it to be healthy.
`/healthz` is the liveness endpoint.

**Cloudflare R2:** create a bucket and an API token with object read/write. Backups live under
`shops/<id>/backups/` and must not have a lifecycle rule. Job artifacts
(`shops/<id>/jobs/`) can expire after ~90 days if you want to save space.

**GPU service:** `modal deploy gpu-service/modal_app.py` (or the CUDA `Dockerfile` on
RunPod / any GPU host), then set `GPU_SERVICE_URL` and the same `GPU_SERVICE_SECRET` on both
sides. For the first 50–100 merchants you can run the service on CPU with
`MODEL_BACKEND=replicate` instead of hosting GPUs.

**Shopify:** `shopify app deploy` pushes `shopify.app.toml` (scopes, webhooks, compliance
topics). Webhook API version is `2026-07`.

## Shopify App Store

Everything for the listing and the review lives in `docs/app-store/`:

- `listing.md`: the listing copy (name, subtitle, description, features, pricing), ready to
  paste into the Partner Dashboard.
- `submission-checklist.md`: what to set and verify before pressing Submit (Partner
  Dashboard pricing, billing test, payouts, config deploy).
- `reviewer-instructions.md`: the testing instructions for Shopify's reviewer.
- `screencast-script.md` and `screenshots.md`: what to record and capture.
- `incident-response.md`: breach and outage steps (Shopify expects notice within 24 h).

Brand assets are in `public/brand/` (`icon.svg`, `icon-1200.png` for the listing icon,
`feature-1600x900.png`, `og-1200x630.png`), plus `public/favicon.ico` and
`public/apple-touch-icon.png`. Their render sources are `docs/app-store/brand-src/*.html`.
`scripts/listing-screenshot.py` fits raw screenshots onto exact 1600 × 900 canvases; run it
with `gpu-service/.venv/bin/python` (it needs Pillow).

The public legal and help pages are `/privacy`, `/terms` and `/support` (`app/lib/brand.ts`
has the paths, the support email and the site URL; shared promises such as the erasure window
are in `app/components/legal/copy.ts`).

## Before launch: things to verify on a real dev store

The code follows the current docs, but these depend on Shopify behaviour that only the
2-day spike can confirm:

- [ ] `fileUpdate` keeps gallery position, alt text and variant links across 50 real
      products (JPG, PNG, WebP originals).
- [ ] How long the storefront CDN shows the old image after a replace (the UI warns about it).
- [ ] The fallback path on a product with variant images.
- [ ] `productVendors` / `productTypes` in the picker (the picker falls back to text fields
      if they fail).
- [ ] BiRefNet cut-out quality on 50 real supplier images (target ≥90% usable) and the flag
      thresholds (`gpu-service/README.md`).
- [ ] GPU cold-start and per-image timing on Modal; tune `GPU_TIMEOUT_MS` and
      `min_containers`.
- [ ] Billing approval flow and the `app_purchases_one_time/update` webhook in test mode
      (steps in `docs/app-store/submission-checklist.md`).
- [ ] Shopify's revenue share and that Partner payouts reach your country (payout and tax
      setup in `docs/app-store/submission-checklist.md`).

## Known limitations / v1.1

- Auto-process new products (`products/update` + subscription), marketplace presets,
  transparent PNG output, saved presets per store: not in v1 (see the plan).
- If a worker crashes midway through the *fallback* apply (after attaching the new image,
  before detaching the old), a retry can attach a second copy. In-place replacement, the
  normal path, is idempotent.
- Uninstall: backups are kept until `shop/redact` (48 h after uninstall) or at the latest 25
  days after uninstall, then everything for the shop is deleted from Postgres and storage.
  If `shop/redact` arrives for a shop we think is installed, the worker asks Shopify (a
  one-point `{ shop { id } }` query with the shop's token) and erases it if the token is
  refused; shops with no token activity for 3 days get the same check, so a lost
  `app/uninstalled` still ends in erasure within 30 days. A `shop/redact` for a store that
  has reinstalled is recorded but not executed; maintenance retries purges hourly until the
  data is gone.
- Webhooks verify the HMAC themselves (`app/lib/webhooks.server.ts`) instead of using
  `authenticate.webhook`, which refreshes expired offline tokens first and answers 500
  after an uninstall, when the refresh can never succeed.
- Free credits are granted per Shop row, so a store that uninstalls, is erased by
  `shop/redact` and reinstalls gets them again.
