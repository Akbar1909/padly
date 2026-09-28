"""Make the landing page's before/after examples with the real pipeline.

Runs the same Pipeline the service uses, in-process: MODEL_BACKEND=local (BiRefNet +
Real-ESRGAN) and, with ``--escalation replicate``, the paid model for cut-outs that fail their
checks, exactly as in production. Writes ``<name>-before.jpg`` / ``<name>-after.jpg`` (1000 px
wide, in the chosen aspect; an output smaller than that is kept at its own size, never
enlarged), WebP variants of both for the page's srcset (``<name>-after-<width>.webp``, see
``VARIANT_WIDTHS``), an OpenGraph image, and prints the product selection boxes for
app/components/landing/examples.ts. Everything else (BIREFNET_INPUT_SIZE, DEVICE,
LOCAL_MAX_AI_SCALE, REPLICATE_API_TOKEN, ...) is read from the environment like the service
does, so set it as in production (see docker-compose.vps.yml and Dockerfile.cpu-ml).

    BIREFNET_INPUT_SIZE=512 REPLICATE_API_TOKEN=... python scripts/make_landing_examples.py \
        --models /path/with/RealESRGAN_x2plus.pth \
        --birefnet /path/to/BiRefNet-checkout \
        --escalation replicate \
        --out ../public/examples \
        sneakers=src/sneakers.jpg case=src/case.jpg ...

``--variants-only`` skips the pipeline and just (re)writes the WebP variants of the JPEGs given
as arguments (``python scripts/make_landing_examples.py --variants-only ../public/examples/*.jpg``).

``--attempts DIR`` also writes ``<name>-attempt-<n>-<method>-<outcome>.jpg`` for every cut-out
attempt (rejected ones included), composed exactly like the output, for showing what the
quality checks caught. ``--report PATH`` writes the JSON report (flags, attempts, paid calls).
"""

from __future__ import annotations

import argparse
import io
import json
import time
from pathlib import Path
from types import SimpleNamespace

import cv2
import numpy as np
from PIL import Image, ImageOps

import app.pipeline as pipeline_module
from app.backends import build_backend
from app.checks import MaskAnalysis
from app.config import ServiceConfig
from app.pipeline import PIPELINE_VERSION, Pipeline
from app.quality import QualityReport
from app.schemas import ProcessSettings
from app.text_detect import load_text_detector

WIDTH = 1000
ASPECTS = {"1:1": 1.0, "4:5": 4 / 5}  # width / height
OG_SIZE = (1200, 630)
OG_PAPER = (243, 239, 230)  # the landing page's paper colour, also behind letterboxed photos
PRODUCT_MARGIN = 0.03  # room kept around the product in a letterboxed "before", per side
# srcset widths (px). 280 is the trust-grid thumbnail; an image narrower than a width gets a
# variant at its own width instead, so nothing is enlarged. Keep in sync with examples.ts.
VARIANT_WIDTHS = (280, 480, 720, 1000)
WEBP_QUALITY = 76


def write_variants(path: Path, widths: tuple[int, ...] = VARIANT_WIDTHS) -> list[int]:
    """WebP copies of ``path`` at each width (capped at the image's own), as
    ``<stem>-<width>.webp`` next to it. Returns the widths written."""
    img = Image.open(path).convert("RGB")
    written: list[int] = []
    for want in widths:
        w = min(want, img.width)
        if w in written:
            continue
        h = round(img.height * w / img.width)
        out = img if w == img.width else img.resize((w, h), Image.LANCZOS)
        out.save(path.with_name(f"{path.stem}-{w}.webp"), "WEBP", quality=WEBP_QUALITY, method=6)
        written.append(w)
    return written


def to_json(value: object) -> object:
    """``json.dumps`` default for numpy scalars in quality checks."""
    return value.item() if isinstance(value, np.generic) else str(value)


def frame_size(aspect: str) -> tuple[int, int]:
    return WIDTH, round(WIDTH / ASPECTS[aspect])


