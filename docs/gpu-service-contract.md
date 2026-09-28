# GPU service HTTP contract

The Node worker calls the Python GPU service over HTTPS. The GPU service is stateless:
it never holds storage credentials. The worker hands it a presigned GET URL for the
backed-up original and presigned PUT URLs for every artifact it must write.

## Authentication

Every request (except `GET /healthz`) carries:

```
X-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(GPU_SERVICE_SECRET, "<t>.<raw request body>")>
```

The service rejects with `401` when the header is missing, malformed, the timestamp is
more than 300 s away from the server clock, or the signature doesn't match
(constant-time compare).

## `POST /v1/process`

Request body (JSON):

```jsonc
{
  "request_id": "clx...",                    // JobItem id, echoed back and logged
  "source_url": "https://...",               // presigned GET of the original backup
  "source_mime_type": "image/jpeg",          // hint only; the service sniffs the bytes
  "uploads": {
    "output":  { "url": "https://...", "headers": { "Content-Type": "image/jpeg" } },
    "preview": { "url": "https://...", "headers": { "Content-Type": "image/jpeg" } },
    "before":  { "url": "https://...", "headers": { "Content-Type": "image/jpeg" } },
    "mask":    { "url": "https://...", "headers": { "Content-Type": "image/png" } }
  },
  "settings": {
    "aspect": "1:1",                         // "1:1" | "4:5" (width:height)
    "margin_pct": 8,                         // 0–40, % of canvas size kept empty on each side
    "remove_bg": true,
    "bg_color": "#FFFFFF",
    "upscale": false,                        // AI upscaling opt-in
    "upscale_threshold_px": 1200,            // only upscale when source short side < this
    "target_px": 2048,                       // output canvas width in px
    "output_format": "jpeg",                 // "jpeg" | "png" | "webp" (worker matches the original's format)
    "jpeg_quality": 90,
    "ai_metadata": true,                     // write IPTC DigitalSourceType XMP when AI upscaling ran
    "force_escalation": false                // "Retry with stronger model": the cut-out goes to ESCALATION_BACKEND
                                             // first (see "Routing and the quality gate"); never answered NO_CHANGE
  }
}
```

The service must send exactly the headers given in `uploads.*.headers` with each PUT
(the URLs are signed for that Content-Type).

Artifacts:

| Key       | What                                                                  |
|-----------|-----------------------------------------------------------------------|
| `output`  | Final image, in `output_format`, sRGB, ≤ 20 MP, ≤ 20 MB               |
| `preview` | Output resized to 640 px long side, JPEG q80                          |
| `before`  | Normalised original (sRGB, EXIF-rotated) resized to 640 px long side, JPEG q80 |
| `mask`    | RGBA PNG, same geometry as `before`: removed background tinted red at ~45% alpha, product fully transparent. Blank (fully transparent) when `remove_bg` is false |

Response `200`:

