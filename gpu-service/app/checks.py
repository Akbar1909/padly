"""Quality checks: mask metrics, upscale fidelity, product colour drift, and their flags."""

from __future__ import annotations

from dataclasses import dataclass

import cv2
import numpy as np
from skimage.color import deltaE_ciede2000
from skimage.metrics import structural_similarity

from .canvas import Box
from .config import ServiceConfig
from .ops import downscale_to, fit_max_pixels, image_size, luminance, resize_mask, resize_rgb, to_lab
from .schemas import Flag, Severity

FIDELITY_MAX_PIXELS = 2_000_000  # compare at ≤ 2 MP (SSIM) ...
DELTA_E_LONG_SIDE = 512  # ... and ≤ 512 px long side (ΔE, CIEDE2000 is slow)
DRIFT_LONG_SIDE = 768
MASK_EMPTY_BOX_FRAC = 0.01  # a low-coverage cut-out whose bounding box spans less than this is "empty"


def flag(code: str, message: str, severity: Severity = "warning") -> Flag:
    return Flag(code=code, severity=severity, message=message)


# --------------------------------------------------------------------------------------
# Mask metrics
# --------------------------------------------------------------------------------------
@dataclass
class MaskAnalysis:
    coverage: float  # fraction of pixels with p > 0.5
    fragments: int  # significant connected components
    uncertainty: float  # fraction of model-resolution pixels with 0.2 < p < 0.8
    bbox: Box | None  # union of significant components (None = nothing found)
    cleaned: np.ndarray  # full-res mask with insignificant fragments removed


def analyze_mask(full_mask: np.ndarray, model_mask: np.ndarray, *, min_fragment_frac: float) -> MaskAnalysis:
    """Compute coverage / fragments / uncertainty and the product bounding box.

    Components smaller than ``min_fragment_frac`` of the largest component are "tiny": they
    are ignored for the bbox and fragment count, and erased from the returned mask.
    """
    binary = (full_mask > 0.5).astype(np.uint8)
    coverage = float(binary.mean())
    uncertainty = float(((model_mask > 0.2) & (model_mask < 0.8)).mean())

    n, labels, stats, _ = cv2.connectedComponentsWithStats(binary, connectivity=8)
    if n <= 1:
        return MaskAnalysis(coverage, 0, uncertainty, None, full_mask)

    areas = stats[1:, cv2.CC_STAT_AREA]
    largest = int(areas.max())
    significant = np.flatnonzero(areas >= max(1.0, min_fragment_frac * largest)) + 1
    tiny = np.flatnonzero(areas < max(1.0, min_fragment_frac * largest)) + 1

    lefts = stats[significant, cv2.CC_STAT_LEFT]
    tops = stats[significant, cv2.CC_STAT_TOP]
    rights = lefts + stats[significant, cv2.CC_STAT_WIDTH]
    bottoms = tops + stats[significant, cv2.CC_STAT_HEIGHT]
    bbox = Box(int(lefts.min()), int(tops.min()), int(rights.max()), int(bottoms.max()))

    cleaned = full_mask
    if tiny.size:
        lut = np.zeros(n, dtype=bool)
        lut[tiny] = True
        tiny_px = lut[labels].astype(np.uint8)
        keep_lut = np.zeros(n, dtype=bool)
        keep_lut[significant] = True
        halo = cv2.dilate(tiny_px, np.ones((5, 5), np.uint8)).astype(bool) & ~keep_lut[labels]
        cleaned = full_mask.copy()
        cleaned[halo] = 0.0

    return MaskAnalysis(coverage, int(significant.size), uncertainty, bbox, cleaned)


def mask_flags(analysis: MaskAnalysis, cfg: ServiceConfig) -> list[Flag]:
    """Contract flags ``mask_empty`` / ``mask_full`` / ``mask_fragmented`` / ``mask_low_confidence``."""
    flags: list[Flag] = []
    # "Nothing found" means no product, or only a speck. A small product in a big photo, or a
    # thin necklace, also covers under 2% of the pixels but spans a real area: not empty.
    h, w = analysis.cleaned.shape[:2]
    box_frac = analysis.bbox.width * analysis.bbox.height / float(w * h) if analysis.bbox else 0.0
    if analysis.bbox is None or (analysis.coverage < cfg.mask_empty_max and box_frac < MASK_EMPTY_BOX_FRAC):
        flags.append(
            flag(
                "mask_empty",
                f"Almost nothing was detected as product ({analysis.coverage:.1%} of the image)",
                "error",
            )
        )
    if analysis.coverage > cfg.mask_full_min:
        flags.append(
            flag(
                "mask_full",
                f"The cut-out covers {analysis.coverage:.0%} of the image; the background may not have been removed",
            )
        )
    if analysis.fragments > cfg.mask_fragments_max:
        flags.append(flag("mask_fragmented", f"The cut-out is split into {analysis.fragments} separate pieces"))
    if analysis.uncertainty > cfg.mask_uncertainty_max:
        flags.append(flag("mask_low_confidence", "Cut-out edges are uncertain (glass, hair or jewelry?)"))
    return flags


