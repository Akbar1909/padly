"""Primary → fallback backend (e.g. Replicate out of credit → local models)."""

from __future__ import annotations

import json
from typing import Any

import numpy as np
import pytest
from fastapi.testclient import TestClient

from app.backends.base import Backend, Segmenter
from app.backends.classic import build_classic_backend
from app.config import ServiceConfig
from app.errors import ServiceError, backend_failed, unsupported_image
from app.fallback import FallbackPipeline
from app.main import create_app
from app.security import sign

from .conftest import StubStorage
from .helpers import SECRET, product_on_white, to_bytes


class FakePipeline:
    def __init__(self, kind: str, error: ServiceError | None = None) -> None:
        self.backend = Backend(kind=kind, device="cpu", segmenter=None, upscaler=None)  # type: ignore[arg-type]
        self.error = error
        self.calls = 0

    def run(self, data: bytes, settings: Any) -> str:
        self.calls += 1
        if self.error:
            raise self.error
        return self.backend.kind


class Clock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


def test_primary_used_while_it_works_and_fallback_never_loaded() -> None:
    primary = FakePipeline("replicate")
    built: list[str] = []
    pipe = FallbackPipeline(primary, lambda: built.append("x") or FakePipeline("local"), cooldown_s=60)
    assert pipe.run(b"", None) == "replicate"
    assert pipe.run(b"", None) == "replicate"
    assert primary.calls == 2 and built == []


def test_backend_failure_reruns_on_fallback_then_skips_primary_during_cooldown() -> None:
    clock = Clock()
    primary = FakePipeline("replicate", backend_failed("Replicate create failed: HTTP 402"))
    fallback = FakePipeline("local")
    pipe = FallbackPipeline(primary, lambda: fallback, cooldown_s=60, clock=clock)

    assert pipe.run(b"", None) == "local"
    assert (primary.calls, fallback.calls) == (1, 1)

    clock.now += 30  # still cooling down: primary isn't tried
    assert pipe.run(b"", None) == "local"
    assert (primary.calls, fallback.calls) == (1, 2)

    clock.now += 31  # cooldown over: primary is tried again
    primary.error = None
    assert pipe.run(b"", None) == "replicate"
    assert primary.calls == 2


def test_bad_input_is_not_retried_on_the_fallback() -> None:
    primary = FakePipeline("replicate", unsupported_image("not an image"))
    built: list[str] = []
    pipe = FallbackPipeline(primary, lambda: built.append("x") or FakePipeline("local"), cooldown_s=60)
    with pytest.raises(ServiceError) as err:
        pipe.run(b"", None)
    assert err.value.code == "unsupported_image" and built == []


def test_fallback_must_differ_from_primary() -> None:
    with pytest.raises(ValueError, match="FALLBACK_BACKEND"):
        ServiceConfig(model_backend="classic", fallback_backend="classic", gpu_service_secret=SECRET)


class DeadProviderSegmenter(Segmenter):
    name = "BiRefNet@replicate:test"
    in_process = False

    def __init__(self) -> None:
        self.calls = 0

    def predict(self, rgb: np.ndarray) -> np.ndarray:
        self.calls += 1
        raise backend_failed("Replicate create failed: HTTP 402 Insufficient credit")


def test_service_answers_from_fallback_when_provider_is_down(cfg: ServiceConfig, storage: StubStorage) -> None:
    dead = DeadProviderSegmenter()

    def factory(c: ServiceConfig) -> Backend:
        if c.model_backend == "replicate":
            classic = build_classic_backend()
            return Backend(kind="replicate", device="cpu", segmenter=dead, upscaler=classic.upscaler)
        return build_classic_backend()

    cfg = cfg.model_copy(update={"model_backend": "replicate", "fallback_backend": "classic"})
    with TestClient(create_app(cfg, backend_factory=factory)) as client:
        health = client.get("/healthz").json()
        assert health["backend"] == "replicate" and health["fallback_backend"] == "classic"

        for request_id in ("job_1", "job_2"):
            body = {
                "request_id": request_id,
                "source_url": storage.serve(f"/src/{request_id}", to_bytes(product_on_white())) + "?X-Amz-Signature=x",
                "source_mime_type": "image/jpeg",
                "uploads": storage.upload_targets(f"/out/{request_id}"),
                "settings": {"aspect": "1:1", "remove_bg": True, "target_px": 1024},
            }
            raw = json.dumps(body).encode()
            resp = client.post(
                "/v1/process",
                content=raw,
                headers={"Content-Type": "application/json", "X-Signature": sign(SECRET, raw)},
            )
            assert resp.status_code == 200, resp.text
            models = resp.json()["models"]
            assert models["backend"] == "classic" and "replicate" not in models["segmentation"]

    assert dead.calls == 1  # the second request skipped the dead provider (cooldown)
