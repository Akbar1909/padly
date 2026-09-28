"""Cheapest safe method first: local results are validated and escalated to the paid backend
only when they fail, with cost tracking (app/pipeline.py, app/escalation.py, app/trace.py)."""

from __future__ import annotations

import json
from typing import Any

import cv2
import httpx
import numpy as np
from fastapi.testclient import TestClient

from app.backends.base import Backend, Segmenter, UpscaleFactor, Upscaler
from app.backends.classic import ClassicSegmenter, LanczosUpscaler
from app.backends.replicate import API_URL, ReplicateClient
from app.checks import flag
from app.config import ServiceConfig
from app.errors import backend_failed
from app.escalation import EscalationGate
from app.main import create_app
from app.ops import lanczos_upscale
from app.pipeline import Pipeline, cutout_check_flags
from app.quality import QualityReport
from app.schemas import ProcessSettings
from app.security import sign
from app.text_detect import MserTextDetector
from app.trace import begin_trace, record_replicate_call

from .conftest import StubStorage
from .helpers import SECRET, product_on_white, to_bytes

PRICE = 0.0014


def product_mask(rgb: np.ndarray) -> np.ndarray:
    """The exact product of ``product_on_white`` (anything clearly not background)."""
    return (np.abs(rgb.astype(np.int16) - 247).max(axis=2) > 30).astype(np.float32)


class CleanSegmenter(Segmenter):
    """A good local model: returns the exact product mask."""

    in_process = True

    def __init__(self, name: str = "birefnet-lite") -> None:
        self.name = name
        self.inputs: list[tuple[int, int]] = []

    def predict(self, rgb: np.ndarray) -> np.ndarray:
        self.inputs.append((rgb.shape[1], rgb.shape[0]))
        return product_mask(rgb)


class FuzzySegmenter(CleanSegmenter):
    """A weak local model: right product, but a wide band of undecided edge pixels."""

    def predict(self, rgb: np.ndarray) -> np.ndarray:
        mask = super().predict(rgb)
        band = cv2.dilate(mask, np.ones((41, 41), np.uint8)) - cv2.erode(mask, np.ones((41, 41), np.uint8))
        mask[band > 0] = 0.5
        return mask


class PropFlipSegmenter(CleanSegmenter):
    """A confident but knife-edge local model: it also keeps a background patch as a "prop",
    but only when it sees the product on the left of its input (so only on the mirrored
    ``product_on_white``, whose product is on the right)."""

    def predict(self, rgb: np.ndarray) -> np.ndarray:
        mask = super().predict(rgb)
        xs = np.nonzero(mask)[1]
        if xs.size and xs.mean() < rgb.shape[1] / 2:
            mask[60:160, 60:160] = 1.0
        return mask


class MirrorSpeckSegmenter(CleanSegmenter):
    """Keeps six small background specks, each under 0.5% of the product (fragments the cut-out
    itself would drop), but only on the mirrored ``product_on_white`` (product on the left)."""

    def predict(self, rgb: np.ndarray) -> np.ndarray:
        mask = super().predict(rgb)
        xs = np.nonzero(mask)[1]
        if xs.size and xs.mean() < rgb.shape[1] / 2:
            for x in range(600, 900, 50):
                mask[650:670, x : x + 20] = 1.0
        return mask


class MirrorSliceSegmenter(CleanSegmenter):
    """Misses an 8 px slice of the product, in input pixels, only when it is shown the mirror
    of an input it saw before (the pipeline's mirrored pass)."""

    def __init__(self) -> None:
        super().__init__()
        self.seen: list[np.ndarray] = []

    def predict(self, rgb: np.ndarray) -> np.ndarray:
        mask = super().predict(rgb)
        if any(s.shape == rgb.shape and np.array_equal(s[:, ::-1], rgb) for s in self.seen):
            x = int(np.nonzero(mask)[1].mean())
            mask[:, x : x + 8] = 0.0
        self.seen.append(rgb.copy())
        return mask


class CountingClassic(ClassicSegmenter):
    def __init__(self) -> None:
        self.calls = 0

    def predict(self, rgb: np.ndarray) -> np.ndarray:
        self.calls += 1
        return super().predict(rgb)


class BlindSegmenter(CleanSegmenter):
    """A local model that finds nothing."""

    def predict(self, rgb: np.ndarray) -> np.ndarray:
        super().predict(rgb)
        return np.zeros(rgb.shape[:2], np.float32)