# --------------------------------------------------------------------------------------
# Upscale fidelity
# --------------------------------------------------------------------------------------
def fidelity(original: np.ndarray, upscaled: np.ndarray) -> tuple[float, float]:
    """Shrink ``upscaled`` back to the original size and compare with the original.

    Returns (SSIM on luminance, mean CIEDE2000 ΔE on lightly blurred images).
    """
    size = image_size(original)
    down = resize_rgb(upscaled, size)
    cmp_size = fit_max_pixels(size[0], size[1], FIDELITY_MAX_PIXELS)
    a, b = resize_rgb(original, cmp_size), resize_rgb(down, cmp_size)

    min_side = min(a.shape[0], a.shape[1])
    if min_side >= 11:  # Wang et al. settings: 11x11 Gaussian window, sigma 1.5
        ssim = float(
            structural_similarity(
                luminance(a),
                luminance(b),
                data_range=255.0,
                gaussian_weights=True,
                sigma=1.5,
                use_sample_covariance=False,
            )
        )
    elif min_side >= 3:  # tiny images: largest odd uniform window that fits
        win = min_side if min_side % 2 == 1 else min_side - 1
        ssim = float(structural_similarity(luminance(a), luminance(b), data_range=255.0, win_size=win))
    else:
        ssim = 1.0 if np.array_equal(a, b) else 0.0

    blur_a = cv2.GaussianBlur(a, (0, 0), 1.0)
    blur_b = cv2.GaussianBlur(b, (0, 0), 1.0)
    small_a = downscale_to(blur_a, DELTA_E_LONG_SIDE)
    small_b = downscale_to(blur_b, DELTA_E_LONG_SIDE)
    delta_e = float(np.mean(deltaE_ciede2000(to_lab(small_a), to_lab(small_b))))
    return ssim, delta_e


def fidelity_flags(ssim: float, delta_e: float, cfg: ServiceConfig) -> list[Flag]:
    if ssim < cfg.fidelity_ssim_min or delta_e > cfg.fidelity_delta_e_max:
        return [
            flag(
                "fidelity_low",
                f"The upscaled image deviates from the original (SSIM {ssim:.2f}, ΔE {delta_e:.1f})",
            )
        ]
    return []


# --------------------------------------------------------------------------------------
# Colour drift
# --------------------------------------------------------------------------------------
def mean_lab(rgb: np.ndarray, mask: np.ndarray, *, min_pixels: int = 32) -> np.ndarray | None:
    """Mean L*a*b* of confident product pixels (p > 0.9; falls back to p > 0.5)."""
    small = downscale_to(rgb, DRIFT_LONG_SIDE)
    m = resize_mask(mask, image_size(small))
    for threshold in (0.9, 0.5):
        sel = m > threshold
        if int(sel.sum()) >= min_pixels:
            pixels = small[sel][None, :, :]
            return to_lab(pixels).reshape(-1, 3).mean(axis=0)
    return None


def color_drift(
    original: np.ndarray,
    original_mask: np.ndarray,
    output: np.ndarray,
    output_mask: np.ndarray,
) -> float | None:
    """CIEDE2000 between the mean product colour in the original and in the output."""
    a = mean_lab(original, original_mask)
    b = mean_lab(output, output_mask)
    if a is None or b is None:
        return None
    return float(deltaE_ciede2000(a[None, :], b[None, :])[0])


def color_drift_flags(delta_e: float | None, cfg: ServiceConfig) -> list[Flag]:
    if delta_e is not None and delta_e > cfg.color_drift_delta_e_max:
        return [flag("color_drift", f"The product colour changed noticeably (ΔE {delta_e:.1f})")]
    return []
