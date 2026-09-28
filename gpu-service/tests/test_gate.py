"""The quality gate and routing: analysis / no change, SAFE_LOCAL / UNCERTAIN / FAILED, the AI
gate and its retry, final statuses, reason codes, rollout and shadow mode (app/pipeline.py,
app/analysis.py)."""

from __future__ import annotations

import cv2
import numpy as np
import pytest

from app.analysis import analyze_image
from app.backends.classic import analyze_border
from app.config import ServiceConfig
from app.escalation import EscalationGate
from app.imageio import load_image
from app.schemas import ProcessSettings

from .helpers import product_on_white, to_bytes
from .test_escalation import (
    SETTINGS,
    BlindSegmenter,
    CleanSegmenter,
    PaidSegmenter,
    build,
    product_mask,
    red_parts,
    run,
)


def cfg(**kw: object) -> ServiceConfig:
    return ServiceConfig(allow_unsigned=True, **kw)  # type: ignore[arg-type]


class BandSegmenter(CleanSegmenter):
    """The right product with a ``width`` px band of undecided pixels around its edge."""

    def __init__(self, width: int, name: str = "birefnet-lite") -> None:
        super().__init__(name)
        self.width = width

    def predict(self, rgb: np.ndarray) -> np.ndarray:
        mask = super().predict(rgb)
        k = np.ones((self.width, self.width), np.uint8)
        mask[(cv2.dilate(mask, k) - cv2.erode(mask, k)) > 0] = 0.5
        return mask


class SecondOpinion:
    """Mixin: the model can run at another input size (``predict_at``), where it finds the
    exact product, or (``disagree``) a copy shifted sideways."""

    supports_input_size = True
    disagree = False

    def predict_at(self, rgb: np.ndarray, input_size: int) -> np.ndarray:
        self.verify_inputs = [*getattr(self, "verify_inputs", []), input_size]
        mask = product_mask(rgb)
        return np.roll(mask, 60, axis=1) if self.disagree else mask


class VerifiedClean(SecondOpinion, CleanSegmenter):
    pass


class DisagreeingClean(SecondOpinion, CleanSegmenter):
    disagree = True


class VerifiedBlind(SecondOpinion, BlindSegmenter):
    """Finds nothing at its own size, the whole product at the second opinion's."""


class VerifiedBand(SecondOpinion, BandSegmenter):
    pass


class FuzzyPaid(PaidSegmenter):
    """A paid model whose cut-out fails its checks (wide undecided edge), except, with
    ``clean_on_crops``, when it is shown a crop (the pipeline's zoomed retry)."""

    def __init__(self, clean_on_crops: bool = False) -> None:
        super().__init__()
        self.clean_on_crops = clean_on_crops
        self.full: tuple[int, int] | None = None

    def predict(self, rgb: np.ndarray) -> np.ndarray:
        mask = super().predict(rgb)
        if self.full is None:
            self.full = (rgb.shape[1], rgb.shape[0])
        if self.clean_on_crops and (rgb.shape[1], rgb.shape[0]) != self.full:
            return mask
        k = np.ones((41, 41), np.uint8)
        mask[(cv2.dilate(mask, k) - cv2.erode(mask, k)) > 0] = 0.5
        return mask


def edge_uncertainty(segmenter: CleanSegmenter) -> float:
    """What the pipeline measures for this segmenter on ``product_on_white``."""
    p = run(build(segmenter, None, cfg=cfg(escalate_mask_uncertainty=1.0)))
    segmenter.inputs.clear()
    value = p.processing.quality_checks["cutout_edge_uncertainty"]
    assert isinstance(value, float) and value > 0
    return value


def near_limit_cfg(segmenter: CleanSegmenter, **kw: object) -> ServiceConfig:
    """A config under which ``segmenter`` passes, but at 85% of the uncertainty limit."""
    return cfg(escalate_mask_uncertainty=edge_uncertainty(segmenter) / 0.85, **kw)


def codes(result) -> list[str]:  # type: ignore[no-untyped-def]
    return result.processing.reason_codes


