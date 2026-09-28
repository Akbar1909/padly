"""Operation-aware quality checks that decide whether a result is good enough to keep.

Background removal (``assess_cutout``) — run on every model cut-out, and the reason a cheap
local result is escalated to a stronger (paid) model. Only checks that separate a weak cut-out
from a good one trigger escalation (calibrated on real product photos, local BiRefNet-lite vs
Replicate's full BiRefNet, 2026-09-27):
  * something was found, and not the whole photo;
  * edge confidence: share of undecided mask pixels (hair, glass, fine chains);
  * a label or logo on a solid part of the product is not cut through by a hole or a notch
    in the cut-out. A text box on the product's outer edge doesn't count, whether it is a
    false detection (polka dots, stripes, hair, a sole's tread) or a real label that the
    cut-out's outer edge runs through (one side of the product dropped; only the mirrored
    pass below may catch that, when the model's decision there is a knife-edge one);
  * no enclosed part of the product dropped: on a plain background, a hole in the cut-out
    that is clearly neither the background nor the product's own surroundings (sunglass
    lenses, a dark inner panel; not openwork showing the product's shadow);
  * the decision is stable: the same local model on the mirrored photo gives the same
    cut-out, up to edge jitter. A confidently wrong cut-out (a prop kept, a product or part
    of it missed, a background patch kept) is usually a knife-edge decision that flips
    (54-photo sweep, 2026-09-27, BiRefNet-lite at 512 px: 8 of 9 false passes caught, 4 of
    35 good photos escalated). Compared over the region the model saw (the crop, for a
    zoomed attempt), so a small product isn't judged at thumbnail size.
Recorded but never escalated, because a stronger model gives the same answer: the number of
separate pieces (a flat lay is several products), the rim of old background around the
edge (glass legitimately shows the background through it), and how much of the photo's
top, left or right edge the cut-out touches (the merchant is told: the product or a prop
may be cut off by the photo).

Output (``assess_output``) — run on every result; these are invariants of the canvas maths,
so a failure means a bug, never a reason to pay for AI:
  * requested aspect ratio and size, product fully on the canvas, centred, with at least the
    requested margin, and never enlarged by interpolation.

None of this is "similarity to the input": removing a background changes most pixels on
purpose, and a similarity score would reject exactly the edits merchants asked for.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import cv2
import numpy as np

from .backends.classic import BorderStats
from .canvas import ASPECTS, Box, CanvasPlan
from .checks import MaskAnalysis
from .config import ServiceConfig
from .ops import downscale_to, fit_long_side, image_size, resize_mask, to_lab_fast
from .text_detect import Rect

HALO_LONG_SIDE = 1024  # measure halos / holes at <= 1024 px
HALO_MATCH_DELTA_E = 8.0  # a rim pixel this close to the old background colour is "old background"
HALO_MIN_BG_CHANGE = 12.0  # skip the halo check when old and new backgrounds look alike
HOLE_FOREIGN_DELTA_E = 20.0  # a hole whose median colour is this far from the background isn't background
HOLE_MIN_AREA = 0.002  # ignore holes smaller than 0.2% of the product
HOLE_LOCAL_RING = (3.0, 8.0)  # px outside the cut-out (at <= 1024 px): the product's local background
HOLE_LOCAL_PX = 300  # a hole's local background: the ring pixels nearest to it (~60 px of ring)...
HOLE_LOCAL_WINDOW = 64  # ... found within this many px of the hole
HOLE_LOCAL_MIN_PX = 50  # fewer ring pixels near a hole: compare it with the border colour only
EMPTY_ESCALATE_MAX = 0.002  # "nothing found": escalate only below 0.2% (a thin chain covers ~1%)
TEXT_CUT_BAND = 0.25  # text kept at 25-85%: cut through; below 25%: text is background, removed on purpose
TEXT_SOLID_MIN = 0.8  # only text on a solid part of the product counts: the box's surround is mostly cut-out
# A box the silhouette's edge runs through, with more background around it, is an edge. Inert
# while TEXT_SOLID_MIN >= 1 - TEXT_EDGE_BG_MAX (a surround that is 80% cut-out has at most 20%
# background); it only takes effect if TEXT_SOLID_MIN is lowered.
TEXT_EDGE_BG_MAX = 0.2
FLIP_COMPARE_LONG_SIDE = 1024  # compare a mask with its mirrored-run twin at <= 1024 px...
FLIP_JITTER_PX = 3  # ... where disagreement thinner than ~7 px is edge jitter
UNSTABLE_PENALTY = 0.3  # score penalty for "unstable_cutout"
EDGE_CONTACT_FLAG = 0.05  # cut-out covers >= 5% of the photo's top, left or right edge: tell the merchant


@dataclass
class QualityReport:
    score: float  # 1.0 = every check passed
    reasons: list[str] = field(default_factory=list)  # machine-readable, e.g. "background_artifacts"
    checks: dict[str, float | bool | None] = field(default_factory=dict)
    # No check failed, but a measurement is close to its limit or a risk signal fired: the
    # result is UNCERTAIN, and a local one is escalated (``gate``).
    doubts: list[str] = field(default_factory=list)

    @property
    def passed(self) -> bool:
        return not self.reasons

    @property
    def confident(self) -> bool:
        return not self.reasons and not self.doubts

    @property
    def gate(self) -> str:
        """SAFE_LOCAL (every check passed with margin) / UNCERTAIN / FAILED."""
        if self.reasons:
            return "FAILED"
        return "UNCERTAIN" if self.doubts else "SAFE_LOCAL"


# Internal reason / doubt / flag names -> the structured codes callers count (the contract's
# reason_codes). Unknown names fall back to QUALITY_SCORE_UNCERTAIN.
REASON_CODES: dict[str, str] = {
    "empty_mask": "PRODUCT_NOT_FOUND",
    "full_mask": "BACKGROUND_NOT_REMOVED",
    "background_artifacts": "LOW_SEGMENTATION_CONFIDENCE",
    "unstable_cutout": "SEGMENTATION_UNSTABLE",
    "text_or_logo_cut": "TEXT_OR_LOGO_CHANGED",
    "dropped_inner_part": "PRODUCT_PART_MISSING",
    "crop_too_tight": "PRODUCT_TOUCHING_EDGE",
    "near_limit": "QUALITY_SCORE_UNCERTAIN",
    "fine_structure": "FINE_STRUCTURE",
    # merchant flags
    "mask_empty": "PRODUCT_NOT_FOUND",
    "mask_full": "BACKGROUND_NOT_REMOVED",
    "mask_fragmented": "BACKGROUND_ARTIFACTS",
    "mask_low_confidence": "LOW_SEGMENTATION_CONFIDENCE",
    "color_drift": "COLOR_SHIFT",
    "upscale_capped": "LOW_RESOLUTION",
    "fidelity_low": "DISTORTION_DETECTED",
    "text_detected": "TEXT_PRESENT",
    "output_check": "BAD_CENTERING",
    "edge_contact": "PRODUCT_TOUCHING_EDGE",
    # output checks
    "off_center": "BAD_CENTERING",
    "margins": "BAD_CENTERING",
    "product_cropped": "PRODUCT_TOUCHING_EDGE",
    "output_geometry": "DISTORTION_DETECTED",
    "enlarged_by_interpolation": "LOW_RESOLUTION",
    # routing
    "too_slow_on_cpu": "UPSCALE_TOO_LARGE_FOR_LOCAL",
    "replicate_unavailable": "ESCALATION_UNAVAILABLE",
    "not_escalated": "ESCALATION_UNAVAILABLE",
    "ai_result_unsafe": "AI_RESULT_UNSAFE",
    "forced": "FORCED_BY_MERCHANT",
    "rollout": "ROLLOUT_NOT_LOCAL",
    "shadow": "SHADOW_MODE",
    "complex_background": "COMPLEX_BACKGROUND",
    "busy_scene": "COMPLEX_BACKGROUND",
    "model_disagreement": "MODEL_DISAGREEMENT",
}


def reason_code(name: str) -> str:
    base = name.split(":", 1)[0].strip()
    return REASON_CODES.get(base, "QUALITY_SCORE_UNCERTAIN")


def _delta_e76(lab: np.ndarray, ref: np.ndarray) -> np.ndarray:
    return np.sqrt(((lab - ref) ** 2).sum(axis=-1))


def _rgb_lab(rgb: tuple[int, int, int]) -> np.ndarray:
    return to_lab_fast(np.array([[rgb]], dtype=np.uint8))[0, 0]


def _silhouette_runs_through(surround: np.ndarray, box: Box) -> bool:
    """Whether the cut-out's outer edge crosses ``box`` (in ``surround`` pixels), with more
    than ``TEXT_EDGE_BG_MAX`` of the surround outside the silhouette.

    Background in ``surround`` that reaches its border is outside the silhouette. A hole the
    cut-out punched through a label is enclosed by the product, so it doesn't count.
    """
    _, labels = cv2.connectedComponents((~surround).astype(np.uint8), connectivity=4)
    rim = np.unique(np.concatenate([labels[0], labels[-1], labels[:, 0], labels[:, -1]]))
    outside = np.isin(labels, rim[rim > 0])  # label 0 is the cut-out itself
    crossed = bool(outside[box.y0 : box.y1, box.x0 : box.x1].any())
    return crossed and float(outside.mean()) > TEXT_EDGE_BG_MAX


def text_coverage(mask: np.ndarray, bbox: Box, rects: tuple[Rect, ...], scale: float) -> float | None:
    """Lowest share of any on-product text box that the cut-out keeps (None = no text on it).

    ``rects`` are in the detector's input pixels; ``scale`` maps them onto ``mask``. A box counts
    when it is centred inside the product's bounding box and sits on a solid part of the product:
    its surround (the box padded by half its longer side) is at least ``TEXT_SOLID_MIN`` cut-out,
    and the silhouette's edge doesn't run through it. Text elsewhere (a sign in the room) may
    legitimately be removed with the background; "text" on a thin chain, or EAST boxes that
    straddle the product's edge (polka dots, stripes, hair, a sole's tread), are false detections.

    Scope: this catches a label that the cut-out cuts with a hole or a notch while the product
    around it is kept. A label that the cut-out's outer edge runs through (the model dropped a
    whole side of the product) leaves too much background around the box, so it is ignored by
    design, like the false detections above. With the current constants the surround rule
    already rejects every box the edge rule would (see ``TEXT_EDGE_BG_MAX``); the edge rule only
    matters if ``TEXT_SOLID_MIN`` is lowered.
    """
    h, w = mask.shape
    worst: float | None = None
    for x, y, bw, bh in rects:
        x0, y0 = int(x * scale), int(y * scale)
        x1, y1 = min(w, int((x + bw) * scale) + 1), min(h, int((y + bh) * scale) + 1)
        cx, cy = (x0 + x1) / 2.0, (y0 + y1) / 2.0
        if x1 <= x0 or y1 <= y0 or not (bbox.x0 <= cx < bbox.x1 and bbox.y0 <= cy < bbox.y1):
            continue
        kept = float((mask[y0:y1, x0:x1] > 0.5).mean())
        if kept < TEXT_CUT_BAND:
            continue  # the model confidently left it out: background text (or a false detection)
        pad = max(x1 - x0, y1 - y0) // 2
        sx0, sy0 = max(0, x0 - pad), max(0, y0 - pad)
        surround = mask[sy0 : min(h, y1 + pad), sx0 : min(w, x1 + pad)] > 0.5
        if float(surround.mean()) < TEXT_SOLID_MIN:
            continue  # not on a solid part of the product
        if _silhouette_runs_through(surround, Box(x0 - sx0, y0 - sy0, x1 - sx0, y1 - sy0)):
            continue  # on the product's edge
        worst = kept if worst is None else min(worst, kept)
    return worst


def _local_background(lab: np.ndarray, ring: np.ndarray, hole: np.ndarray) -> np.ndarray | None:
    """Median colour of the ``ring`` pixels nearest to ``hole`` (all arrays are one window)."""
    candidates = int(ring.sum())
    if candidates < HOLE_LOCAL_MIN_PX:
        return None
    dist = cv2.distanceTransform((~hole).astype(np.uint8), cv2.DIST_L2, 3)[ring]
    nearest = np.argsort(dist, kind="stable")[:HOLE_LOCAL_PX]
    return np.median(lab[ring][nearest], axis=0)


def dropped_inner_parts(rgb: np.ndarray, mask: np.ndarray, *, bg: tuple[int, int, int]) -> float:
    """Share of the product's area in enclosed holes that are clearly not background.

    A hole the cut-out leaves inside the product (a component of the background that doesn't
    reach the photo's edge) is normal when it shows the background (a mug handle, a chain
    loop), and a dropped part of the product when it doesn't (sunglass lenses, a dark panel).
    A hole is foreign only when its colour is far from both the plain border colour ``bg`` and
    its local background: the ``HOLE_LOCAL_PX`` ring pixels 3-8 px outside the cut-out that
    are nearest the hole (within ``HOLE_LOCAL_WINDOW``). Openwork jewellery shows the product's
    own shadow and warm reflections through its holes, and they fall just outside it too; a
    dark lens is far from both. Known limit: a dark lens right next to an equally dark contact
    shadow (within ΔE ``HOLE_FOREIGN_DELTA_E``) matches its local background and isn't counted.
    """
    small = downscale_to(rgb, HALO_LONG_SIDE)
    h, w = small.shape[:2]
    m = resize_mask(mask.astype(np.float32, copy=False), (w, h)) > 0.5
    product = int(m.sum())
    if product == 0:
        return 0.0
    n, labels, stats, _ = cv2.connectedComponentsWithStats((~m).astype(np.uint8), connectivity=4)
    x, y, bw, bh, area = (stats[:, i] for i in range(5))
    outer = (x == 0) | (y == 0) | (x + bw >= w) | (y + bh >= h)  # reaches the edge: outside the product
    outer[0] = False  # label 0 is the product itself
    holes = [i for i in range(1, n) if not outer[i] and area[i] >= HOLE_MIN_AREA * product]
    if not holes:
        return 0.0
    lab = to_lab_fast(small)
    bg_lab = _rgb_lab(bg)
    near, far = HOLE_LOCAL_RING
    dist = cv2.distanceTransform((~m).astype(np.uint8), cv2.DIST_L2, 3)  # px to the nearest product pixel
    ring = outer[labels] & (dist > near) & (dist <= far)
    dropped = 0
    for i in holes:
        pad = HOLE_LOCAL_WINDOW
        win = (slice(max(0, y[i] - pad), y[i] + bh[i] + pad), slice(max(0, x[i] - pad), x[i] + bw[i] + pad))
        hole = labels[win] == i
        pixels = lab[win][hole]
        if float(np.median(_delta_e76(pixels, bg_lab))) <= HOLE_FOREIGN_DELTA_E:
            continue  # shows the background
        local = _local_background(lab[win], ring[win], hole)
        if local is not None and float(np.median(_delta_e76(pixels, local))) <= HOLE_FOREIGN_DELTA_E:
            continue  # shows what surrounds the product: its shadow or reflections
        dropped += int(area[i])
    return dropped / product


def halo_fraction(
    rgb: np.ndarray, mask: np.ndarray, *, old_bg: tuple[int, int, int], new_bg: tuple[int, int, int]
) -> float | None:
    """Share of the cut-out's outer rim that is really the old background (None = not measurable).

    Only meaningful when the old background was plain and visibly differs from the new one;
    otherwise a leftover rim is invisible and the check is skipped.
    """
    old_lab, new_lab = _rgb_lab(old_bg), _rgb_lab(new_bg)
    if float(np.sqrt(((old_lab - new_lab) ** 2).sum())) < HALO_MIN_BG_CHANGE:
        return None
    small = downscale_to(rgb, HALO_LONG_SIDE)
    m = resize_mask(mask.astype(np.float32, copy=False), image_size(small)) > 0.5
    rim = m & ~cv2.erode(m.astype(np.uint8), np.ones((5, 5), np.uint8)).astype(bool)  # ~2 px wide
    if int(rim.sum()) < 50:
        return None
    lab = to_lab_fast(small)
    return float((_delta_e76(lab[rim], old_lab) < HALO_MATCH_DELTA_E).mean())


def flip_compare_size(width: int, height: int) -> tuple[int, int]:
    """(width, height) at which a region of this size is compared with its mirrored run."""
    if max(width, height) <= FLIP_COMPARE_LONG_SIDE:
        return width, height
    return fit_long_side(width, height, FLIP_COMPARE_LONG_SIDE)


def flip_disagreement(mask: np.ndarray, flipped: np.ndarray, *, outside: Box | None = None) -> float:
    """Share of the cut-out that changes when the same model sees the mirrored photo.

    ``flipped`` is the model's mask for the mirrored input, mirrored back, over the same region
    as ``mask`` (any resolution with the same aspect ratio; the pipeline passes it at the
    comparison size). An opening removes thin edge jitter, so only whole regions count: a prop
    kept by one run only, a missing product or part, a background patch. With ``outside`` (a
    Box in ``mask`` pixels) only disagreement outside it counts (the refine path: a product the
    zoomed crop could not see). Measured at <= 1024 px, relative to the larger of the two masks.
    """
    h, w = mask.shape[:2]
    size = flip_compare_size(w, h)
    a = resize_mask(mask.astype(np.float32, copy=False), size) > 0.5
    b = resize_mask(flipped.astype(np.float32, copy=False), size) > 0.5
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * FLIP_JITTER_PX + 1, 2 * FLIP_JITTER_PX + 1))
    diff = cv2.morphologyEx((a ^ b).astype(np.uint8), cv2.MORPH_OPEN, k)
    if outside is not None:
        box = outside.scaled(size[0] / w, size)
        diff[box.y0 : box.y1, box.x0 : box.x1] = 0
    return float(diff.sum()) / max(1, int(a.sum()), int(b.sum()))


def photo_edge_contact(mask: np.ndarray) -> float:
    """Largest share of the photo's top, left or right edge that the cut-out covers.

    The bottom is ignored: products stand on it, and people are cropped there.
    """
    m = mask > 0.5
    return float(max(m[0].mean(), m[:, 0].mean(), m[:, -1].mean()))


def assess_cutout(
    analysis: MaskAnalysis,
    rgb: np.ndarray,
    *,
    border: BorderStats,
    text_rects: tuple[Rect, ...],
    text_scale: float,
    new_bg: tuple[int, int, int],
    cfg: ServiceConfig,
    flipped: np.ndarray | None = None,
    flipped_region: Box | None = None,
) -> QualityReport:
    """Is this cut-out good enough to show a merchant without trying a stronger model?

    ``flipped`` is the same model's mask for the mirrored input (see ``flip_disagreement``);
    None when no mirrored pass ran (a paid model, or the check is off). It covers
    ``flipped_region`` of the frame (the crop a zoomed attempt's model saw), or the whole frame
    when that is None, and the two are compared there: at the scale the model saw the product.
    """
    report = QualityReport(score=1.0)
    checks, reasons = report.checks, report.reasons
    penalty = 0.0

    checks["coverage"] = round(analysis.coverage, 4)
    if analysis.bbox is None or analysis.coverage < EMPTY_ESCALATE_MAX:
        reasons.append("empty_mask")
        penalty += 0.6
    elif analysis.coverage > cfg.mask_full_min:
        reasons.append("full_mask")
        penalty += 0.6

    checks["fragments"] = analysis.fragments  # recorded only: a flat lay is several products

    checks["edge_uncertainty"] = round(analysis.uncertainty, 4)
    limit = cfg.escalate_mask_uncertainty
    if limit > 0 and analysis.uncertainty > limit:
        reasons.append("background_artifacts")
        penalty += min(0.35, 0.1 + 0.25 * (analysis.uncertainty - limit) / limit)

    checks["text_kept"] = None
    if analysis.bbox is not None and text_rects:
        kept = text_coverage(analysis.cleaned, analysis.bbox, text_rects, text_scale)
        checks["text_kept"] = round(kept, 3) if kept is not None else None
        if kept is not None and kept < cfg.escalate_text_coverage_min:
            reasons.append("text_or_logo_cut")
            penalty += 0.3

    checks["halo"] = None  # recorded only (see the module docstring)
    checks["dropped_inner_parts"] = None
    if border.uniform and analysis.bbox is not None:
        halo = halo_fraction(rgb, analysis.cleaned, old_bg=border.median_rgb, new_bg=new_bg)
        checks["halo"] = round(halo, 4) if halo is not None else None
        dropped = dropped_inner_parts(rgb, analysis.cleaned, bg=border.median_rgb)
        checks["dropped_inner_parts"] = round(dropped, 4)
        if dropped > cfg.escalate_dropped_parts_max:
            reasons.append("dropped_inner_part")
            penalty += min(0.4, 0.15 + 5.0 * dropped)

    checks["flip_disagreement"] = None
    checks["flip_compare_px"] = None
    limit = cfg.escalate_flip_disagreement
    if flipped is not None and analysis.bbox is not None and limit > 0:
        own = analysis.cleaned
        if flipped_region is not None:
            r = flipped_region
            own = own[r.y0 : r.y1, r.x0 : r.x1]
        disagreement = flip_disagreement(own, flipped)
        checks["flip_disagreement"] = round(disagreement, 4)
        checks["flip_compare_px"] = float(max(flip_compare_size(own.shape[1], own.shape[0])))
        if disagreement > limit:
            reasons.append("unstable_cutout")
            penalty += UNSTABLE_PENALTY

    # Recorded only; the pipeline tells the merchant when the kept cut-out touches the edge.
    checks["edge_contact"] = round(photo_edge_contact(analysis.cleaned), 4) if analysis.bbox is not None else None

    # --- doubts: no failure, but not enough margin to skip the stronger model ------------------
    doubts = report.doubts
    band = cfg.uncertain_band
    relative = analysis.uncertainty / max(analysis.coverage, 1e-6) if analysis.bbox is not None else None
    checks["relative_uncertainty"] = round(relative, 4) if relative is not None else None
    if not reasons and analysis.bbox is not None:
        near = []
        flip = checks.get("flip_disagreement")
        if isinstance(flip, float) and cfg.escalate_flip_disagreement > 0:
            if flip >= band * cfg.escalate_flip_disagreement:
                near.append("flip")
        if cfg.escalate_mask_uncertainty > 0 and analysis.uncertainty >= band * cfg.escalate_mask_uncertainty:
            near.append("uncertainty")
        dropped_v = checks.get("dropped_inner_parts")
        if isinstance(dropped_v, float) and dropped_v >= band * cfg.escalate_dropped_parts_max:
            near.append("dropped")
        text_v = checks.get("text_kept")
        if isinstance(text_v, float) and text_v < 1.0 - band * (1.0 - cfg.escalate_text_coverage_min):
            near.append("text")
        if near:
            doubts.append("near_limit:" + ",".join(near))
        if (
            relative is not None
            and cfg.escalate_relative_uncertainty > 0
            and relative >= cfg.escalate_relative_uncertainty
        ):
            doubts.append("fine_structure")

    report.score = round(max(0.0, 1.0 - penalty - 0.1 * len(doubts)), 3)
    return report


def product_box(canvas_mask: np.ndarray) -> Box | None:
    ys, xs = np.nonzero(canvas_mask > 0.5)
    if xs.size == 0:
        return None
    return Box(int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1)


def assess_output(
    plan: CanvasPlan,
    canvas_mask: np.ndarray,
    *,
    aspect: str,
    margin_pct: float,
    output_size: tuple[int, int],
) -> QualityReport:
    """Geometry invariants of the final canvas (``output_size`` = encoded width, height)."""
    report = QualityReport(score=1.0)
    checks, reasons = report.checks, report.reasons
    w, h = output_size
    aw, ah = ASPECTS[aspect]

    checks["aspect_ok"] = abs(w * ah - h * aw) <= max(aw, ah)  # exact up to 1 px rounding
    checks["dimensions_ok"] = (canvas_mask.shape[1], canvas_mask.shape[0]) == (plan.width, plan.height)
    if not (checks["aspect_ok"] and checks["dimensions_ok"]):
        reasons.append("output_geometry")

    checks["not_enlarged"] = plan.scale <= 1.0 + 1e-6
    if not checks["not_enlarged"]:
        reasons.append("enlarged_by_interpolation")

    box = product_box(canvas_mask)
    cw, ch = plan.width, plan.height
    if box is None:
        checks.update(fully_visible=None, margins_ok=None, centered=None)
    else:
        tol_x, tol_y = max(2.0, 0.01 * cw), max(2.0, 0.01 * ch)
        edge = canvas_mask > 0.5
        checks["fully_visible"] = not (edge[0].any() or edge[-1].any() or edge[:, 0].any() or edge[:, -1].any())
        mx, my = margin_pct / 100.0 * cw, margin_pct / 100.0 * ch
        margins = (box.x0, cw - box.x1, box.y0, ch - box.y1)
        checks["min_margin_px"] = int(min(margins))
        checks["margins_ok"] = min(margins[0], margins[1]) >= mx - tol_x and min(margins[2], margins[3]) >= my - tol_y
        off_x = abs((box.x0 + box.x1) / 2.0 - cw / 2.0)
        off_y = abs((box.y0 + box.y1) / 2.0 - ch / 2.0)
        checks["centered"] = off_x <= max(2.0, 0.015 * cw) and off_y <= max(2.0, 0.015 * ch)
        if not checks["fully_visible"]:
            reasons.append("product_cropped")
        if not checks["margins_ok"]:
            reasons.append("margins")
        if not checks["centered"]:
            reasons.append("off_center")

    report.score = round(max(0.0, 1.0 - 0.25 * len(reasons)), 3)
    return report
