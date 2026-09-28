"""End-to-end ``/v1/process`` tests: real HTTP download/upload against a local stub server."""

from __future__ import annotations

import json
import time
from collections.abc import Iterator
from typing import Any

import numpy as np
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app.backends.base import Backend, Segmenter, UpscaleFactor, Upscaler
from app.backends.classic import ClassicSegmenter
from app.config import ServiceConfig
from app.imageio import AI_DIGITAL_SOURCE_TYPE
from app.main import create_app
from app.ops import lanczos_upscale
from app.pipeline import PIPELINE_VERSION
from app.security import sign

from .conftest import StubStorage
from .helpers import SECRET, decode, product_on_white, tall_product, text_image, to_bytes

RESPONSE_KEYS = {
    "request_id",
    "output",
    "source",
    "upscale",
    "flags",
    "metrics",
    "fidelity",
    "models",
    "timings_ms",
    "processing",
}
METRIC_KEYS = {
    "mask_coverage",
    "mask_fragments",
    "mask_uncertainty",
    "text_detected",
    "text_boxes",
    "fidelity_ssim",
    "fidelity_delta_e",
    "color_drift_delta_e",
}
TIMING_KEYS = {"download", "upscale", "segment", "compose", "upload", "total"}
FLAG_CODES = {
    "mask_empty",
    "mask_full",
    "mask_fragmented",
    "mask_low_confidence",
    "text_detected",
    "fidelity_low",
    "color_drift",
    "upscale_capped",
}


class FakeAIUpscaler(Upscaler):
    """Stands in for Real-ESRGAN: reports itself as AI so the applied/XMP paths run."""

    is_ai = True

    def model_name(self, scale: UpscaleFactor) -> str:
        return f"RealESRGAN_x{scale}plus"

    def upscale(self, rgb: np.ndarray, scale: UpscaleFactor) -> np.ndarray:
        return lanczos_upscale(rgb, float(scale))


def fake_ai_backend(_: ServiceConfig) -> Backend:
    return Backend(
        kind="local",
        device="cpu",
        segmenter=ClassicSegmenter(),
        upscaler=FakeAIUpscaler(),
        models_loaded=["segmentation", "upscaler_x2", "upscaler_x4"],
    )


@pytest.fixture
def client(cfg: ServiceConfig) -> Iterator[TestClient]:
    with TestClient(create_app(cfg)) as c:
        yield c


def make_body(storage: StubStorage, source: bytes, request_id: str = "job_1", **settings: Any) -> dict[str, Any]:
    base_settings = {
        "aspect": "1:1",
        "margin_pct": 8,
        "remove_bg": True,
        "bg_color": "#FFFFFF",
        "upscale": False,
        "upscale_threshold_px": 1200,
        "target_px": 1024,
        "output_format": "jpeg",
        "jpeg_quality": 90,
        "ai_metadata": True,
    }
    base_settings.update(settings)
    return {
        "request_id": request_id,
        "source_url": storage.serve(f"/src/{request_id}", source) + "?X-Amz-Signature=xyz",
        "source_mime_type": "image/jpeg",
        "uploads": storage.upload_targets(f"/out/{request_id}"),
        "settings": base_settings,
    }


def post(client: TestClient, body: dict[str, Any] | bytes, *, secret: str | None = SECRET, header: str | None = None):
    raw = body if isinstance(body, bytes) else json.dumps(body).encode()
    headers = {"Content-Type": "application/json"}
    if header is not None:
        headers["X-Signature"] = header
    elif secret is not None:
        headers["X-Signature"] = sign(secret, raw)
    return client.post("/v1/process", content=raw, headers=headers)


def uploaded(storage: StubStorage, request_id: str, name: str) -> tuple[dict[str, str], Image.Image]:
    headers, body = storage.uploads[f"/out/{request_id}/{name}"]
    return headers, decode(body)


def assert_error(resp: Any, status: int, code: str) -> None:
    assert resp.status_code == status, resp.text
    body = resp.json()
    assert set(body) == {"error"} and body["error"]["code"] == code and body["error"]["message"]