```jsonc
{
  "request_id": "clx...",
  "output":  { "width": 2048, "height": 2048, "bytes": 812345, "format": "jpeg", "content_type": "image/jpeg" },
  "source":  { "width": 900, "height": 1200, "format": "JPEG", "mode": "RGB", "icc_converted": false },
  "upscale": {
    "eligible": true,                        // opted in AND short side < threshold
    "applied": true,                         // AI model actually ran (credit charged for it)
    "method": "realesrgan-x2",               // "realesrgan-x2" | "realesrgan-x4" | "lanczos" | "none"
    "scale": 2.0,
    "reason": "short side 900 < 1200"
  },
  "flags": [
    { "code": "mask_low_confidence", "severity": "warning", "message": "Cut-out edges are uncertain (glass, hair or jewelry?)" }
  ],
  "metrics": {
    "mask_coverage": 0.41,                   // fraction of pixels in product mask
    "mask_fragments": 1,                     // significant connected components
    "mask_uncertainty": 0.03,                // fraction of pixels with 0.2 < p < 0.8
    "text_detected": false,
    "text_boxes": 0,
    "fidelity_ssim": 0.93,                   // null when no upscaling ran
    "fidelity_delta_e": 2.1,                 // null when no upscaling ran
    "color_drift_delta_e": 1.2               // product-region mean colour, original vs output
  },
  "fidelity": 0.93,                          // = metrics.fidelity_ssim (convenience), may be null
  "models": {
    "backend": "local",                      // "local" | "replicate" | "classic" — the backend whose result was kept (the escalation or fallback, if used)
    "segmentation": "ZhengPeng7/BiRefNet@<revision>",
    "upscaler": "RealESRGAN_x2plus",         // null when not used
    "text_detector": "opencv-east"           // null when not used
  },
  "timings_ms": { "download": 120, "upscale": 900, "segment": 450, "compose": 80, "upload": 300, "total": 1900 },
  "processing": {                            // how the image was made (cost + quality monitoring)
    "operations": ["decode", "analysis", "background_removal", "canvas", "export"],   // + "upscale" when wanted
    "method": "local",                       // what made the kept result: "deterministic" | "source_alpha" | "local" | "replicate" | "local+replicate"
    "replicate_used": false,                 // any Replicate call was made (kept or not)
    "replicate_calls": 0,
    "replicate_models": [],                  // e.g. ["men1scus/birefnet"]
    "estimated_cost_usd": 0.0,               // Σ prediction time × REPLICATE_*_USD_PER_S (Replicate bills predict time only)
    "fallback_reason": null,                 // why Replicate was tried: a cut-out escalation reason ("empty_mask", "full_mask",
                                             // "background_artifacts", "text_or_logo_cut", "dropped_inner_part",
                                             // "crop_too_tight", "unstable_cutout"; see "Cut-out checks"), "too_slow_on_cpu",
                                             // "replicate_unavailable", "… (not escalated: escalation_cooldown)"; "; "-joined
    "quality_score": 1.0,                    // 0–1, min of the cut-out and output checks
    "quality_checks": {                      // cutout_* = the kept cut-out's checks; null = not measured
      "cutout_edge_uncertainty": 0.004, "cutout_text_kept": 1.0, "cutout_flip_disagreement": 0.002,
      "cutout_flip_compare_px": 1024, "cutout_edge_contact": 0.0, "aspect_ok": true, "centered": true, ...
      // "cutout_flip_disagreement_outside_crop" is present only when a local_refine result was kept
    },
    "attempts": [                            // every attempt, in order; "outcome": "used" | "rejected" | "failed";
                                             // "reason": the checks it failed, ","-joined (a local attempt's duration_ms
                                             // includes its mirrored pass)
      { "operation": "background_removal", "method": "local", "model": "/models/birefnet@…", "duration_ms": 6200,
        "cost_usd": 0.0, "outcome": "used", "reason": null, "quality_score": 1.0 }
    ],                                       // "outcome" is also "shadow" for a judged local cut-out in shadow mode,
                                             // and "check" for the second opinion (method "local_verify")
    // ── the quality gate (image service 2026-09-28.1 on; see "Routing and the quality gate") ──
    "route": "local",                        // what made the kept result: "no_change" | "deterministic" | "local" |
                                             // "replicate" | "local_then_replicate" (the gated cut-out's route when there is one)
    "local_attempted": true,                 // a local cut-out was made
    "local_accepted": true,                  // ... it was kept, and its gate said SAFE_LOCAL
    "gate": "SAFE_LOCAL",                    // verdict on the best local cut-out: "SAFE_LOCAL" | "UNCERTAIN" | "FAILED"; null = none made
    "ai_gate": null,                         // verdict on the paid cut-out(s): "PASS" (one passed its checks) | "UNSAFE"; null = none made
    "reason_codes": [],                      // why it was routed / reviewed, e.g. ["QUALITY_SCORE_UNCERTAIN", "FINE_STRUCTURE"]
    "replicate_attempts": 0,                 // paid cut-outs made (≤ ESCALATION_MAX_ATTEMPTS)
    "quality_scores": {                      // headroom to each limit, 0–1 (0 = at or past it); null = not measured
      "segmentation_confidence": 0.92, "product_retention": 1.0, "geometry": 1.0, "artifact": 0.97, "fidelity": 0.9
    },
    "analysis": {                            // stage 0, before any model (null only for older services)
      "already_acceptable": false, "needs_resize": true, "needs_centering": true, "needs_background_removal": true,
      "background_complexity": "low",        // "clean" | "low" | "medium" | "high"
      "product_coverage": 0.21, "product_touches_edge": false, "has_transparency": false,
      "recommended_route": "local",          // "no_change" | "local"
      "analysis_confidence": 0.9
    },
    "shadow": null,                          // LOCAL_PROCESSING_SHADOW only: { "mode": "shadow", "local_gate": "SAFE_LOCAL",
                                             //   "local_would_have_been_used": true, "iou_local_vs_final": 0.98 }
    "final_status": "READY"                  // "READY" | "NEEDS_REVIEW" | "NO_CHANGE"
  }
}
```