def red_parts(rgb: np.ndarray) -> np.ndarray:
    return ((rgb[..., 0] > 150) & (rgb[..., 1] < 100) & (rgb[..., 2] < 100)).astype(np.float32)


class HalfSetSegmenter(CleanSegmenter):
    """Finds the red products of a set, but misses any in the left 40% of its input: on the
    full photo it sees one of two, and only the mirrored pass sees the other."""

    def predict(self, rgb: np.ndarray) -> np.ndarray:
        self.inputs.append((rgb.shape[1], rgb.shape[0]))
        mask = red_parts(rgb)
        n, labels, _, centroids = cv2.connectedComponentsWithStats(mask.astype(np.uint8))
        for i in range(1, n):
            if centroids[i][0] < 0.4 * rgb.shape[1]:
                mask[labels == i] = 0.0
        return mask


def two_product_set() -> np.ndarray:
    """Two small red products on a gradient (not plain) backdrop."""
    ramp = np.linspace(60, 230, 1600, dtype=np.float32)
    img = np.repeat(np.repeat(ramp[None, :, None], 1200, axis=0), 3, axis=2).astype(np.uint8)
    img[700:860, 1000:1160] = (200, 40, 40)
    img[300:460, 300:460] = (200, 40, 40)
    return img


class PaidSegmenter(CleanSegmenter):
    """Stands in for Replicate: records a billed prediction per call, or fails like a 402."""

    in_process = False

    def __init__(self, fail: bool = False) -> None:
        super().__init__("BiRefNet@replicate:test")
        self.fail = fail

    def predict(self, rgb: np.ndarray) -> np.ndarray:
        self.inputs.append((rgb.shape[1], rgb.shape[0]))
        if self.fail:
            raise backend_failed("Replicate create failed: HTTP 402 Insufficient credit")
        record_replicate_call(
            model="men1scus/birefnet",
            version="v1",
            predict_time_s=0.5,
            usd_per_s=PRICE,
            duration_ms=900,
            status="succeeded",
        )
        return product_mask(rgb)


class LocalAIUpscaler(Upscaler):
    is_ai = True

    def __init__(self) -> None:
        self.calls = 0

    def model_name(self, scale: UpscaleFactor) -> str:
        return f"RealESRGAN_x{scale}plus"

    def upscale(self, rgb: np.ndarray, scale: UpscaleFactor) -> np.ndarray:
        self.calls += 1
        return lanczos_upscale(rgb, float(scale))


class PaidUpscaler(LocalAIUpscaler):
    def model_name(self, scale: UpscaleFactor) -> str:
        return "RealESRGAN@replicate:test"

    def upscale(self, rgb: np.ndarray, scale: UpscaleFactor) -> np.ndarray:
        record_replicate_call(
            model="nightmareai/real-esrgan",
            version="v2",
            predict_time_s=2.0,
            usd_per_s=PRICE,
            duration_ms=3000,
            status="succeeded",
        )
        return super().upscale(rgb, scale)


def build(
    segmenter: Segmenter,
    paid: Segmenter | None,
    *,
    cfg: ServiceConfig | None = None,
    gate: EscalationGate | None = None,
    local_upscaler: Upscaler | None = None,
    paid_upscaler: Upscaler | None = None,
) -> Pipeline:
    # The mirrored-pass tests below predate the second opinion (test_gate.py covers it), so the
    # default here is the mirrored pass alone.
    cfg = cfg or ServiceConfig(allow_unsigned=True, local_second_opinion="off")
    local = Backend(kind="local", device="cpu", segmenter=segmenter, upscaler=local_upscaler or LanczosUpscaler())
    escalation = None
    if paid is not None:
        escalation = Backend(kind="replicate", device="cpu", segmenter=paid, upscaler=paid_upscaler or PaidUpscaler())
    return Pipeline(cfg, local, MserTextDetector(), escalation=escalation, gate=gate)


SETTINGS = ProcessSettings(aspect="1:1", remove_bg=True, target_px=1024)


def run(pipeline: Pipeline, img: np.ndarray | None = None, settings: ProcessSettings = SETTINGS):
    return pipeline.run(to_bytes(product_on_white() if img is None else img, "PNG"), settings)


