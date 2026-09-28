"""Replicate backend against a mocked HTTP transport (no network)."""

from __future__ import annotations

import base64
import io
import json
from typing import Any

import httpx
import numpy as np
import pytest
from PIL import Image

from app.backends.replicate import API_URL, ReplicateClient, ReplicateSegmenter, ReplicateUpscaler
from app.errors import ServiceError

from .helpers import product_on_white


def png_bytes(img: Image.Image) -> bytes:
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()


class FakeReplicate:
    """Create → (processing) → succeeded, then serves the output file."""

    def __init__(self, output: bytes, *, polls: int = 1, final_status: str = "succeeded") -> None:
        self.output = output
        self.polls_left = polls
        self.final_status = final_status
        self.created: list[dict[str, Any]] = []
        self.headers: list[httpx.Headers] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.headers.append(request.headers)
        url = str(request.url)
        if request.method == "POST" and url == API_URL:
            self.created.append(json.loads(request.content))
            return httpx.Response(
                201,
                json={
                    "id": "p1",
                    "status": "processing",
                    "urls": {"get": "https://api.replicate.com/v1/predictions/p1"},
                },
            )
        if url.endswith("/predictions/p1"):
            if self.polls_left > 0:
                self.polls_left -= 1
                return httpx.Response(200, json={"id": "p1", "status": "processing", "urls": {"get": url}})
            body: dict[str, Any] = {"id": "p1", "status": self.final_status, "urls": {"get": url}}
            if self.final_status == "succeeded":
                body["output"] = "https://replicate.delivery/out.png"
            else:
                body["error"] = "boom"
            return httpx.Response(200, json=body)
        if url == "https://replicate.delivery/out.png":
            return httpx.Response(200, content=self.output)
        return httpx.Response(404)


def make_client(fake: FakeReplicate) -> ReplicateClient:
    return ReplicateClient("r8_token", 30, poll_interval_s=0, client=httpx.Client(transport=httpx.MockTransport(fake)))


def test_segmenter_uses_alpha_channel() -> None:
    rgba = np.zeros((64, 64, 4), np.uint8)
    rgba[16:48, 16:48] = (200, 10, 10, 255)
    fake = FakeReplicate(png_bytes(Image.fromarray(rgba, "RGBA")))
    seg = ReplicateSegmenter(make_client(fake), "ver123")
    mask = seg.predict(product_on_white(128, 128))
    assert mask.dtype == np.float32 and mask.shape == (64, 64)
    assert mask[32, 32] == 1.0 and mask[2, 2] == 0.0
    created = fake.created[0]
    assert created["version"] == "ver123" and created["input"]["image"].startswith("data:image/jpeg;base64,")
    assert fake.headers[0]["prefer"].startswith("wait") and fake.headers[0]["authorization"] == "Bearer r8_token"
    assert seg.in_process is False and seg.name == "BiRefNet@replicate:ver123"


def test_segmenter_grayscale_mask() -> None:
    gray = np.zeros((40, 40), np.uint8)
    gray[10:30, 10:30] = 255
    fake = FakeReplicate(png_bytes(Image.fromarray(gray, "L")))
    mask = ReplicateSegmenter(make_client(fake), "v").predict(product_on_white(80, 80))
    assert mask[20, 20] == 1.0 and mask[0, 0] == 0.0


def test_segmenter_downscales_payload() -> None:
    fake = FakeReplicate(png_bytes(Image.new("L", (10, 10), 255)))
    ReplicateSegmenter(make_client(fake), "v").predict(product_on_white(3000, 2000))
    data_uri = fake.created[0]["input"]["image"]
    sent = Image.open(io.BytesIO(base64.b64decode(data_uri.split(",", 1)[1])))
    assert max(sent.size) == 1024


def test_upscaler_returns_exact_scale() -> None:
    fake = FakeReplicate(png_bytes(Image.new("RGB", (199, 151), (10, 20, 30))))  # off by one
    up = ReplicateUpscaler(make_client(fake), "esr")
    out = up.upscale(product_on_white(100, 75), 2)
    assert out.shape == (150, 200, 3)
    assert fake.created[0]["input"]["scale"] == 2 and fake.created[0]["input"]["image"].startswith("data:image/jpeg")
    assert up.is_ai and up.model_name(2) == "RealESRGAN@replicate:esr"


def test_failed_prediction_is_transient_error() -> None:
    fake = FakeReplicate(b"", final_status="failed")
    with pytest.raises(ServiceError) as err:
        ReplicateSegmenter(make_client(fake), "v").predict(product_on_white(50, 50))
    assert err.value.code == "model_backend_failed" and err.value.status == 502


def test_create_error_is_transient_error() -> None:
    client = ReplicateClient(
        "t",
        5,
        poll_interval_s=0,
        client=httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(422, text="bad version"))),
    )
    with pytest.raises(ServiceError) as err:
        client.run("v", {})
    assert err.value.status == 502


def test_data_uri_stays_under_replicate_limit() -> None:
    from app.backends.replicate import MAX_DATA_URI_BYTES, jpeg_data_uri

    noisy = np.random.default_rng(0).integers(0, 256, (1024, 1024, 3), dtype=np.uint8)  # incompressible
    assert len(jpeg_data_uri(noisy)) <= MAX_DATA_URI_BYTES
    small = np.full((300, 400, 3), 200, dtype=np.uint8)
    assert jpeg_data_uri(small).startswith("data:image/jpeg;base64,")


def throttled_then(fake: FakeReplicate, times: int, retry_after: float = 0):
    """Answer the first ``times`` creates with Replicate's low-credit 429, then behave normally."""
    state = {"left": times}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "POST" and str(request.url) == API_URL and state["left"] > 0:
            state["left"] -= 1
            return httpx.Response(429, json={"detail": "Request was throttled.", "retry_after": retry_after})
        return fake(request)

    return handler


def test_throttled_create_waits_and_retries(monkeypatch: pytest.MonkeyPatch) -> None:
    slept: list[float] = []
    monkeypatch.setattr("app.backends.replicate.time.sleep", slept.append)
    fake = FakeReplicate(png_bytes(Image.new("L", (10, 10), 255)))
    client = ReplicateClient(
        "t", 30, poll_interval_s=0, client=httpx.Client(transport=httpx.MockTransport(throttled_then(fake, 2, 6)))
    )
    mask = ReplicateSegmenter(client, "v").predict(product_on_white(50, 50))
    assert mask.shape == (10, 10) and len(fake.created) == 1
    assert slept[:2] == [6.5, 6.5]


def test_throttle_longer_than_deadline_fails_fast(monkeypatch: pytest.MonkeyPatch) -> None:
    slept: list[float] = []
    monkeypatch.setattr("app.backends.replicate.time.sleep", slept.append)
    fake = FakeReplicate(b"")
    client = ReplicateClient(
        "t", 5, poll_interval_s=0, client=httpx.Client(transport=httpx.MockTransport(throttled_then(fake, 1, 30)))
    )
    with pytest.raises(ServiceError) as err:
        client.run("v", {})
    assert err.value.code == "model_backend_failed" and "429" in err.value.message and slept == []