## Routing and the quality gate

**Stage 0: analysis** (`app/analysis.py`, no model). If the photo already satisfies the whole
request, nothing is processed: `final_status` is `NO_CHANGE`, `route` `no_change`, and the
`output` artifact is the source file byte for byte (`preview` and `before` are its 640 px
preview, `mask` is blank). The worker marks the item unchanged; it is never applied or
charged. Deliberately strict (a false "already acceptable" ships an unprocessed image), all
of these must hold: no transparency; the aspect within 0.5%; no resize (width ≤ 1.02 ×
`target_px`, no working downscale) and no upscale due; the same file format as
`output_format`; no EXIF rotation or ICC conversion; within the output limits; on a plain
border, a product box (border difference at ≤ 768 px) centred within 1.5% and at the
margin within 1.5 points on its limiting axis; with `remove_bg`, the border within ΔE 2 of
`bg_color` and ≥ 99.9% of the pixels outside the (2%-grown) product box within ΔE 3 of it;
without `remove_bg`, a plain border. `force_escalation` or `NO_CHANGE_DETECTION=false` skip it.

**Routes.** Local first by default. Paid first (`ESCALATION_BACKEND`, `route` `replicate`)
when `force_escalation` is set (reason `FORCED_BY_MERCHANT`), `LOCAL_PROCESSING_ENABLED` is
false, or the photo falls outside `LOCAL_PROCESSING_PERCENTAGE` (bucket = first 4 bytes of the
source's sha256 mod 100, so a photo always takes the same route; reason `ROLLOUT_NOT_LOCAL`,
which also sends its AI upscaling to the paid backend; `force_escalation` doesn't, the paid
upscaler is the same Real-ESRGAN). `LOCAL_PROCESSING_SHADOW`: the local cut-out is made and
judged, the paid one is always made and used when it passes (`shadow` says whether the local
one would have been used and the IoU of the two; reason `SHADOW_MODE`).

**The local gate** (`quality.QualityReport.gate`) on the best local cut-out:

* `FAILED`: a cut-out check failed (table below).
* `UNCERTAIN`: every check passed, but without margin: a measurement is at or above
  `UNCERTAIN_BAND` (0.7) × its limit (mirrored-pass disagreement, edge uncertainty, dropped
  parts; text kept below 1 − 0.7 × (1 − `ESCALATE_TEXT_COVERAGE_MIN`)) → `near_limit`, or
  undecided edge pixels are ≥ `ESCALATE_RELATIVE_UNCERTAINTY` (0.12) of the product's own
  area → `fine_structure` (spokes, wire, lace, where the 512 px model loses parts without
  disagreeing with itself).
* `SAFE_LOCAL`: everything passed with margin **and a second opinion reproduces it**. Only
  this skips the paid model.