def test_good_local_cutout_never_calls_the_paid_model() -> None:
    paid = PaidSegmenter()
    result = run(build(CleanSegmenter(), paid))
    p = result.processing
    assert paid.inputs == []
    assert p.method == "local" and not p.replicate_used and p.replicate_calls == 0
    assert p.estimated_cost_usd == 0.0 and p.fallback_reason is None and p.quality_score == 1.0
    assert result.models.backend == "local" and result.models.segmentation == "birefnet-lite"
    assert [(a.operation, a.method, a.outcome) for a in p.attempts] == [("background_removal", "local", "used")]
    assert p.operations == ["decode", "analysis", "background_removal", "canvas", "export"]
    assert p.quality_checks["aspect_ok"] and p.quality_checks["centered"] and p.quality_checks["margins_ok"]


def test_failed_local_cutout_escalates_once_and_keeps_the_better_result() -> None:
    paid = PaidSegmenter()
    result = run(build(FuzzySegmenter(), paid))
    p = result.processing
    assert len(paid.inputs) == 1
    assert p.method == "replicate" and p.replicate_used and p.replicate_calls == 1  # it made the result
    assert p.replicate_models == ["men1scus/birefnet"]
    assert p.estimated_cost_usd == round(0.5 * PRICE, 6)
    assert p.fallback_reason == "background_artifacts"
    assert [(a.method, a.outcome) for a in p.attempts] == [("local", "rejected"), ("replicate", "used")]
    assert p.attempts[1].cost_usd == round(0.5 * PRICE, 6)
    assert result.models.backend == "replicate" and result.models.segmentation == "BiRefNet@replicate:test"
    assert "mask_low_confidence" not in {f.code for f in result.flags}


def test_without_a_paid_backend_the_local_result_is_kept_and_flagged_for_review() -> None:
    result = run(build(FuzzySegmenter(), None))
    assert result.processing.method == "local" and result.processing.replicate_calls == 0
    assert result.processing.quality_score is not None and result.processing.quality_score < 1.0
    assert "cutout_check" in {f.code for f in result.flags}  # unverified: the merchant reviews it


def test_paid_outage_keeps_the_local_result_then_cools_down() -> None:
    clock = [1000.0]
    gate = EscalationGate(cooldown_s=120, clock=lambda: clock[0])
    paid = PaidSegmenter(fail=True)
    pipeline = build(FuzzySegmenter(), paid, gate=gate)

    first = run(pipeline).processing
    assert len(paid.inputs) == 1
    assert "replicate_unavailable" in (first.fallback_reason or "")
    assert [(a.method, a.outcome) for a in first.attempts] == [("local", "used"), ("replicate", "failed")]

    clock[0] += 60  # still cooling down: no paid call, the image is still processed
    second = run(pipeline).processing
    assert len(paid.inputs) == 1 and second.replicate_calls == 0
    assert "not escalated: escalation_cooldown" in (second.fallback_reason or "")

    clock[0] += 61
    paid.fail = False
    third = run(pipeline).processing
    assert len(paid.inputs) == 2 and third.replicate_calls == 1


def test_daily_cap_limits_paid_calls() -> None:
    gate = EscalationGate(cooldown_s=0, daily_max_calls=1)
    paid = PaidSegmenter()
    pipeline = build(FuzzySegmenter(), paid, gate=gate)
    assert run(pipeline).processing.replicate_calls == 1
    capped = run(pipeline).processing
    assert capped.replicate_calls == 0 and "escalation_daily_cap" in (capped.fallback_reason or "")


def l_shaped(backdrop: np.ndarray) -> np.ndarray:
    """A small asymmetric (L-shaped) red product on ``backdrop`` (1600 px)."""
    img = backdrop.copy()
    img[900:1060, 1000:1040] = (200, 40, 40)
    img[1020:1060, 1000:1160] = (200, 40, 40)
    return img


class RedSegmenter(CleanSegmenter):
    def predict(self, rgb: np.ndarray) -> np.ndarray:
        self.inputs.append((rgb.shape[1], rgb.shape[0]))
        return red_parts(rgb)


