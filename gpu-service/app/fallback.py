"""Primary backend with an automatic fallback (e.g. Replicate → the local CPU models).

When the primary backend's model call fails (provider down, out of credit, timed out), the
whole request is re-run on the fallback backend, so one response never mixes two models and
``models`` always reports what actually ran. After a failure the primary is skipped for
``cooldown_s`` so a dead provider doesn't add its timeout to every request.
"""

from __future__ import annotations

import logging
import threading
import time
from collections.abc import Callable

from .backends.base import Backend
from .errors import ServiceError
from .pipeline import Pipeline, PipelineResult
from .schemas import ProcessSettings

log = logging.getLogger(__name__)


class FallbackPipeline:
    def __init__(
        self,
        primary: Pipeline,
        build_fallback: Callable[[], Pipeline],
        *,
        cooldown_s: float,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.primary = primary
        self._build_fallback = build_fallback
        self.cooldown_s = cooldown_s
        self._clock = clock
        self._lock = threading.Lock()
        self._fallback: Pipeline | None = None
        self._skip_primary_until = 0.0

    @property
    def backend(self) -> Backend:
        """The primary backend (what /healthz reports)."""
        return self.primary.backend

    def run(self, data: bytes, settings: ProcessSettings) -> PipelineResult:
        if self._clock() >= self._skip_primary_until:
            try:
                return self.primary.run(data, settings)
            except ServiceError as exc:
                if exc.code != "model_backend_failed":
                    raise  # bad input fails the same way on any backend
                self._skip_primary_until = self._clock() + self.cooldown_s
                log.warning(
                    "primary_backend_failed",
                    extra={"backend": self.primary.backend.kind, "error": exc.message, "cooldown_s": self.cooldown_s},
                )
        return self.fallback().run(data, settings)

    def fallback(self) -> Pipeline:
        """The fallback pipeline, built (models loaded) on first use."""
        with self._lock:
            if self._fallback is None:
                self._fallback = self._build_fallback()
                log.info("fallback_backend_ready", extra={"backend": self._fallback.backend.kind})
            return self._fallback

    def close(self) -> None:
        if self._fallback is not None:
            self._fallback.backend.close()