# --------------------------------------------------------------------------------------
# SAFE_LOCAL
# --------------------------------------------------------------------------------------
def test_safe_local_cutout_is_ready_without_the_paid_model() -> None:
    local, paid = CleanSegmenter(), PaidSegmenter()
    result = run(build(local, paid))
    p = result.processing
    assert paid.inputs == [] and local.inputs
    assert p.route == "local" and p.gate == "SAFE_LOCAL" and p.ai_gate is None
    assert p.local_attempted and p.local_accepted and p.replicate_attempts == 0
    assert p.final_status == "READY" and result.flags == [] and p.reason_codes == []
    assert set(p.quality_scores) == {"segmentation_confidence", "product_retention", "geometry", "artifact", "fidelity"}
    assert p.quality_scores["segmentation_confidence"] == 1.0 and p.quality_scores["geometry"] == 1.0
    assert p.analysis is not None and p.analysis["already_acceptable"] is False
    assert p.analysis["background_complexity"] in ("clean", "low")


# --------------------------------------------------------------------------------------
# UNCERTAIN: passed, but not with margin → escalated
# --------------------------------------------------------------------------------------
def test_near_limit_local_cutout_is_uncertain_and_escalated() -> None:
    local = VerifiedBand(5)
    paid = PaidSegmenter()
    result = run(build(local, paid, cfg=near_limit_cfg(local, local_second_opinion="resolution")))
    p = result.processing
    assert p.gate == "UNCERTAIN" and len(paid.inputs) == 1
    assert p.route == "local_then_replicate" and p.ai_gate == "PASS" and not p.local_accepted
    assert "QUALITY_SCORE_UNCERTAIN" in p.reason_codes
    # the paid result passed with margin, and the second opinion reproduces it
    assert p.final_status == "READY" and result.flags == []
    assert p.quality_checks["cutout_model_agreement"] == 1.0
    outcomes = {a.method: a.outcome for a in p.attempts if a.operation == "background_removal"}
    assert outcomes == {"local": "rejected", "local_verify": "check", "replicate": "used"}
    assert result.models.segmentation == "BiRefNet@replicate:test"


def test_uncertain_local_cutout_without_a_stronger_model_needs_review() -> None:
    local = BandSegmenter(5)
    result = run(build(local, None, cfg=near_limit_cfg(local)))
    p = result.processing
    assert p.gate == "UNCERTAIN" and p.route == "local" and not p.local_accepted
    assert p.final_status == "NEEDS_REVIEW"
    [check] = [f for f in result.flags if f.code == "cutout_check"]
    assert "only narrowly" in check.message
    assert "ESCALATION_UNAVAILABLE" not in p.reason_codes  # none is configured: nothing was unavailable


def test_uncertain_local_cutout_with_escalation_blocked_needs_review() -> None:
    local = BandSegmenter(5)
    gate = EscalationGate(cooldown_s=600)
    gate.failed()
    result = run(build(local, PaidSegmenter(), cfg=near_limit_cfg(local), gate=gate))
    p = result.processing
    assert p.gate == "UNCERTAIN" and p.replicate_calls == 0 and p.final_status == "NEEDS_REVIEW"
    assert "ESCALATION_UNAVAILABLE" in p.reason_codes and "not escalated" in (p.fallback_reason or "")
    [check] = [f for f in result.flags if f.code == "cutout_check"]
    assert "wasn't available" in check.message


# --------------------------------------------------------------------------------------
# FAILED → paid → AI gate, retry on a zoomed crop, NEEDS_REVIEW
# --------------------------------------------------------------------------------------
def test_unsafe_paid_result_is_retried_on_a_zoomed_crop() -> None:
    paid = FuzzyPaid(clean_on_crops=True)
    result = run(build(VerifiedBlind(), paid, cfg=cfg(local_second_opinion="resolution")))
    p = result.processing
    assert p.gate == "FAILED" and p.ai_gate == "PASS" and p.replicate_attempts == 2 and p.replicate_calls == 2
    assert paid.inputs[1][0] < paid.inputs[0][0]  # the retry saw a crop
    used = [a.method for a in p.attempts if a.operation == "background_removal" and a.outcome == "used"]
    assert used == ["replicate_zoom"]
    assert p.final_status == "READY" and p.method == "replicate"
    assert "PRODUCT_NOT_FOUND" in p.reason_codes


