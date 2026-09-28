"""Operation-aware quality checks (app/quality.py)."""

from __future__ import annotations

import cv2
import numpy as np
import pytest

from app import quality
from app.backends.classic import analyze_border
from app.canvas import Box, plan_canvas, render
from app.checks import analyze_mask
from app.config import ServiceConfig
from app.ops import resize_mask
from app.quality import (
    assess_cutout,
    assess_output,
    dropped_inner_parts,
    flip_compare_size,
    flip_disagreement,
    photo_edge_contact,
    text_coverage,
)

CFG = ServiceConfig(allow_unsigned=True)


def disc_photo(size: int = 400, bg: int = 240) -> tuple[np.ndarray, np.ndarray]:
    """A red disc on a plain background, and its exact mask."""
    rgb = np.full((size, size, 3), bg, np.uint8)
    mask = np.zeros((size, size), np.float32)
    cv2.circle(rgb, (size // 2, size // 2), size // 4, (200, 30, 30), -1)
    cv2.circle(mask, (size // 2, size // 2), size // 4, 1.0, -1)
    return rgb, mask


def assess(rgb: np.ndarray, mask: np.ndarray, model_mask: np.ndarray | None = None, **kw: object):
    analysis = analyze_mask(mask, mask if model_mask is None else model_mask, min_fragment_frac=0.005)
    defaults = {"text_rects": (), "text_scale": 1.0, "new_bg": (255, 255, 255)}
    defaults.update(kw)
    return assess_cutout(analysis, rgb, border=analyze_border(rgb), cfg=CFG, **defaults)  # type: ignore[arg-type]


def test_clean_cutout_passes() -> None:
    rgb, mask = disc_photo()
    report = assess(rgb, mask)
    assert report.passed and report.score == 1.0
    assert report.checks["dropped_inner_parts"] == 0.0


def test_undecided_edges_are_background_artifacts() -> None:
    rgb, mask = disc_photo()
    fuzzy = mask.copy()
    ring = cv2.dilate(mask, np.ones((31, 31), np.uint8)) - cv2.erode(mask, np.ones((31, 31), np.uint8))
    fuzzy[ring > 0] = 0.5  # a wide band the model couldn't decide on
    report = assess(rgb, mask, model_mask=fuzzy)
    assert "background_artifacts" in report.reasons and report.score < 1.0


def test_nothing_found_is_escalated_but_a_thin_product_is_not() -> None:
    rgb, _ = disc_photo()
    assert "empty_mask" in assess(rgb, np.zeros((400, 400), np.float32)).reasons
    chain = np.zeros((400, 400), np.float32)
    cv2.ellipse(chain, (200, 120), (120, 180), 0, 0, 180, 1.0, 2)  # ~1% coverage, spans the photo
    assert "empty_mask" not in assess(rgb, chain).reasons


def test_label_cut_through_by_a_hole_is_detected() -> None:
    rgb, mask = disc_photo()
    label = (170, 190, 60, 20)  # x, y, w, h on the disc
    cut = mask.copy()
    cut[190:210, 200:230] = 0.0  # a hole inside the product drops the right half of the label
    assert "text_or_logo_cut" in assess(rgb, cut, text_rects=(label,)).reasons
    assert "text_or_logo_cut" not in assess(rgb, mask, text_rects=(label,)).reasons


def box_photo() -> tuple[np.ndarray, np.ndarray, tuple[int, int, int, int]]:
    """A 400 px box product with a 120x30 label near its right side, and the box's mask."""
    rgb = np.full((600, 600, 3), 240, np.uint8)
    rgb[100:500, 100:500] = (60, 90, 160)
    mask = np.zeros((600, 600), np.float32)
    mask[100:500, 100:500] = 1.0
    return rgb, mask, (330, 280, 120, 30)


def test_label_notched_from_the_side_is_caught_but_one_the_outer_edge_runs_through_is_not() -> None:
    rgb, mask, label = box_photo()
    notched = mask.copy()
    notched[285:305, 420:500] = 0.0  # a slot from the box's edge into the label; the box around it is kept
    assert "text_or_logo_cut" in assess(rgb, notched, text_rects=(label,)).reasons

    # Scope (by design): when the cut-out drops the box's whole right side, the label's surround
    # is mostly background, like the false EAST boxes on a silhouette's edge, so it isn't counted.
    dropped_side = mask.copy()
    dropped_side[:, 420:] = 0.0
    assert text_coverage(dropped_side, Box(100, 100, 420, 500), (label,), 1.0) is None
    assert "text_or_logo_cut" not in assess(rgb, dropped_side, text_rects=(label,)).reasons


def test_text_that_is_background_or_on_a_thin_chain_is_ignored() -> None:
    rgb, mask = disc_photo()
    box = Box(100, 100, 300, 300)
    assert text_coverage(mask, box, ((110, 110, 20, 10),), 1.0) is None  # background text, left out
    chain = np.zeros((400, 400), np.float32)
    cv2.line(chain, (100, 200), (300, 200), 1.0, 4)
    assert text_coverage(chain, box, ((180, 195, 40, 12),), 1.0) is None  # not on a solid surface


def polka_dot_dress() -> tuple[np.ndarray, Box, tuple[tuple[int, int, int, int], ...]]:
    """A dress-like silhouette and a grid of EAST-like boxes over it (one per polka dot).

    Boxes on the dress keep 100%; the ones the silhouette's edge runs through keep 25-85%.
    """
    mask = np.zeros((400, 400), np.float32)
    cv2.ellipse(mask, (200, 210), (110, 170), 0, 0, 360, 1.0, -1)
    rects = tuple((x, y, 36, 36) for x in range(40, 340, 50) for y in range(20, 380, 50))
    return mask, Box(90, 40, 311, 381), rects


def test_polka_dot_boxes_on_the_silhouette_edge_are_not_labels() -> None:
    mask, bbox, rects = polka_dot_dress()
    kept = [float((mask[y : y + 36, x : x + 36] > 0.5).mean()) for x, y, _, _ in rects]
    assert any(0.25 <= k < 0.85 for k in kept)  # some boxes straddle the edge, as on the real dress
    worst = text_coverage(mask, bbox, rects, 1.0)  # only the boxes on the dress count
    assert worst is not None and worst >= CFG.escalate_text_coverage_min
    rgb = np.full((400, 400, 3), 235, np.uint8)
    rgb[mask > 0.5] = (30, 30, 30)
    assert "text_or_logo_cut" not in assess(rgb, mask, text_rects=rects).reasons


def test_edge_rule_is_inert_at_the_current_constants_but_works_if_the_surround_rule_is_relaxed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # A surround that is >= TEXT_SOLID_MIN cut-out has at most 1 - TEXT_SOLID_MIN background,
    # so the silhouette-edge rule (more than TEXT_EDGE_BG_MAX background) can't fire today.
    assert quality.TEXT_SOLID_MIN >= 1 - quality.TEXT_EDGE_BG_MAX

    mask, bbox, rects = polka_dot_dress()
    monkeypatch.setattr(quality, "TEXT_SOLID_MIN", 0.5)  # the old surround threshold
    worst = text_coverage(mask, bbox, rects, 1.0)  # the silhouette-edge rule drops the edge boxes
    assert worst is not None and worst >= CFG.escalate_text_coverage_min
    monkeypatch.setattr(quality, "TEXT_EDGE_BG_MAX", 1.0)  # ...without it, the old rule fired
    worst = text_coverage(mask, bbox, rects, 1.0)
    assert worst is not None and worst < CFG.escalate_text_coverage_min


def shadowed_openwork(
    hole_rgb: tuple[int, int, int], shadow: tuple[int, int, int] = (185, 170, 145)
) -> tuple[np.ndarray, np.ndarray]:
    """A gold openwork disc on a plain background, casting a (warm) shadow around itself; the
    cut-out correctly opens its centre, which shows ``hole_rgb``."""
    rgb = np.full((400, 400, 3), 240, np.uint8)
    cv2.circle(rgb, (200, 200), 118, shadow, -1)
    cv2.circle(rgb, (200, 200), 100, (205, 160, 60), -1)
    cv2.circle(rgb, (200, 200), 40, hole_rgb, -1)
    mask = np.zeros((400, 400), np.float32)
    cv2.circle(mask, (200, 200), 100, 1.0, -1)
    cv2.circle(mask, (200, 200), 40, 0.0, -1)
    return rgb, mask


def test_openwork_hole_showing_the_products_shadow_is_not_a_dropped_part() -> None:
    rgb, mask = shadowed_openwork(hole_rgb=(185, 170, 145))  # the hole shows the same shadow
    assert analyze_border(rgb).uniform
    shadow_vs_border = np.linalg.norm(quality._rgb_lab((185, 170, 145)) - quality._rgb_lab((240, 240, 240)))
    assert shadow_vs_border > quality.HOLE_FOREIGN_DELTA_E  # the border colour alone would call it dropped
    assert dropped_inner_parts(rgb, mask, bg=(240, 240, 240)) == 0.0  # far from the border colour only
    assert "dropped_inner_part" not in assess(rgb, mask).reasons

    lens_rgb, lens_mask = shadowed_openwork(hole_rgb=(20, 20, 20))  # a dark lens is far from both
    assert dropped_inner_parts(lens_rgb, lens_mask, bg=(240, 240, 240)) > 0.05
    assert "dropped_inner_part" in assess(lens_rgb, lens_mask).reasons


def test_known_limit_a_dark_lens_next_to_an_equally_dark_shadow_is_not_a_dropped_part() -> None:
    # Pinned on purpose (see dropped_inner_parts): the lens's colour matches the product's local
    # background (its dark contact shadow), so it reads as openwork showing that shadow.
    rgb, mask = shadowed_openwork(hole_rgb=(20, 20, 20), shadow=(28, 26, 24))
    assert dropped_inner_parts(rgb, mask, bg=(240, 240, 240)) == 0.0
    assert "dropped_inner_part" not in assess(rgb, mask).reasons


def test_dropped_inner_part_vs_a_hole_showing_the_background() -> None:
    rgb, mask = disc_photo(bg=240)
    cv2.circle(rgb, (200, 200), 40, (20, 20, 20), -1)  # a dark inner panel (e.g. a lens)
    hole = mask.copy()
    cv2.circle(hole, (200, 200), 40, 0.0, -1)  # ...that the cut-out dropped
    assert dropped_inner_parts(rgb, hole, bg=(240, 240, 240)) > 0.05
    assert "dropped_inner_part" in assess(rgb, hole).reasons

    handle_rgb, handle_mask = disc_photo(bg=240)
    cv2.circle(handle_rgb, (200, 200), 40, (240, 240, 240), -1)  # the hole really is background
    cv2.circle(handle_mask, (200, 200), 40, 0.0, -1)
    assert "dropped_inner_part" not in assess(handle_rgb, handle_mask).reasons


def test_flip_disagreement_counts_whole_regions_not_edge_jitter() -> None:
    _, mask = disc_photo()
    assert flip_disagreement(mask, mask) == 0.0

    jitter = np.zeros_like(mask)
    cv2.circle(jitter, (201, 199), 102, 1.0, -1)  # the same disc, 1-2 px off everywhere
    assert flip_disagreement(mask, jitter) < 0.002

    prop = mask.copy()
    prop[20:70, 20:70] = 1.0  # the mirrored run also keeps a prop (8% of the product)
    assert flip_disagreement(mask, prop) > CFG.escalate_flip_disagreement
    assert flip_disagreement(prop, mask) == pytest.approx(flip_disagreement(mask, prop))  # relative to the larger


def test_flip_disagreement_outside_a_box_ignores_what_is_inside_it() -> None:
    big = np.zeros((1600, 2000), np.float32)  # > 1024 px: measured downscaled, the box scaled with it
    cv2.circle(big, (1000, 800), 200, 1.0, -1)
    crop = Box(760, 560, 1240, 1040)
    flipped = big.copy()
    flipped[700:800, 1100:1200] = 0.0  # a different edge inside the crop: ignored
    assert flip_disagreement(big, flipped, outside=crop) == 0.0
    assert flip_disagreement(big, flipped) > 0.05
    flipped[100:300, 100:300] = 1.0  # a second product outside the crop: counted
    expected = 40_000 / flipped.sum()  # relative to the larger mask
    assert flip_disagreement(big, flipped, outside=crop) == pytest.approx(expected, rel=0.05)


def test_flip_is_compared_where_the_model_saw_the_product() -> None:
    # A 300 px product in a 4000 px photo, cut out from a crop around it; the mirrored run
    # misses a 25 px slice (4% of the product). At the frame's <= 1024 px scale the slice is
    # ~6 px wide and reads as edge jitter; on the crop it is a region.
    frame = np.zeros((4000, 4000), np.float32)
    cv2.circle(frame, (2000, 2000), 150, 1.0, -1)
    missed = frame.copy()
    missed[1850:2150, 2125:2150] = 0.0
    crop = Box(1780, 1780, 2220, 2220)
    rgb = np.full((4000, 4000, 3), 240, np.uint8)
    at_frame = resize_mask(missed, flip_compare_size(4000, 4000))
    report = assess(rgb, frame, flipped=at_frame)
    assert report.checks["flip_disagreement"] == 0.0 and report.checks["flip_compare_px"] == 1024.0
    on_crop = missed[crop.y0 : crop.y1, crop.x0 : crop.x1]
    report = assess(rgb, frame, flipped=on_crop, flipped_region=crop)
    assert report.checks["flip_disagreement"] > CFG.escalate_flip_disagreement
    assert report.checks["flip_compare_px"] == 440.0 and "unstable_cutout" in report.reasons


def test_photo_edge_contact_ignores_the_bottom() -> None:
    mask = np.zeros((100, 200), np.float32)
    assert photo_edge_contact(mask) == 0.0
    mask[60:, 50:150] = 1.0  # standing on the bottom edge
    assert photo_edge_contact(mask) == 0.0
    mask[:30, 150:] = 1.0  # runs into the top (25% of it) and the right side (30%)
    assert photo_edge_contact(mask) == pytest.approx(0.3)

    rgb, disc = disc_photo()
    report = assess(rgb, disc)
    assert report.checks["edge_contact"] == 0.0 and report.passed
    cut_off = disc.copy()
    cut_off[:, :150] = 0.0
    cut_off = np.roll(cut_off, -150, axis=1)  # the disc runs off the photo's left edge
    report = assess(rgb, cut_off)
    assert report.checks["edge_contact"] > 0.3 and report.passed  # recorded, never escalated


def test_output_checks_pass_for_a_planned_canvas_and_catch_an_off_centre_product() -> None:
    _, mask = disc_photo(600)
    box = Box(150, 150, 451, 451)
    plan = plan_canvas(box, aspect="4:5", margin_pct=8, target_px=800, max_pixels=20_000_000)
    canvas_mask = render(mask, plan, fill=0.0)
    report = assess_output(plan, canvas_mask, aspect="4:5", margin_pct=8, output_size=(plan.width, plan.height))
    assert report.passed, report.checks
    assert report.checks["aspect_ok"] and report.checks["centered"] and report.checks["margins_ok"]

    shifted = np.roll(canvas_mask, 15, axis=1)  # still on the canvas, but not centred
    bad = assess_output(plan, shifted, aspect="4:5", margin_pct=8, output_size=(plan.width, plan.height))
    assert "off_center" in bad.reasons and bad.score < 1.0
    wrong_aspect = assess_output(plan, canvas_mask, aspect="4:5", margin_pct=8, output_size=(800, 800))
    assert "output_geometry" in wrong_aspect.reasons
