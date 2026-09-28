"""The processing pipeline (synchronous; run in a worker thread under the GPU semaphore).

Order (from the build plan):
 0. analysis: does the photo already meet the request? Then nothing is processed and the source
    comes back unmodified (final_status NO_CHANGE; ``analysis.analyze_image``)
 1. decode + normalise (EXIF, ICC → sRGB)
 2. upscale (eligibility, text guardrail, AI x2/x4 or Lanczos, fidelity check)
 3. cut-out (segmentation mask, resized + feathered)
 4. bbox + mask metrics / flags
 5. canvas maths (aspect, margin, centre, never crop, never enlarge by interpolation)
 6. background (composite on bg_color, or seamless padding when keeping the background)
 7. export (format, sRGB ICC, no EXIF, ≤ 20 MP / 20 MB, optional AI XMP)
 8. checks + previews (colour drift, preview / before / mask artifacts)

AI steps try the cheapest safe method first. The cut-out from the models in this process
(MODEL_BACKEND) goes through the quality gate (``quality.assess_cutout``): SAFE_LOCAL (every
check passed with margin), UNCERTAIN (passed, but a measurement is near its limit or a risk
signal fired) or FAILED. Only SAFE_LOCAL skips the paid ESCALATION_BACKEND (Replicate); if
uncertain, escalate. The paid result is validated the same way (``ai_gate`` PASS / UNSAFE); an
unsafe one is tried once more on a zoomed crop, and a result nobody can vouch for is kept for
the merchant to review (final_status NEEDS_REVIEW, with a flag saying why). Only a confident
result with no flags is READY. A local cut-out is also re-run on the mirrored photo, and one
that changes is escalated (``unstable_cutout``): one more local inference per attempt.

Routing (``Route``): local first by default; paid first when the merchant asked for the
stronger model (force_escalation), when LOCAL_PROCESSING_ENABLED is off or the photo falls
outside LOCAL_PROCESSING_PERCENTAGE; LOCAL_PROCESSING_SHADOW runs and judges the local cut-out
but always uses the paid one. What ran, why, paid calls and their estimated cost are returned
as ``processing``.
"""

from __future__ import annotations

import hashlib
import logging
import math
import time
from collections import defaultdict
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field

import cv2
import numpy as np

from .analysis import ImageAnalysis, analyze_image
from .backends.base import Backend, Segmenter, UpscaleFactor, Upscaler
from .backends.classic import BorderStats, ClassicSegmenter, analyze_border, border_difference_mask
from .canvas import Box, CanvasPlan, falloff_weights, fill_scale, plan_canvas, render
from .checks import (
    MaskAnalysis,
    analyze_mask,
    color_drift,
    color_drift_flags,
    fidelity,
    fidelity_flags,
    flag,
    mask_flags,
)
from .config import ServiceConfig
from .errors import ServiceError
from .escalation import EscalationGate
from .imageio import (
    NormalizedImage,
    build_ai_xmp,
    encode_mask_overlay,
    encode_output,
    encode_preview_jpeg,
    load_image,
)
from .ops import downscale_to, image_size, lanczos_upscale, resize_mask
from .quality import (
    EDGE_CONTACT_FLAG,
    FLIP_COMPARE_LONG_SIDE,
    UNSTABLE_PENALTY,
    QualityReport,
    assess_cutout,
    assess_output,
    flip_compare_size,
    flip_disagreement,
    reason_code,
)
from .schemas import (
    CONTENT_TYPES,
    Flag,
    Metrics,
    ModelsInfo,
    OutputInfo,
    ProcessingAttempt,
    ProcessingInfo,
    ProcessSettings,
    SourceInfo,
    UpscaleInfo,
)
from .text_detect import TextDetector, TextResult
from .trace import Attempt, ProcessingTrace, begin_trace, current_trace

log = logging.getLogger(__name__)

WHITE = (255, 255, 255)
KEEP_BG_BOX_PAD = 0.03  # grow the kept-background crop by 3% of the product size
MODEL_MASK_LONG_SIDE = 1024
# Bump when a code change can alter the result for the same image and settings (quality checks,
# escalation rules, compositing, encoding). /healthz reports it (with a hash of the output-
# affecting configuration) as `pipeline_version`; callers key reused results on it, so a bump
# stops reuse of results made by older code (docs/gpu-service-contract.md).
PIPELINE_VERSION = "2026-09-28.4"
REFINE_CROP_PAD = 0.15  # context kept around a small product when it is cut out again
# The paid model's second try is a zoomed crop; one covering more of the photo than this would
# show it the same picture again (and the model is deterministic).
PAID_RETRY_MAX_CROP_FRAC = 0.8
SECOND_OPINION_LONG_SIDE = 1024  # the letterbox second opinion pads the photo at this size


class Timer:
    """Accumulates wall time per phase in milliseconds."""

    def __init__(self) -> None:
        self.ms: dict[str, float] = defaultdict(float)

    @contextmanager
    def __call__(self, phase: str) -> Iterator[None]:
        start = time.perf_counter()
        try:
            yield
        finally:
            self.ms[phase] += (time.perf_counter() - start) * 1000.0


@dataclass
class UpscaleOutcome:
    rgb: np.ndarray
    alpha: np.ndarray | None
    info: UpscaleInfo
    factor: float  # working image size / original size
    wanted: bool  # eligible and the product needed enlarging
    ai_ran: bool = False
    upscaler_name: str | None = None
    text: TextResult | None = None
    text_detector: str | None = None
    fidelity: tuple[float, float] | None = None


@dataclass
class Composition:
    canvas: np.ndarray  # final RGB canvas
    plan: CanvasPlan
    canvas_mask: np.ndarray  # product region on the canvas (for colour drift)
    work_mask: np.ndarray  # product region in working geometry (for colour drift)
    artifact_mask: np.ndarray | None  # cut-out mask in working geometry, None = nothing removed


@dataclass
class PipelineResult:
    artifacts: dict[str, bytes]
    output: OutputInfo
    source: SourceInfo
    upscale: UpscaleInfo
    flags: list[Flag]
    metrics: Metrics
    models: ModelsInfo
    timings_ms: dict[str, float] = field(default_factory=dict)
    processing: ProcessingInfo | None = None


@dataclass
class CutCandidate:
    """One cut-out attempt and its validation."""

    method: str
    model: str
    analysis: MaskAnalysis
    quality: QualityReport
    attempt: Attempt
    # The model's mask for the mirrored input, mirrored back: over the attempt's region (its
    # crop, or the frame) at the comparison size (<= 1024 px), not at full resolution.
    flipped: np.ndarray | None = None
    paid: bool = False  # made by the escalation (paid) backend


@dataclass(frozen=True)
class Route:
    """How this image's AI steps are routed."""

    mode: str  # "local" (paid only when the gate isn't SAFE_LOCAL) | "paid" (paid first) | "shadow"
    reason: str | None = None  # "forced" | "rollout" | "shadow" (a reason name, see REASON_CODES)


@dataclass
class CutoutResult:
    """The kept cut-out and how the quality gate chose it."""

    analysis: MaskAnalysis
    mask: np.ndarray  # feathered, full resolution
    model: str
    quality: QualityReport | None  # the kept cut-out's checks; None for the source's own alpha
    route: str  # "deterministic" (source alpha) | "local" | "replicate" | "local_then_replicate"
    local_gate: str | None = None  # verdict on the best local cut-out; None when none was made
    ai_gate: str | None = None  # "PASS" if a paid cut-out passed its checks, "UNSAFE" if none did
    local_attempted: bool = False
    local_accepted: bool = False  # the local cut-out was kept, and its gate said SAFE_LOCAL
    paid_attempts: int = 0
    ready: bool = True  # the kept cut-out can be READY (confident; a paid one when forced)
    notes: list[str] = field(default_factory=list)  # extra cutout_check notes for the merchant
    shadow: dict[str, object] | None = None