**The second opinion** (`LOCAL_SECOND_OPINION`, default `letterbox`). A local cut-out that
passed everything else must be reproduced by the same model on another view of the photo:
IoU at ≤ 1024 px of the binarised masks ≥ `ESCALATE_VERIFY_MIN_IOU` (0.98), else it is
`UNCERTAIN` (`model_disagreement`, reason code `MODEL_DISAGREEMENT`) and escalated.
`letterbox`: the photo padded to a square with its border colour (aspect kept) where the model
otherwise sees it stretched; one more inference at the same memory, in addition to the
mirrored pass (recorded as an attempt with method `local_verify`, outcome `check`;
`cutout_verify_iou` in `quality_checks`). Each catches bad cut-outs the other misses, so a
local cut-out now runs the model three times on CPU.
`resolution`: the model at `LOCAL_VERIFY_INPUT_SIZE` (768) instead; it doesn't fit the 2 GB
CPU VPS (measured on Linux, 2026-09-28: killed at 768 and 640 px, while `letterbox` peaked at
1.74 GB like the mirrored pass). `off`: the mirrored pass alone. Calibration on the 117
labelled eval photos (gpu-service/eval, 2026-09-28): `letterbox` at 0.98 escalated 9 of the
18 bad local cut-outs the mirrored pass had kept, and 1 of 26 good ones.

**Escalation and the AI gate.** An `UNCERTAIN` or `FAILED` local cut-out goes to the paid
model; its cut-out is checked the same way (no mirrored pass): `ai_gate` `PASS` when it
passes. One that fails is tried once more (`ESCALATION_MAX_ATTEMPTS`, default 2) on a crop
around everything any attempt found (method `replicate_zoom`; the model sees the product at
a higher resolution; skipped when the crop would cover more than 80% of the photo, since a
deterministic model would give the same answer). None passing: `ai_gate` `UNSAFE`, reason
`AI_RESULT_UNSAFE`. The kept cut-out is a passing paid one (a confident one first), else a
`SAFE_LOCAL` local one, else the best by (passed, confident, score). In paid-first routes a
paid model that is unavailable or unsafe falls back to the free local model.

