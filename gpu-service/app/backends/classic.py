"""Classic (no-ML) backend for local dev / CI, plus border analysis used by every backend.

Segmentation: model the background from the image border (robust bilinear fit in Lab),
threshold the colour distance with hysteresis, clean up morphologically, keep significant
components and soften the edge. Works well for products shot on near-uniform backgrounds.
"""

from __future__ import annotations

from dataclasses import dataclass

import cv2
import numpy as np

from ..ops import downscale_to, lanczos_upscale, to_lab_fast
from .base import Backend, Segmenter, UpscaleFactor, Upscaler

WORK_LONG_SIDE = 1024  # classic "model resolution"
UNIFORM_DELTA_E = 10.0  # border pixel counts as background-coloured within this ΔE76
UNIFORM_FRACTION = 0.9  # ... and the border is "near-uniform" when this share of it is
# Enclosed "holes" in a product (white labels, highlights) are far more common in product
# photos than real see-through holes, and colour alone can't tell them apart: fill holes
# smaller than a quarter of the image.
HOLE_FILL_FRACTION = 0.25
MIN_COMPONENT_REL = 0.005  # drop components < 0.5% of the largest one
MIN_COMPONENT_ABS = 0.0001  # ... or < 0.01% of the image


# --------------------------------------------------------------------------------------
# Border analysis
# --------------------------------------------------------------------------------------
@dataclass(frozen=True)
class BorderStats:
    median_rgb: tuple[int, int, int]  # padding colour ("median edge colour")
    uniform: bool  # near-uniform (low colour variance) border
    uniform_fraction: float  # share of border pixels within UNIFORM_DELTA_E of the median


def _border_mask(h: int, w: int, band: int) -> np.ndarray:
    mask = np.zeros((h, w), dtype=bool)
    mask[:band, :] = True
    mask[-band:, :] = True
    mask[:, :band] = True
    mask[:, -band:] = True
    return mask


def analyze_border(rgb: np.ndarray) -> BorderStats:
    """Median edge colour and whether the border is near-uniform."""
    small = downscale_to(rgb, 512)
    h, w = small.shape[:2]
    band = max(2, round(0.02 * min(h, w)))
    pixels = small[_border_mask(h, w, band)]
    median = np.median(pixels, axis=0).round().astype(np.uint8)
    lab = to_lab_fast(pixels[None, :, :])[0]
    median_lab = to_lab_fast(median[None, None, :])[0, 0]
    fraction = float((np.linalg.norm(lab - median_lab, axis=1) <= UNIFORM_DELTA_E).mean())
    return BorderStats(
        median_rgb=(int(median[0]), int(median[1]), int(median[2])),
        uniform=fraction >= UNIFORM_FRACTION,
        uniform_fraction=fraction,
    )


# --------------------------------------------------------------------------------------
# Border-difference segmentation
# --------------------------------------------------------------------------------------
# A curved (vignette) background model is only used when it explains the border
# clearly better than the bilinear one.
CURVED_FIT_GAIN = 0.8


def _design(xn: np.ndarray, yn: np.ndarray, curved: bool = False) -> np.ndarray:
    """Bilinear basis [1, x, y, xy]; `curved` adds x², y² for vignettes (bright centre, darker edges).

    The bilinear field keeps its extremes at the corners, so it can't invent interior
    bumps, but it also can't model a vignette, whose centre is brighter than any border
    pixel; the brighter middle then reads as "product".
    """
    cols = [np.ones_like(xn), xn, yn, xn * yn]
    if curved:
        cols += [xn * xn, yn * yn]
    return np.stack(cols, axis=-1)


def _robust_fit(design: np.ndarray, samples: np.ndarray) -> tuple[np.ndarray, float]:
    """Iteratively reweighted least squares, rejecting product pixels that touch the border."""
    inliers = np.ones(samples.shape[0], dtype=bool)
    coef = np.zeros((design.shape[1], 3))
    resid = np.zeros(samples.shape[0])
    for _ in range(4):
        coef, *_ = np.linalg.lstsq(design[inliers], samples[inliers], rcond=None)
        resid = np.linalg.norm(samples - design @ coef, axis=1)
        sigma = 1.4826 * float(np.median(resid[inliers])) + 1e-6
        new_inliers = resid < max(4.0, 2.5 * sigma)
        if new_inliers.sum() < 0.3 * samples.shape[0] or np.array_equal(new_inliers, inliers):
            break
        inliers = new_inliers
    return coef, 1.4826 * float(np.median(resid[inliers]))