def test_a_paid_result_no_other_model_confirms_needs_review() -> None:
    # Nothing local found the product and there is no second opinion: the paid cut-out passes its
    # checks, but no independent model agrees with it.
    result = run(build(BlindSegmenter(), FuzzyPaid(clean_on_crops=True)))
    p = result.processing
    assert p.ai_gate == "PASS" and p.final_status == "NEEDS_REVIEW"
    assert "MODEL_DISAGREEMENT" in p.reason_codes
    [check] = [f for f in result.flags if f.code == "cutout_check"]
    assert "second model" in check.message
    off = run(build(BlindSegmenter(), FuzzyPaid(clean_on_crops=True), cfg=cfg(ready_min_agreement=0)))
    assert off.processing.final_status == "READY"


def test_the_resolution_second_opinion() -> None:
    local, paid = VerifiedClean(), PaidSegmenter()
    result = run(build(local, paid, cfg=cfg(local_second_opinion="resolution")))
    p = result.processing
    assert len(local.inputs) == 2 and local.verify_inputs == [768]  # the cut-out, its mirror, one check at 768
    assert p.quality_checks["cutout_verify_iou"] == 1.0 and p.quality_checks["cutout_flip_disagreement"] == 0.0
    assert p.gate == "SAFE_LOCAL" and p.local_accepted and paid.inputs == [] and p.final_status == "READY"
    assert p.quality_checks["cutout_model_agreement"] == 1.0


def test_a_local_cutout_the_second_opinion_disagrees_with_is_escalated() -> None:
    paid = PaidSegmenter()
    result = run(build(DisagreeingClean(), paid, cfg=cfg(local_second_opinion="resolution")))
    p = result.processing
    assert p.gate == "UNCERTAIN" and len(paid.inputs) == 1 and "MODEL_DISAGREEMENT" in p.reason_codes
    assert p.quality_checks["cutout_model_agreement"] == 1.0  # the paid result matches the local one
    assert p.final_status == "READY" and p.route == "local_then_replicate"
    no_check = run(build(DisagreeingClean(), PaidSegmenter(), cfg=cfg(local_second_opinion="off")))
    assert no_check.processing.gate == "SAFE_LOCAL"  # without the second opinion it would have been kept


class SquareShy(CleanSegmenter):
    """Right on the photo as given, but shifted sideways when shown it letterboxed (square)."""

    def predict(self, rgb: np.ndarray) -> np.ndarray:
        mask = super().predict(rgb)
        return np.roll(mask, 60, axis=1) if rgb.shape[0] == rgb.shape[1] else mask


def test_the_letterbox_second_opinion_is_the_default_next_to_the_mirrored_pass() -> None:
    local, paid = CleanSegmenter(), PaidSegmenter()
    result = run(build(local, paid, cfg=cfg()))
    p = result.processing
    # the cut-out, its mirrored pass, and the square second opinion (the photo padded, aspect kept)
    assert local.inputs == [(1000, 800), (1000, 800), (1000, 1000)]
    assert p.quality_checks["cutout_verify_iou"] == 1.0 and p.quality_checks["cutout_flip_disagreement"] == 0.0
    assert p.gate == "SAFE_LOCAL" and p.final_status == "READY" and paid.inputs == []
    verify = [a for a in p.attempts if a.method == "local_verify"]
    assert len(verify) == 1 and verify[0].outcome == "check" and verify[0].model.endswith("letterbox")


def test_a_letterbox_disagreement_escalates() -> None:
    paid = PaidSegmenter()
    result = run(build(SquareShy(), paid, cfg=cfg()))
    p = result.processing
    assert p.gate == "UNCERTAIN" and "MODEL_DISAGREEMENT" in p.reason_codes and len(paid.inputs) == 1
    assert p.route == "local_then_replicate" and p.final_status == "READY"  # the paid one matches the local one