# Why a kept cut-out still failed its checks, or passed them without margin (no stronger model,
# or it didn't do better), for reasons the mask flags above don't already cover. The merchant
# reviews these before applying.
CUTOUT_CHECK_MESSAGES = {
    "background_artifacts": "the cut-out's edges look uncertain",
    "text_or_logo_cut": "a label or logo may be cut off",
    "dropped_inner_part": "part of the product may be missing",
    "crop_too_tight": "the product may be cut off at one side",
    "unstable_cutout": "the cut-out may include a prop or background, or miss part of the product",
    "near_limit": "the automatic checks passed, but only narrowly",
    "fine_structure": "fine details (spokes, wire, lace, hair) may be cut badly",
}
AI_UNSAFE_NOTE = "the stronger model's cut-out didn't pass its checks either"
FORCED_LOCAL_NOTE = "the stronger model's cut-out didn't pass its checks, so this is the standard one"
NOT_ESCALATED_NOTE = "the stronger model wasn't available to double-check it"
UNCONFIRMED_NOTE = "the automatic checks couldn't confirm the cut-out"
DISAGREE_NOTE = "a second model's cut-out differs from this one, so the outline isn't confirmed"
BUSY_SCENE_NOTE = "a busy background: check that only the product was kept (not a prop, furniture or a shadow)"
EDGE_CONTACT_NOTE = "the cut-out runs into the photo's edge, so the product or a prop may be cut off"
COVERED_BY_MASK_FLAGS = {
    "empty_mask": "mask_empty",
    "full_mask": "mask_full",
    "background_artifacts": "mask_low_confidence",
}


def cutout_check_flags(
    quality: QualityReport | None, flags: list[Flag], extra: tuple[str, ...] | list[str] = ()
) -> list[Flag]:
    """At most one ``cutout_check`` flag for the kept cut-out: its failed checks not already
    covered by a mask flag, or (when none failed) its doubts, then ``extra`` notes, and
    whether it runs into the photo's top, left or right edge (flag only: a stronger model can't
    bring back what the photo cut off)."""
    if quality is None:
        return []
    present = {f.code for f in flags}
    names = quality.reasons or [d.split(":", 1)[0] for d in quality.doubts]
    notes = [
        CUTOUT_CHECK_MESSAGES[r]
        for r in names
        if r in CUTOUT_CHECK_MESSAGES and COVERED_BY_MASK_FLAGS.get(r) not in present
    ]
    notes += list(extra)
    edge = quality.checks.get("edge_contact")
    # Not for a cut-out of the whole photo (mask_full: the background wasn't removed, so it
    # touches every edge), nor on top of crop_too_tight's own "cut off" note.
    redundant = bool({"full_mask", "crop_too_tight"} & set(quality.reasons)) or "mask_full" in present
    if isinstance(edge, float) and edge >= EDGE_CONTACT_FLAG and not redundant:
        notes.append(EDGE_CONTACT_NOTE)
    if not notes:
        return []
    return [flag("cutout_check", f"Please check this image: {'; '.join(dict.fromkeys(notes))}")]


def mask_iou(a: np.ndarray, b: np.ndarray) -> float | None:
    """Intersection over union of two same-size masks (at <= 1024 px); None if both are empty."""
    x = downscale_to(a, FLIP_COMPARE_LONG_SIDE) > 0.5
    y = downscale_to(b, FLIP_COMPARE_LONG_SIDE) > 0.5
    union = int(np.logical_or(x, y).sum())
    return round(int(np.logical_and(x, y).sum()) / union, 4) if union else None


def _touches_inner_edge(mask: np.ndarray, crop: Box, size: tuple[int, int]) -> bool:
    """Whether the cut-out reaches a side of ``crop`` that isn't also the photo's edge."""
    m = mask[crop.y0 : crop.y1, crop.x0 : crop.x1] > 0.5
    sides = []
    if crop.y0 > 0:
        sides.append(m[0])
    if crop.y1 < size[1]:
        sides.append(m[-1])
    if crop.x0 > 0:
        sides.append(m[:, 0])
    if crop.x1 < size[0]:
        sides.append(m[:, -1])
    return any(bool(side.any()) for side in sides)


def _mask_bbox(mask: np.ndarray, size: tuple[int, int], min_fragment_frac: float) -> Box | None:
    """Bounding box (in ``size`` coordinates) of the significant components of ``mask``."""
    analysis = analyze_mask(mask, mask, min_fragment_frac=min_fragment_frac)
    if analysis.bbox is None:
        return None
    factor = size[0] / mask.shape[1]
    return analysis.bbox.scaled(factor, size)


