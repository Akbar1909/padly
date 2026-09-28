# Padly: GPU service

A stateless Python service that cleans up product photos for the Shopify app. It removes
backgrounds, pads the image onto a square or 4:5 canvas and can run AI upscaling. It
implements the HTTP contract in [`../docs/gpu-service-contract.md`](../docs/gpu-service-contract.md).
The Node worker sends a presigned GET URL for the original and presigned PUT URLs for the
four artifacts (`output`, `preview`, `before`, `mask`). The service never holds storage
credentials.

## What happens to an image

1. **Download and normalise.** The source is streamed in with a size cap. The format is
   sniffed from the bytes (the declared MIME type is ignored) and the image is decoded with
   Pillow. The pipeline applies the EXIF orientation and converts to sRGB with the embedded
   ICC profile (CMYK, P, LA, RGBA and 16-bit are all handled). Transparency is flattened
   onto white. When the alpha channel really cuts the image out (at least 1% of pixels
   transparent), it is used directly as the mask. Animated images, non-images and truncated
   files are rejected. Decompression bombs are refused.
2. **Upscale.** This step runs only when `settings.upscale` is set and the short side is
   below `upscale_threshold_px`. The service estimates the product box, computes the scale
   needed to fill the target canvas and chooses AI ×2 when that scale is at most 2, otherwise
   ×4. Before any AI model runs, a text detector (OpenCV EAST, or an MSER heuristic when the
   model file is missing) checks for text. If it finds any, the image is enlarged with
   Lanczos and a light sharpen instead, so labels aren't hallucinated. After upscaling, the
   result is shrunk back to the original size and compared with it (SSIM on luminance,
   CIEDE2000 on lightly blurred images).
3. **Cut-out** (only when `remove_bg` is set). The segmentation mask is produced at model
   resolution, resized to the image with bicubic interpolation and lightly feathered.
4. **Bbox and mask metrics.** Components smaller than 0.5% of the largest are ignored and
   erased. The step computes coverage, the number of significant fragments and edge
   uncertainty (the share of pixels with 0.2 < p < 0.8, measured on the model-resolution
   mask).
5. **Canvas.** The canvas is 1:1 or 4:5, with a content area of canvas × (1 − 2·margin).
   The product is fitted to the content area and centred. It is padded, never cropped. The
   product is never enlarged by plain interpolation: if it can't fill `target_px` at native
   (or upscaled) resolution, the canvas shrinks proportionally instead, keeping aspect and
   margin exact. The canvas is capped at 20 MP.
6. **Background.** With `remove_bg`, the product is alpha-composited onto `bg_color`.
   Without it, nothing is cut out. On a near-uniform border, the canvas is framed on the
   product bbox and the original background fades smoothly into the median edge colour.
   Otherwise the whole image is the product box, padded with the median edge colour.
7. **Export** as JPEG (progressive, 4:4:4 while it fits), PNG (optimised) or WebP q90. The
   file carries an sRGB ICC profile and no EXIF, and stays within 20 MP and 20 MB (quality,
   then size, steps down if needed). When AI upscaling ran and `ai_metadata` is true, an XMP
   packet with `Iptc4xmpExt:DigitalSourceType = compositeWithTrainedAlgorithmicMedia` is
   embedded. For JPEG it is written as an APP1 segment directly after SOI and JFIF APP0.
8. **Checks and previews.** Product colour drift is the CIEDE2000 distance between the mean
   Lab colour of confident product pixels (p > 0.9) in the original and in the output. The
   service builds the preview, before and mask artifacts and PUTs all four with the exact
   headers from the request, retrying on 5xx and network errors.

