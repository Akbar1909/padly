"""Mask metrics + flags, upscale fidelity, colour drift."""

from __future__ import annotations

import cv2
import numpy as np
import pytest

from app.checks import (
    analyze_mask,
    color_drift,
    color_drift_flags,
    fidelity,
    fidelity_flags,
    mask_flags,
)
from app.config import ServiceConfig
from app.ops import lanczos_upscale

from .helpers import product_on_white


@pytest.fixture
def thresholds() -> ServiceConfig:
    return ServiceConfig(allow_unsigned=True)


def codes(flags: list) -> set[str]:
    return {f.code for f in flags}


def test_clean_mask_metrics(thresholds: ServiceConfig) -> None:
    mask = np.zeros((400, 400), np.float32)
    mask[100:300, 120:280] = 1.0
    a = analyze_mask(mask, mask, min_fragment_frac=0.005)
    assert a.coverage == pytest.approx(200 * 160 / 400**2)
    assert a.fragments == 1 and a.uncertainty == 0.0
    assert (a.bbox.x0, a.bbox.y0, a.bbox.x1, a.bbox.y1) == (120, 100, 280, 300)
    assert mask_flags(a, thresholds) == []


def test_tiny_fragments_ignored_for_bbox_and_erased(thresholds: ServiceConfig) -> None:
    mask = np.zeros((400, 400), np.float32)
    mask[100:300, 100:300] = 1.0
    mask[10:13, 380:383] = 1.0  # 9 px speck ≪ 0.5% of 40000
    a = analyze_mask(mask, mask, min_fragment_frac=0.005)
    assert a.fragments == 1
    assert (a.bbox.x1, a.bbox.y0) == (300, 100)
    assert a.cleaned[11, 381] == 0.0 and a.cleaned[200, 200] == 1.0


def test_empty_and_full_flags(thresholds: ServiceConfig) -> None:
    empty = np.zeros((100, 100), np.float32)
    a = analyze_mask(empty, empty, min_fragment_frac=0.005)
    assert a.bbox is None and a.fragments == 0
    assert "mask_empty" in codes(mask_flags(a, thresholds))

    full = np.ones((100, 100), np.float32)
    a = analyze_mask(full, full, min_fragment_frac=0.005)
    assert "mask_full" in codes(mask_flags(a, thresholds))


def test_fragmented_flag(thresholds: ServiceConfig) -> None:
    mask = np.zeros((400, 400), np.float32)
    for i in range(5):
        mask[50:350, 20 + i * 75 : 70 + i * 75] = 1.0  # five equal bars
    a = analyze_mask(mask, mask, min_fragment_frac=0.005)
    assert a.fragments == 5
    assert "mask_fragmented" in codes(mask_flags(a, thresholds))


def test_low_confidence_flag_uses_model_mask(thresholds: ServiceConfig) -> None:
    model = np.zeros((256, 256), np.float32)
    model[64:192, 64:192] = 1.0
    model[:, :40] = 0.5  # a wide band of 50/50 pixels (glass, hair...)
    full = cv2.resize(model, (1024, 1024), interpolation=cv2.INTER_NEAREST)
    a = analyze_mask(full, model, min_fragment_frac=0.005)
    assert a.uncertainty == pytest.approx(40 / 256, abs=0.01)
    assert "mask_low_confidence" in codes(mask_flags(a, thresholds))


def test_thresholds_are_configurable() -> None:
    mask = np.zeros((100, 100), np.float32)
    mask[45:53, 45:53] = 1.0  # a speck: 0.64% coverage, 0.64% of the frame
    a = analyze_mask(mask, mask, min_fragment_frac=0.005)
    assert "mask_empty" in codes(mask_flags(a, ServiceConfig(allow_unsigned=True)))
    lenient = ServiceConfig(allow_unsigned=True, mask_empty_max=0.005)
    assert "mask_empty" not in codes(mask_flags(a, lenient))


def test_small_or_thin_product_is_not_empty() -> None:
    """Under 2% coverage but spanning a real area: a found product, not "product not found"."""
    small = np.zeros((1000, 1000), np.float32)
    small[500:620, 600:720] = 1.0  # small product in a big photo: 1.4% coverage, 1.4% of the frame
    chain = np.zeros((1000, 1000), np.float32)
    cv2.ellipse(chain, (500, 300), (300, 450), 0, 0, 180, 1.0, 3)  # thin necklace: ~0.7% coverage
    for mask in (small, chain):
        a = analyze_mask(mask, mask, min_fragment_frac=0.005)
        assert a.coverage < 0.02
        assert "mask_empty" not in codes(mask_flags(a, ServiceConfig(allow_unsigned=True)))


def test_fidelity_identical_upscale(thresholds: ServiceConfig) -> None:
    img = product_on_white(300, 240)
    up = cv2.resize(img, (600, 480), interpolation=cv2.INTER_CUBIC)
    ssim, delta_e = fidelity(img, up)
    assert ssim > 0.97 and delta_e < 1.0
    assert fidelity_flags(ssim, delta_e, thresholds) == []


def test_fidelity_lanczos_upscale_passes(thresholds: ServiceConfig) -> None:
    img = product_on_white(300, 240)
    ssim, delta_e = fidelity(img, lanczos_upscale(img, 4.0))
    assert ssim > 0.9 and delta_e < 2
    assert fidelity_flags(ssim, delta_e, thresholds) == []


def test_fidelity_exact_copy_is_perfect() -> None:
    img = product_on_white(200, 200)
    ssim, delta_e = fidelity(img, img.copy())
    assert ssim == pytest.approx(1.0) and delta_e == pytest.approx(0.0, abs=1e-6)


def test_fidelity_heavily_altered_is_flagged(thresholds: ServiceConfig) -> None:
    img = product_on_white(300, 240)
    up = cv2.resize(img, (600, 480), interpolation=cv2.INTER_CUBIC)
    rng = np.random.default_rng(0)
    altered = np.clip(up.astype(int) + rng.integers(-90, 90, up.shape), 0, 255).astype(np.uint8)
    altered = cv2.cvtColor(altered, cv2.COLOR_RGB2BGR)  # swap channels too: hallucinated colours
    ssim, delta_e = fidelity(img, altered)
    assert "fidelity_low" in codes(fidelity_flags(ssim, delta_e, thresholds))


def test_color_drift(thresholds: ServiceConfig) -> None:
    img = product_on_white(400, 300)
    mask = np.zeros(img.shape[:2], np.float32)
    mask[np.all(img < 230, axis=2)] = 1.0
    same = color_drift(img, mask, img, mask)
    assert same == pytest.approx(0.0, abs=1e-6)
    assert color_drift_flags(same, thresholds) == []

    shifted = img.copy()
    shifted[..., 1] = np.clip(shifted[..., 1].astype(int) + 60, 0, 255)
    drift = color_drift(img, mask, shifted, mask)
    assert drift is not None and drift > 5
    assert codes(color_drift_flags(drift, thresholds)) == {"color_drift"}


def test_color_drift_none_without_product() -> None:
    img = product_on_white(100, 100)
    empty = np.zeros((100, 100), np.float32)
    assert color_drift(img, empty, img, empty) is None