class Pipeline:
    def __init__(
        self,
        cfg: ServiceConfig,
        backend: Backend,
        text_detector: TextDetector,
        *,
        escalation: Backend | None = None,
        gate: EscalationGate | None = None,
    ) -> None:
        self.cfg = cfg
        self.backend = backend
        self.text_detector = text_detector
        self.escalation = escalation  # paid backend, used only when the local result isn't good enough
        self.gate = gate or EscalationGate(
            cooldown_s=cfg.fallback_cooldown_s, daily_max_calls=cfg.escalation_daily_max_calls
        )

    # ----------------------------------------------------------------------------------
    def run(self, data: bytes, settings: ProcessSettings) -> PipelineResult:
        timer = Timer()
        flags: list[Flag] = []
        trace = begin_trace()
        operations = ["decode"]

        # 1. Decode + normalise ------------------------------------------------------
        with timer("decode"):
            src = load_image(
                data,
                max_source_pixels=self.cfg.max_source_pixels,
                max_working_pixels=self.cfg.max_working_pixels,
            )
            border = analyze_border(src.rgb)

        # 0. Analysis: already acceptable? ---------------------------------------------
        with timer("analysis"):
            facts = analyze_image(
                data,
                src,
                border,
                settings,
                max_output_bytes=self.cfg.max_output_bytes,
                max_output_pixels=self.cfg.max_output_pixels,
            )
        log.info(
            "ANALYSIS",
            extra={**facts.as_dict(), "not_acceptable_because": facts.not_acceptable_because},
        )
        operations.append("analysis")
        if self.cfg.no_change_detection and facts.already_acceptable and not settings.force_escalation:
            return self._no_change(data, src, settings, facts, trace, timer, operations)

        route = self._route(data, settings)
        if route.reason:
            trace.notes.append(route.reason)

        # 2. Upscale -------------------------------------------------------------------
        with timer("upscale"):
            up = self._upscale(src, border, settings, flags, route)
        if up.wanted:
            operations.append("upscale")

        # 3 + 4. Cut-out, bbox, mask metrics -------------------------------------------
        analysis: MaskAnalysis | None = None
        cut_mask: np.ndarray | None = None
        cut: CutoutResult | None = None
        segmentation_name = self.backend.segmenter.name
        with timer("segment"):
            if settings.remove_bg:
                operations.append("background_removal")
                cut = self._segment(up, border, settings, route, facts)
                analysis, cut_mask, segmentation_name = cut.analysis, cut.mask, cut.model
                flags.extend(mask_flags(analysis, self.cfg))
                flags.extend(cutout_check_flags(cut.quality, flags, cut.notes if not cut.ready else ()))
                if not cut.ready and not any(f.code == "cutout_check" or f.code.startswith("mask_") for f in flags):
                    # Never NEEDS_REVIEW without a flag saying why.
                    flags.append(flag("cutout_check", f"Please check this image: {UNCONFIRMED_NOTE}"))
        operations += ["canvas", "export"]

        # 5 + 6 + 7 + 8. Canvas, background, export, checks, previews ------------------
        with timer("compose"):
            if analysis is not None and analysis.bbox is not None and cut_mask is not None:
                comp = self._compose_cutout(up, cut_mask, analysis.bbox, settings)
            else:
                comp = self._compose_keep_background(up, border, settings)

            if up.wanted and comp.plan.shrunk:
                flags.append(
                    flag(
                        "upscale_capped",
                        f"Upscaling couldn't reach the {settings.target_px} px target; "
                        f"output is {comp.plan.width}x{comp.plan.height}",
                    )
                )

            xmp = build_ai_xmp() if (up.ai_ran and settings.ai_metadata) else None
            encoded = encode_output(
                comp.canvas,
                settings.output_format,
                jpeg_quality=settings.jpeg_quality,
                xmp=xmp,
                max_bytes=self.cfg.max_output_bytes,
                max_pixels=self.cfg.max_output_pixels,
            )

            drift = color_drift(src.rgb, comp.work_mask, comp.canvas, comp.canvas_mask)
            flags.extend(color_drift_flags(drift, self.cfg))

            out_quality = assess_output(
                comp.plan,
                comp.canvas_mask,
                aspect=settings.aspect,
                margin_pct=settings.margin_pct,
                output_size=(encoded.width, encoded.height),
            )
            if not out_quality.passed:  # canvas invariants: a bug, never expected
                log.error("output_check_failed", extra={"reasons": out_quality.reasons})
                flags.append(flag("output_check", f"Output layout check failed: {', '.join(out_quality.reasons)}"))

            preview, _, _ = encode_preview_jpeg(comp.canvas)
            before, bw, bh = encode_preview_jpeg(src.rgb)
            mask_png = encode_mask_overlay(comp.artifact_mask, (bw, bh))

        fid = up.fidelity
        processing = self._processing_info(trace, operations, cut, out_quality, drift, flags, up, facts)
        metrics = Metrics(
            mask_coverage=round(analysis.coverage, 4) if analysis else None,
            mask_fragments=analysis.fragments if analysis else None,
            mask_uncertainty=round(analysis.uncertainty, 4) if analysis else None,
            text_detected=bool(up.text and up.text.found),
            text_boxes=up.text.boxes if up.text else 0,
            fidelity_ssim=round(fid[0], 4) if fid else None,
            fidelity_delta_e=round(fid[1], 3) if fid else None,
            color_drift_delta_e=round(drift, 3) if drift is not None else None,
        )
        return PipelineResult(
            artifacts={"output": encoded.data, "preview": preview, "before": before, "mask": mask_png},
            output=OutputInfo(
                width=encoded.width,
                height=encoded.height,
                bytes=len(encoded.data),
                format=settings.output_format,
                content_type=encoded.content_type,
            ),
            source=SourceInfo(
                width=src.width,
                height=src.height,
                format=src.format,
                mode=src.mode,
                icc_converted=src.icc_converted,
            ),
            upscale=up.info,
            flags=flags,
            metrics=metrics,
            models=ModelsInfo(
                backend=self._models_backend(trace),
                segmentation=segmentation_name,
                upscaler=up.upscaler_name,
                text_detector=up.text_detector,
            ),
            timings_ms=dict(timer.ms),
            processing=processing,
        )

    def _no_change(
        self,
        data: bytes,
        src: NormalizedImage,
        settings: ProcessSettings,
        facts: ImageAnalysis,
        trace: ProcessingTrace,
        timer: Timer,
        operations: list[str],
    ) -> PipelineResult:
        """The source already meets the request: it comes back byte for byte (the caller never
        applies or charges it), with the usual previews. No model runs."""
        with timer("compose"):
            preview, bw, bh = encode_preview_jpeg(src.rgb)
            mask_png = encode_mask_overlay(None, (bw, bh))
        fmt = settings.output_format
        info = ProcessingInfo(
            operations=operations,
            method="deterministic",
            replicate_used=False,
            replicate_calls=0,
            replicate_models=[],
            estimated_cost_usd=0.0,
            fallback_reason=None,
            quality_score=None,
            quality_checks={},
            attempts=[],
            route="no_change",
            analysis=facts.as_dict(),
            final_status="NO_CHANGE",
        )
        log.info(
            "PROCESSING_COST",
            extra={"method": info.method, "route": info.route, "replicate_calls": 0, "estimated_usd": 0.0},
        )
        return PipelineResult(
            artifacts={"output": data, "preview": preview, "before": preview, "mask": mask_png},
            output=OutputInfo(
                width=src.width, height=src.height, bytes=len(data), format=fmt, content_type=CONTENT_TYPES[fmt]
            ),
            source=SourceInfo(
                width=src.width, height=src.height, format=src.format, mode=src.mode, icc_converted=src.icc_converted
            ),
            upscale=UpscaleInfo(
                eligible=False, applied=False, method="none", scale=1.0, reason="the photo already meets the request"
            ),
            flags=[],
            metrics=Metrics(
                mask_coverage=None,
                mask_fragments=None,
                mask_uncertainty=None,
                text_detected=False,
                text_boxes=0,
                fidelity_ssim=None,
                fidelity_delta_e=None,
                color_drift_delta_e=None,
            ),
            models=ModelsInfo(backend=self.backend.kind, segmentation="none", upscaler=None, text_detector=None),  # type: ignore[arg-type]
            timings_ms=dict(timer.ms),
            processing=info,
        )

    def _route(self, data: bytes, settings: ProcessSettings) -> Route:
        """Local first, unless the merchant asked for the stronger model (force_escalation), the
        local model is switched off (LOCAL_PROCESSING_ENABLED) or the photo is outside
        LOCAL_PROCESSING_PERCENTAGE: then paid first. The rollout bucket is the source's hash,
        so the same photo always takes the same route. LOCAL_PROCESSING_SHADOW: local runs and
        is judged, the paid result is used."""
        if settings.force_escalation:
            # A paid primary backend already is the stronger model.
            if self.escalation is None and not self.backend.segmenter.in_process:
                return Route("local", "forced")
            return Route("paid", "forced")
        if self.escalation is None:
            return Route("local")
        cfg = self.cfg
        if not cfg.local_processing_enabled:
            return Route("paid", "rollout")
        if cfg.local_processing_percentage < 100:
            bucket = int.from_bytes(hashlib.sha256(data).digest()[:4], "big") % 100
            if bucket >= cfg.local_processing_percentage:
                return Route("paid", "rollout")
        if cfg.local_processing_shadow:
            return Route("shadow", "shadow")
        return Route("local")

    # ----------------------------------------------------------------------------------
    # 2. Upscaling
    # ----------------------------------------------------------------------------------
    def _estimate_box(self, src: NormalizedImage, border: BorderStats, settings: ProcessSettings) -> Box:
        """Cheap product-box estimate on the original, used to size the upscale."""
        size = image_size(src.rgb)
        full = Box.full(*size)
        frac = self.cfg.mask_min_fragment_frac
        if src.alpha is not None:
            alpha = downscale_to(src.alpha.astype(np.float32) / 255.0, MODEL_MASK_LONG_SIDE)
            return _mask_bbox(alpha, size, frac) or full
        if not settings.remove_bg and not border.uniform:
            return full  # whole image is the product box
        if settings.remove_bg and self.backend.segmenter.in_process:
            return _mask_bbox(self.backend.segmenter.predict(src.rgb), size, frac) or full
        if border.uniform:
            return _mask_bbox(border_difference_mask(src.rgb), size, frac) or full
        return full

    def _upscale(
        self,
        src: NormalizedImage,
        border: BorderStats,
        settings: ProcessSettings,
        flags: list[Flag],
        route: Route | None = None,
    ) -> UpscaleOutcome:
        rgb, alpha = src.rgb, src.alpha
        short = min(src.width, src.height)
        threshold = settings.upscale_threshold_px

        def skip(eligible: bool, reason: str, wanted: bool = False, **extra: object) -> UpscaleOutcome:
            info = UpscaleInfo(eligible=eligible, applied=False, method="none", scale=1.0, reason=reason)
            return UpscaleOutcome(rgb, alpha, info, 1.0, wanted, **extra)  # type: ignore[arg-type]

        if not settings.upscale:
            return skip(False, "upscaling not requested")
        if short >= threshold:
            return skip(False, f"short side {short} >= {threshold}")
        reason = f"short side {short} < {threshold}"

        box = self._estimate_box(src, border, settings)
        needed = fill_scale(
            box.width,
            box.height,
            aspect=settings.aspect,
            margin_pct=settings.margin_pct,
            target_px=settings.target_px,
            max_pixels=self.cfg.max_output_pixels,
        )
        if needed <= 1.0:
            return skip(True, f"{reason}; product already fills the {settings.target_px} px canvas")

        w, h = image_size(rgb)
        max_factor = math.sqrt(self.cfg.max_working_pixels / (w * h))
        text = self.text_detector.detect(rgb)
        detector = self.text_detector.name

        ai_ran = False
        trace = current_trace() or ProcessingTrace()
        # On CPU, Real-ESRGAN holds the only inference slot for minutes: its time grows with the
        # factor (LOCAL_MAX_AI_SCALE) and the input's pixels (LOCAL_MAX_AI_UPSCALE_PIXELS).
        # Work beyond that goes to the paid backend when there is one (same Real-ESRGAN models,
        # so the same quality), else it is capped to x2 / Lanczos as before. A photo outside the
        # local rollout (LOCAL_PROCESSING_*) goes there too; "Retry with stronger model" doesn't:
        # the paid upscaler is the same Real-ESRGAN, so it would cost more for the same result.
        on_cpu = self.backend.kind == "local" and self.backend.device == "cpu"
        rollout = route is not None and route.mode == "paid" and route.reason == "rollout"
        over_cpu_budget = on_cpu and 0 < self.cfg.local_max_ai_upscale_pixels < w * h
        want: UpscaleFactor = 2 if needed <= 2.0 else 4
        if want > max_factor:
            want = 2
        cpu_capped = on_cpu and want > self.cfg.local_max_ai_scale
        out: np.ndarray | None = None
        paid = None
        why = "too_slow_on_cpu" if (over_cpu_budget or cpu_capped) else "rollout"
        if not text.found and (over_cpu_budget or cpu_capped or rollout) and want <= max_factor:
            paid = self._paid_upscaler(trace, why)
        if paid is not None:
            started, before = time.perf_counter(), len(trace.replicate_calls)
            trace.fallback("upscale", why, to=self._escalation_kind())
            trace.notes.append(why)
            try:
                out = paid.upscale(rgb, want)
            except ServiceError as exc:
                if exc.code != "model_backend_failed":
                    raise
                self._paid_call_done(trace, before, failed=True)
                self._record(
                    trace,
                    "upscale",
                    self._escalation_kind(),
                    paid.model_name(want),
                    started,
                    before,
                    outcome="failed",
                    reason=exc.message[:200],
                )
                trace.fallback_reasons.append("replicate_unavailable")
                trace.notes.append("replicate_unavailable")
            else:
                self._paid_call_done(trace, before)
                upscaler_name = paid.model_name(want)
                self._record(trace, "upscale", self._escalation_kind(), upscaler_name, started, before)
                ai_ran = True
                method = f"realesrgan-x{want}"
                if why == "rollout":
                    reason += f"; ran on {self._escalation_kind()} (local processing rollout)"
                else:
                    reason += f"; too large for AI upscaling on CPU, ran on {self._escalation_kind()}"

        if out is not None:
            pass  # upscaled by the paid backend above
        elif text.found or over_cpu_budget:
            if text.found:
                flags.append(
                    flag(
                        "text_detected",
                        f"Text or a label was detected ({text.boxes} region(s)); used Lanczos + light "
                        "sharpening instead of AI upscaling so it isn't altered",
                        "info",
                    )
                )
            factor = min(needed, 4.0, max_factor)
            if factor <= 1.0:
                return skip(True, f"{reason}; image too large to upscale", True, text=text, text_detector=detector)
            started = time.perf_counter()
            out = lanczos_upscale(rgb, factor)
            method, upscaler_name = "lanczos", "lanczos"
            self._record(trace, "upscale", "lanczos", "lanczos", started, len(trace.replicate_calls))
            if text.found:
                reason += "; text detected, used Lanczos instead of AI"
            else:
                reason += "; too large for AI upscaling on CPU, used Lanczos"
        else:
            scale: UpscaleFactor = 2 if needed <= 2.0 else 4
            if scale > self.cfg.local_max_ai_scale and on_cpu:
                scale = 2
                reason += "; AI upscaling limited to x2 on CPU"
            if scale > max_factor:
                scale = 2
            if scale > max_factor:
                return skip(True, f"{reason}; image too large to upscale", True, text=text, text_detector=detector)
            started, before = time.perf_counter(), len(trace.replicate_calls)
            out = self.backend.upscaler.upscale(rgb, scale)
            upscaler_name = self.backend.upscaler.model_name(scale)
            self._record(
                trace,
                "upscale",
                self.backend.kind if self.backend.upscaler.is_ai else "lanczos",
                upscaler_name,
                started,
                before,
            )
            if self.backend.upscaler.is_ai:
                ai_ran = True
                method = f"realesrgan-x{scale}"
            else:
                method = "lanczos"
                reason += "; no AI model on this backend, used Lanczos"

        factor_x = out.shape[1] / w
        out_alpha = None
        if alpha is not None:
            up_alpha = resize_mask(alpha.astype(np.float32) / 255.0, image_size(out))
            out_alpha = np.round(up_alpha * 255.0).astype(np.uint8)

        ssim, delta_e = fidelity(rgb, out)
        flags.extend(fidelity_flags(ssim, delta_e, self.cfg))

        info = UpscaleInfo(
            eligible=True,
            applied=ai_ran,
            method=method,  # type: ignore[arg-type]
            scale=round(factor_x, 3),
            reason=reason,
        )
        return UpscaleOutcome(
            rgb=out,
            alpha=out_alpha,
            info=info,
            factor=factor_x,
            wanted=True,
            ai_ran=ai_ran,
            upscaler_name=upscaler_name,
            text=text,
            text_detector=detector,
            fidelity=(ssim, delta_e),
        )

    # ----------------------------------------------------------------------------------
    # 3 + 4. Cut-out: cheapest safe method first, through the quality gate
    # ----------------------------------------------------------------------------------
    def _segment(
        self,
        up: UpscaleOutcome,
        border: BorderStats,
        settings: ProcessSettings,
        route: Route | None = None,
        facts: ImageAnalysis | None = None,
    ) -> CutoutResult:
        """The kept cut-out (feathered, full resolution) and the gate's record of how it was
        chosen (see the module docstring)."""
        route = route or Route("local")
        trace = current_trace() or ProcessingTrace()
        size = image_size(up.rgb)
        if up.alpha is not None:  # the source already has an exact cut-out
            started = time.perf_counter()
            full = up.alpha.astype(np.float32) / 255.0
            model_mask = downscale_to(full, MODEL_MASK_LONG_SIDE)
            analysis = analyze_mask(full, model_mask, min_fragment_frac=self.cfg.mask_min_fragment_frac)
            self._record(trace, "background_removal", "source_alpha", None, started, len(trace.replicate_calls))
            cleaned = analysis.cleaned.astype(np.float32, copy=False)
            return CutoutResult(analysis, cleaned, "source-alpha", None, "deterministic")

        text, text_scale = self._text_on(up)
        flip_limit = self.cfg.escalate_flip_disagreement
        primary = self.backend.segmenter
        opinion = self.cfg.local_second_opinion
        verify_size = self.cfg.local_verify_input_size
        # The second opinion (LOCAL_SECOND_OPINION, see config.py) runs in addition to the
        # mirrored pass: each catches bad cut-outs the other misses. Free in-process models only;
        # the classic segmenter isn't a model worth a second opinion.
        verifying = (
            primary.in_process
            and not isinstance(primary, ClassicSegmenter)
            and (opinion == "letterbox" or (opinion == "resolution" and primary.supports_input_size))
        )

        def mirror_checked(segmenter: Segmenter) -> bool:
            # Free models only: a paid model is never called twice. The classic segmenter is
            # mirror-symmetric by construction, so its mirrored pass would only cost time.
            return segmenter.in_process and flip_limit > 0 and not isinstance(segmenter, ClassicSegmenter)

        second: dict[str, np.ndarray | None] = {}

        def second_opinion() -> np.ndarray | None:
            """The primary model at LOCAL_VERIFY_INPUT_SIZE on the whole frame (cleaned, full
            size; made once, and only when asked for). None when there is no second opinion."""
            if not verifying:
                return None
            if "mask" not in second:
                started, before = time.perf_counter(), len(trace.replicate_calls)
                frac_min = self.cfg.mask_min_fragment_frac
                if opinion == "letterbox":
                    # The photo padded to a square with its border colour (aspect kept), where
                    # the model otherwise sees it stretched. The model input is far smaller than
                    # 1024 px, so the padding is done at that size.
                    small = downscale_to(up.rgb, SECOND_OPINION_LONG_SIDE)
                    sh, sw = small.shape[:2]
                    side = max(sh, sw)
                    square = np.empty((side, side, 3), np.uint8)
                    square[:] = border.median_rgb
                    y0, x0 = (side - sh) // 2, (side - sw) // 2
                    square[y0 : y0 + sh, x0 : x0 + sw] = small
                    raw: np.ndarray | None = primary.predict(square)
                    full = resize_mask(resize_mask(raw, (side, side))[y0 : y0 + sh, x0 : x0 + sw], size)
                    model_name = f"{primary.name} letterbox"
                else:
                    raw = primary.predict_at(up.rgb, verify_size)
                    full = resize_mask(raw, size) if raw is not None else None
                    model_name = f"{primary.name}@{verify_size}"
                second["mask"] = (
                    None if raw is None or full is None else analyze_mask(full, raw, min_fragment_frac=frac_min).cleaned
                )
                self._record(
                    trace,
                    "background_removal",
                    f"{self.backend.kind}_verify",
                    model_name,
                    started,
                    before,
                    outcome="check",
                )
            return second["mask"]

        def verify(c: CutCandidate) -> None:
            """A local cut-out that passed everything else must be reproduced by the second
            opinion, else it is UNCERTAIN ("model_disagreement") and escalated."""
            if c.paid or c.quality.gate != "SAFE_LOCAL":
                return
            other = second_opinion()
            if other is None:
                return
            agree = mask_iou(c.analysis.cleaned, other)
            c.quality.checks["verify_iou"] = agree
            if agree is None or agree < self.cfg.escalate_verify_min_iou:
                c.quality.doubts.append("model_disagreement")
                c.quality.score = round(max(0.0, c.quality.score - 0.1), 3)
                c.attempt.reason = ",".join(c.quality.reasons + c.quality.doubts)

        def attempt(
            segmenter: Segmenter,
            method: str,
            crop: Box | None = None,
            context_flipped: np.ndarray | None = None,
            *,
            paid: bool = False,
        ) -> CutCandidate:
            """One cut-out, validated. ``context_flipped`` (crop attempts): the full-frame
            attempt's mirrored mask, which must agree outside ``crop`` too."""
            started, before = time.perf_counter(), len(trace.replicate_calls)
            region = up.rgb if crop is None else up.rgb[crop.y0 : crop.y1, crop.x0 : crop.x1]
            frac_min = self.cfg.mask_min_fragment_frac

            def place(model_mask: np.ndarray) -> np.ndarray:
                if crop is None:
                    return resize_mask(model_mask, size)
                full = np.zeros((size[1], size[0]), dtype=np.float32)
                full[crop.y0 : crop.y1, crop.x0 : crop.x1] = resize_mask(model_mask, (crop.width, crop.height))
                return full

            model_mask = segmenter.predict(region)
            analysis = analyze_mask(place(model_mask), model_mask, min_fragment_frac=frac_min)
            flipped = None
            if mirror_checked(segmenter) and analysis.bbox is not None:  # nothing found: escalated anyway
                # The same model on the mirrored input (one more local inference, timed into
                # this attempt): a confident but knife-edge decision flips, edge jitter doesn't.
                # Kept over the attempt's region at the comparison size (never full-res), and
                # with small specks removed like analysis.cleaned.
                mirrored = segmenter.predict(np.ascontiguousarray(region[:, ::-1]))
                back = resize_mask(np.ascontiguousarray(mirrored[:, ::-1]), flip_compare_size(*image_size(region)))
                flipped = analyze_mask(back, back, min_fragment_frac=frac_min).cleaned
            quality = assess_cutout(
                analysis,
                up.rgb,
                border=border,
                text_rects=text.rects,
                text_scale=text_scale,
                new_bg=settings.bg_rgb,
                cfg=self.cfg,
                flipped=flipped,
                flipped_region=crop,
            )
            if crop is not None and _touches_inner_edge(analysis.cleaned, crop, size):
                quality.reasons.append("crop_too_tight")  # the product continues past the crop
                quality.score = round(max(0.0, quality.score - 0.5), 3)
            if crop is not None and context_flipped is not None and analysis.bbox is not None:
                # The crop hides the rest of the photo from every other check: a second product
                # the full-frame pass only found when mirrored lies outside it.
                outside = flip_disagreement(analysis.cleaned, context_flipped, outside=crop)
                quality.checks["flip_disagreement_outside_crop"] = round(outside, 4)
                if outside > flip_limit and "unstable_cutout" not in quality.reasons:
                    quality.reasons.append("unstable_cutout")
                    quality.score = round(max(0.0, quality.score - UNSTABLE_PENALTY), 3)
            if quality.reasons:
                quality.doubts.clear()  # FAILED already; doubts only qualify a pass
            record = self._record(
                trace,
                "background_removal",
                method,
                segmenter.name,
                started,
                before,
                reason=",".join(quality.reasons + quality.doubts) or None,
                quality=quality,
            )
            return CutCandidate(method, segmenter.name, analysis, quality, record, flipped, paid)

        def rank(c: CutCandidate) -> tuple[bool, bool, float]:
            return (c.quality.passed, c.quality.confident, c.quality.score)

        def prefer(new: CutCandidate, old: CutCandidate) -> CutCandidate:
            keep, drop = (new, old) if rank(new) >= rank(old) else (old, new)
            drop.attempt.outcome = "rejected"
            return keep

        kind = self.backend.kind
        frac = self.cfg.refine_small_product_frac
        zoomable = primary.in_process and frac > 0

        def small(box: Box | None) -> bool:
            return box is not None and max(box.width / size[0], box.height / size[1]) < frac

        def around(box: Box) -> Box:
            return box.pad(round(REFINE_CROP_PAD * max(box.width, box.height)) + 8, size)

        def run_primary() -> CutCandidate:
            """The primary backend's best cut-out (free when it runs in this process)."""
            paid = not primary.in_process  # MODEL_BACKEND=replicate
            # A small product in a big photo is cut out from a crop around it, so the model sees
            # it at a useful size (a 512 px model otherwise sees it at ~100 px and may find
            # nothing). On a plain background the product is located first without AI;
            # otherwise the model's first mask locates it. Both are free (in-process only).
            classic_box = None
            if zoomable and border.uniform:
                classic_box = _mask_bbox(border_difference_mask(up.rgb), size, self.cfg.mask_min_fragment_frac)
            if classic_box is not None and small(classic_box):
                # The border-difference box already spans everything that isn't background.
                best = attempt(primary, f"{kind}_zoom", around(classic_box))
                if not best.quality.confident:  # located wrongly, the crop cut the product, or doubtful
                    best = prefer(attempt(primary, kind), best)
            else:
                best = attempt(primary, kind, paid=paid)  # a failing primary raises, as before
                if zoomable and small(best.analysis.bbox):
                    crop = around(best.analysis.bbox)  # type: ignore[arg-type]
                    # The first mask may have found only part of a set: its mirrored pass is
                    # checked outside the crop (a second product the crop can't see).
                    best = prefer(attempt(primary, f"{kind}_refine", crop, best.flipped), best)
            return best

        def run_paid(why: str, local: CutCandidate | None) -> tuple[list[CutCandidate], bool]:
            """Up to ESCALATION_MAX_ATTEMPTS paid cut-outs: the frame, then, while none passed its
            checks, a zoomed crop around everything any attempt found (the model then sees the
            product at a higher resolution). Returns (attempts, paid backend unavailable)."""
            esc = self.escalation
            assert esc is not None
            made: list[CutCandidate] = []
            for n in range(self.cfg.escalation_max_attempts):
                crop = None
                if n:
                    boxes = [c.analysis.bbox for c in (*made, local) if c is not None and c.analysis.bbox is not None]
                    if not boxes:
                        break
                    box = boxes[0]
                    for other in boxes[1:]:
                        box = box.union(other)
                    crop = around(box)
                    if crop.width * crop.height > PAID_RETRY_MAX_CROP_FRAC * size[0] * size[1]:
                        break  # the same picture again: a deterministic model gives the same answer
                blocked = self.gate.blocked()
                if blocked:
                    trace.fallback_reasons.append(f"{why} (not escalated: {blocked})")
                    trace.notes.append("not_escalated")
                    log.info(
                        "AI_FALLBACK_SKIPPED",
                        extra={"operation": "background_removal", "reason": why, "why": blocked},
                    )
                    return made, not made
                trace.fallback("background_removal", why if n == 0 else "ai_result_unsafe", to=esc.kind)
                method = esc.kind if crop is None else f"{esc.kind}_zoom"
                started, before = time.perf_counter(), len(trace.replicate_calls)
                try:
                    candidate = attempt(esc.segmenter, method, crop, paid=True)
                except ServiceError as exc:
                    if exc.code != "model_backend_failed":
                        raise
                    self._paid_call_done(trace, before, failed=True)
                    trace.fallback_reasons.append("replicate_unavailable")
                    trace.notes.append("replicate_unavailable")
                    self._record(
                        trace,
                        "background_removal",
                        method,
                        esc.segmenter.name,
                        started,
                        before,
                        outcome="failed",
                        reason=exc.message[:200],
                    )
                    return made, not made
                self._paid_call_done(trace, before)
                made.append(candidate)
                if candidate.quality.passed:
                    break
            return made, False

        def gate_notes(c: CutCandidate) -> None:
            trace.notes.extend(c.quality.reasons + c.quality.doubts)
            if facts is not None and facts.background_complexity == "high":
                trace.notes.append("complex_background")

        # --- local attempt → gate ---------------------------------------------------------
        local: CutCandidate | None = None
        paid: list[CutCandidate] = []
        unavailable = False
        if route.mode != "paid" or self.escalation is None:
            local = run_primary()
            if local.paid:  # a paid primary backend: its result is the paid one
                paid, local = [local], None
            else:
                verify(local)
        if local is not None and local.quality.gate != "SAFE_LOCAL":
            gate_notes(local)

        # --- paid attempts (uncertain, failed, paid first, or shadow) → AI gate -------------
        if self.escalation is not None and (
            route.mode in ("paid", "shadow") or (local is not None and local.quality.gate != "SAFE_LOCAL")
        ):
            doubtful = local is not None and local.quality.gate != "SAFE_LOCAL"
            why = (local.quality.reasons + local.quality.doubts)[0] if doubtful else (route.reason or "forced")  # type: ignore[union-attr]
            paid, unavailable = run_paid(why, local)
        elif route.mode == "paid":  # forced, with no stronger model configured
            trace.fallback_reasons.append("forced (not escalated: no stronger model configured)")
            trace.notes.append("not_escalated")
            unavailable = True
        if local is None and primary.in_process and not any(c.quality.passed for c in paid):
            # Paid first, but unavailable or unsafe: the free model is the fallback.
            local = run_primary()
            verify(local)
            if local.quality.gate != "SAFE_LOCAL":
                gate_notes(local)

        # --- choose ----------------------------------------------------------------------
        passing = [c for c in paid if c.quality.passed]
        if passing:
            kept = max(passing, key=lambda c: (c.quality.confident, c.quality.score))
        elif local is not None and local.quality.gate == "SAFE_LOCAL":
            kept = local
        else:
            kept = max([c for c in (local, *paid) if c is not None], key=rank)
        for c in (local, *paid):
            if c is not None and c is not kept:
                c.attempt.outcome = "shadow" if (c is local and route.mode == "shadow") else "rejected"
        ai_gate = ("PASS" if passing else "UNSAFE") if paid else None
        if ai_gate == "UNSAFE":
            trace.notes.append("ai_result_unsafe")
            for c in paid:
                trace.notes.extend(c.quality.reasons)

        # --- READY? ------------------------------------------------------------------------
        ready = kept.quality.confident
        notes: list[str] = []
        local_distrusted = route.reason == "forced" or not self.cfg.local_processing_enabled
        if route.mode == "paid" and not kept.paid and local_distrusted:
            # The merchant asked for the stronger model, or the local model is switched off: a
            # local fallback is shown, never READY.
            ready = False
            notes.append(FORCED_LOCAL_NOTE if paid else NOT_ESCALATED_NOTE)
        elif not kept.quality.confident:
            if ai_gate == "UNSAFE":
                notes.append(AI_UNSAFE_NOTE)
            elif unavailable or "not_escalated" in trace.notes:
                notes.append(NOT_ESCALATED_NOTE)
        # A second, independent model must agree with the kept cut-out. A local one was checked
        # by the second opinion (verify); a paid one is compared with the local cut-outs.
        agreement = self._agreement(kept, local, second_opinion, verifying)
        kept.quality.checks["model_agreement"] = agreement
        if ready and kept.paid and self.cfg.ready_min_agreement > 0:
            if agreement is None or agreement < self.cfg.ready_min_agreement:
                ready = False
                notes.append(DISAGREE_NOTE)
                trace.notes.append("model_disagreement")
        busy = facts is not None and facts.background_complexity in ("medium", "high")
        if self.cfg.ready_requires_plain_background and busy:
            # Busy scenes: both models often keep a prop, furniture or a shadow as the product.
            if ready:
                notes.append(BUSY_SCENE_NOTE)
            ready = False
            trace.notes.append("busy_scene")

        shadow = None
        if route.mode == "shadow" and local is not None and paid:
            shadow = {
                "mode": "shadow",
                "local_gate": local.quality.gate,
                "local_would_have_been_used": local.quality.gate == "SAFE_LOCAL",
                "iou_local_vs_final": 1.0 if kept is local else mask_iou(local.analysis.cleaned, kept.analysis.cleaned),
            }
            log.info("SHADOW_COMPARE", extra=shadow)

        mask = kept.analysis.cleaned
        sigma = max(0.6, max(size) / 2000.0)  # light edge feathering
        mask = np.clip(cv2.GaussianBlur(mask, (0, 0), sigma), 0.0, 1.0)
        return CutoutResult(
            analysis=kept.analysis,
            mask=mask.astype(np.float32, copy=False),
            model=kept.model,
            quality=kept.quality,
            route=("local_then_replicate" if local is not None else "replicate") if kept.paid else "local",
            local_gate=local.quality.gate if local is not None else None,
            ai_gate=ai_gate,
            local_attempted=local is not None,
            local_accepted=kept is local and local.quality.gate == "SAFE_LOCAL",
            paid_attempts=len(paid),
            ready=ready,
            notes=notes,
            shadow=shadow,
        )

    def _agreement(
        self,
        kept: CutCandidate,
        local: CutCandidate | None,
        second_opinion: Callable[[], np.ndarray | None],
        verifying: bool,
    ) -> float | None:
        """How well an independent model reproduces the kept cut-out (IoU at <= 1024 px): the
        second opinion for a local cut-out; for a paid one, the best of the local cut-out and
        the second opinion (made only when the local one doesn't agree). None: nothing to
        compare with."""
        if not kept.paid:
            value = kept.quality.checks.get("verify_iou")
            return value if isinstance(value, float) else None
        best: float | None = None
        others: list[Callable[[], np.ndarray | None]] = []
        if local is not None:
            others.append(lambda: local.analysis.cleaned)
        if verifying:
            others.append(second_opinion)
        for get in others:
            other = get()
            value = mask_iou(kept.analysis.cleaned, other) if other is not None else None
            if value is not None and (best is None or value > best):
                best = value
            if best is not None and best >= self.cfg.ready_min_agreement:
                break
        return best

    def _text_on(self, up: UpscaleOutcome) -> tuple[TextResult, float]:
        """Text boxes for the cut-out check and the scale that maps them onto ``up.rgb``."""
        if up.text is not None:  # detected on the original during upscaling
            return up.text, up.factor
        return self.text_detector.detect(up.rgb), 1.0

    # ----------------------------------------------------------------------------------
    # Attempts, paid calls and the processing summary
    # ----------------------------------------------------------------------------------
    def _escalation_kind(self) -> str:
        return self.escalation.kind if self.escalation is not None else "none"

    def _paid_upscaler(self, trace: ProcessingTrace, why: str) -> Upscaler | None:
        if self.escalation is None or not self.escalation.upscaler.is_ai:
            return None
        blocked = self.gate.blocked()
        if blocked:
            trace.fallback_reasons.append(f"{why} (not escalated: {blocked})")
            trace.notes += [why, "not_escalated"]
            log.info("AI_FALLBACK_SKIPPED", extra={"operation": "upscale", "reason": why, "why": blocked})
            return None
        return self.escalation.upscaler

    def _paid_call_done(self, trace: ProcessingTrace, before: int, *, failed: bool = False) -> None:
        made = len(trace.replicate_calls) - before
        if made:
            self.gate.spent(made)
        if failed:
            self.gate.failed()

    def _record(
        self,
        trace: ProcessingTrace,
        operation: str,
        method: str,
        model: str | None,
        started: float,
        calls_before: int,
        *,
        outcome: str = "used",
        reason: str | None = None,
        quality: QualityReport | None = None,
    ) -> Attempt:
        cost = round(sum(c.cost_usd for c in trace.replicate_calls[calls_before:]), 6)
        record = trace.add(
            Attempt(
                operation=operation,
                method=method,
                model=model,
                duration_ms=round((time.perf_counter() - started) * 1000),
                cost_usd=cost,
                outcome=outcome,
                reason=reason,
                quality_score=quality.score if quality else None,
            )
        )
        log.info(
            "IMAGE_PROCESSING",
            extra={
                "operation": operation,
                "method": method,
                "model": model,
                "duration_ms": record.duration_ms,
                "estimated_usd": cost,
                "quality_passed": quality.passed if quality else None,
                "quality_score": record.quality_score,
                "quality_checks": dict(quality.checks) if quality else None,  # e.g. flip_disagreement
                "reason": reason,
                "outcome": outcome,
            },
        )
        return record

    def _is_paid(self, method: str) -> bool:
        """Whether an attempt's method ran on the escalation backend (e.g. replicate, replicate_zoom)."""
        kind = self._escalation_kind()
        return self.escalation is not None and (method == kind or method.startswith(f"{kind}_"))

    def _models_backend(self, trace: ProcessingTrace) -> str:
        """The backend whose model produced the result (the paid one, if its result was kept)."""
        if any(self._is_paid(a.method) and a.outcome == "used" for a in trace.attempts):
            return self._escalation_kind()
        return self.backend.kind

    def _quality_scores(
        self, cut: QualityReport | None, output: QualityReport, up: UpscaleOutcome, drift: float | None
    ) -> dict[str, float | None]:
        """Per-dimension headroom in [0, 1]: 1 - measured / limit (0 = at or past the limit;
        the gate wants more than 1 - UNCERTAIN_BAND). None when not measured."""
        cfg = self.cfg

        def headroom(value: object, limit: float) -> float | None:
            if not isinstance(value, (int, float)) or isinstance(value, bool) or limit <= 0:
                return None
            return round(min(1.0, max(0.0, 1.0 - float(value) / limit)), 3)

        def lowest(*values: float | None) -> float | None:
            present = [v for v in values if v is not None]
            return min(present) if present else None

        seg = retention = artifact = None
        if cut is not None:
            c = cut.checks
            seg = lowest(
                headroom(c.get("edge_uncertainty"), cfg.escalate_mask_uncertainty),
                headroom(c.get("flip_disagreement"), cfg.escalate_flip_disagreement),
            )
            kept = c.get("text_kept")
            retention = lowest(
                headroom(c.get("dropped_inner_parts"), cfg.escalate_dropped_parts_max),
                headroom(1.0 - kept, 1.0 - cfg.escalate_text_coverage_min) if isinstance(kept, float) else None,
            )
            artifact = headroom(c.get("relative_uncertainty"), cfg.escalate_relative_uncertainty)
            agree, floor = c.get("model_agreement"), cfg.ready_min_agreement
            if isinstance(agree, float) and 0 < floor < 1:
                seg = lowest(seg, round(min(1.0, max(0.0, (agree - floor) / (1.0 - floor))), 3))
            if {"empty_mask", "full_mask"} & set(cut.reasons):
                seg = 0.0
            if {"empty_mask", "crop_too_tight"} & set(cut.reasons):
                retention = 0.0
        fidelity_score = lowest(
            None
            if up.fidelity is None
            else round(min(1.0, max(0.0, (up.fidelity[0] - cfg.fidelity_ssim_min) / (1.0 - cfg.fidelity_ssim_min))), 3)
            if cfg.fidelity_ssim_min < 1
            else None,
            None if up.fidelity is None else headroom(up.fidelity[1], cfg.fidelity_delta_e_max),
            headroom(drift, cfg.color_drift_delta_e_max),
        )
        return {
            "segmentation_confidence": seg,
            "product_retention": retention,
            "geometry": round(output.score, 3),
            "artifact": artifact,
            "fidelity": fidelity_score,
        }

    def _processing_info(
        self,
        trace: ProcessingTrace,
        operations: list[str],
        cut: CutoutResult | None,
        output: QualityReport,
        drift: float | None,
        flags: list[Flag],
        up: UpscaleOutcome,
        facts: ImageAnalysis | None,
    ) -> ProcessingInfo:
        used = [a for a in trace.attempts if a.outcome == "used"]
        ai_used = [a for a in used if a.method not in ("lanczos", "source_alpha")]
        calls = trace.replicate_calls
        if not ai_used:
            method = "source_alpha" if any(a.method == "source_alpha" for a in used) else "deterministic"
        elif calls and any(not self._is_paid(a.method) for a in ai_used):
            method = f"{self.backend.kind}+{self._escalation_kind()}"
        elif calls and all(self._is_paid(a.method) for a in ai_used):
            method = self._escalation_kind()
        else:
            method = self.backend.kind
        quality = cut.quality if cut is not None else None
        checks: dict[str, float | bool | None] = {}
        if quality is not None:
            checks.update({f"cutout_{k}": v for k, v in quality.checks.items()})
        checks.update(output.checks)
        checks["color_drift_delta_e"] = round(drift, 3) if drift is not None else None
        scores = [output.score] + ([quality.score] if quality is not None else [])
        reasons = list(dict.fromkeys(trace.fallback_reasons))

        # What produced the kept result: the gated cut-out when there is one, else the upscale.
        if cut is not None and cut.route != "deterministic":
            route = cut.route
        elif ai_used:
            route = "replicate" if all(self._is_paid(a.method) for a in ai_used) else "local"
        else:
            route = "deterministic"

        # READY only when nothing is flagged and the kept cut-out was confidently good.
        ready = not flags and (cut is None or cut.ready)
        names = list(trace.notes)
        codes = {f.code for f in flags}
        names += [f.code for f in flags if f.code not in ("cutout_check",)]
        if "cutout_check" in codes and quality is not None:
            names += quality.reasons + quality.doubts
            edge = quality.checks.get("edge_contact")
            if isinstance(edge, float) and edge >= EDGE_CONTACT_FLAG:
                names.append("edge_contact")
        reason_codes = list(dict.fromkeys(reason_code(n) for n in names))

        info = ProcessingInfo(
            operations=operations,
            method=method,
            replicate_used=bool(calls),
            replicate_calls=len(calls),
            replicate_models=sorted({c.model for c in calls}),
            estimated_cost_usd=trace.cost_usd,
            fallback_reason="; ".join(reasons) or None,
            quality_score=round(min(scores), 3),
            quality_checks=checks,
            attempts=[ProcessingAttempt(**a.__dict__) for a in trace.attempts],
            route=route,
            local_attempted=bool(cut and cut.local_attempted),
            local_accepted=bool(cut and cut.local_accepted),
            gate=cut.local_gate if cut is not None else None,  # type: ignore[arg-type]
            ai_gate=cut.ai_gate if cut is not None else None,  # type: ignore[arg-type]
            reason_codes=reason_codes,
            replicate_attempts=cut.paid_attempts if cut is not None else 0,
            quality_scores=self._quality_scores(quality, output, up, drift),
            analysis=facts.as_dict() if facts is not None else None,
            shadow=cut.shadow if cut is not None else None,
            final_status="READY" if ready else "NEEDS_REVIEW",
        )
        log.info(
            "PROCESSING_COST",
            extra={
                "method": method,
                "route": route,
                "gate": info.gate,
                "ai_gate": info.ai_gate,
                "final_status": info.final_status,
                "reason_codes": reason_codes,
                "replicate_calls": info.replicate_calls,
                "estimated_usd": info.estimated_cost_usd,
                "fallback_reason": info.fallback_reason,
                "quality_score": info.quality_score,
            },
        )
        return info

    # ----------------------------------------------------------------------------------
    # 5 + 6. Canvas + background
    # ----------------------------------------------------------------------------------
    def _plan(self, box: Box, settings: ProcessSettings) -> CanvasPlan:
        return plan_canvas(
            box,
            aspect=settings.aspect,
            margin_pct=settings.margin_pct,
            target_px=settings.target_px,
            max_pixels=self.cfg.max_output_pixels,
            max_scale=1.0,  # never enlarge by interpolation (upscaling already happened in step 2)
        )

    def _compose_cutout(
        self, up: UpscaleOutcome, mask: np.ndarray, bbox: Box, settings: ProcessSettings
    ) -> Composition:
        plan = self._plan(bbox, settings)
        bg = np.array(settings.bg_rgb, dtype=np.float32)
        m = render(mask, plan, fill=0.0)[..., None]
        if up.alpha is not None:
            # Source was flattened on white: I = c·a + 255·(1−a)  ⇒  c·a + bg·(1−a) = I + (1−a)(bg − 255)
            img = render(up.rgb, plan, fill=WHITE).astype(np.float32)
            out = img + (1.0 - m) * (bg - 255.0)
        else:
            img = render(up.rgb, plan, fill=settings.bg_rgb).astype(np.float32)
            out = img * m + bg * (1.0 - m)
        canvas = np.clip(np.round(out), 0, 255).astype(np.uint8)
        return Composition(canvas=canvas, plan=plan, canvas_mask=m[..., 0], work_mask=mask, artifact_mask=mask)

    def _compose_keep_background(
        self, up: UpscaleOutcome, border: BorderStats, settings: ProcessSettings
    ) -> Composition:
        """No cut-out: crop to the product on uniform backgrounds, otherwise keep the whole
        image; pad with the median edge colour."""
        size = image_size(up.rgb)
        full = Box.full(*size)
        pad = border.median_rgb
        frac = self.cfg.mask_min_fragment_frac

        product_mask: np.ndarray | None = None
        box = full
        if border.uniform:
            masks: list[np.ndarray] = [border_difference_mask(up.rgb)]
            if self.backend.segmenter.in_process and not isinstance(self.backend.segmenter, ClassicSegmenter):
                masks.append(self.backend.segmenter.predict(up.rgb))
            if up.alpha is not None:
                masks.append(downscale_to(up.alpha.astype(np.float32) / 255.0, MODEL_MASK_LONG_SIDE))
            boxes = [b for b in (_mask_bbox(mk, size, frac) for mk in masks) if b is not None]
            if boxes:
                box = boxes[0]
                for other in boxes[1:]:
                    box = box.union(other)
                product_mask = resize_mask(masks[0], size)
                for other_mask in masks[1:]:
                    np.maximum(product_mask, resize_mask(other_mask, size), out=product_mask)

        plan = self._plan(box, settings)
        if box == full:
            canvas = render(up.rgb, plan, fill=pad)
        else:
            # Crop to the product: beyond a small safety pad around the bbox the original
            # background fades smoothly into the median edge colour (seamless padding).
            core = box.pad(round(KEEP_BG_BOX_PAD * max(box.width, box.height)) + 2, size)
            img = render(up.rgb, plan, fill=pad).astype(np.float32)
            weights = falloff_weights(plan, core, full)[..., None]
            blended = img * weights + np.array(pad, np.float32) * (1.0 - weights)
            canvas = np.clip(np.round(blended), 0, 255).astype(np.uint8)

        if product_mask is None:
            product_mask = np.zeros((size[1], size[0]), dtype=np.float32)
            product_mask[box.y0 : box.y1, box.x0 : box.x1] = 1.0
        canvas_mask = render(product_mask, plan, fill=0.0)
        return Composition(
            canvas=canvas, plan=plan, canvas_mask=canvas_mask, work_mask=product_mask, artifact_mask=None
        )