def product_box(mask_png: bytes) -> tuple[float, float, float, float] | None:
    """Normalised (x0, y0, x1, y1) of the product in the mask overlay (product = transparent)."""
    alpha = np.asarray(Image.open(io.BytesIO(mask_png)).convert("RGBA"))[:, :, 3]
    product = alpha < 10
    if product.all() or not product.any():
        return None
    ys, xs = np.nonzero(product)
    h, w = alpha.shape
    return xs.min() / w, ys.min() / h, (xs.max() + 1) / w, (ys.max() + 1) / h


def _place(centre: float, size: int, span: int) -> int:
    """Start of a ``span`` window on an axis of ``size``: centred on ``centre`` and inside the
    photo, or, for a window larger than the photo, with the photo centred in it."""
    if span >= size:
        return round((size - span) / 2)
    return round(min(max(centre - span / 2, 0), size - span))


def aspect_crop(
    img: Image.Image, box: tuple[float, float, float, float] | None, aspect: str, fill: tuple[int, int, int]
) -> tuple[Image.Image, dict | None, bool]:
    """Largest crop of the original in ``aspect``, centred on the product where possible.

    A product that doesn't fit that crop (a wide product in a tall frame, say) is never cut: the
    frame grows to show all of it and the photo is letterboxed on ``fill``. Returns the frame,
    the product's selection box in percent of it, and whether it was letterboxed."""
    w, h = img.size
    ratio = ASPECTS[aspect]
    cw, ch = (round(h * ratio), h) if w / h > ratio else (w, round(w / ratio))
    cx, cy = w / 2, h / 2
    if box:
        cx, cy = (box[0] + box[2]) / 2 * w, (box[1] + box[3]) / 2 * h
        grow = max((box[2] - box[0]) * w / cw, (box[3] - box[1]) * h / ch)
        if grow > 1:
            grow *= 1 + 2 * PRODUCT_MARGIN
            cw, ch = round(cw * grow), round(ch * grow)
    left, top = _place(cx, w, cw), _place(cy, h, ch)
    frame = Image.new("RGB", (cw, ch), fill)
    frame.paste(img, (-left, -top))
    letterboxed = left < 0 or top < 0 or left + cw > w or top + ch > h
    selection = None
    if box:
        pad = 0.015
        x0 = max(0.0, (box[0] * w - left) / cw - pad)
        y0 = max(0.0, (box[1] * h - top) / ch - pad)
        x1 = min(1.0, (box[2] * w - left) / cw + pad)
        y1 = min(1.0, (box[3] * h - top) / ch + pad)
        selection = {k: round(v * 100, 1) for k, v in {"x": x0, "y": y0, "w": x1 - x0, "h": y1 - y0}.items()}
    return frame.resize(frame_size(aspect), Image.LANCZOS), selection, letterboxed


def save_jpeg(img: Image.Image, path: Path, quality: int, max_bytes: int) -> int:
    """Progressive JPEG at ``quality``, lowered in steps until it fits ``max_bytes``."""
    q = quality
    while True:
        buf = io.BytesIO()
        img.save(buf, "JPEG", quality=q, optimize=True, progressive=True)
        if buf.tell() <= max_bytes or q <= 60:
            path.write_bytes(buf.getvalue())
            return q
        q -= 3


class AttemptRecorder:
    """Keeps every cut-out attempt's full-resolution mask and quality report.

    Each attempt in ``Pipeline._segment`` validates its mask with ``assess_cutout`` exactly once
    (the paid attempt too), so wrapping that function sees them all, in order. Later changes to
    a report (e.g. ``crop_too_tight``) land on the same object."""

    def __init__(self) -> None:
        self.calls: list[tuple[MaskAnalysis, QualityReport]] = []
        original = pipeline_module.assess_cutout

        def recording(analysis: MaskAnalysis, *args: object, **kwargs: object) -> QualityReport:
            report = original(analysis, *args, **kwargs)
            self.calls.append((analysis, report))
            return report

        pipeline_module.assess_cutout = recording