# --------------------------------------------------------------------------------------
def test_healthz_no_auth(client: TestClient) -> None:
    resp = client.get("/healthz")
    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is True and body["backend"] == "classic" and body["device"] == "cpu"
    assert {"segmentation", "upscaler_x2", "upscaler_x4"} <= set(body["models_loaded"])
    assert body["text_detector"] == "mser-heuristic"
    assert body["pipeline_version"].startswith(f"{PIPELINE_VERSION}+")


def test_pipeline_version_tracks_output_affecting_settings_only(cfg: ServiceConfig) -> None:
    base = cfg.output_fingerprint()
    assert cfg.model_copy(update={"escalate_flip_disagreement": 0.02}).output_fingerprint() != base
    assert cfg.model_copy(update={"birefnet_input_size": 512}).output_fingerprint() != base
    assert cfg.model_copy(update={"gpu_service_secret": "rotated"}).output_fingerprint() == base
    assert cfg.model_copy(update={"max_concurrency": 4}).output_fingerprint() == base


def test_process_cutout_matches_contract(client: TestClient, storage: StubStorage) -> None:
    src = product_on_white(1000, 800)
    body = make_body(storage, to_bytes(src, quality=95))
    resp = post(client, body)
    assert resp.status_code == 200, resp.text
    data = resp.json()

    assert set(data) == RESPONSE_KEYS
    assert data["request_id"] == "job_1"
    assert set(data["metrics"]) == METRIC_KEYS and set(data["timings_ms"]) == TIMING_KEYS
    assert data["source"] == {"width": 1000, "height": 800, "format": "JPEG", "mode": "RGB", "icc_converted": False}
    assert data["upscale"] == {
        "eligible": False,
        "applied": False,
        "method": "none",
        "scale": 1.0,
        "reason": "upscaling not requested",
    }
    assert data["models"] == {
        "backend": "classic",
        "segmentation": "classic-border-lab",
        "upscaler": None,
        "text_detector": None,
    }
    assert data["flags"] == [] and data["fidelity"] is None
    m = data["metrics"]
    assert 0.1 < m["mask_coverage"] < 0.2 and m["mask_fragments"] == 1 and m["mask_uncertainty"] < 0.08
    assert m["fidelity_ssim"] is None and m["fidelity_delta_e"] is None and m["color_drift_delta_e"] < 2
    assert m["text_detected"] is False and m["text_boxes"] == 0

    out = data["output"]
    headers, out_img = uploaded(storage, "job_1", "output")
    assert headers["content-type"] == "image/jpeg"
    assert out == {
        "width": out_img.width,
        "height": out_img.height,
        "bytes": len(storage.uploads["/out/job_1/output"][1]),
        "format": "jpeg",
        "content_type": "image/jpeg",
    }
    assert out_img.format == "JPEG" and out_img.width == out_img.height
    # Product is ~400 px wide at native size → canvas shrinks rather than enlarging it.
    assert out_img.width < 1024
    arr = np.asarray(out_img.convert("RGB")).astype(int)
    assert (arr[3, 3] > 245).all()  # pure white background
    assert arr[out_img.height // 2 - 40, out_img.width // 2, 0] > 150  # red disc near centre

    _, preview = uploaded(storage, "job_1", "preview")
    assert preview.format == "JPEG" and max(preview.size) == 640
    _, before = uploaded(storage, "job_1", "before")
    assert before.format == "JPEG" and before.size == (640, 512)
    mask_headers, mask = uploaded(storage, "job_1", "mask")
    assert mask_headers["content-type"] == "image/png" and mask_headers["x-amz-meta-kind"] == "mask"
    assert mask.format == "PNG" and mask.mode == "RGBA" and mask.size == before.size
    marr = np.asarray(mask)
    assert tuple(marr[10, 10]) == (255, 0, 0, 115)  # background tinted red ~45%
    assert marr[int(512 * 0.42), int(640 * 0.68), 3] == 0  # product transparent


def test_process_4x5_png_colored_bg(client: TestClient, storage: StubStorage) -> None:
    body = make_body(
        storage,
        to_bytes(tall_product(), "PNG"),
        aspect="4:5",
        margin_pct=5,
        bg_color="#1E90FF",
        output_format="png",
        target_px=512,
    )
    for target in body["uploads"].values():
        if target["url"].split("?")[0].endswith("/output"):
            target["headers"] = {"Content-Type": "image/png"}
    resp = post(client, body)
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["output"]["format"] == "png" and data["output"]["content_type"] == "image/png"
    _, out = uploaded(storage, "job_1", "output")
    assert out.format == "PNG" and out.mode == "RGB"
    assert out.size == (512, 640) and (data["output"]["width"], data["output"]["height"]) == (512, 640)
    assert tuple(np.asarray(out)[2, 2]) == (0x1E, 0x90, 0xFF)
    assert data["source"]["format"] == "PNG"


def test_process_keep_background(client: TestClient, storage: StubStorage) -> None:
    body = make_body(storage, to_bytes(product_on_white(1000, 800), quality=95), remove_bg=False)
    resp = post(client, body)
    assert resp.status_code == 200, resp.text
    data = resp.json()
    m = data["metrics"]
    assert m["mask_coverage"] is None and m["mask_fragments"] is None and m["mask_uncertainty"] is None
    assert not {f["code"] for f in data["flags"]} & {
        "mask_empty",
        "mask_full",
        "mask_fragmented",
        "mask_low_confidence",
    }
    _, out = uploaded(storage, "job_1", "output")
    arr = np.asarray(out.convert("RGB")).astype(int)
    assert np.abs(arr[2, 2] - 247).max() <= 3  # padded with the median edge colour (seamless)
    _, mask = uploaded(storage, "job_1", "mask")
    assert np.asarray(mask)[..., 3].max() == 0  # blank when remove_bg is false


def test_process_upscale_classic_uses_lanczos(client: TestClient, storage: StubStorage) -> None:
    body = make_body(storage, to_bytes(product_on_white(600, 480), quality=95), upscale=True, target_px=1024)
    resp = post(client, body)
    assert resp.status_code == 200, resp.text
    data = resp.json()
    up = data["upscale"]
    assert up["eligible"] is True and up["applied"] is False and up["method"] == "lanczos"
    assert up["scale"] in (2.0, 4.0) and up["reason"].startswith("short side 480 < 1200")
    assert data["models"]["upscaler"] == "lanczos" and data["models"]["text_detector"] == "mser-heuristic"
    assert data["fidelity"] == data["metrics"]["fidelity_ssim"] and data["fidelity"] > 0.9
    assert data["metrics"]["fidelity_delta_e"] < 3
    assert (data["output"]["width"], data["output"]["height"]) == (1024, 1024)
    _, out = uploaded(storage, "job_1", "output")
    assert "xmp" not in out.info  # AI never ran
    assert "upscale_capped" not in {f["code"] for f in data["flags"]}


def test_process_upscale_not_eligible(client: TestClient, storage: StubStorage) -> None:
    body = make_body(storage, to_bytes(product_on_white(1600, 1300)), upscale=True)
    data = post(client, body).json()
    assert data["upscale"]["eligible"] is False and data["upscale"]["method"] == "none"
    assert data["upscale"]["reason"] == "short side 1300 >= 1200"
    assert data["fidelity"] is None


def test_process_text_guardrail(client: TestClient, storage: StubStorage) -> None:
    body = make_body(storage, to_bytes(text_image(), quality=95), upscale=True, target_px=2048)
    data = post(client, body).json()
    codes = {f["code"] for f in data["flags"]}
    assert "text_detected" in codes
    assert data["metrics"]["text_detected"] is True and data["metrics"]["text_boxes"] >= 1
    assert data["upscale"]["method"] == "lanczos" and data["upscale"]["applied"] is False
    assert data["models"]["text_detector"] == "mser-heuristic"


def test_process_ai_upscale_embeds_xmp(cfg: ServiceConfig, storage: StubStorage) -> None:
    with TestClient(create_app(cfg, backend_factory=fake_ai_backend)) as c:
        body = make_body(storage, to_bytes(product_on_white(500, 400), quality=95), upscale=True, target_px=1024)
        data = post(c, body).json()
        up = data["upscale"]
        assert up["applied"] is True and up["method"] in ("realesrgan-x2", "realesrgan-x4")
        assert data["models"]["upscaler"] == f"RealESRGAN_x{int(up['scale'])}plus"
        assert data["models"]["backend"] == "local"
        raw = storage.uploads["/out/job_1/output"][1]
        assert AI_DIGITAL_SOURCE_TYPE.encode() in raw

        body = make_body(
            storage,
            to_bytes(product_on_white(500, 400), quality=95),
            request_id="job_2",
            upscale=True,
            target_px=1024,
            ai_metadata=False,
        )
        assert post(c, body).status_code == 200
        assert AI_DIGITAL_SOURCE_TYPE.encode() not in storage.uploads["/out/job_2/output"][1]


def test_process_upscale_capped(cfg: ServiceConfig, storage: StubStorage) -> None:
    with TestClient(create_app(cfg, backend_factory=fake_ai_backend)) as c:
        img = np.full((300, 300, 3), 250, np.uint8)
        img[130:170, 130:170] = (200, 30, 30)  # 40 px product: needs ~40x for 2048
        data = post(c, make_body(storage, to_bytes(img, "PNG"), upscale=True, target_px=2048)).json()
        assert data["upscale"]["method"] == "realesrgan-x4"
        assert "upscale_capped" in {f["code"] for f in data["flags"]}
        assert data["output"]["width"] < 2048


def test_cpu_backend_caps_ai_upscale_at_local_max_ai_scale(cfg: ServiceConfig, storage: StubStorage) -> None:
    img = np.full((300, 300, 3), 250, np.uint8)
    img[130:170, 130:170] = (200, 30, 30)  # needs far more than 4x, so x4 would be chosen
    capped = cfg.model_copy(update={"local_max_ai_scale": 2})
    with TestClient(create_app(capped, backend_factory=fake_ai_backend)) as c:  # local on CPU
        data = post(c, make_body(storage, to_bytes(img, "PNG"), upscale=True, target_px=2048)).json()
        up = data["upscale"]
        assert up["applied"] is True and up["method"] == "realesrgan-x2" and up["scale"] == 2.0
        assert up["reason"].endswith("; AI upscaling limited to x2 on CPU")
        assert data["models"]["upscaler"] == "RealESRGAN_x2plus"
        assert "upscale_capped" in {f["code"] for f in data["flags"]}

    def gpu_backend(c: ServiceConfig) -> Backend:
        backend = fake_ai_backend(c)
        backend.device = "cuda"
        return backend

    with TestClient(create_app(capped, backend_factory=gpu_backend)) as c:  # the cap is CPU-only
        data = post(c, make_body(storage, to_bytes(img, "PNG"), request_id="job_2", upscale=True, target_px=2048))
        assert data.json()["upscale"]["method"] == "realesrgan-x4"


def test_cpu_backend_uses_lanczos_above_the_ai_upscale_pixel_budget(cfg: ServiceConfig, storage: StubStorage) -> None:
    budget = cfg.model_copy(update={"local_max_ai_upscale_pixels": 150_000})
    with TestClient(create_app(budget, backend_factory=fake_ai_backend)) as c:  # local on CPU
        big = post(c, make_body(storage, to_bytes(product_on_white(500, 400), quality=95), upscale=True)).json()
        up = big["upscale"]
        assert up["applied"] is False and up["method"] == "lanczos" and up["scale"] > 1.0
        assert up["reason"].endswith("; too large for AI upscaling on CPU, used Lanczos")
        assert big["models"]["upscaler"] == "lanczos"
        assert AI_DIGITAL_SOURCE_TYPE.encode() not in storage.uploads["/out/job_1/output"][1]
        body = make_body(storage, to_bytes(product_on_white(400, 300), quality=95), request_id="job_2", upscale=True)
        small = post(c, body).json()  # 120,000 px: within the budget
        assert small["upscale"]["applied"] is True and small["upscale"]["method"].startswith("realesrgan-x")


def test_local_max_ai_scale_must_be_2_or_4(cfg: ServiceConfig) -> None:
    from pydantic import ValidationError

    with pytest.raises(ValidationError, match="LOCAL_MAX_AI_SCALE must be 2 or 4"):
        ServiceConfig(gpu_service_secret=SECRET, local_max_ai_scale=3)
    assert ServiceConfig(gpu_service_secret=SECRET).local_max_ai_scale == 4


def test_queued_request_is_skipped_when_the_caller_hung_up(cfg: ServiceConfig, storage: StubStorage) -> None:
    """Real uvicorn: a caller that times out while waiting for the semaphore costs no pipeline run."""
    import logging
    import threading

    import httpx
    import uvicorn

    calls: list[int] = []
    running, release = threading.Event(), threading.Event()

    class BlockingSegmenter(ClassicSegmenter):
        def predict(self, rgb: np.ndarray) -> np.ndarray:
            calls.append(1)
            running.set()
            release.wait(15)
            return super().predict(rgb)

    def factory(_: ServiceConfig) -> Backend:
        return Backend(kind="classic", device="cpu", segmenter=BlockingSegmenter(), upscaler=FakeAIUpscaler())

    messages: list[str] = []

    class Collect(logging.Handler):
        def emit(self, record: logging.LogRecord) -> None:
            messages.append(record.getMessage())

    handler = Collect()
    logging.getLogger("app").addHandler(handler)
    one_slot = cfg.model_copy(update={"max_concurrency": 1})
    server = uvicorn.Server(uvicorn.Config(create_app(one_slot, backend_factory=factory), port=0, log_config=None))
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    try:
        deadline = time.monotonic() + 15
        while not server.started:
            assert time.monotonic() < deadline and thread.is_alive(), "uvicorn did not start"
            time.sleep(0.02)
        url = f"http://127.0.0.1:{server.servers[0].sockets[0].getsockname()[1]}/v1/process"

        def send(request_id: str, timeout: httpx.Timeout) -> httpx.Response:
            raw = json.dumps(make_body(storage, to_bytes(product_on_white(300, 200)), request_id=request_id)).encode()
            headers = {"Content-Type": "application/json", "X-Signature": sign(SECRET, raw)}
            return httpx.post(url, content=raw, headers=headers, timeout=timeout)

        first: list[httpx.Response] = []
        sender = threading.Thread(target=lambda: first.append(send("holds_slot", httpx.Timeout(30))))
        sender.start()
        assert running.wait(15)
        with pytest.raises(httpx.ReadTimeout):  # queued behind the first request, then gives up
            send("gave_up", httpx.Timeout(10, read=0.5))
        time.sleep(0.3)  # let the server see the hang-up
        release.set()
        sender.join(30)
        assert first and first[0].status_code == 200
        deadline = time.monotonic() + 10
        while "client_gone" not in messages:
            assert time.monotonic() < deadline, messages
            time.sleep(0.02)
        assert len(calls) == 1  # the abandoned request never ran the pipeline
    finally:
        release.set()
        logging.getLogger("app").removeHandler(handler)
        server.should_exit = True
        thread.join(15)


def test_process_alpha_source_uses_alpha_as_mask(client: TestClient, storage: StubStorage) -> None:
    rgba = np.zeros((400, 400, 4), np.uint8)
    rgba[100:300, 150:250] = (240, 240, 240, 255)  # near-white product: invisible to border diff
    body = make_body(storage, to_bytes(rgba, "PNG"), bg_color="#000000")
    data = post(client, body).json()
    assert data["models"]["segmentation"] == "source-alpha"
    assert data["source"]["mode"] == "RGBA"
    _, out = uploaded(storage, "job_1", "output")
    arr = np.asarray(out.convert("RGB")).astype(int)
    assert (arr[2, 2] < 10).all()  # black bg
    assert (arr[out.height // 2, out.width // 2] > 225).all()  # product kept


def test_process_exif_rotated_source(client: TestClient, storage: StubStorage) -> None:
    exif = Image.Exif()
    exif[0x0112] = 8
    data = post(client, make_body(storage, to_bytes(product_on_white(800, 600), exif=exif.tobytes()))).json()
    assert (data["source"]["width"], data["source"]["height"]) == (600, 800)
    _, before = uploaded(storage, "job_1", "before")
    assert before.size == (480, 640)


def test_process_blank_image_flags_mask_empty(client: TestClient, storage: StubStorage) -> None:
    data = post(client, make_body(storage, to_bytes(np.full((500, 500, 3), 240, np.uint8)))).json()
    assert {f["code"] for f in data["flags"]} >= {"mask_empty"}
    assert all(f["code"] in FLAG_CODES and f["severity"] in ("info", "warning", "error") for f in data["flags"])
    assert data["output"]["width"] > 0  # still produces an output (original kept, padded)


# --------------------------------------------------------------------------------------
# Errors
# --------------------------------------------------------------------------------------
def test_missing_signature(client: TestClient, storage: StubStorage) -> None:
    assert_error(post(client, make_body(storage, b"x"), secret=None), 401, "unauthorized")


def test_bad_signature(client: TestClient, storage: StubStorage) -> None:
    assert_error(post(client, make_body(storage, b"x"), secret="nope"), 401, "unauthorized")


def test_stale_signature(client: TestClient, storage: StubStorage) -> None:
    raw = json.dumps(make_body(storage, b"x")).encode()
    header = sign(SECRET, raw, int(time.time()) - 1000)
    assert_error(post(client, raw, header=header), 401, "unauthorized")


def test_unsigned_allowed_in_dev(cfg: ServiceConfig, storage: StubStorage) -> None:
    dev = cfg.model_copy(update={"allow_unsigned": True, "gpu_service_secret": None})
    with TestClient(create_app(dev)) as c:
        resp = post(c, make_body(storage, to_bytes(product_on_white(400, 300))), secret=None)
        assert resp.status_code == 200, resp.text


@pytest.mark.parametrize(
    "patch",
    [
        {"aspect": "16:9"},
        {"margin_pct": 45},
        {"bg_color": "white"},
        {"output_format": "gif"},
        {"target_px": 10},
    ],
)
def test_invalid_settings(client: TestClient, storage: StubStorage, patch: dict[str, Any]) -> None:
    assert_error(post(client, make_body(storage, b"x", **patch)), 400, "invalid_settings")


def test_malformed_json(client: TestClient) -> None:
    assert_error(post(client, b"{not json"), 400, "invalid_settings")


def test_http_url_rejected_unless_allowed(cfg: ServiceConfig, storage: StubStorage) -> None:
    strict = cfg.model_copy(update={"allow_http_urls": False})
    with TestClient(create_app(strict)) as c:
        assert_error(post(c, make_body(storage, b"x")), 400, "invalid_settings")


def test_host_allowlist(cfg: ServiceConfig, storage: StubStorage) -> None:
    allow = cfg.model_copy(update={"allowed_url_hosts": "storage.example.com"})
    with TestClient(create_app(allow)) as c:
        assert_error(post(c, make_body(storage, b"x")), 400, "invalid_settings")


def test_unsupported_image(client: TestClient, storage: StubStorage) -> None:
    assert_error(post(client, make_body(storage, b"<html>error page</html>")), 415, "unsupported_image")


def test_image_too_large(cfg: ServiceConfig, storage: StubStorage) -> None:
    small = cfg.model_copy(update={"max_source_bytes": 2048})
    with TestClient(create_app(small)) as c:
        body = make_body(
            storage, to_bytes(np.random.default_rng(0).integers(0, 255, (200, 200, 3), dtype=np.uint8), "PNG")
        )
        assert_error(post(c, body), 413, "image_too_large")


def test_source_404_is_permanent(client: TestClient, storage: StubStorage) -> None:
    body = make_body(storage, b"")
    storage.objects.pop("/src/job_1")
    assert_error(post(client, body), 400, "source_download_failed")


def test_source_500_is_transient(client: TestClient, storage: StubStorage) -> None:
    body = make_body(storage, b"")
    storage.objects["/src/job_1"] = (503, b"busy")
    assert_error(post(client, body), 502, "source_download_failed")


def test_upload_retried_on_5xx(client: TestClient, storage: StubStorage) -> None:
    storage.put_status["/out/job_1/preview"] = [500]
    resp = post(client, make_body(storage, to_bytes(product_on_white(400, 300))))
    assert resp.status_code == 200, resp.text
    assert storage.put_attempts["/out/job_1/preview"] == 2
    assert "/out/job_1/preview" in storage.uploads


def test_upload_4xx_fails(client: TestClient, storage: StubStorage) -> None:
    storage.put_status["/out/job_1/output"] = [403]
    assert_error(post(client, make_body(storage, to_bytes(product_on_white(400, 300)))), 502, "upload_failed")
    assert storage.put_attempts["/out/job_1/output"] == 1


def test_internal_error_shape(cfg: ServiceConfig, storage: StubStorage, monkeypatch: pytest.MonkeyPatch) -> None:
    from app import pipeline

    def boom(*_: object, **__: object) -> None:
        raise RuntimeError("kaboom")

    monkeypatch.setattr(pipeline.Pipeline, "run", boom)
    with TestClient(create_app(cfg), raise_server_exceptions=False) as c:
        assert_error(post(c, make_body(storage, to_bytes(product_on_white(100, 100)))), 500, "internal")


def test_unknown_route_error_shape(client: TestClient) -> None:
    assert_error(client.get("/nope"), 404, "not_found")


def test_structured_logs_carry_request_id(client: TestClient, storage: StubStorage) -> None:
    import logging

    from app.log import JsonFormatter

    records: list[logging.LogRecord] = []

    class Collect(logging.Handler):
        def emit(self, record: logging.LogRecord) -> None:
            records.append(record)

    handler = Collect()
    logger = logging.getLogger("app")
    logger.addHandler(handler)
    try:
        assert (
            post(client, make_body(storage, to_bytes(product_on_white(300, 200)), request_id="clx_log")).status_code
            == 200
        )
    finally:
        logger.removeHandler(handler)
    lines = [json.loads(JsonFormatter().format(r)) for r in records]
    by_msg = {line["msg"]: line for line in lines}
    assert {"process_start", "process_done", "http_request"} <= set(by_msg)
    assert all(by_msg[m]["request_id"] == "clx_log" for m in ("process_start", "process_done", "http_request"))
    assert by_msg["http_request"]["status"] == 200 and by_msg["process_done"]["timings_ms"]["total"] >= 0


class FakeModelSegmenter(Segmenter):
    """An in-process 'model' segmenter (like BiRefNet) returning a 512x512 model-res mask."""

    name = "fake/BiRefNet@deadbeef"
    in_process = True

    def __init__(self) -> None:
        self.calls = 0

    def predict(self, rgb: np.ndarray) -> np.ndarray:
        import cv2

        from app.backends.classic import border_difference_mask

        self.calls += 1
        return cv2.resize(border_difference_mask(rgb), (512, 512), interpolation=cv2.INTER_LINEAR)


def test_model_segmenter_paths(cfg: ServiceConfig, storage: StubStorage) -> None:
    seg = FakeModelSegmenter()

    def factory(_: ServiceConfig) -> Backend:
        return Backend(kind="local", device="cpu", segmenter=seg, upscaler=FakeAIUpscaler())

    with TestClient(create_app(cfg, backend_factory=factory)) as c:
        src = to_bytes(product_on_white(900, 700), quality=95)
        cut = post(c, make_body(storage, src, request_id="cut")).json()
        assert cut["models"]["segmentation"] == "fake/BiRefNet@deadbeef" and cut["flags"] == []
        keep = post(c, make_body(storage, src, request_id="keep", remove_bg=False)).json()
        assert keep["metrics"]["mask_coverage"] is None and keep["output"]["width"] > 0
        # cut-out + its mirrored stability pass + the letterbox second opinion, then bbox
        # refinement when keeping the background
        assert seg.calls == 4