def _fit_background(lab: np.ndarray, band: int) -> tuple[np.ndarray, float]:
    """Robustly fit a smooth background field to the border; returns (field HxWx3, noise)."""
    h, w = lab.shape[:2]
    ys, xs = np.nonzero(_border_mask(h, w, band))
    if ys.size > 40_000:
        pick = np.random.default_rng(0).choice(ys.size, 40_000, replace=False)
        ys, xs = ys[pick], xs[pick]
    xn = xs.astype(np.float64) / max(1, w - 1) * 2 - 1
    yn = ys.astype(np.float64) / max(1, h - 1) * 2 - 1
    samples = lab[ys, xs].astype(np.float64)

    coef, noise = _robust_fit(_design(xn, yn), samples)
    curved = False
    coef_c, noise_c = _robust_fit(_design(xn, yn, curved=True), samples)
    if noise_c < CURVED_FIT_GAIN * noise:
        coef, noise, curved = coef_c, noise_c, True

    gx = np.linspace(-1, 1, w)[None, :].repeat(h, 0)
    gy = np.linspace(-1, 1, h)[:, None].repeat(w, 1)
    field = _design(gx, gy, curved=curved) @ coef
    return field.astype(np.float32), noise


def _keep_significant(binary: np.ndarray) -> np.ndarray:
    n, labels, stats, _ = cv2.connectedComponentsWithStats(binary, connectivity=8)
    if n <= 1:
        return binary
    areas = stats[1:, cv2.CC_STAT_AREA]
    min_area = max(MIN_COMPONENT_REL * areas.max(), MIN_COMPONENT_ABS * binary.size)
    keep = np.zeros(n, dtype=bool)
    keep[1:] = areas >= min_area
    return keep[labels].astype(np.uint8)


def _fill_small_holes(binary: np.ndarray) -> np.ndarray:
    """Fill background regions fully enclosed by the product that are small."""
    h, w = binary.shape
    inv = (1 - binary).astype(np.uint8)
    n, labels, stats, _ = cv2.connectedComponentsWithStats(inv, connectivity=4)
    if n <= 1:
        return binary
    left, top = stats[:, cv2.CC_STAT_LEFT], stats[:, cv2.CC_STAT_TOP]
    right, bottom = left + stats[:, cv2.CC_STAT_WIDTH], top + stats[:, cv2.CC_STAT_HEIGHT]
    enclosed = (left > 0) & (top > 0) & (right < w) & (bottom < h)
    small = stats[:, cv2.CC_STAT_AREA] < HOLE_FILL_FRACTION * h * w
    fill = enclosed & small
    fill[0] = False
    out = binary.copy()
    out[fill[labels]] = 1
    return out


def border_difference_mask(rgb: np.ndarray, *, long_side: int = WORK_LONG_SIDE) -> np.ndarray:
    """Float32 [0,1] product mask at ≤ ``long_side`` resolution from border-colour difference."""
    small = downscale_to(rgb, long_side)
    h, w = small.shape[:2]
    lab = to_lab_fast(cv2.GaussianBlur(small, (0, 0), 0.8))
    band = max(3, round(0.03 * min(h, w)))
    field, noise = _fit_background(lab, band)
    dist = np.linalg.norm(lab - field, axis=2)

    t_low = max(6.0, 3.0 * noise)
    t_high = max(14.0, 6.0 * noise)
    weak = (dist > t_low).astype(np.uint8)
    n, labels = cv2.connectedComponents(weak, connectivity=8)
    keep = np.zeros(n, dtype=bool)
    keep[np.unique(labels[dist > t_high])] = True
    keep[0] = False
    binary = keep[labels].astype(np.uint8)

    k = max(3, round(0.008 * min(h, w))) | 1
    binary = cv2.morphologyEx(binary, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k)))
    binary = cv2.morphologyEx(binary, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3)))
    binary = _fill_small_holes(binary)
    binary = _keep_significant(binary)

    sigma = max(0.7, min(h, w) / 700.0)
    mask = cv2.GaussianBlur(binary.astype(np.float32), (0, 0), sigma)
    return np.clip(mask, 0.0, 1.0)


# --------------------------------------------------------------------------------------
# Backend
# --------------------------------------------------------------------------------------
class ClassicSegmenter(Segmenter):
    name = "classic-border-lab"
    in_process = True

    def predict(self, rgb: np.ndarray) -> np.ndarray:
        return border_difference_mask(rgb)


class LanczosUpscaler(Upscaler):
    """Lanczos + light unsharp mask. Not AI: ``upscale.applied`` stays false."""

    is_ai = False

    def model_name(self, scale: UpscaleFactor) -> str:
        return "lanczos"

    def upscale(self, rgb: np.ndarray, scale: UpscaleFactor) -> np.ndarray:
        return lanczos_upscale(rgb, float(scale))


def build_classic_backend() -> Backend:
    return Backend(
        kind="classic",
        device="cpu",
        segmenter=ClassicSegmenter(),
        upscaler=LanczosUpscaler(),
        models_loaded=["segmentation", "upscaler_x2", "upscaler_x4"],
    )