def test_no_second_opinion_for_the_classic_backend() -> None:
    from app.backends.classic import ClassicSegmenter

    result = run(build(ClassicSegmenter(), None, cfg=cfg()))
    assert not [a for a in result.processing.attempts if a.method == "local_verify"]


class RedSegmenter(SecondOpinion, CleanSegmenter):
    """Finds the red product (at any size)."""

    def predict(self, rgb: np.ndarray) -> np.ndarray:
        self.inputs.append((rgb.shape[1], rgb.shape[0]))
        return red_parts(rgb)

    def predict_at(self, rgb: np.ndarray, input_size: int) -> np.ndarray:
        return red_parts(rgb)


def busy_photo() -> np.ndarray:
    """A red product on a noisy blue-green backdrop (a busy scene, no red in it)."""
    rng = np.random.default_rng(5)
    img = np.zeros((800, 1000, 3), np.uint8)
    img[..., 1] = rng.integers(60, 200, (800, 1000))
    img[..., 2] = rng.integers(60, 200, (800, 1000))
    img[250:550, 350:650] = (200, 40, 40)
    return img


def test_a_busy_background_is_never_ready() -> None:
    result = run(build(RedSegmenter(), PaidSegmenter()), busy_photo())
    p = result.processing
    assert p.analysis is not None and p.analysis["background_complexity"] in ("medium", "high")
    assert p.final_status == "NEEDS_REVIEW" and "COMPLEX_BACKGROUND" in p.reason_codes
    [check] = [f for f in result.flags if f.code == "cutout_check"]
    assert "busy background" in check.message
    off = run(build(RedSegmenter(), PaidSegmenter(), cfg=cfg(ready_requires_plain_background=False)), busy_photo())
    assert off.processing.final_status == "READY"


def test_paid_result_unsafe_twice_needs_review() -> None:
    paid = FuzzyPaid()
    result = run(build(BlindSegmenter(), paid))
    p = result.processing
    assert p.ai_gate == "UNSAFE" and p.replicate_attempts == 2 and p.final_status == "NEEDS_REVIEW"
    assert {"AI_RESULT_UNSAFE", "LOW_SEGMENTATION_CONFIDENCE"} <= set(p.reason_codes)
    assert result.flags  # a flag always says why


def test_paid_retry_is_skipped_when_the_crop_would_be_the_whole_photo() -> None:
    big = np.full((600, 600, 3), 247, np.uint8)
    cv2.rectangle(big, (40, 40), (560, 560), (200, 40, 40), -1)
    paid = FuzzyPaid(clean_on_crops=True)
    result = run(build(BlindSegmenter(), paid), big)
    assert result.processing.replicate_attempts == 1 and len(paid.inputs) == 1


def test_escalation_max_attempts_one_never_retries() -> None:
    paid = FuzzyPaid(clean_on_crops=True)
    result = run(build(BlindSegmenter(), paid, cfg=cfg(escalation_max_attempts=1)))
    assert result.processing.replicate_attempts == 1 and result.processing.ai_gate == "UNSAFE"


# --------------------------------------------------------------------------------------
# Routing: forced, rollout, shadow
# --------------------------------------------------------------------------------------
FORCED = SETTINGS.model_copy(update={"force_escalation": True})


def test_forced_escalation_skips_the_local_model() -> None:
    local, paid = VerifiedClean(), PaidSegmenter()
    result = run(build(local, paid, cfg=cfg(local_second_opinion="resolution")), settings=FORCED)
    p = result.processing
    # the local cut-out isn't made; only the second opinion runs, to confirm the paid one
    assert local.inputs == [] and local.verify_inputs == [768] and len(paid.inputs) == 1
    assert p.route == "replicate" and not p.local_attempted and p.gate is None and p.ai_gate == "PASS"
    assert p.reason_codes == ["FORCED_BY_MERCHANT"] and p.final_status == "READY"