def test_crop_attempts_mirror_back_inside_the_crop() -> None:
    # Asymmetric product: a mirrored mask placed without mirroring back inside the crop would
    # disagree with the cut-out.
    plain = l_shaped(np.full((1600, 1600, 3), 247, np.uint8))
    zoom = run(build(CleanSegmenter(), PaidSegmenter()), plain).processing
    assert [(a.method, a.outcome, a.reason) for a in zoom.attempts] == [("local_zoom", "used", None)]
    assert zoom.quality_checks["cutout_flip_disagreement"] == 0.0
    assert zoom.quality_checks["cutout_flip_compare_px"] < 400  # compared on the crop, not the frame

    ramp = np.linspace(60, 230, 1600, dtype=np.float32)
    gradient = l_shaped(np.repeat(np.repeat(ramp[None, :, None], 1600, axis=0), 3, axis=2).astype(np.uint8))
    refine = run(build(RedSegmenter(), PaidSegmenter()), gradient).processing
    assert [(a.method, a.outcome) for a in refine.attempts] == [("local", "rejected"), ("local_refine", "used")]
    assert refine.replicate_calls == 0
    assert refine.quality_checks["cutout_flip_disagreement"] == 0.0
    assert refine.quality_checks["cutout_flip_disagreement_outside_crop"] == 0.0


def test_a_crop_attempt_is_compared_with_its_mirrored_run_on_the_crop() -> None:
    img = np.full((1600, 1600, 3), 247, np.uint8)
    img[900:1060, 1000:1160] = (200, 40, 40)  # a 160 px product in a 1600 px photo
    result = run(build(MirrorSliceSegmenter(), None), img)
    # On the ~224 px crop the missed 8 px slice is a region (5% of the product); on the full
    # frame, compared at 1024 px, the same slice is ~5 px wide: edge jitter at that scale.
    assert [(a.method, a.outcome, a.reason) for a in result.processing.attempts] == [
        ("local_zoom", "rejected", "unstable_cutout"),
        ("local", "used", None),
    ]
    assert result.processing.quality_checks["cutout_flip_compare_px"] == 1024.0


def test_the_classic_backend_is_never_run_mirrored() -> None:
    classic = CountingClassic()
    result = run(build(classic, None))
    assert classic.calls == 1  # mirror-symmetric by construction: one predict per cut-out
    assert result.processing.quality_checks["cutout_flip_disagreement"] is None


def test_small_product_is_cut_out_from_a_zoomed_crop_for_free() -> None:
    img = np.full((1600, 1600, 3), 247, np.uint8)
    img[900:1060, 1000:1160] = (200, 40, 40)  # a 160 px product in a 1600 px photo
    local, paid = CleanSegmenter(), PaidSegmenter()
    result = run(build(local, paid), img)
    p = result.processing
    assert local.inputs and max(local.inputs[0]) < 400  # the model saw a crop, not the whole photo
    assert [(a.method, a.outcome) for a in p.attempts] == [("local_zoom", "used")]
    assert p.replicate_calls == 0 and paid.inputs == []
    assert "mask_empty" not in {f.code for f in result.flags}


def test_a_cutout_that_changes_when_mirrored_is_escalated_as_unstable() -> None:
    local, paid = PropFlipSegmenter(), PaidSegmenter()
    result = run(build(local, paid))
    p = result.processing
    assert len(local.inputs) == 2 and len(paid.inputs) == 1  # one mirrored local pass, one paid call
    assert p.fallback_reason == "unstable_cutout"
    assert [(a.method, a.outcome, a.reason) for a in p.attempts] == [
        ("local", "rejected", "unstable_cutout"),
        ("replicate", "used", None),
    ]
    assert p.quality_checks["cutout_flip_disagreement"] is None  # the paid model is never re-run mirrored
    assert "cutout_check" not in {f.code for f in result.flags}

    alone = run(build(PropFlipSegmenter(), None))  # no paid backend: kept, and the merchant is told
    assert alone.processing.quality_checks["cutout_flip_disagreement"] > 0.015
    checks = [f.message for f in alone.flags if f.code == "cutout_check"]
    assert checks == [
        "Please check this image: the cut-out may include a prop or background, or miss part of the product"
    ]

    off = PropFlipSegmenter()  # ESCALATE_FLIP_DISAGREEMENT=0: no mirrored pass at all
    no_pass = ServiceConfig(allow_unsigned=True, escalate_flip_disagreement=0, local_second_opinion="off")
    result = run(build(off, PaidSegmenter(), cfg=no_pass))
    assert len(off.inputs) == 1 and result.processing.replicate_calls == 0