**Final status.** `READY` only when all of these hold:
* nothing is flagged and the kept cut-out passed every check with margin (no doubts; for
  `force_escalation`, or with `LOCAL_PROCESSING_ENABLED` false, it must also be the paid
  model's);
* an independent model agrees with it (`cutout_model_agreement` in `quality_checks`): a local
  cut-out by the second opinion above; a paid one must match the local cut-out or the second
  opinion at IoU ≥ `READY_MIN_AGREEMENT` (0.98; the second opinion is made only when needed,
  also in paid-first routes). No independent model at all (e.g. `MODEL_BACKEND=replicate`
  alone) means no `READY`; set `READY_MIN_AGREEMENT=0` to accept a paid cut-out on its checks;
* the background is plain (`analysis.background_complexity` `clean` or `low`) while
  `READY_REQUIRES_PLAIN_BACKGROUND` is true (default): in busy scenes both models often keep a
  prop, furniture or a shadow as part of the product, which no check can tell from the
  product (reason code `COMPLEX_BACKGROUND`).

Otherwise `NEEDS_REVIEW`, always with a flag saying why (`cutout_check` notes: "passed, but
only narrowly", "fine details … may be cut badly", "the stronger model's cut-out didn't pass
its checks either", "the stronger model wasn't available to double-check it", "a second
model's cut-out differs from this one", "a busy background: check that only the product was
kept", …). Upscaling has no escalation (both backends run the same
Real-ESRGAN): its gate is `fidelity_low`, which flags the image for review. Only `READY`
images may be bulk-approved; the worker never reuses anything but a `READY` result.

**Reason codes** (`reason_codes`, deduplicated, in order): `PRODUCT_NOT_FOUND`,
`BACKGROUND_NOT_REMOVED`, `LOW_SEGMENTATION_CONFIDENCE`, `SEGMENTATION_UNSTABLE`,
`TEXT_OR_LOGO_CHANGED`, `PRODUCT_PART_MISSING`, `PRODUCT_TOUCHING_EDGE`,
`QUALITY_SCORE_UNCERTAIN` (near a limit), `FINE_STRUCTURE`, `MODEL_DISAGREEMENT` (the second
opinion, or no independent model, disagrees), `COMPLEX_BACKGROUND` (a busy background: an
escalated or review-only cut-out), `AI_RESULT_UNSAFE`, `ESCALATION_UNAVAILABLE` (the paid model
was wanted but blocked, failing or not configured for a forced request: such results are
never reused), `FORCED_BY_MERCHANT`, `ROLLOUT_NOT_LOCAL`, `SHADOW_MODE`,
`UPSCALE_TOO_LARGE_FOR_LOCAL`, and from flags: `BACKGROUND_ARTIFACTS` (fragmented),
`COLOR_SHIFT`, `LOW_RESOLUTION` (upscale capped), `DISTORTION_DETECTED` (fidelity),
`TEXT_PRESENT`, `BAD_CENTERING` (output check). Not emitted: `HALO_DETECTED` (the halo is
recorded, never escalated: a stronger model gives the same answer) and
`GENERATIVE_EDIT_REQUIRED` (the service never edits generatively).

**Quality scores** are the headroom to each limit, `1 − measured / limit` clipped to 0–1:
`segmentation_confidence` (edge uncertainty and mirrored-pass disagreement, 0 for an empty or
full mask), `product_retention` (dropped parts and text kept, 0 for an empty mask or a crop
too tight), `artifact` (relative uncertainty), `geometry` (the output checks' score) and
`fidelity` (upscale SSIM and ΔE, colour drift). The gate wants more than 1 − `UNCERTAIN_BAND`
= 0.3 on each measured cut-out score.

Logs: `ANALYSIS` (the analysis, and `not_acceptable_because`), `SHADOW_COMPARE`, and
`PROCESSING_COST` / `PROCESSING_SUCCESS` with `route`, `gate`, `ai_gate`, `final_status`,
`reason_codes`.

**Cheapest safe method first.** `MODEL_BACKEND` does the work and `ESCALATION_BACKEND`
(Replicate; default `none`) is used only when needed:

* Background removal runs on the local model. A product that is small in the photo is cut
  out from a crop around it (`local_zoom` when a plain background locates it first,
  `local_refine` otherwise), so a 512 px model sees it at a useful size. Each local result is
  checked (`quality.assess_cutout`, see *Cut-out checks* below), including a second pass of
  the same model on the mirrored photo. Only a result that passes every check with margin
  (`SAFE_LOCAL`) skips the escalation model; its result is checked the same way (without a
  mirrored pass) and retried once on a zoomed crop if it fails (see *Routing and the quality
  gate*). A kept result that isn't confidently good gets the `cutout_check` flag and
  `final_status` `NEEDS_REVIEW`.
* AI upscaling runs locally only within `LOCAL_MAX_AI_SCALE` / `LOCAL_MAX_AI_UPSCALE_PIXELS`;
  bigger jobs go to the escalation backend (same Real-ESRGAN models), or, if it is
  unavailable, take the CPU-limited path below. Text on the product still means Lanczos.
* Everything else (decode, canvas, padding, centring, resizing, encoding) is deterministic.
* After a failed paid call the escalation backend is skipped for `FALLBACK_COOLDOWN_S`, and
  optionally after `ESCALATION_DAILY_MAX_CALLS` per UTC day; images then keep their local
  result (and flags). Paid failures never fail an image.

**Cut-out checks** (`quality.assess_cutout`). A local cut-out that fails any of these is
escalated; the first failed check is the `fallback_reason`, all of them are the attempt's
`reason`:

| Reason | Escalated when | Setting (default) |
|---|---|---|
| `empty_mask` | nothing found (coverage < 0.2%) | — |
| `full_mask` | coverage > `MASK_FULL_MIN` | `MASK_FULL_MIN` (0.95) |
| `background_artifacts` | share of the frame with undecided mask pixels (0.2 < p < 0.8) above the limit | `ESCALATE_MASK_UNCERTAINTY` (0.035) |
| `text_or_logo_cut` | a text box on a solid part of the product keeps 25% to the limit of its area (see below) | `ESCALATE_TEXT_COVERAGE_MIN` (0.85) |
| `dropped_inner_part` | plain background only: more than the limit of the product's area is in enclosed holes that are clearly a dropped part (see below) | `ESCALATE_DROPPED_PARTS_MAX` (0.01) |
| `crop_too_tight` | `local_zoom` / `local_refine`: the cut-out reaches a side of the crop that isn't the photo's edge | — |
| `unstable_cutout` | the same local model on the mirrored photo gives a different cut-out (see below) | `ESCALATE_FLIP_DISAGREEMENT` (0.015; `0` = off) |

* **Mirrored pass (`unstable_cutout`).** Every local attempt that found something runs the
  same model again on the horizontally mirrored input (the same crop for `local_zoom` /
  `local_refine`), mirrors the mask back, removes specks from it like from the cut-out, and
  compares the two over the region the model saw (the crop for `local_zoom` /
  `local_refine`, so a small product isn't judged at thumbnail size) at ≤ 1024 px
  (`cutout_flip_compare_px`: that region's long side at the comparison): the XOR of the
  binarised masks, opened with a 7×7 ellipse to remove edge jitter, divided by the larger
  mask's area (`cutout_flip_disagreement`). A confidently wrong cut-out (a prop kept, a
  product or part of one missed, a background patch kept) is usually a knife-edge decision
  that flips; edge jitter doesn't. On `local_refine`, the full-frame attempt's mirrored mask
  must also agree with the refined cut-out outside the crop, compared on the full frame
  (`cutout_flip_disagreement_outside_crop`), because a second product the crop can't see is
  otherwise invisible to every check. The escalation model is never re-run mirrored (a paid
  call is never repeated), so `cutout_flip_disagreement` is `null` when its result was kept;
  the classic backend is mirror-symmetric and skips the pass too.
  **CPU cost:** one extra local inference per local attempt (the `local_refine` path runs
  four: full frame and crop, each also mirrored), timed into the attempt's `duration_ms`
  and `timings_ms.segment`. Measured on 54 photos with BiRefNet-lite at 512 px on 2
  Apple-silicon threads: +1.9 s (+86%) segmentation per cut-out, and the `local_refine` path
  from ~3.8 to ~7.5 s. Not yet re-benchmarked on the CPU VPS (`MAX_CONCURRENCY=1` there, so
  catalogue throughput drops by about as much). Memory: the mirrored input is a transient
  copy of the attempt's region; the mirrored mask is kept at ≤ 1024 px only.
  `ESCALATE_FLIP_DISAGREEMENT=0` turns the pass off. Calibration (54 photos against Replicate,
  2026-09-27, BiRefNet-lite at 512 px on arm64): 8 of 9 confident false passes caught, 4 of 35
  good photos escalated; the highest good photo scored 0.0142 and the lowest caught false
  pass 0.0187. The limit is calibrated for that model and size only: with full BiRefNet at
  1024 px on CPU (~45 s per pass) set it to `0` or recalibrate.
* **Labels (`text_or_logo_cut`).** A detected text box counts only when it is centred in the
  product's bounding box and sits on a solid part of the product: its surround (the box
  padded by half its longer side) is at least 80% cut-out. EAST boxes on polka dots, stripes,
  hair or a sole's tread straddle the product's edge and are ignored (they were all 4 text
  escalations in the 54-photo sweep). Scope: a label cut by a hole or a notch while the
  product around it is kept still counts; a label that the cut-out's outer edge runs through
  (a whole side of the product dropped) leaves too much background around it and is ignored
  by design (only the mirrored pass may catch that case). The code also has a
  silhouette-edge rule (ignore a box the outer edge crosses when more than 20% of the
  surround is background); it is inert at the 80% surround threshold and only matters if
  that threshold is lowered.
* **Dropped parts (`dropped_inner_part`).** On a plain background, a hole enclosed by the
  cut-out (≥ 0.2% of the product) is a dropped part only when its median colour is more than
  ΔE 20 from both the border colour and the product's local background: the ring 3–8 px
  outside the cut-out (at ≤ 1024 px) nearest the hole (the border colour alone decides when
  fewer than 50 ring pixels lie within 64 px of it). Sunglass lenses or a dark inner panel
  are far from both. Openwork jewellery whose holes show the product's own shadow or
  reflections is not a dropped part.
* **Recorded only, never escalated** (a stronger model gives the same answer): the number of
  pieces (`cutout_fragments`), the rim of old background (`cutout_halo`), and
  `cutout_edge_contact`, the largest share of the photo's top, left or right edge that the
  cut-out covers (the bottom is ignored: products stand on it, and people are cropped there).
  The merchant is told when it is ≥ 0.05 (see `cutout_check`), except for a cut-out of the
  whole photo (`mask_full`: the background wasn't removed) or one already noted as
  `crop_too_tight`.

Logs (JSON lines, with `request_id`): `IMAGE_PROCESSING` per attempt (with its `quality_checks`,
e.g. `flip_disagreement`), `AI_FALLBACK` /
`AI_FALLBACK_SKIPPED` on escalation, `REPLICATE_CALL` per prediction (model, predict time,
estimated USD), `PROCESSING_COST` and `PROCESSING_SUCCESS` / `PROCESSING_FAILURE` per request.

Flag codes (all may appear together):

| Code                  | When                                                              |
|-----------------------|-------------------------------------------------------------------|
| `mask_empty`          | nothing found, or coverage < `MASK_EMPTY_MAX` (default 0.02) with a bounding box under 1% of the photo (a small or thin product is not "empty") |
| `mask_full`           | mask coverage > `MASK_FULL_MIN` (default 0.95)                    |
| `mask_fragmented`     | significant fragments > `MASK_FRAGMENTS_MAX` (default 3)          |
| `mask_low_confidence` | uncertainty > `MASK_UNCERTAINTY_MAX` (default 0.08)               |
| `text_detected`       | upscaling was eligible, text/label found → Lanczos + light sharpen used instead of AI |
| `fidelity_low`        | SSIM < `FIDELITY_SSIM_MIN` (default 0.85) or ΔE > `FIDELITY_DELTA_E_MAX` (default 6) |
| `color_drift`         | product-region ΔE > `COLOR_DRIFT_DELTA_E_MAX` (default 5)         |
| `upscale_capped`      | the largest allowed factor (4×, or `LOCAL_MAX_AI_SCALE` on CPU) couldn't reach `target_px`; output is smaller than target |
| `cutout_check`        | the kept cut-out is not confidently good (`final_status` NEEDS_REVIEW): it passed only narrowly or has fine structure (UNCERTAIN, see *Routing and the quality gate*) and the paid model couldn't do better or wasn't available, a forced request fell back to the local model, or it failed an escalation check not covered above (label cut, dropped part, crop too tight, unstable cut-out, uncertain edges below `MASK_UNCERTAINTY_MAX`) — no stronger model was available or it failed too — or it covers ≥ 5% of the photo's top, left or right edge (`cutout_edge_contact`; flag only, never escalated: a stronger model can't bring back what the photo cut off; not with `mask_full` or `crop_too_tight`). At most one per image, its notes `"; "`-joined, e.g. "Please check this image: the cut-out may include a prop or background, or miss part of the product; the cut-out runs into the photo's edge, so the product or a prop may be cut off" |
| `output_check`        | a canvas invariant failed (aspect, size, centring, margins, fully visible, not enlarged); a bug, never expected |

Mask flags are only computed when `remove_bg` is true.

Errors: JSON `{ "error": { "code": "unsupported_image", "message": "..." } }`.
`4xx` = the input is bad, don't retry (`unsupported_image`, `image_too_large`,
`source_download_failed` with a 4xx from storage, `invalid_settings`). `5xx` = transient,
the worker retries.

## Limits

Enforced by the service (environment variables, defaults in `gpu-service/README.md`). Values
in brackets are the CPU VPS settings in `docker-compose.vps.yml`.

| Limit | Default [VPS] | Behaviour |
|-------|---------------|-----------|
| `MAX_SOURCE_BYTES` | 60 MB [25 MiB] | Larger downloads are cut off: `413 image_too_large`. |
| `MAX_SOURCE_PIXELS` | 120 MP [30 MP] | Checked from the image header before decoding: `413 image_too_large`. Shopify product images are at most 25 MP. |
| `MAX_WORKING_PIXELS` | 50 MP [16 MP] | Larger sources are downscaled to this before processing (`source` still reports the original size). Also caps the size after upscaling. |
| `MAX_OUTPUT_PIXELS` | 20 MP | Output canvas cap. |
| `MAX_OUTPUT_BYTES` | 20 MB | Quality, then dimensions, step down until the output fits. |

Decoding memory is bounded by the pixel cap, not the file size: a small, highly compressible
file can decode to a large image. Transparency is flattened in 8-bit, so a transparent PNG at
the cap peaks at about 15 bytes per source pixel. JPEGs of at least 4× `MAX_WORKING_PIXELS`
are decoded at 1/2, 1/4 or 1/8 scale; with the VPS limits every accepted JPEG is decoded at
full size (about 0.35 GB peak at 30 MP). Callers that accept public uploads should also check
the header themselves (the landing-page try-it rejects anything over 12.6 MP before calling
the service).

When the local models run on CPU, where Real-ESRGAN ×4 takes minutes per photo,
`LOCAL_MAX_AI_SCALE` [2] caps the AI factor (a product that needs more than ×2 gets ×2 and
`upscale_capped`), and sources over `LOCAL_MAX_AI_UPSCALE_PIXELS` [0.25 MP] take the Lanczos
path (`method: "lanczos"`, `applied: false`) — unless an `ESCALATION_BACKEND` takes them. Requests queue for `MAX_CONCURRENCY` processing slots [1]. A run that
has started always finishes, but a request whose caller disconnected while it waited for a
slot is dropped without running (logged as `client_gone`; the caller never sees a response).

## `GET /healthz`

No auth. `{ "ok": true, "backend": "local", "device": "cuda", "models_loaded": ["segmentation", "upscaler_x2", ...], "fallback_backend": null, "escalation_backend": "replicate", "pipeline_version": "2026-09-28.4+1a2b3c4d5e6f" }`

`pipeline_version` is `PIPELINE_VERSION` (gpu-service/app/pipeline.py) plus a hash of every
setting that can change a result for the same image and request (models, backends, quality
and escalation thresholds, resizing limits; not secrets, timeouts or throughput settings,
see `_NOT_OUTPUT_AFFECTING` in app/config.py; `LOCAL_PROCESSING_PERCENTAGE` and
`LOCAL_PROCESSING_SHADOW` are left out too, so a rollout ramp doesn't stop reuse, while the
`LOCAL_PROCESSING_ENABLED` kill switch is in).

**Result reuse (the Node side keys on this endpoint).** The worker reuses an earlier item's
artifacts instead of calling `/v1/process` when the media, source bytes (sha256), request
settings and a fingerprint of `/healthz` (backend, device, models_loaded, text_detector,
escalation_backend, fallback_backend, pipeline_version) all match, and the earlier result was
made as intended (no `replicate_unavailable` / `not escalated`, no stand-in backend). So:

* Bump `PIPELINE_VERSION` for any code change that can alter outputs for the same inputs
  (checks, escalation rules, compositing, encoding). Output-affecting configuration changes
  are covered automatically by the hash.
* `RESULT_KEY_VERSION` in app/lib/reuse.server.ts is only for changes on the Node side of
  the key.

**Retry semantics the worker relies on.** `out_of_memory` (503) and the worker's own timeout
are image-specific: they don't open the worker's "image service down" breaker (`gpu:down`)
and an image is tried at most twice for them. A service-wide 503 must carry no code or a
non-image code. Any new image-specific 5xx code must be added to `IMAGE_SPECIFIC_GPU_CODES` in
app/lib/gpu.server.ts.

`fallback_backend` is set when `FALLBACK_BACKEND` is configured (e.g. `replicate` with a
`local` fallback): if the primary's model call fails, the whole request is re-run on the
fallback, so `models` in the response always describes one backend.
