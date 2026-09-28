"""Classic backend: border analysis, border-difference segmentation, Lanczos upscaler."""

from __future__ import annotations

import numpy as np
import pytest
from PIL import Image, ImageDraw, ImageFilter

from app.backends.classic import ClassicSegmenter, LanczosUpscaler, analyze_border, border_difference_mask
from app.checks import analyze_mask
from app.ops import resize_mask

from .helpers import decode, product_bbox_on_white, product_on_white, tall_product, to_bytes


def iou(a: tuple[int, int, int, int], b: tuple[int, int, int, int]) -> float:
    ix = max(0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0, min(a[3], b[3]) - max(a[1], b[1]))
    inter = ix * iy
    area = lambda r: (r[2] - r[0]) * (r[3] - r[1])  # noqa: E731
    return inter / (area(a) + area(b) - inter)


def bbox_of(mask: np.ndarray, size: tuple[int, int]) -> tuple[int, int, int, int]:
    full = resize_mask(mask, size)
    box = analyze_mask(full, mask, min_fragment_frac=0.005).bbox
    assert box is not None
    return box.x0, box.y0, box.x1, box.y1


def test_border_analysis_uniform_vs_busy() -> None:
    stats = analyze_border(product_on_white())
    assert stats.uniform and stats.median_rgb == (247, 247, 247)
    rng = np.random.default_rng(0)
    busy = rng.integers(0, 256, (300, 400, 3), dtype=np.uint8)
    assert not analyze_border(busy).uniform


def test_segments_off_centre_product() -> None:
    img = product_on_white(1000, 800)
    mask = ClassicSegmenter().predict(img)
    assert mask.dtype == np.float32 and 0.0 <= mask.min() and mask.max() <= 1.0
    assert max(mask.shape) <= 1024
    assert iou(bbox_of(mask, (1000, 800)), product_bbox_on_white(1000, 800)) > 0.95
    full = resize_mask(mask, (1000, 800))
    assert full[330, 680] > 0.99  # inside the disc
    assert full[20, 20] < 0.01  # background


def test_segments_tall_product() -> None:
    img = tall_product()
    box = bbox_of(border_difference_mask(img), (600, 900))
    assert iou(box, (250, 55, 331, 821)) > 0.9


def test_handles_gradient_background() -> None:
    h, w = 600, 800
    ramp = np.linspace(200, 250, w, dtype=np.float32)[None, :, None]
    img = np.repeat(np.repeat(ramp, h, 0), 3, 2).astype(np.uint8)
    img[200:400, 300:500] = (30, 30, 160)
    box = bbox_of(border_difference_mask(img), (w, h))
    assert iou(box, (300, 200, 500, 400)) > 0.9


def vignette_bottle() -> np.ndarray:
    """A blue bottle left of centre on a studio vignette with a soft floor shadow, JPEG'd."""
    h, w = 1300, 1000
    y, x = np.mgrid[0:h, 0:w]
    d = np.sqrt(((x - w / 2) / w) ** 2 + ((y - h / 2) / h) ** 2)
    bg = (236 - 40 * d).clip(0, 255).astype(np.uint8)
    img = Image.fromarray(np.dstack([bg, bg, bg - 6]))
    shadow = Image.new("L", (w, h), 0)
    ImageDraw.Draw(shadow).ellipse((230, 1010, 610, 1080), fill=120)
    img.paste((120, 120, 120), (0, 0), shadow.filter(ImageFilter.GaussianBlur(18)))
    draw = ImageDraw.Draw(img)
    draw.rounded_rectangle((300, 380, 540, 1040), radius=60, fill=(40, 90, 160))
    draw.rectangle((380, 250, 460, 400), fill=(40, 90, 160))
    draw.rectangle((310, 600, 530, 780), fill=(245, 240, 230))
    return np.asarray(decode(to_bytes(np.asarray(img), "JPEG", quality=90)).convert("RGB"))


def test_handles_vignette_background() -> None:
    """Studio vignette: the centre is brighter than every border pixel. A flat
    (bilinear) background model reads the bright middle as product."""
    img = vignette_bottle()
    h, w = img.shape[:2]
    full = resize_mask(ClassicSegmenter().predict(img), (w, h)) > 0.5
    # Bottle, cap and the soft shadow under it — nothing to the right of the bottle.
    assert not full[300:900, 560:1000].any()
    assert full.mean() == pytest.approx(0.145, abs=0.006)


def test_blank_image_gives_empty_mask() -> None:
    mask = border_difference_mask(np.full((300, 300, 3), 240, np.uint8))
    assert float((mask > 0.5).mean()) == 0.0


def test_product_touching_border() -> None:
    img = np.full((500, 500, 3), 250, np.uint8)
    img[150:500, 180:320] = (120, 60, 20)  # product runs off the bottom edge
    box = bbox_of(border_difference_mask(img), (500, 500))
    assert iou(box, (180, 150, 320, 500)) > 0.9


@pytest.mark.parametrize("scale", [2, 4])
def test_lanczos_upscaler(scale: int) -> None:
    img = product_on_white(120, 90)
    up = LanczosUpscaler()
    out = up.upscale(img, scale)  # type: ignore[arg-type]
    assert out.shape == (90 * scale, 120 * scale, 3) and out.dtype == np.uint8
    assert up.is_ai is False and up.model_name(scale) == "lanczos"  # type: ignore[arg-type]