def test_forced_escalation_with_the_paid_model_down_falls_back_to_local_for_review() -> None:
    local = CleanSegmenter()
    result = run(build(local, PaidSegmenter(fail=True)), settings=FORCED)
    p = result.processing
    assert local.inputs and p.route == "local" and p.gate == "SAFE_LOCAL"
    assert p.final_status == "NEEDS_REVIEW"  # the merchant asked for the stronger model
    assert {"FORCED_BY_MERCHANT", "ESCALATION_UNAVAILABLE"} <= set(p.reason_codes)
    assert any(f.code == "cutout_check" for f in result.flags)


def test_forced_escalation_without_a_stronger_model_says_so() -> None:
    result = run(build(CleanSegmenter(), None), settings=FORCED)
    p = result.processing
    assert p.final_status == "NEEDS_REVIEW" and "ESCALATION_UNAVAILABLE" in p.reason_codes


def test_forced_escalation_is_never_answered_with_no_change() -> None:
    data, settings = ready_made()
    result = build(CleanSegmenter(), PaidSegmenter()).run(data, settings.model_copy(update={"force_escalation": True}))
    assert result.processing.final_status != "NO_CHANGE" and result.processing.replicate_calls == 1


@pytest.mark.parametrize("kw", [{"local_processing_percentage": 0}, {"local_processing_enabled": False}])
def test_rollout_sends_images_outside_it_to_the_paid_model(kw: dict[str, object]) -> None:
    local, paid = VerifiedClean(), PaidSegmenter()
    result = run(build(local, paid, cfg=cfg(local_second_opinion="resolution", **kw)))
    p = result.processing
    assert local.inputs == [] and p.route == "replicate" and p.final_status == "READY"
    assert p.reason_codes == ["ROLLOUT_NOT_LOCAL"]


def test_rollout_with_the_paid_model_down_uses_a_safe_local_result() -> None:
    result = run(build(CleanSegmenter(), PaidSegmenter(fail=True), cfg=cfg(local_processing_percentage=0)))
    p = result.processing
    assert p.route == "local" and p.gate == "SAFE_LOCAL" and p.final_status == "READY"
    assert "ESCALATION_UNAVAILABLE" in p.reason_codes  # so the result isn't reused


def test_local_processing_switched_off_never_makes_a_local_result_ready() -> None:
    result = run(build(CleanSegmenter(), PaidSegmenter(fail=True), cfg=cfg(local_processing_enabled=False)))
    assert result.processing.route == "local" and result.processing.final_status == "NEEDS_REVIEW"


def test_rollout_bucket_is_stable_per_photo_and_splits_traffic() -> None:
    pipeline = build(CleanSegmenter(), PaidSegmenter(), cfg=cfg(local_processing_percentage=50))
    rng = np.random.default_rng(7)
    photos = [rng.bytes(64) for _ in range(400)]
    modes = [pipeline._route(d, SETTINGS).mode for d in photos]
    assert modes == [pipeline._route(d, SETTINGS).mode for d in photos]
    assert 0.4 < modes.count("local") / len(modes) < 0.6


def test_shadow_mode_judges_local_but_uses_the_paid_result() -> None:
    local, paid = CleanSegmenter(), PaidSegmenter()
    result = run(build(local, paid, cfg=cfg(local_processing_shadow=True)))
    p = result.processing
    assert local.inputs and len(paid.inputs) == 1
    assert p.route == "local_then_replicate" and p.gate == "SAFE_LOCAL" and not p.local_accepted
    assert p.shadow == {
        "mode": "shadow",
        "local_gate": "SAFE_LOCAL",
        "local_would_have_been_used": True,
        "iou_local_vs_final": pytest.approx(1.0, abs=1e-3),
    }
    outcomes = {a.method: a.outcome for a in p.attempts if a.operation == "background_removal"}
    assert outcomes == {"local": "shadow", "local_verify": "check", "replicate": "used"}
    assert p.reason_codes == ["SHADOW_MODE"] and p.final_status == "READY"


# --------------------------------------------------------------------------------------
# Analysis and NO_CHANGE
# --------------------------------------------------------------------------------------
def ready_made(size: int = 1000) -> tuple[bytes, ProcessSettings]:
    """A photo that already meets the settings: square, white, product centred at the margin."""
    img = np.full((size, size, 3), 255, np.uint8)
    m = round(0.08 * size)
    cv2.rectangle(img, (m, round(0.3 * size)), (size - m - 1, round(0.7 * size) - 1), (200, 40, 40), -1)
    settings = ProcessSettings(aspect="1:1", margin_pct=8, remove_bg=True, output_format="png", target_px=2048)
    return to_bytes(img, "PNG"), settings


