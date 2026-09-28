"""Canvas maths (aspect, margins, centring, no-crop / no-enlarge rules) and rendering.

Coordinates: a product box ``(x0, y0, x1, y1)`` in *working-image* pixels (x1/y1 exclusive).
The plan maps source → canvas as ``cx = (sx - x0) * scale + left`` (same for y/top).
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import cv2
import numpy as np

from .ops import image_size

ASPECTS: dict[str, tuple[int, int]] = {"1:1": (1, 1), "4:5": (4, 5)}  # width:height


@dataclass(frozen=True)
class Box:
    x0: int
    y0: int
    x1: int
    y1: int

    @property
    def width(self) -> int:
        return self.x1 - self.x0

    @property
    def height(self) -> int:
        return self.y1 - self.y0

    def pad(self, px: int, bounds: tuple[int, int]) -> Box:
        """Grow by ``px`` on every side, clipped to ``bounds`` = (width, height)."""
        w, h = bounds
        return Box(max(0, self.x0 - px), max(0, self.y0 - px), min(w, self.x1 + px), min(h, self.y1 + px))

    def union(self, other: Box) -> Box:
        return Box(min(self.x0, other.x0), min(self.y0, other.y0), max(self.x1, other.x1), max(self.y1, other.y1))

    def scaled(self, factor: float, bounds: tuple[int, int]) -> Box:
        """Scale coordinates (outward rounding), clipped to ``bounds``."""
        w, h = bounds
        return Box(
            max(0, math.floor(self.x0 * factor)),
            max(0, math.floor(self.y0 * factor)),
            min(w, math.ceil(self.x1 * factor)),
            min(h, math.ceil(self.y1 * factor)),
        )

    @staticmethod
    def full(width: int, height: int) -> Box:
        return Box(0, 0, width, height)


@dataclass(frozen=True)
class CanvasPlan:
    width: int
    height: int
    scale: float  # product scale factor (working px → canvas px)
    box: Box  # product box in working-image px
    left: float  # canvas x of box.x0
    top: float  # canvas y of box.y0
    shrunk: bool  # canvas reduced below target to avoid enlarging the product

    @property
    def product_width(self) -> float:
        return self.box.width * self.scale

    @property
    def product_height(self) -> float:
        return self.box.height * self.scale


def _height_for(width: int, aspect: str) -> int:
    aw, ah = ASPECTS[aspect]
    return max(1, round(width * ah / aw))


def target_canvas_size(aspect: str, target_px: int, max_pixels: int) -> tuple[int, int]:
    """Canvas at full target: width = target_px, height from aspect, capped at max_pixels."""
    width = target_px
    height = _height_for(width, aspect)
    while width > 1 and width * height > max_pixels:
        aw, ah = ASPECTS[aspect]
        width = min(width - 1, math.floor(math.sqrt(max_pixels * aw / ah)))
        height = _height_for(width, aspect)
    return width, height


def content_size(width: int, height: int, margin_pct: float) -> tuple[float, float]:
    """Area available to the product: canvas × (1 − 2·margin) in each dimension."""
    k = 1.0 - 2.0 * margin_pct / 100.0
    return width * k, height * k


def fill_scale(box_w: int, box_h: int, *, aspect: str, margin_pct: float, target_px: int, max_pixels: int) -> float:
    """Scale at which a ``box_w``×``box_h`` product fills the content area of the target canvas."""
    cw, ch = target_canvas_size(aspect, target_px, max_pixels)
    aw, ah = content_size(cw, ch, margin_pct)
    return min(aw / max(1, box_w), ah / max(1, box_h))


def plan_canvas(
    box: Box,
    *,
    aspect: str,
    margin_pct: float,
    target_px: int,
    max_pixels: int,
    max_scale: float = 1.0,
    min_width: int = 8,
) -> CanvasPlan:
    """Fit ``box`` into the content area and centre it; pad, never crop.

    When filling the target canvas would need a product scale above ``max_scale`` (i.e.
    enlarging with plain interpolation), the canvas shrinks proportionally instead, keeping
    aspect and margin exact.
    """
    width, height = target_canvas_size(aspect, target_px, max_pixels)
    s = fill_scale(
        box.width, box.height, aspect=aspect, margin_pct=margin_pct, target_px=target_px, max_pixels=max_pixels
    )
    shrunk = False
    if s > max_scale:
        shrunk = True
        width = max(min_width, math.floor(width * max_scale / s))
        height = _height_for(width, aspect)
        aw, ah = content_size(width, height, margin_pct)
        s = min(aw / max(1, box.width), ah / max(1, box.height), max_scale)
    left = (width - box.width * s) / 2.0
    top = (height - box.height * s) / 2.0
    return CanvasPlan(width=width, height=height, scale=s, box=box, left=left, top=top, shrunk=shrunk)


def render(
    src: np.ndarray,
    plan: CanvasPlan,
    *,
    fill: float | tuple[int, int, int],
    region: Box | None = None,
) -> np.ndarray:
    """Draw ``src`` (uint8 HxWx3 or float32 HxW) onto a canvas-sized array per ``plan``.

    Only pixels inside ``region`` (default: the whole source) are drawn; everything else is
    ``fill``. The source is cropped to what is visible before resizing, so this stays cheap
    for large working images.
    """
    src_w, src_h = image_size(src)
    region = region or Box.full(src_w, src_h)
    s = plan.scale
    if src.ndim == 3:
        canvas = np.empty((plan.height, plan.width, src.shape[2]), dtype=src.dtype)
        canvas[...] = np.asarray(fill, dtype=src.dtype)
    else:
        canvas = np.full((plan.height, plan.width), fill, dtype=src.dtype)

    # Source window visible on the canvas, intersected with the drawable region.
    vis_x0 = plan.box.x0 - plan.left / s
    vis_y0 = plan.box.y0 - plan.top / s
    vis_x1 = plan.box.x0 + (plan.width - plan.left) / s
    vis_y1 = plan.box.y0 + (plan.height - plan.top) / s
    cx0 = max(region.x0, math.floor(vis_x0))
    cy0 = max(region.y0, math.floor(vis_y0))
    cx1 = min(region.x1, math.ceil(vis_x1))
    cy1 = min(region.y1, math.ceil(vis_y1))
    if cx1 <= cx0 or cy1 <= cy0:
        return canvas

    crop = src[cy0:cy1, cx0:cx1]
    dst_w = max(1, round((cx1 - cx0) * s))
    dst_h = max(1, round((cy1 - cy0) * s))
    if (dst_w, dst_h) != (cx1 - cx0, cy1 - cy0):
        shrinking = dst_w * dst_h < crop.shape[0] * crop.shape[1]
        if src.dtype == np.float32:
            interp = cv2.INTER_AREA if shrinking else cv2.INTER_LINEAR
        else:
            interp = cv2.INTER_AREA if shrinking else cv2.INTER_LANCZOS4
        crop = cv2.resize(np.ascontiguousarray(crop), (dst_w, dst_h), interpolation=interp)
        if src.dtype == np.float32:
            crop = np.clip(crop, 0.0, 1.0)

    dx = round((cx0 - plan.box.x0) * s + plan.left)
    dy = round((cy0 - plan.box.y0) * s + plan.top)
    # Clip the paste rectangle to the canvas (rounding can overshoot by a pixel).
    px0, py0 = max(0, dx), max(0, dy)
    px1, py1 = min(plan.width, dx + crop.shape[1]), min(plan.height, dy + crop.shape[0])
    if px1 > px0 and py1 > py0:
        canvas[py0:py1, px0:px1] = crop[py0 - dy : py1 - dy, px0 - dx : px1 - dx]
    return canvas


def falloff_weights(plan: CanvasPlan, region: Box, limit: Box | None = None) -> np.ndarray:
    """Canvas-sized float32 blend weights: 1 inside ``region`` (working px, mapped through
    ``plan``), falling off smoothly to 0 at the canvas edges — or earlier, where the source
    image (``limit``, working px) ends inside the canvas.

    Used when keeping a near-uniform background: the real background around the product
    fades into the padding colour, so vignetting or slight gradients never leave a visible
    crop rectangle.
    """
    s = plan.scale

    def to_x(v: float) -> float:
        return (v - plan.box.x0) * s + plan.left

    def to_y(v: float) -> float:
        return (v - plan.box.y0) * s + plan.top

    def axis(n: int, start: float, stop: float, lo: float, hi: float) -> np.ndarray:
        lo, hi = max(0.0, min(lo, start)), min(float(n), max(hi, stop))
        centres = np.arange(n, dtype=np.float32) + 0.5
        weights = np.ones(n, dtype=np.float32)
        if start > lo:
            before = centres < start
            weights[before] = (centres[before] - lo) / (start - lo)
        if stop < hi:
            after = centres >= stop
            weights[after] = (hi - centres[after]) / (hi - stop)
        weights = np.clip(weights, 0.0, 1.0)
        return weights * weights * (3.0 - 2.0 * weights)  # smoothstep

    limit = limit or Box(-(10**9), -(10**9), 10**9, 10**9)
    wx = axis(plan.width, to_x(region.x0), to_x(region.x1), to_x(limit.x0), to_x(limit.x1))
    wy = axis(plan.height, to_y(region.y0), to_y(region.y1), to_y(limit.y0), to_y(limit.y1))
    return np.minimum(wy[:, None], wx[None, :]).astype(np.float32)
