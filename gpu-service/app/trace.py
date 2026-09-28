"""Per-request processing trace: which method ran each AI operation, paid calls and their cost.

The pipeline opens a trace at the start of a request (``begin_trace``); backends record into
``current_trace()`` without being passed it, so a Replicate call made deep inside a segmenter
still lands on the request that caused it. Each request runs in one worker thread, so a
context variable is enough.
"""

from __future__ import annotations

import logging
from contextvars import ContextVar
from dataclasses import dataclass, field

log = logging.getLogger("app.processing")

# Operations the pipeline can run (used in logs and the response's ``processing.operations``).
Operation = str  # "decode" | "upscale" | "background_removal" | "canvas" | "export"


@dataclass
class Attempt:
    """One way an AI operation was tried (and whether its result was kept)."""

    operation: str  # "background_removal" | "upscale"
    method: str  # "local" | "local_refine" | "replicate" | "source_alpha" | "lanczos" | ...
    model: str | None
    duration_ms: int
    cost_usd: float = 0.0
    outcome: str = "used"  # "used" | "rejected" (failed the quality checks) | "failed" (error)
    reason: str | None = None
    quality_score: float | None = None


@dataclass
class ReplicateCall:
    model: str
    version: str
    predict_time_s: float | None
    cost_usd: float
    duration_ms: int
    status: str


@dataclass
class ProcessingTrace:
    attempts: list[Attempt] = field(default_factory=list)
    replicate_calls: list[ReplicateCall] = field(default_factory=list)
    fallback_reasons: list[str] = field(default_factory=list)
    # Reason names behind the routing and the final status, in order (quality.REASON_CODES maps
    # them to the response's reason_codes).
    notes: list[str] = field(default_factory=list)

    @property
    def cost_usd(self) -> float:
        return round(sum(c.cost_usd for c in self.replicate_calls), 6)

    def add(self, attempt: Attempt) -> Attempt:
        self.attempts.append(attempt)
        return attempt

    def fallback(self, operation: str, reason: str, *, to: str) -> None:
        self.fallback_reasons.append(reason)
        log.info("AI_FALLBACK", extra={"operation": operation, "reason": reason, "to": to})


_current: ContextVar[ProcessingTrace | None] = ContextVar("processing_trace", default=None)


def begin_trace() -> ProcessingTrace:
    trace = ProcessingTrace()
    _current.set(trace)
    return trace


def current_trace() -> ProcessingTrace | None:
    return _current.get()


def record_replicate_call(
    *, model: str, version: str, predict_time_s: float | None, usd_per_s: float, duration_ms: int, status: str
) -> ReplicateCall:
    """Log a Replicate prediction and add it to the current request's trace.

    Replicate bills public models for prediction time only; when a prediction reports none
    (e.g. it failed before running), a one-second minimum keeps the estimate conservative.
    """
    billed = predict_time_s if predict_time_s is not None else 1.0
    call = ReplicateCall(
        model=model,
        version=version,
        predict_time_s=predict_time_s,
        cost_usd=round(billed * usd_per_s, 6),
        duration_ms=duration_ms,
        status=status,
    )
    log.info(
        "REPLICATE_CALL",
        extra={
            "model": model,
            "version": version[:12],
            "status": status,
            "predict_time_s": predict_time_s,
            "estimated_usd": call.cost_usd,
            "duration_ms": duration_ms,
        },
    )
    trace = current_trace()
    if trace is not None:
        trace.replicate_calls.append(call)
    return call