def analyse(data: bytes, settings: ProcessSettings):  # type: ignore[no-untyped-def]
    src = load_image(data, max_source_pixels=100_000_000, max_working_pixels=40_000_000)
    return analyze_image(data, src, analyze_border(src.rgb), settings)


def test_a_photo_that_already_meets_the_request_is_returned_unchanged() -> None:
    data, settings = ready_made()
    local, paid = CleanSegmenter(), PaidSegmenter()
    result = build(local, paid).run(data, settings)
    p = result.processing
    assert p.final_status == "NO_CHANGE" and p.route == "no_change" and p.replicate_calls == 0
    assert result.artifacts["output"] == data  # byte for byte
    assert local.inputs == [] and paid.inputs == []
    assert result.flags == [] and p.analysis is not None and p.analysis["already_acceptable"] is True
    assert (result.output.width, result.output.height, result.output.format) == (1000, 1000, "png")


def test_no_change_detection_can_be_switched_off() -> None:
    data, settings = ready_made()
    result = build(CleanSegmenter(), None, cfg=cfg(no_change_detection=False)).run(data, settings)
    assert result.processing.final_status == "READY" and result.processing.route == "local"


@pytest.mark.parametrize(
    ("change", "why"),
    [
        ({"output_format": "jpeg"}, "format"),
        ({"aspect": "4:5"}, "aspect"),
        ({"margin_pct": 15}, "centering_or_margins"),
        ({"bg_color": "#F0F0F0"}, "background_colour"),
        ({"target_px": 800}, "resize"),
        ({"upscale": True, "upscale_threshold_px": 1200}, "upscale_requested"),
    ],
)
def test_analysis_is_strict_about_already_acceptable(change: dict[str, object], why: str) -> None:
    data, settings = ready_made()
    facts = analyse(data, settings.model_copy(update=change))
    assert not facts.already_acceptable and why in facts.not_acceptable_because
    assert facts.recommended_route == "local"


def test_analysis_rejects_off_centre_products_specks_and_transparency() -> None:
    settings = ProcessSettings(aspect="1:1", output_format="png")
    off = np.full((1000, 1000, 3), 255, np.uint8)
    cv2.rectangle(off, (200, 300), (999 - 40, 700), (200, 40, 40), -1)
    assert "centering_or_margins" in analyse(to_bytes(off, "PNG"), settings).not_acceptable_because

    data, settings = ready_made()
    img = np.array(load_image(data, max_source_pixels=10**8, max_working_pixels=10**8).rgb)
    img[120:150, 400:460] = 225  # a faint smudge above the product (0.2% of the background)
    facts = analyse(to_bytes(img, "PNG"), settings)
    assert not facts.already_acceptable

    rgba = np.zeros((400, 400, 4), np.uint8)
    rgba[100:300, 32:368] = (200, 40, 40, 255)
    facts = analyse(to_bytes(rgba, "PNG"), settings)
    assert "has_transparency" in facts.not_acceptable_because


def test_analysis_rates_background_complexity() -> None:
    settings = ProcessSettings()
    plain = analyse(to_bytes(product_on_white(), "PNG"), settings)
    assert plain.background_complexity in ("clean", "low") and plain.product_box is not None
    rng = np.random.default_rng(3)
    busy = rng.integers(0, 255, (800, 1000, 3), dtype=np.uint8)
    busy[250:550, 350:650] = (200, 40, 40)
    facts = analyse(to_bytes(busy, "PNG"), settings)
    assert facts.background_complexity == "high" and facts.analysis_confidence < plain.analysis_confidence


def test_product_mask_helper_matches_the_product() -> None:
    # Guards the fixtures above: product_mask finds the synthetic product and nothing else.
    img = product_on_white()
    assert 0.08 < product_mask(img).mean() < 0.2
