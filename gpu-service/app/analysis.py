"""Stage 1: analyse the photo before any model runs.

Cheap and deterministic (border statistics, a border-difference product box, a few pixel
counts). It answers two questions:

* Does the photo already satisfy the request? Then nothing is processed and the source is
  returned unmodified (``final_status`` NO_CHANGE). This is deliberately strict: a false
  "already acceptable" ships an unprocessed image, so every condition must hold with margin
  (exact aspect, the requested background everywhere outside the product, margins and
  centring within 1.5 points, no resize, same file format, no rotation or colour conversion).
* What does it need, and how hard does it look (background complexity)? Reported for
  monitoring and routing.

Nothing here decides a cut-out is good: that is the quality gate's job after segmentation.
"""

from __future__ import annotations

import io
from dataclasses import dataclass

import cv2
import numpy as np
from PIL import ExifTags, Image

from .backends.classic import BorderStats, border_difference_mask
from .canvas import ASPECTS, Box
from .checks import analyze_mask
from .imageio import NormalizedImage
from .ops import downscale_to, image_size, to_lab_fast
from .schemas import ProcessSettings

ANALYSIS_LONG_SIDE = 768
ASPECT_TOLERANCE = 0.005  # relative
MARGIN_TOLERANCE = 1.5  # percentage points of the canvas side
CENTRE_TOLERANCE = 0.015  # fraction of the canvas side
BG_MATCH_DELTA_E = 2.0  # border median vs the requested background colour
BG_CLEAN_DELTA_E = 3.0  # a pixel outside the product box this close to the background is "clean"
BG_CLEAN_SHARE = 0.999  # ... and this share of them must be (a smudge or a shadow isn't)
RESIZE_TOLERANCE = 1.02  # output wider than target_px by more than 2% would be resized
FORMATS = {"JPEG": "jpeg", "MPO": "jpeg", "PNG": "png", "WEBP": "webp"}


@dataclass
class ImageAnalysis:
    width: int
    height: int
    has_transparency: bool
    background_rgb: tuple[int, int, int]
    background_uniform: bool
    background_complexity: str  # "clean" | "low" | "medium" | "high"
    product_box: Box | None  # at working-image size (border-difference estimate, plain backgrounds)
    product_coverage: float | None
    product_touches_edge: bool | None
    needs_resize: bool
    needs_centering: bool | None
    needs_background_removal: bool
    already_acceptable: bool
    not_acceptable_because: list[str]
    recommended_route: str  # "no_change" | "local" | "replicate"
    analysis_confidence: float

    def as_dict(self) -> dict[str, object]:
        return {
            "already_acceptable": self.already_acceptable,
            "needs_resize": self.needs_resize,
            "needs_centering": self.needs_centering,
            "needs_background_removal": self.needs_background_removal,
            "background_complexity": self.background_complexity,
            "product_coverage": None if self.product_coverage is None else round(self.product_coverage, 4),
            "product_touches_edge": self.product_touches_edge,
            "has_transparency": self.has_transparency,
            "recommended_route": self.recommended_route,
            "analysis_confidence": round(self.analysis_confidence, 3),
        }


def _delta_e(lab: np.ndarray, ref: np.ndarray) -> np.ndarray:
    return np.sqrt(((lab - ref) ** 2).sum(axis=-1))


def _rgb_lab(rgb: tuple[int, int, int]) -> np.ndarray:
    return to_lab_fast(np.array([[rgb]], dtype=np.uint8))[0, 0]


def background_complexity(rgb: np.ndarray, border: BorderStats) -> tuple[str, float]:
    """clean / low / medium / high from the border band's colour spread and edge density."""
    small = downscale_to(rgb, 512)
    h, w = small.shape[:2]
    band = max(3, round(0.06 * min(h, w)))
    ring = np.zeros((h, w), dtype=bool)
    ring[:band, :] = ring[-band:, :] = True
    ring[:, :band] = ring[:, -band:] = True
    edges = cv2.Canny(cv2.cvtColor(small, cv2.COLOR_RGB2GRAY), 60, 160) > 0
    density = float(edges[ring].mean())
    if border.uniform and border.uniform_fraction >= 0.98 and density < 0.01:
        return "clean", density
    if border.uniform and density < 0.04:
        return "low", density
    if border.uniform_fraction >= 0.5 and density < 0.08:
        return "medium", density
    return "high", density


def _source_facts(data: bytes) -> tuple[str | None, bool]:
    """(output format name of the source, whether it carries a non-trivial EXIF rotation)."""
    try:
        with Image.open(io.BytesIO(data)) as img:
            fmt = FORMATS.get(img.format or "")
            rotated = img.getexif().get(ExifTags.Base.Orientation, 1) not in (1, None)
            return fmt, rotated
    except Exception:  # noqa: BLE001 - decoding problems surface in load_image
        return None, True


