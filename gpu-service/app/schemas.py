"""Request / response models for ``POST /v1/process`` (see docs/gpu-service-contract.md)."""

from __future__ import annotations

import re
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

_HEX_COLOR = re.compile(r"^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$")

OutputFormat = Literal["jpeg", "png", "webp"]
Severity = Literal["info", "warning", "error"]
UpscaleMethod = Literal["realesrgan-x2", "realesrgan-x4", "lanczos", "none"]

CONTENT_TYPES: dict[str, str] = {"jpeg": "image/jpeg", "png": "image/png", "webp": "image/webp"}


# --------------------------------------------------------------------------------------
# Request
# --------------------------------------------------------------------------------------
class UploadTarget(BaseModel):
    """A presigned PUT URL plus the exact headers it was signed with."""

    model_config = ConfigDict(extra="ignore")

    url: str = Field(min_length=1, max_length=8192)
    headers: dict[str, str] = Field(default_factory=dict)


class Uploads(BaseModel):
    model_config = ConfigDict(extra="ignore")

    output: UploadTarget
    preview: UploadTarget
    before: UploadTarget
    mask: UploadTarget


class ProcessSettings(BaseModel):
    """Per-request processing settings."""

    model_config = ConfigDict(extra="ignore")

    aspect: Literal["1:1", "4:5"] = "1:1"
    margin_pct: float = Field(8, ge=0, le=40)
    remove_bg: bool = True
    bg_color: str = "#FFFFFF"
    upscale: bool = False
    upscale_threshold_px: int = Field(1200, ge=0, le=100_000)
    target_px: int = Field(2048, ge=64, le=8000)
    output_format: OutputFormat = "jpeg"
    jpeg_quality: int = Field(90, ge=1, le=100)
    ai_metadata: bool = True
    # "Retry with stronger model": the paid backend first for AI steps (reason FORCED_BY_MERCHANT).
    force_escalation: bool = False

    @field_validator("bg_color")
    @classmethod
    def _hex(cls, value: str) -> str:
        if not _HEX_COLOR.match(value):
            raise ValueError("bg_color must be #RGB or #RRGGBB")
        return value.upper()

    @property
    def bg_rgb(self) -> tuple[int, int, int]:
        hex_part = self.bg_color[1:]
        if len(hex_part) == 3:
            hex_part = "".join(ch * 2 for ch in hex_part)
        return (int(hex_part[0:2], 16), int(hex_part[2:4], 16), int(hex_part[4:6], 16))


class ProcessRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")

    request_id: str = Field(min_length=1, max_length=256)
    source_url: str = Field(min_length=1, max_length=8192)
    source_mime_type: str | None = None
    uploads: Uploads
    settings: ProcessSettings


# --------------------------------------------------------------------------------------
# Response
# --------------------------------------------------------------------------------------
class OutputInfo(BaseModel):
    width: int
    height: int
    bytes: int
    format: OutputFormat
    content_type: str


class SourceInfo(BaseModel):
    width: int
    height: int
    format: str
    mode: str
    icc_converted: bool


class UpscaleInfo(BaseModel):
    eligible: bool
    applied: bool
    method: UpscaleMethod
    scale: float
    reason: str


class Flag(BaseModel):
    code: str
    severity: Severity
    message: str


class Metrics(BaseModel):
    mask_coverage: float | None
    mask_fragments: int | None
    mask_uncertainty: float | None
    text_detected: bool
    text_boxes: int
    fidelity_ssim: float | None
    fidelity_delta_e: float | None
    color_drift_delta_e: float | None


class ModelsInfo(BaseModel):
    backend: Literal["local", "replicate", "classic"]
    segmentation: str
    upscaler: str | None
    text_detector: str | None


class ProcessingAttempt(BaseModel):
    operation: str  # "background_removal" | "upscale"
    method: str  # "local" | "local_refine" | "replicate" | "lanczos" | ...
    model: str | None
    duration_ms: int
    cost_usd: float
    outcome: str  # "used" | "rejected" (failed the quality checks) | "failed" (error)
    reason: str | None = None
    quality_score: float | None = None


class ProcessingInfo(BaseModel):
    """How the image was made, for cost and quality monitoring (see the contract)."""

    operations: list[str]  # e.g. ["decode", "background_removal", "canvas", "export"]
    method: str  # "deterministic" | "source_alpha" | "local" | "replicate" | "local+replicate"
    replicate_used: bool
    replicate_calls: int
    replicate_models: list[str]
    estimated_cost_usd: float
    fallback_reason: str | None
    quality_score: float | None
    quality_checks: dict[str, float | bool | None]
    attempts: list[ProcessingAttempt]
    # Routing and the quality gate (contract "Routing and the quality gate").
    route: str = "deterministic"  # no_change | deterministic | local | replicate | local_then_replicate
    local_attempted: bool = False
    local_accepted: bool = False
    gate: Literal["SAFE_LOCAL", "UNCERTAIN", "FAILED"] | None = None
    ai_gate: Literal["PASS", "UNSAFE"] | None = None
    reason_codes: list[str] = Field(default_factory=list)
    replicate_attempts: int = 0
    quality_scores: dict[str, float | None] = Field(default_factory=dict)
    analysis: dict[str, object] | None = None
    shadow: dict[str, object] | None = None
    final_status: Literal["READY", "NEEDS_REVIEW", "NO_CHANGE"] = "READY"


class Timings(BaseModel):
    download: int
    upscale: int
    segment: int
    compose: int
    upload: int
    total: int


class ProcessResponse(BaseModel):
    request_id: str
    output: OutputInfo
    source: SourceInfo
    upscale: UpscaleInfo
    flags: list[Flag]
    metrics: Metrics
    fidelity: float | None
    models: ModelsInfo
    timings_ms: Timings
    processing: ProcessingInfo | None = None


class HealthResponse(BaseModel):
    ok: bool
    backend: str
    device: str
    models_loaded: list[str]
    text_detector: str | None = None
    fallback_backend: str | None = None
    escalation_backend: str | None = None
    # Changes whenever results for the same image and settings could change (code version +
    # output-affecting configuration); clients key reused results on it.
    pipeline_version: str | None = None
