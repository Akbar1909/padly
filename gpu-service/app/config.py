"""Service configuration, read from environment variables (validated with pydantic v2)."""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import Field, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

# Settings that never change what an image comes out as (secrets, access, timing, throughput,
# rejection-only limits, file locations). Everything else feeds ServiceConfig.output_fingerprint.
_NOT_OUTPUT_AFFECTING = {
    "gpu_service_secret",
    "replicate_api_token",
    "allow_unsigned",
    "signature_tolerance_s",
    "allow_http_urls",
    "allowed_url_hosts",
    "max_source_bytes",
    "max_source_pixels",
    "http_timeout_s",
    "http_retries",
    "max_concurrency",
    "log_level",
    "fallback_cooldown_s",
    "escalation_daily_max_calls",
    "replicate_timeout_s",
    "models_dir",
    "realesrgan_x2_path",
    "realesrgan_x4_path",
    "east_model_path",
    # Rollout: both routes make results that passed the same checks, so a ramp or shadow run
    # doesn't stop reuse. LOCAL_PROCESSING_ENABLED (the kill switch) stays in the fingerprint.
    "local_processing_percentage",
    "local_processing_shadow",
}


class ServiceConfig(BaseSettings):
    """All runtime knobs. Every field maps to the upper-case env var of the same name."""

    model_config = SettingsConfigDict(env_prefix="", case_sensitive=False, extra="ignore", protected_namespaces=())

    # --- backend -------------------------------------------------------------------------
    model_backend: Literal["local", "replicate", "classic"] = "classic"
    device: Literal["auto", "cuda", "mps", "cpu"] = "auto"
    max_concurrency: int = Field(2, ge=1, le=64)
    # Backend to re-run a request on when the primary's model call fails (e.g. replicate →
    # local). Loaded on first use; the primary is then skipped for FALLBACK_COOLDOWN_S.
    fallback_backend: Literal["none", "local", "classic"] = "none"
    fallback_cooldown_s: float = Field(120.0, ge=0)
    # Cheapest safe method first: MODEL_BACKEND does the work, and this paid backend is used
    # only when a local cut-out fails its quality checks, or for AI upscaling that is too big
    # for the local CPU. "none" = never pay for AI.
    escalation_backend: Literal["none", "replicate"] = "none"
    # Optional cap on paid calls per UTC day (0 = no cap). Past it, results stay local and
    # keep their quality flags for the merchant's review.
    escalation_daily_max_calls: int = Field(0, ge=0)
    # --- routing / rollout (docs/gpu-service-contract.md "Routing") --------------------------
    # false: the paid backend first for every cut-out (local only if it is unavailable).
    local_processing_enabled: bool = True
    # Share of images (deterministic by source bytes) that try the local model first; the rest
    # go paid-first with reason ROLLOUT_NOT_LOCAL.
    local_processing_percentage: int = Field(100, ge=0, le=100)
    # Shadow: run and validate the local model, but ship the paid result whenever it passes;
    # the comparison is reported, so the local path can be measured on real photos risk-free.
    local_processing_shadow: bool = False
    # Return a photo that already satisfies the request unmodified (final_status NO_CHANGE).
    no_change_detection: bool = True
    # Paid attempts per cut-out: the second is a stronger configuration (a zoomed crop around a
    # small product), made only when the first paid result fails its checks and it can help.
    escalation_max_attempts: int = Field(2, ge=1, le=3)

    # --- security ------------------------------------------------------------------------
    gpu_service_secret: str | None = None
    allow_unsigned: bool = False
    signature_tolerance_s: int = Field(300, ge=1)
    allow_http_urls: bool = False
    allowed_url_hosts: str = ""  # comma-separated host suffixes, empty = any host

    # --- limits --------------------------------------------------------------------------
    max_source_bytes: int = Field(60 * 1024 * 1024, ge=1024)
    max_source_pixels: int = Field(120_000_000, ge=1_000_000)
    max_working_pixels: int = Field(50_000_000, ge=1_000_000)
    max_output_pixels: int = Field(20_000_000, ge=100_000)
    max_output_bytes: int = Field(20 * 1024 * 1024, ge=100_000)
    http_timeout_s: float = Field(60.0, gt=0)
    http_retries: int = Field(3, ge=1, le=10)

    # --- local models --------------------------------------------------------------------
    models_dir: Path = Path("/models")
    birefnet_model_id: str = "ZhengPeng7/BiRefNet"
    birefnet_revision: str = "main"
    birefnet_input_size: int = Field(1024, ge=256, le=2048)
    realesrgan_x2_path: Path | None = None
    realesrgan_x4_path: Path | None = None
    upscale_tile_size: int = Field(512, ge=0)
    upscale_tile_pad: int = Field(32, ge=0)
    # Local models on CPU: Real-ESRGAN x4 takes minutes per photo there (about 5x x2) and holds
    # the only inference slot. Largest AI factor (2 or 4), and the largest input for AI
    # upscaling in pixels (0 = no limit; larger inputs get the Lanczos path, not billed as AI).
    local_max_ai_scale: int = Field(4, ge=2, le=4)
    local_max_ai_upscale_pixels: int = Field(0, ge=0)
    east_model_path: Path | None = None
    text_min_confidence: float = Field(0.5, gt=0, lt=1)

    # --- replicate -----------------------------------------------------------------------
    replicate_api_token: str | None = None
    # Verified 2026-09-26 against the Replicate API: men1scus/birefnet (BiRefNet, MIT) and
    # nightmareai/real-esrgan (Real-ESRGAN, BSD-3). Pin versions so results don't drift.
    replicate_birefnet_version: str | None = "f74986db0355b58403ed20963af156525e2891ea3c2d499bfbfb2a28cd87c5d7"
    replicate_esrgan_version: str | None = "b3ef194191d13140337468c916c2c5b96dd0cb06dffc032a022a31807f6a5ea8"
    replicate_timeout_s: float = Field(180.0, gt=0)
    # Cost estimates: Replicate bills public models for prediction time only. men1scus/birefnet
    # runs on an A100 80GB ($0.0014/s, ~0.6 s per cut-out, checked 2026-09-27); the Real-ESRGAN
    # hardware isn't published, so it is assumed to be the same A100 (a ceiling, not a guess
    # low). Update both if the model pages change.
    replicate_birefnet_usd_per_s: float = Field(0.0014, ge=0)
    replicate_esrgan_usd_per_s: float = Field(0.0014, ge=0)

    # --- quality thresholds (see contract) -----------------------------------------------
    mask_empty_max: float = Field(0.02, ge=0, le=1)
    mask_full_min: float = Field(0.95, ge=0, le=1)
    mask_fragments_max: int = Field(3, ge=0)
    mask_uncertainty_max: float = Field(0.08, ge=0, le=1)
    mask_min_fragment_frac: float = Field(0.005, ge=0, le=1)
    fidelity_ssim_min: float = Field(0.85, ge=0, le=1)
    fidelity_delta_e_max: float = Field(6.0, ge=0)
    color_drift_delta_e_max: float = Field(5.0, ge=0)
    # When a local cut-out is good enough (below these it is escalated to ESCALATION_BACKEND).
    # Stricter than the merchant-facing flags above, so doubtful edges get the stronger model
    # before a merchant ever sees them.
    escalate_mask_uncertainty: float = Field(0.035, ge=0, le=1)
    escalate_text_coverage_min: float = Field(0.85, ge=0, le=1)
    # UNCERTAIN (escalate) when a measurement is within this fraction of its limit: a local
    # result only bypasses the paid model with margin to spare (SAFE_LOCAL).
    uncertain_band: float = Field(0.7, ge=0, le=1)
    # FINE_STRUCTURE (escalate): undecided mask pixels relative to the product's area. Spokes,
    # wire and lace are where the 512 px model loses parts without disagreeing with itself.
    escalate_relative_uncertainty: float = Field(0.12, ge=0, le=1)
    # Second opinion on a local cut-out, in addition to the mirrored pass. A local cut-out the
    # second opinion doesn't reproduce (IoU below ESCALATE_VERIFY_MIN_IOU) is UNCERTAIN
    # ("model_disagreement") and escalated.
    #   letterbox: the same model on the photo padded to a square (aspect kept) instead of
    #     stretched: one more inference at the same memory. On the 117 labelled eval photos
    #     (2026-09-28) it escalated 9 of the 18 bad local cut-outs the mirrored pass had kept
    #     and 1 of 26 good ones; alone it also caught 25 of the mirrored pass's 26 escalations,
    #     but not all of them, so both run.
    #   resolution: the same model at LOCAL_VERIFY_INPUT_SIZE (768 px doesn't fit the 2 GB CPU
    #     VPS: measured 2026-09-28; for GPU hosts).
    #   off: the mirrored pass only (ESCALATE_FLIP_DISAGREEMENT).
    # CPU: the default runs the model three times per local cut-out (as-is, mirrored, letterbox).
    local_second_opinion: Literal["letterbox", "resolution", "off"] = "letterbox"
    local_verify_input_size: int = Field(768, ge=64, le=2048)
    escalate_verify_min_iou: float = Field(0.98, ge=0, le=1)
    # READY needs a second model to agree with the kept cut-out: a paid one must match a local
    # cut-out (IoU) at least this well (0 = off; a local one is checked by the second opinion).
    ready_min_agreement: float = Field(0.98, ge=0, le=1)
    # READY only on plain backgrounds (analysis complexity clean / low): in busy scenes both
    # models often keep a prop, furniture or a shadow as part of the product (21 of 71 busy
    # labelled photos), which no check can tell from the product.
    ready_requires_plain_background: bool = True
    # Share of the product's area in enclosed, clearly non-background holes (dropped lenses).
    escalate_dropped_parts_max: float = Field(0.01, ge=0, le=1)
    # Share of the cut-out that changes (edge jitter removed) when the local model sees the
    # mirrored photo; above it the result is escalated as "unstable_cutout". Costs one extra
    # local inference per cut-out attempt (in-process models only). 0 disables. Calibrated on
    # 54 photos (2026-09-27) for BiRefNet-lite at 512 px on arm64: highest good photo 0.0142,
    # lowest false pass caught 0.0187. Set 0 or recalibrate for another model or input size
    # (full BiRefNet at 1024 px on CPU would also double a ~45 s cut-out).
    escalate_flip_disagreement: float = Field(0.015, ge=0, le=1)
    # A product whose long side is under this fraction of the photo is cut out again from a
    # crop around it (local, free): the model then sees it at a useful size. 0 = off.
    refine_small_product_frac: float = Field(0.45, ge=0, le=1)

    # --- misc ----------------------------------------------------------------------------
    log_level: str = "INFO"

    @model_validator(mode="after")
    def _check(self) -> ServiceConfig:
        if not self.allow_unsigned and not self.gpu_service_secret:
            raise ValueError("GPU_SERVICE_SECRET is required unless ALLOW_UNSIGNED=1")
        if "replicate" in (self.model_backend, self.escalation_backend):
            missing = [
                name
                for name, value in (
                    ("REPLICATE_API_TOKEN", self.replicate_api_token),
                    ("REPLICATE_BIREFNET_VERSION", self.replicate_birefnet_version),
                    ("REPLICATE_ESRGAN_VERSION", self.replicate_esrgan_version),
                )
                if not value
            ]
            if missing:
                raise ValueError(f"Replicate (MODEL_BACKEND or ESCALATION_BACKEND) requires {', '.join(missing)}")
        if self.fallback_backend == self.model_backend:
            raise ValueError("FALLBACK_BACKEND must differ from MODEL_BACKEND")
        if self.escalation_backend == self.model_backend:
            raise ValueError("ESCALATION_BACKEND must differ from MODEL_BACKEND")
        if self.local_max_ai_scale not in (2, 4):
            raise ValueError("LOCAL_MAX_AI_SCALE must be 2 or 4")
        return self

    # --- derived -------------------------------------------------------------------------
    def output_fingerprint(self) -> str:
        """Short hash of every setting that can change a result for the same image and request
        (models, backends, thresholds, limits that resize), without secrets and settings that
        only affect access, timing or throughput."""
        import hashlib
        import json

        data = self.model_dump(mode="json", exclude=_NOT_OUTPUT_AFFECTING)
        return hashlib.sha256(json.dumps(data, sort_keys=True, default=str).encode()).hexdigest()[:12]

    @property
    def url_host_suffixes(self) -> list[str]:
        """Normalised allowlist entries (lower-case, no leading ``*.`` / ``.``)."""
        out: list[str] = []
        for raw in self.allowed_url_hosts.split(","):
            host = raw.strip().lower().removeprefix("*.").lstrip(".")
            if host:
                out.append(host)
        return out

    @property
    def x2_weights(self) -> Path:
        return self.realesrgan_x2_path or self.models_dir / "RealESRGAN_x2plus.pth"

    @property
    def x4_weights(self) -> Path:
        return self.realesrgan_x4_path or self.models_dir / "RealESRGAN_x4plus.pth"

    @property
    def east_path(self) -> Path:
        return self.east_model_path or self.models_dir / "frozen_east_text_detection.pb"


@lru_cache(maxsize=1)
def get_config() -> ServiceConfig:
    """Process-wide config singleton (tests construct ``ServiceConfig`` directly instead)."""
    return ServiceConfig()