def test_specks_only_the_mirrored_run_keeps_are_removed_like_from_the_cutout() -> None:
    # Together the specks are ~2.5% of the product, above the limit if they counted; the
    # mirrored mask is cleaned like analysis.cleaned, so only whole regions of it count.
    local, paid = MirrorSpeckSegmenter(), PaidSegmenter()
    result = run(build(local, paid))
    p = result.processing
    assert len(local.inputs) == 2 and paid.inputs == []
    assert p.quality_checks["cutout_flip_disagreement"] == 0.0
    assert [(a.method, a.outcome, a.reason) for a in p.attempts] == [("local", "used", None)]


def test_an_empty_local_cutout_is_escalated_without_a_mirrored_pass() -> None:
    local, paid = BlindSegmenter(), PaidSegmenter()
    result = run(build(local, paid))
    assert len(local.inputs) == 1 and len(paid.inputs) == 1  # not re-run mirrored: nothing to compare
    assert result.processing.fallback_reason == "empty_mask"
    assert [(a.method, a.outcome) for a in result.processing.attempts] == [("local", "rejected"), ("replicate", "used")]


def test_refine_crop_cannot_hide_a_product_the_mirrored_full_frame_pass_found() -> None:
    local, paid = HalfSetSegmenter(), PaidSegmenter()
    paid.predict = lambda rgb: (PaidSegmenter.predict(paid, rgb), red_parts(rgb))[1]  # type: ignore[method-assign]
    result = run(build(local, paid), two_product_set())
    p = result.processing
    # full frame + mirrored, then the refine crop around the one product found + mirrored
    assert len(local.inputs) == 4 and max(local.inputs[2]) < 400
    assert [(a.method, a.outcome) for a in p.attempts] == [
        ("local", "rejected"),
        ("local_refine", "rejected"),
        ("replicate", "used"),
    ]
    # the crop is stable when mirrored; the full-frame mirrored pass found a product outside it
    assert "unstable_cutout" in (p.attempts[1].reason or "")
    assert p.fallback_reason == "unstable_cutout" and len(paid.inputs) == 1
    assert result.metrics.mask_fragments == 2  # the paid model's cut-out has both products

    alone = run(build(HalfSetSegmenter(), None), two_product_set())
    assert [(a.method, a.outcome) for a in alone.processing.attempts] == [
        ("local", "rejected"),
        ("local_refine", "used"),
    ]
    assert alone.processing.quality_checks["cutout_flip_disagreement"] == 0.0
    assert alone.processing.quality_checks["cutout_flip_disagreement_outside_crop"] > 0.5
    assert "cutout_check" in {f.code for f in alone.flags}


def test_a_cutout_running_into_the_photos_edge_is_flagged_but_not_escalated() -> None:
    img = product_on_white()
    img[:120, :] = (40, 60, 180)  # a blue band across the top: the product runs into the photo's edge
    local, paid = CleanSegmenter(), PaidSegmenter()
    # (the band also makes the background "busy"; that rule has its own test in test_gate.py)
    plain_rule_off = ServiceConfig(allow_unsigned=True, ready_requires_plain_background=False)
    result = run(build(local, paid, cfg=plain_rule_off), img)
    assert paid.inputs == [] and result.processing.fallback_reason is None
    assert result.processing.quality_checks["cutout_edge_contact"] == 1.0
    checks = [f.message for f in result.flags if f.code == "cutout_check"]
    assert checks == [
        "Please check this image: the cut-out runs into the photo's edge, so the product or a prop may be cut off"
    ]

    both = run(build(PropFlipSegmenter(), None), img)  # with another note: still a single flag
    checks = [f.message for f in both.flags if f.code == "cutout_check"]
    assert len(checks) == 1 and "prop or background" in checks[0] and "photo's edge" in checks[0]


def test_no_edge_note_for_a_whole_photo_cutout_or_on_top_of_crop_too_tight() -> None:
    whole = QualityReport(score=0.4, reasons=["full_mask"], checks={"edge_contact": 1.0})
    mask_full = [flag("mask_full", "The cut-out covers 98% of the image")]
    assert cutout_check_flags(whole, mask_full) == []  # the problem is the background, not the edge
    tight = QualityReport(score=0.5, reasons=["crop_too_tight"], checks={"edge_contact": 0.3})
    assert [f.message for f in cutout_check_flags(tight, [])] == [
        "Please check this image: the product may be cut off at one side"
    ]


