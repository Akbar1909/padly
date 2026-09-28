"""Small numpy/OpenCV helpers shared by the pipeline modules."""

from __future__ import annotations

import math

import cv2
import numpy as np
from skimage.color import rgb2lab

Size = tuple[int, int]  # (width, height)


def image_size(arr: np.ndarray) -> Size:
    """(width, height) of an HxW[xC] array."""
    return int(arr.shape[1]), int(arr.shape[0])


def fit_long_side(width: int, height: int, long_side: int) -> Size:
    """Size with the given long side, preserving aspect ratio (each side ≥ 1)."""
    ratio = long_side / max(width, height)
    return max(1, round(width * ratio)), max(1, round(height * ratio))


def fit_max_pixels(width: int, height: int, max_pixels: int) -> Size:
    """Shrink (never enlarge) so that width*height ≤ max_pixels."""
    if width * height <= max_pixels:
        return width, height
    ratio = math.sqrt(max_pixels / (width * height))
    w, h = max(1, math.floor(width * ratio)), max(1, math.floor(height * ratio))
    return w, h


def resize_rgb(arr: np.ndarray, size: Size) -> np.ndarray:
    """Resize a uint8 image: area-averaging when shrinking, Lanczos when enlarging."""
    if image_size(arr) == size:
        return arr
    shrinking = size[0] * size[1] < arr.shape[0] * arr.shape[1]
    interp = cv2.INTER_AREA if shrinking else cv2.INTER_LANCZOS4
    return cv2.resize(arr, size, interpolation=interp)


def resize_mask(mask: np.ndarray, size: Size) -> np.ndarray:
    """Resize a float32 [0,1] mask: area when shrinking, bicubic (clipped) when enlarging."""
    if image_size(mask) == size:
        return mask.astype(np.float32, copy=False)
    src = mask.astype(np.float32, copy=False)
    shrinking = size[0] * size[1] < src.shape[0] * src.shape[1]
    out = cv2.resize(src, size, interpolation=cv2.INTER_AREA if shrinking else cv2.INTER_CUBIC)
    return np.clip(out, 0.0, 1.0, out=out)


def downscale_to(arr: np.ndarray, long_side: int) -> np.ndarray:
    """Shrink so the long side is at most ``long_side`` (no-op for smaller images)."""
    w, h = image_size(arr)
    if max(w, h) <= long_side:
        return arr
    size = fit_long_side(w, h, long_side)
    return resize_mask(arr, size) if arr.dtype == np.float32 else resize_rgb(arr, size)


def to_lab(rgb: np.ndarray) -> np.ndarray:
    """sRGB uint8 → CIE L*a*b* (D65) float64 via scikit-image (accurate, for checks)."""
    return rgb2lab(rgb)


def to_lab_fast(rgb: np.ndarray) -> np.ndarray:
    """sRGB uint8 → CIE L*a*b* float32 via OpenCV (fast, for segmentation heuristics)."""
    return cv2.cvtColor(rgb.astype(np.float32) / 255.0, cv2.COLOR_RGB2LAB)


def luminance(rgb: np.ndarray) -> np.ndarray:
    """BT.601 luma in [0, 255] as float64."""
    f = rgb.astype(np.float64)
    return 0.299 * f[..., 0] + 0.587 * f[..., 1] + 0.114 * f[..., 2]


def unsharp(rgb: np.ndarray, sigma: float = 1.0, amount: float = 0.35) -> np.ndarray:
    """Light unsharp mask for interpolated enlargements."""
    blurred = cv2.GaussianBlur(rgb, (0, 0), sigma)
    return cv2.addWeighted(rgb, 1.0 + amount, blurred, -amount, 0)


def lanczos_upscale(rgb: np.ndarray, factor: float, *, sharpen: bool = True) -> np.ndarray:
    """Plain Lanczos enlargement by ``factor`` followed by a light unsharp mask."""
    w, h = image_size(rgb)
    size = (max(1, round(w * factor)), max(1, round(h * factor)))
    out = cv2.resize(rgb, size, interpolation=cv2.INTER_LANCZOS4)
    return unsharp(out, sigma=max(0.8, factor * 0.5), amount=0.3) if sharpen else out
