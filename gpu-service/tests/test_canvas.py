"""Canvas maths: aspect, margin, centring, never-crop, no-enlarge rule, 20 MP cap."""

from __future__ import annotations

import numpy as np
import pytest

from app.canvas import Box, falloff_weights, fill_scale, plan_canvas, render, target_canvas_size

MP20 = 20_000_000


def plan(box: Box, **kw: object):
    params = {"aspect": "1:1", "margin_pct": 8.0, "target_px": 2048, "max_pixels": MP20, "max_scale": 1.0}
    params.update(kw)
    return plan_canvas(box, **params)  # type: ignore[arg-type]


@pytest.mark.parametrize("aspect,expected", [("1:1", (2048, 2048)), ("4:5", (2048, 2560))])
def test_aspect_sizes(aspect: str, expected: tuple[int, int]) -> None:
    assert target_canvas_size(aspect, 2048, MP20) == expected


def test_20mp_cap() -> None:
    w, h = target_canvas_size("4:5", 6000, MP20)
    assert w * h <= MP20 and abs(h / w - 1.25) < 1e-3
    w, h = target_canvas_size("1:1", 5000, MP20)
    assert w == h and w * h <= MP20


@pytest.mark.parametrize("aspect", ["1:1", "4:5"])
@pytest.mark.parametrize("margin", [0, 8, 25, 40])
def test_margin_exact_and_centred(aspect: str, margin: float) -> None:
    box = Box(100, 50, 4100, 3050)  # 4000x3000 product (wide) → width-limited
    p = plan(box, aspect=aspect, margin_pct=margin)
    assert (p.width, p.height) == target_canvas_size(aspect, 2048, MP20)
    assert p.product_width == pytest.approx(p.width * (1 - 2 * margin / 100))
    assert p.left == pytest.approx(p.width * margin / 100)
    assert p.left + p.product_width / 2 == pytest.approx(p.width / 2)
    assert p.top + p.product_height / 2 == pytest.approx(p.height / 2)
    assert not p.shrunk


def test_tall_product_is_height_limited_and_never_cropped() -> None:
    box = Box(0, 0, 1000, 5000)
    p = plan(box, aspect="4:5", margin_pct=10)
    assert p.product_height == pytest.approx(p.height * 0.8)
    assert p.left >= 0 and p.left + p.product_width <= p.width
    assert p.top >= p.height * 0.1 - 1e-6 and p.top + p.product_height <= p.height * 0.9 + 1e-6


def test_no_enlarge_shrinks_canvas_keeping_aspect_and_margin() -> None:
    box = Box(0, 0, 500, 400)  # would need 3.3x to fill 2048 @ 8% margin
    p = plan(box)
    assert p.shrunk
    assert p.scale <= 1.0 + 1e-9
    assert p.width == p.height < 2048
    assert p.product_width == pytest.approx(500, abs=1)  # native pixels, no enlargement
    assert p.product_width == pytest.approx(p.width * 0.84, abs=1.5)  # margin still 8%


def test_no_enlarge_4x5_keeps_aspect() -> None:
    p = plan(Box(0, 0, 300, 900), aspect="4:5")
    assert p.shrunk and abs(p.height / p.width - 1.25) < 0.01 and p.scale <= 1.0


def test_enlarging_allowed_when_max_scale_raised() -> None:
    p = plan(Box(0, 0, 500, 400), max_scale=10.0)
    assert not p.shrunk and p.width == 2048 and p.scale > 1


def test_fill_scale_matches_plan() -> None:
    s = fill_scale(900, 1200, aspect="1:1", margin_pct=8, target_px=2048, max_pixels=MP20)
    assert s == pytest.approx(2048 * 0.84 / 1200)


def test_render_places_product_centred_with_padding() -> None:
    src = np.zeros((400, 600, 3), np.uint8)
    src[100:300, 350:550] = 255  # 200x200 white product, off-centre
    box = Box(350, 100, 550, 300)
    p = plan(box, target_px=400, margin_pct=10, max_scale=2.0)
    canvas = render(src, p, fill=(10, 20, 30))
    assert canvas.shape == (400, 400, 3)
    ys, xs = np.nonzero(canvas[..., 0] > 128)
    assert xs.min() == pytest.approx(40, abs=1) and xs.max() == pytest.approx(359, abs=1)
    assert ys.min() == pytest.approx(40, abs=1) and ys.max() == pytest.approx(359, abs=1)


def test_render_region_limits_drawn_pixels() -> None:
    src = np.full((200, 200, 3), 200, np.uint8)
    box = Box(80, 80, 120, 120)  # 40x40 product
    p = plan(box, target_px=100, margin_pct=10, max_scale=1.0)
    assert (p.width, p.scale) == (50, 1.0)  # shrunk: never enlarge a 40 px product
    canvas = render(src, p, fill=(0, 0, 0), region=box)
    drawn = np.argwhere(canvas[..., 0] == 200)
    assert len(drawn) == pytest.approx(40 * 40, abs=90)
    assert drawn.min() >= 4 and drawn.max() <= 46  # only the region, centred, 5 px margins


def test_falloff_weights_fade_to_canvas_edges() -> None:
    box = Box(20, 20, 80, 80)
    p = plan(box, target_px=100, margin_pct=20, max_scale=1.0)
    w = falloff_weights(p, box)
    assert w.shape == (100, 100)
    assert w[50, 50] == 1.0 and w[21, 21] == 1.0  # inside the region
    assert w[50, 0] < 0.01 and w[0, 50] < 0.01 and w[99, 99] < 0.01  # canvas edges → padding colour
    row = w[50, :20]
    assert np.all(np.diff(row) >= 0)  # monotonic fade towards the product


def test_falloff_weights_region_beyond_canvas_has_no_fade() -> None:
    box = Box(0, 0, 100, 100)
    p = plan(box, target_px=100, margin_pct=0, max_scale=1.0)
    assert np.all(falloff_weights(p, Box(-10, -10, 110, 110)) == 1.0)


def test_falloff_weights_reach_zero_where_image_ends() -> None:
    box = Box(40, 40, 60, 60)
    p = plan(box, target_px=100, margin_pct=30, max_scale=2.0)  # 20 px product → 40 px on canvas
    w = falloff_weights(p, box, limit=Box(30, 30, 70, 70))  # image spans canvas 10..90
    assert w[50, 50] == 1.0
    assert w[50, 10] < 0.01 and w[50, 89] < 0.01  # already zero at the image edge
    assert np.all(w[:, :10] == 0.0)