def test_ai_upscaling_too_big_for_the_cpu_goes_to_the_paid_backend() -> None:
    cfg = ServiceConfig(allow_unsigned=True, local_max_ai_upscale_pixels=50_000)
    local_up, paid_up = LocalAIUpscaler(), PaidUpscaler()
    pipeline = build(CleanSegmenter(), PaidSegmenter(), cfg=cfg, local_upscaler=local_up, paid_upscaler=paid_up)
    settings = ProcessSettings(aspect="1:1", remove_bg=True, target_px=2048, upscale=True)
    result = run(pipeline, product_on_white(500, 400), settings)
    p = result.processing
    assert local_up.calls == 0 and paid_up.calls == 1
    assert result.upscale.applied and result.upscale.method.startswith("realesrgan-x")
    assert result.upscale.reason.endswith("too large for AI upscaling on CPU, ran on replicate")
    assert p.operations[:4] == ["decode", "analysis", "upscale", "background_removal"]
    assert ("upscale", "replicate", "used") in [(a.operation, a.method, a.outcome) for a in p.attempts]
    assert p.fallback_reason == "too_slow_on_cpu" and p.estimated_cost_usd == round(2.0 * PRICE, 6)


def test_small_ai_upscale_stays_local() -> None:
    local_up, paid_up = LocalAIUpscaler(), PaidUpscaler()
    pipeline = build(CleanSegmenter(), PaidSegmenter(), local_upscaler=local_up, paid_upscaler=paid_up)
    settings = ProcessSettings(aspect="1:1", remove_bg=True, target_px=2048, upscale=True)
    result = run(pipeline, product_on_white(500, 400), settings)
    assert local_up.calls == 1 and paid_up.calls == 0
    assert result.processing.method == "local" and result.processing.replicate_calls == 0


def test_replicate_client_records_the_billed_prediction_time() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "POST" and str(request.url) == API_URL:
            return httpx.Response(
                201,
                json={
                    "id": "p1",
                    "status": "succeeded",
                    "output": "data:image/png;base64,",
                    "metrics": {"predict_time": 0.84},
                    "urls": {"get": "https://api.replicate.com/v1/predictions/p1"},
                },
            )
        return httpx.Response(404)

    client = ReplicateClient("t", 5, poll_interval_s=0, client=httpx.Client(transport=httpx.MockTransport(handler)))
    trace = begin_trace()
    client.run("v", {}, model="men1scus/birefnet", usd_per_s=PRICE)
    assert len(trace.replicate_calls) == 1
    call = trace.replicate_calls[0]
    assert call.model == "men1scus/birefnet" and call.predict_time_s == 0.84 and call.status == "succeeded"
    assert call.cost_usd == round(0.84 * PRICE, 6) and trace.cost_usd == call.cost_usd


def test_api_reports_processing_and_escalation_backend(cfg: ServiceConfig, storage: StubStorage) -> None:
    paid = PaidSegmenter()

    def factory(c: ServiceConfig) -> Backend:
        if c.model_backend == "replicate":
            return Backend(kind="replicate", device="cpu", segmenter=paid, upscaler=PaidUpscaler())
        return Backend(kind="local", device="cpu", segmenter=FuzzySegmenter(), upscaler=LanczosUpscaler())

    cfg = cfg.model_copy(
        update={"model_backend": "local", "escalation_backend": "replicate", "replicate_api_token": "t"}
    )
    with TestClient(create_app(cfg, backend_factory=factory)) as client:
        assert client.get("/healthz").json()["escalation_backend"] == "replicate"
        body: dict[str, Any] = {
            "request_id": "job_1",
            "source_url": storage.serve("/src/job_1", to_bytes(product_on_white())) + "?X-Amz-Signature=x",
            "source_mime_type": "image/jpeg",
            "uploads": storage.upload_targets("/out/job_1"),
            "settings": {"aspect": "1:1", "remove_bg": True, "target_px": 1024},
        }
        raw = json.dumps(body).encode()
        resp = client.post(
            "/v1/process", content=raw, headers={"Content-Type": "application/json", "X-Signature": sign(SECRET, raw)}
        )
    assert resp.status_code == 200, resp.text
    p = resp.json()["processing"]
    assert p["method"] == "replicate" and p["replicate_calls"] == 1 and p["replicate_used"] is True
    assert p["fallback_reason"] == "background_artifacts" and p["estimated_cost_usd"] > 0
    assert {"operation", "method", "model", "duration_ms", "cost_usd", "outcome"} <= set(p["attempts"][0])
    assert len(paid.inputs) == 1