def analyze_image(
    data: bytes,
    src: NormalizedImage,
    border: BorderStats,
    settings: ProcessSettings,
    *,
    max_output_bytes: int = 0,
    max_output_pixels: int = 0,
) -> ImageAnalysis:
    """``max_output_*``: the service's output limits (0 = none); a source over them can't be
    returned as it is."""
    rgb = src.rgb
    w, h = image_size(rgb)
    complexity, _density = background_complexity(rgb, border)
    why: list[str] = []

    # Product box from the border difference (only meaningful on plain backgrounds).
    box: Box | None = None
    coverage: float | None = None
    touches: bool | None = None
    if border.uniform:
        mask = border_difference_mask(rgb, long_side=ANALYSIS_LONG_SIDE)
        analysis = analyze_mask(mask, mask, min_fragment_frac=0.005)
        if analysis.bbox is not None:
            mh, mw = mask.shape[:2]
            box = analysis.bbox.scaled(w / mw, (w, h))
            coverage = float(analysis.coverage)
            touches = box.x0 <= 0 or box.y0 <= 0 or box.x1 >= w or box.y1 >= h

    fmt, rotated = _source_facts(data)
    aw, ah = ASPECTS[settings.aspect]
    aspect_ok = abs((src.width / src.height) / (aw / ah) - 1.0) <= ASPECT_TOLERANCE
    needs_resize = src.width > settings.target_px * RESIZE_TOLERANCE or (w, h) != (src.width, src.height)
    upscale_due = settings.upscale and min(src.width, src.height) < settings.upscale_threshold_px

    bg_lab = _rgb_lab(settings.bg_rgb)
    border_matches = bool(_delta_e(_rgb_lab(border.median_rgb), bg_lab) <= BG_MATCH_DELTA_E)
    needs_bg = settings.remove_bg and not (border.uniform and border_matches and src.alpha is None)

    needs_centering: bool | None = None
    if box is not None:
        m = settings.margin_pct
        left, right = 100.0 * box.x0 / w, 100.0 * (w - box.x1) / w
        top, bottom = 100.0 * box.y0 / h, 100.0 * (h - box.y1) / h
        centred = abs((box.x0 + box.x1) / 2 / w - 0.5) <= CENTRE_TOLERANCE and (
            abs((box.y0 + box.y1) / 2 / h - 0.5) <= CENTRE_TOLERANCE
        )
        # The planner fits the product to the margin on its limiting axis and centres the other.
        min_margin_ok = min(left, right, top, bottom) >= m - MARGIN_TOLERANCE
        fitted = min(max(left, right), max(top, bottom)) <= m + MARGIN_TOLERANCE
        needs_centering = not (centred and min_margin_ok and fitted)

    # --- already acceptable? (all must hold) ------------------------------------------------
    if src.alpha is not None:
        why.append("has_transparency")
    if not aspect_ok:
        why.append("aspect")
    if needs_resize:
        why.append("resize")
    if upscale_due:
        why.append("upscale_requested")
    if fmt is None or fmt != settings.output_format:
        why.append("format")
    if rotated or src.icc_converted:
        why.append("rotation_or_colour_profile")
    if (max_output_bytes and len(data) > max_output_bytes) or (
        max_output_pixels and src.width * src.height > max_output_pixels
    ):
        why.append("over_output_limits")
    if box is None:
        why.append("no_product_box")
    elif needs_centering:
        why.append("centering_or_margins")
    if settings.remove_bg:
        if not border_matches or not border.uniform:
            why.append("background_colour")
        elif box is not None:
            # Everything outside the product box (slightly grown) must already be the background.
            small = downscale_to(rgb, ANALYSIS_LONG_SIDE)
            sh, sw = small.shape[:2]
            s = sw / w
            grow = max(2, round(0.02 * max(box.width, box.height) * s))
            outside = np.ones((sh, sw), dtype=bool)
            outside[
                max(0, round(box.y0 * s) - grow) : min(sh, round(box.y1 * s) + grow),
                max(0, round(box.x0 * s) - grow) : min(sw, round(box.x1 * s) + grow),
            ] = False
            if outside.any():
                clean = float((_delta_e(to_lab_fast(small)[outside], bg_lab) <= BG_CLEAN_DELTA_E).mean())
                if clean < BG_CLEAN_SHARE:
                    why.append("background_not_clean")
    elif not border.uniform:
        why.append("background_not_plain")

    acceptable = not why
    if acceptable:
        route, confidence = "no_change", 0.97
    else:
        route = "local"
        # How sure the analysis is about what the photo needs: plain backgrounds are easy to read.
        confidence = {"clean": 0.95, "low": 0.9, "medium": 0.75, "high": 0.6}[complexity]
    return ImageAnalysis(
        width=src.width,
        height=src.height,
        has_transparency=src.alpha is not None,
        background_rgb=border.median_rgb,
        background_uniform=border.uniform,
        background_complexity=complexity,
        product_box=box,
        product_coverage=coverage,
        product_touches_edge=touches,
        needs_resize=needs_resize,
        needs_centering=needs_centering,
        needs_background_removal=needs_bg,
        already_acceptable=acceptable,
        not_acceptable_because=why,
        recommended_route=route,
        analysis_confidence=confidence,
    )