CPU- and GPU-heavy work runs in a worker thread behind an `asyncio.Semaphore`
(`MAX_CONCURRENCY`). Downloads and uploads stay async on the event loop. A started run can't
be cancelled, but when the caller has disconnected by the time a request gets the semaphore
(the worker's `GPU_TIMEOUT_MS` ran out while it queued), the request is dropped with a
`client_gone` log line instead of running.

### Contract notes (details the contract leaves open)

| Topic | Behaviour |
|---|---|
| Flag severities | `mask_empty` is `error`. `text_detected` is `info` (it's an intentional fallback). Every other flag is `warning`. |
| `metrics.mask_*` when `remove_bg` is false | `null`, because no cut-out was made and mask flags are not computed. |
| `models.segmentation` | The backend's model id, even when no cut-out ran. It is `source-alpha` when the source's own transparency was used as the mask. |
| `models.upscaler` | `RealESRGAN_x2plus` / `RealESRGAN_x4plus` (local), `RealESRGAN@replicate:<version>`, `lanczos` (text fallback or classic backend), `null` when nothing was upscaled. |
| `upscale_capped` | Raised when upscaling was wanted (eligible and the product needed enlarging) but the final canvas is still smaller than `target_px`. |
| `upscale.scale` | The actual size factor applied (2.0 / 4.0, a fractional value for the Lanczos text fallback, 1.0 for `none`). |
| No product found with `remove_bg` | `mask_empty` is flagged. The image is kept rather than returning an empty canvas, and the `mask` artifact is blank. |
| Previews | `preview` and `before` are resized to exactly 640 px on the long side (small images are enlarged). |
| Error statuses | `unauthorized` 401, `invalid_settings` 400 (includes malformed JSON and disallowed URLs), `unsupported_image` 415, `image_too_large` 413, `source_download_failed` 400 for a storage 4xx and 502 for a storage 5xx or network error, `upload_failed` 502, `model_backend_failed` 502, `out_of_memory` 503, `internal` 500. |
| `/healthz` | Also returns `text_detector` (`opencv-east` or `mser-heuristic`). |

## Configuration

Every setting is an environment variable.

| Variable | Default | Description |
|---|---|---|
| `MODEL_BACKEND` | `classic` | `local` (GPU models), `replicate` (Replicate API) or `classic` (no ML, dev/CI). The Docker GPU image sets `local`. |
| `DEVICE` | `auto` | `auto` tries cuda, then mps, then cpu. `cuda`, `mps` or `cpu` forces a device (local backend). |
| `MAX_CONCURRENCY` | `2` | Concurrent pipeline runs (the GPU semaphore). |
| `GPU_SERVICE_SECRET` | none | HMAC secret shared with the worker. **Required** unless `ALLOW_UNSIGNED=1`. |
| `ALLOW_UNSIGNED` | `0` | Local testing: accept requests without `X-Signature`. A header that is present is still verified when a secret is set. |
| `SIGNATURE_TOLERANCE_S` | `300` | Maximum allowed clock difference for the signature timestamp. |
| `ALLOW_HTTP_URLS` | `0` | Allow `http://` source and upload URLs (for example MinIO in dev). Otherwise only https is accepted. |
| `ALLOWED_URL_HOSTS` | empty | Comma-separated host suffixes allowed for all URLs, e.g. `r2.cloudflarestorage.com,amazonaws.com`. Empty allows any host. |
| `MAX_SOURCE_BYTES` | `62914560` (60 MB) | Download cap. Larger sources get `image_too_large`. |
| `MAX_SOURCE_PIXELS` | `120000000` | Decoded pixel cap (decompression-bomb guard), checked from the header before decoding. Larger images get `image_too_large`. Decoding a transparent PNG peaks at about 15 bytes per source pixel (JPEGs are decoded at 1/2, 1/4 or 1/8 scale when that still covers `MAX_WORKING_PIXELS`), so size it to the container: the CPU VPS uses `30000000`. |
| `MAX_WORKING_PIXELS` | `50000000` | Larger sources are downscaled to this before processing. It also caps the size after upscaling. The CPU VPS uses `16000000`. |
| `MAX_OUTPUT_PIXELS` | `20000000` | Output canvas pixel cap (20 MP). |
| `MAX_OUTPUT_BYTES` | `20971520` (20 MB) | Output file size cap. |
| `HTTP_TIMEOUT_S` | `60` | Download and upload timeout. |
| `HTTP_RETRIES` | `3` | Attempts for downloads and uploads on 5xx or network errors. |
| `MODELS_DIR` | `/models` | Base directory for model files. |
| `BIREFNET_MODEL_ID` | `ZhengPeng7/BiRefNet` | Hugging Face repo for segmentation. |
| `BIREFNET_REVISION` | `main` | Hugging Face revision. **Pin a commit in production.** The resolved commit is reported in `models.segmentation`. |
| `BIREFNET_INPUT_SIZE` | `1024` | BiRefNet input resolution. |
| `REALESRGAN_X2_PATH` | `$MODELS_DIR/RealESRGAN_x2plus.pth` | Real-ESRGAN ×2 weights. |
| `REALESRGAN_X4_PATH` | `$MODELS_DIR/RealESRGAN_x4plus.pth` | Real-ESRGAN ×4 weights. |
| `UPSCALE_TILE_SIZE` | `512` | Real-ESRGAN input tile size in px. `0` disables tiling. On CPU use `128`: at ×4 a 512 px tile needs several GB. |
| `UPSCALE_TILE_PAD` | `32` | Tile overlap in px (avoids seams). `16` with 128 px tiles. |
| `LOCAL_MAX_AI_SCALE` | `4` | Largest AI upscale factor (`2` or `4`) when the local models run on CPU. Real-ESRGAN ×4 takes minutes per photo there, so the CPU VPS uses `2`; products that need more get ×2 and `upscale_capped`. GPUs and Replicate always allow ×4. |
| `LOCAL_MAX_AI_UPSCALE_PIXELS` | `0` (no limit) | Largest source, in pixels, that gets AI upscaling when the local models run on CPU; larger ones take the Lanczos path (`applied: false`). The CPU VPS uses `2000000`. |
| `EAST_MODEL_PATH` | `$MODELS_DIR/frozen_east_text_detection.pb` | OpenCV EAST model. If it is missing, the MSER heuristic is used. |
| `TEXT_MIN_CONFIDENCE` | `0.5` | EAST score threshold. |
| `REPLICATE_API_TOKEN` | none | Required for `MODEL_BACKEND=replicate`. |
| `REPLICATE_BIREFNET_VERSION` | `men1scus/birefnet` `f74986db…` | Replicate version id of a BiRefNet model (verified 2026-09-26). |
| `REPLICATE_ESRGAN_VERSION` | `nightmareai/real-esrgan` `b3ef1941…` | Replicate version id of a Real-ESRGAN model (verified 2026-09-26). |
| `REPLICATE_TIMEOUT_S` | `180` | Per-prediction deadline. |
| `MASK_EMPTY_MAX` | `0.02` | `mask_empty` when coverage is below this. |
| `MASK_FULL_MIN` | `0.95` | `mask_full` when coverage is above this. |
| `MASK_FRAGMENTS_MAX` | `3` | `mask_fragmented` when significant fragments exceed this. |
| `MASK_UNCERTAINTY_MAX` | `0.08` | `mask_low_confidence` when uncertainty is above this. |
| `MASK_MIN_FRAGMENT_FRAC` | `0.005` | Components smaller than this fraction of the largest are ignored (bbox and count) and erased. |
| `FIDELITY_SSIM_MIN` | `0.85` | `fidelity_low` when SSIM is below this... |
| `FIDELITY_DELTA_E_MAX` | `6` | ...or mean ΔE is above this. |
| `COLOR_DRIFT_DELTA_E_MAX` | `5` | `color_drift` when the product-region ΔE is above this. |
| `ESCALATION_BACKEND` | `none` | `replicate`: a local cut-out that fails its quality checks (below), or AI upscaling too big for the local CPU, is re-done once on Replicate and the better result is kept. `none` never pays for AI. After a failed paid call it is skipped for `FALLBACK_COOLDOWN_S` (`120`). |
| `ESCALATION_DAILY_MAX_CALLS` | `0` (no cap) | Paid calls per UTC day; past it, results stay local and keep their flags. |
| `ESCALATE_MASK_UNCERTAINTY` | `0.035` | Escalate (`background_artifacts`) when more of the frame than this has undecided mask pixels. Stricter than `MASK_UNCERTAINTY_MAX`. |
| `ESCALATE_TEXT_COVERAGE_MIN` | `0.85` | Escalate (`text_or_logo_cut`) when a text box on a solid part of the product keeps 25% to this share of its area. |
| `ESCALATE_DROPPED_PARTS_MAX` | `0.01` | Escalate (`dropped_inner_part`) when more of the product than this is in enclosed holes that are neither background nor the product's surroundings. |
| `ESCALATE_FLIP_DISAGREEMENT` | `0.015` | Escalate (`unstable_cutout`) when more of the cut-out than this changes when the local model sees the mirrored photo. Runs the model a second time per attempt (about +85% segmentation time on CPU). Calibrated for BiRefNet-lite at 512 px; set `0` (off) or recalibrate for another model or input size. |
| `LOCAL_PROCESSING_ENABLED` | `true` | Kill switch: `false` sends every cut-out (and AI upscale) to `ESCALATION_BACKEND` first; a local fallback is then never `READY`. |
| `LOCAL_PROCESSING_PERCENTAGE` | `100` | Share of photos (by source hash, stable per photo) tried locally first; the rest go to the escalation backend first (`ROLLOUT_NOT_LOCAL`). |
| `LOCAL_PROCESSING_SHADOW` | `false` | Make and judge the local cut-out, but always use the escalation backend's (`processing.shadow` compares them). Costs as much as escalation-only. |
| `NO_CHANGE_DETECTION` | `true` | Return a photo that already meets the request unmodified (`final_status` `NO_CHANGE`, no model runs). |
| `UNCERTAIN_BAND` | `0.7` | A local cut-out with any measurement at or above this share of its limit is `UNCERTAIN` and escalated (only `SAFE_LOCAL` skips the paid model). |
| `ESCALATE_RELATIVE_UNCERTAINTY` | `0.12` | `UNCERTAIN` (`fine_structure`) when undecided edge pixels are at least this share of the product's area. |
| `ESCALATION_MAX_ATTEMPTS` | `2` | Paid cut-outs per image: a failing one is retried once on a zoomed crop. `1` = no retry. |
| `LOCAL_SECOND_OPINION` | `letterbox` | Second opinion a local cut-out must agree with before it skips the paid model: `letterbox` (the photo padded to a square: one more inference next to the mirrored pass, same memory), `resolution` (the model at `LOCAL_VERIFY_INPUT_SIZE`, 768; too big for the 2 GB CPU VPS) or `off` (mirrored pass only). |
| `ESCALATE_VERIFY_MIN_IOU` | `0.98` | Agreement (IoU) the second opinion must reach, else `model_disagreement` → escalated. |
| `READY_MIN_AGREEMENT` | `0.98` | A paid cut-out is `READY` only if a local cut-out or the second opinion matches it this well. `0` = off. |
| `READY_REQUIRES_PLAIN_BACKGROUND` | `true` | `READY` only on plain backgrounds; busy scenes always go to review (props and shadows are often kept as the product). |
| `REFINE_SMALL_PRODUCT_FRAC` | `0.45` | A product whose long side is under this share of the photo is cut out again from a crop around it (free, local). `0` = off. |
| `LOG_LEVEL` | `INFO` | Logs go to stdout as JSON, one object per line, with `request_id`. |

The Docker images also set `HF_HOME=/models/hf`, `HF_HUB_OFFLINE=1` and
`TRANSFORMERS_OFFLINE=1`, so model weights come only from the image.

## Running locally (classic backend, no GPU)

```bash
cd gpu-service
python3.11 -m venv .venv
.venv/bin/pip install -r requirements.txt -r requirements-dev.txt
MODEL_BACKEND=classic ALLOW_UNSIGNED=1 ALLOW_HTTP_URLS=1 \
  .venv/bin/uvicorn app.main:app --port 8000
curl localhost:8000/healthz
```

For the EAST text detector locally, download the model and point `EAST_MODEL_PATH` at it.
Otherwise the MSER heuristic is used:

```bash
curl -L "https://www.dropbox.com/s/r2ingd0l3zt8hxs/frozen_east_text_detection.tar.gz?dl=1" | tar -xz -C /tmp
export EAST_MODEL_PATH=/tmp/frozen_east_text_detection.pb
```

### Signing a request

`X-Signature: t=<unix>,v1=hex(HMAC_SHA256(secret, "<t>.<raw body>"))`

```python
from app.security import sign

body = open("request.json", "rb").read()
print(sign("my-secret", body))  # → t=1700000000,v1=…
```

```ts
const t = Math.floor(Date.now() / 1000);
const v1 = crypto.createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex");
headers["X-Signature"] = `t=${t},v1=${v1}`;
```

## Tests

```bash
.venv/bin/python -m pytest
# Also exercise the real EAST model:
EAST_MODEL_PATH=/tmp/frozen_east_text_detection.pb .venv/bin/python -m pytest tests/test_text_detect.py
```

The suite runs on the `classic` backend without network access. It covers synthetic
products (off-centre, tall, text, EXIF-rotated, alpha PNG, CMYK and ICC-tagged JPEGs,
16-bit), canvas maths, mask metrics and flags, fidelity, colour drift, signatures and URL
policy. End-to-end `/v1/process` tests run against a local HTTP stub that serves the source
and records the PUTs. They check the response shape, headers, artifact formats and sizes,
retries and the error shapes. Torch is never imported.

## GPU Docker image

```bash
docker build -t vio-gpu-service --build-arg BIREFNET_REVISION=<commit-sha> .
docker run --gpus all -p 8000:8000 -e GPU_SERVICE_SECRET=... \
  -e ALLOWED_URL_HOSTS=r2.cloudflarestorage.com vio-gpu-service
```

The image is based on `nvidia/cuda:12.4.1-cudnn-runtime-ubuntu22.04` with Python 3.11, and
uses the torch 2.5.1 cu124 wheels from `requirements-gpu.txt`. The build downloads
BiRefNet (HF snapshot), `RealESRGAN_x2plus.pth` and `RealESRGAN_x4plus.pth` from the
official Real-ESRGAN releases, and the EAST model into `/models`, checking the sha256 of the
Real-ESRGAN and EAST files (`Dockerfile.cpu-ml` also checks every BiRefNet file). The
service runs as the non-root user `app` with uvicorn on port 8000. Models load once at
startup. Plan for about 1–2 min before `/healthz` answers.

`Dockerfile.cpu` is a slim image (`MODEL_BACKEND=classic` plus EAST) for docker-compose and
local dev:

```bash
docker build -f Dockerfile.cpu -t vio-gpu-service:cpu .
docker run -p 8000:8000 -e ALLOW_UNSIGNED=1 -e ALLOW_HTTP_URLS=1 vio-gpu-service:cpu
```

## Modal

`modal_app.py` serves the same FastAPI app with `@modal.asgi_app()` on a GPU. The weights
are baked into the image.

```bash
pip install modal && modal setup
modal secret create gpu-service-secret GPU_SERVICE_SECRET=... ALLOWED_URL_HOSTS=r2.cloudflarestorage.com
MODAL_GPU=L4 BIREFNET_REVISION=<commit-sha> modal deploy modal_app.py
```

To keep warm containers during busy hours, deploy with `MODAL_BUSY_HOURS_UTC=13-23`
`MODAL_BUSY_MIN_CONTAINERS=1` and `MODAL_MIN_CONTAINERS=0`. A cron function
(`adjust_warm_pool`, every 15 min) calls `update_autoscaler(min_containers=…)`. For a fixed
warm pool, set only `MODAL_MIN_CONTAINERS`. Service env vars such as `MAX_CONCURRENCY` or
the thresholds can go into the same Modal secret. Each container accepts `MODAL_MAX_INPUTS`
(4) concurrent requests, and `MAX_CONCURRENCY` (2) of them use the GPU at once.

## Replicate mode

```bash
MODEL_BACKEND=replicate REPLICATE_API_TOKEN=r8_... \
GPU_SERVICE_SECRET=... uvicorn app.main:app
```

Images are sent as data URIs to `POST https://api.replicate.com/v1/predictions` with
`Prefer: wait`, and the service then polls `urls.get` until the prediction finishes. The
segmentation input is downscaled to 1024 px on the long side and sent as PNG. The ESRGAN
input is sent as JPEG q95 with `{"image", "scale", "face_enhance": false}`. If the returned
segmentation image has alpha, the alpha is used as the mask; otherwise the image is read as
a grayscale mask. Canvas, checks and export still run locally on CPU. Replicate calls are
never made "optionally": when the background is kept, the bbox comes from the border-colour
difference, not an extra paid prediction. Replicate failures return 502
`model_backend_failed`, so the worker retries.

## Threshold tuning

The defaults follow the contract and are a starting point. **Tune them on the spike's
50-image set** before launch:

- Run the set through `local` (and `replicate` if it is used) with the default thresholds.
  Record `metrics` for each image and have a human label good and bad cut-outs.
- `MASK_UNCERTAINTY_MAX` separates clean edges from glass, hair and jewellery. Pick the
  value that flags most bad edges without flagging most good ones. BiRefNet's uncertainty
  is usually under 0.03 on studio shots.
- `MASK_EMPTY_MAX` and `MASK_FULL_MIN` mostly catch failures. Check small products (rings)
  against `MASK_EMPTY_MAX`, which is compared to *coverage*: a ring can legitimately cover
  about 2%.
- `MASK_FRAGMENTS_MAX`: product sets (pairs of shoes, earrings) legitimately have 2–4
  fragments.
- `FIDELITY_SSIM_MIN` and `FIDELITY_DELTA_E_MAX`: Real-ESRGAN on clean product shots
  typically scores SSIM above 0.9. Lower SSIM usually means invented texture.
- `COLOR_DRIFT_DELTA_E_MAX`: ΔE 2–3 is barely visible, above 5 is obvious.
- `TEXT_MIN_CONFIDENCE` trades missed labels for unnecessary Lanczos fallbacks.
- `ESCALATE_FLIP_DISAGREEMENT` (0.015) sits just above the highest good photo measured
  (0.0142) and below the lowest false pass it caught (0.0187), on arm64 with
  BiRefNet-lite at 512 px. Check the distribution of `quality_checks.cutout_flip_disagreement`
  (also in each `IMAGE_PROCESSING` log line) on the production CPU before relying on it, and
  recalibrate after changing the model, its input size or the hardware.

## Layout

```
app/
  main.py         FastAPI app, /v1/process, /healthz, error mapping, lifespan model loading
  config.py       env settings (pydantic-settings)
  security.py     X-Signature HMAC verification, URL policy
  schemas.py      request/response models
  pipeline.py     the 8-step pipeline
  canvas.py       canvas maths + rendering
  imageio.py      decode/normalise, export, XMP, previews
  checks.py       mask metrics, fidelity, colour drift, flags
  text_detect.py  EAST + MSER fallback
  storage.py      presigned download/upload
  ops.py, log.py, errors.py
  backends/       base.py (interfaces), local.py, replicate.py, classic.py
tests/            pytest suite (classic backend, no network)
```