def attempt_frame(pipeline: Pipeline, up: SimpleNamespace, analysis: MaskAnalysis, settings: ProcessSettings):
    """One attempt's mask composed like the output (same feathering as ``Pipeline._segment``)."""
    if analysis.bbox is None:
        return None
    size = (up.rgb.shape[1], up.rgb.shape[0])
    sigma = max(0.6, max(size) / 2000.0)
    mask = np.clip(cv2.GaussianBlur(analysis.cleaned.astype(np.float32), (0, 0), sigma), 0.0, 1.0)
    comp = pipeline._compose_cutout(up, mask, analysis.bbox, settings)  # type: ignore[arg-type]
    return Image.fromarray(comp.canvas)


def og_image(before: Path, after: Path) -> Image.Image:
    og = Image.new("RGB", OG_SIZE, OG_PAPER)
    side = 560
    for path, x in ((before, 27), (after, 613)):
        img = ImageOps.contain(Image.open(path).convert("RGB"), (side, side), Image.LANCZOS)
        og.paste(img, (x + (side - img.width) // 2, 35 + (side - img.height) // 2))
    return og


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--models", type=Path, default=None, help="required unless --variants-only")
    ap.add_argument("--birefnet", default="ZhengPeng7/BiRefNet")
    ap.add_argument("--escalation", choices=["none", "replicate"], default="none")
    ap.add_argument("--out", type=Path, default=None, help="required unless --variants-only")
    ap.add_argument("--aspect", choices=sorted(ASPECTS), default="1:1")
    ap.add_argument("--margin", type=float, default=8)
    ap.add_argument("--bg", default="#FFFFFF", help="background colour of the output")
    ap.add_argument("--upscale", action="store_true", help="allow AI upscaling of small photos")
    ap.add_argument("--quality", type=int, default=82, help="JPEG quality (lowered to fit --max-bytes)")
    ap.add_argument("--max-bytes", type=int, default=180_000)
    ap.add_argument("--og", default=None, help="example for og.jpg (default: the first; 'none' = no og.jpg)")
    ap.add_argument("--attempts", type=Path, default=None, help="also write every cut-out attempt here")
    ap.add_argument("--report", type=Path, default=None, help="write the JSON report here (not under --out)")
    ap.add_argument("--variants-only", action="store_true", help="only write WebP variants of the given JPEGs")
    ap.add_argument("examples", nargs="+", help="name=path (with --variants-only: JPEG paths)")
    args = ap.parse_args()

    if args.variants_only:
        for spec in args.examples:
            path = Path(spec)
            print(path.name, write_variants(path), flush=True)
        return
    if args.models is None or args.out is None:
        ap.error("--models and --out are required")

    cfg = ServiceConfig(
        model_backend="local",
        escalation_backend=args.escalation,
        allow_unsigned=True,
        models_dir=args.models,
        birefnet_model_id=args.birefnet,
    )
    started = time.time()
    backend = build_backend(cfg)
    escalation = None
    if cfg.escalation_backend == "replicate":
        from app.backends.replicate import build_replicate_backend

        escalation = build_replicate_backend(cfg)
    pipeline = Pipeline(cfg, backend, load_text_detector(cfg.east_path), escalation=escalation)
    recorder = AttemptRecorder()
    upscaled: list[SimpleNamespace] = []
    run_upscale = pipeline._upscale

    def capture_upscale(*a: object, **k: object):  # the working image every attempt was cut from
        outcome = run_upscale(*a, **k)  # type: ignore[arg-type]
        upscaled.append(SimpleNamespace(rgb=outcome.rgb, alpha=outcome.alpha))
        return outcome

    pipeline._upscale = capture_upscale  # type: ignore[method-assign]
    print(
        f"models loaded on {backend.device} in {time.time() - started:.1f}s; pipeline {PIPELINE_VERSION}, "
        f"config {cfg.output_fingerprint()}, birefnet input {cfg.birefnet_input_size}, "
        f"escalation {cfg.escalation_backend}",
        flush=True,
    )

    args.out.mkdir(parents=True, exist_ok=True)
    if args.attempts:
        args.attempts.mkdir(parents=True, exist_ok=True)
    frame = frame_size(args.aspect)
    report: dict[str, dict] = {}
    for spec in args.examples:
        name, path = spec.split("=", 1)
        data = Path(path).read_bytes()
        settings = ProcessSettings(
            aspect=args.aspect, margin_pct=args.margin, remove_bg=True, bg_color=args.bg, upscale=args.upscale
        )
        recorder.calls.clear()
        upscaled.clear()
        t = time.time()
        result = pipeline.run(data, settings)
        elapsed = time.time() - t

        # Shrunk to the frame for display; an output smaller than the frame keeps its own size
        # (enlarging it would only make it look softer than the pipeline's real output).
        after = Image.open(io.BytesIO(result.artifacts["output"])).convert("RGB")
        if after.width > frame[0]:
            after = after.resize(frame, Image.LANCZOS)
        q_after = save_jpeg(after, args.out / f"{name}-after.jpg", args.quality, args.max_bytes)
        after_variants = write_variants(args.out / f"{name}-after.jpg")

        original = ImageOps.exif_transpose(Image.open(io.BytesIO(data))).convert("RGB")
        box = product_box(result.artifacts["mask"])
        before, selection, letterboxed = aspect_crop(original, box, args.aspect, OG_PAPER)
        q_before = save_jpeg(before, args.out / f"{name}-before.jpg", args.quality, args.max_bytes)
        write_variants(args.out / f"{name}-before.jpg")

        p = result.processing
        cut_attempts = [
            a for a in (p.attempts if p else []) if a.operation == "background_removal" and a.outcome != "failed"
        ]
        attempts = []
        for i, (analysis, quality) in enumerate(recorder.calls, 1):
            meta = cut_attempts[i - 1] if len(cut_attempts) == len(recorder.calls) else None
            method = meta.method if meta else "attempt"
            outcome = meta.outcome if meta else "unknown"
            row = {
                "method": method,
                "outcome": outcome,
                "reasons": list(quality.reasons),
                "score": quality.score,
                "checks": {k: v for k, v in quality.checks.items() if v is not None},
            }
            if args.attempts and upscaled:
                img = attempt_frame(pipeline, upscaled[-1], analysis, settings)
                if img is not None:
                    file = args.attempts / f"{name}-attempt-{i}-{method}-{outcome}.jpg"
                    save_jpeg(img.resize(frame, Image.LANCZOS), file, args.quality, args.max_bytes)
                    row["frame"] = str(file)
            attempts.append(row)

        report[name] = {
            "source": path,
            "selection": selection,
            "before_letterboxed": letterboxed,
            "flags": [f"{f.code}: {f.message}" for f in result.flags],
            "method": p.method if p else None,
            "replicate_calls": p.replicate_calls if p else 0,
            "estimated_cost_usd": p.estimated_cost_usd if p else 0.0,
            "fallback_reason": p.fallback_reason if p else None,
            "quality_score": p.quality_score if p else None,
            "attempts": attempts,
            "mask_coverage": result.metrics.mask_coverage,
            "output": f"{result.output.width}x{result.output.height}",
            "after_px": after.width,
            "after_variants": after_variants,
            "jpeg_quality": {"before": q_before, "after": q_after},
            "seconds": round(elapsed, 1),
        }
        print(name, json.dumps(report[name], default=to_json), flush=True)

    og = args.og or args.examples[0].split("=", 1)[0]
    if og != "none":
        og_image(args.out / f"{og}-before.jpg", args.out / f"{og}-after.jpg").save(
            args.out / "og.jpg", quality=85, optimize=True
        )
    meta = {"pipeline_version": PIPELINE_VERSION, "config": cfg.output_fingerprint()}
    if args.report:  # never under --out: that folder is public
        args.report.write_text(json.dumps({"meta": meta, "examples": report}, indent=1, default=to_json))
    print("REPORT " + json.dumps({"meta": meta, "examples": report}, default=to_json))


if __name__ == "__main__":
    main()
