"""Replicate backend: BiRefNet and Real-ESRGAN run as Replicate predictions over HTTP.

Everything else (canvas, checks, export) still runs locally on CPU. Calls are synchronous
(``httpx.Client``) because the pipeline runs in a worker thread.
"""

from __future__ import annotations

import base64
import io
import logging
import time
from typing import TYPE_CHECKING, Any

import httpx
import numpy as np
from PIL import Image

from ..errors import backend_failed
from ..ops import downscale_to
from ..trace import record_replicate_call
from .base import Backend, Segmenter, UpscaleFactor, Upscaler, ensure_scale

if TYPE_CHECKING:  # pragma: no cover
    from ..config import ServiceConfig

log = logging.getLogger(__name__)

API_URL = "https://api.replicate.com/v1/predictions"
TERMINAL = {"succeeded", "failed", "canceled"}
BIREFNET_MODEL = "men1scus/birefnet"
ESRGAN_MODEL = "nightmareai/real-esrgan"
SEGMENT_LONG_SIDE = 1024  # BiRefNet works at 1024; don't ship larger payloads
# Replicate only recommends data-URI inputs under 1 MB.
MAX_DATA_URI_BYTES = 900_000


def to_data_uri(rgb: np.ndarray, fmt: str = "PNG", quality: int = 95) -> str:
    buf = io.BytesIO()
    img = Image.fromarray(rgb, "RGB")
    if fmt == "JPEG":
        img.save(buf, "JPEG", quality=quality, subsampling=0)
        mime = "image/jpeg"
    else:
        img.save(buf, "PNG")
        mime = "image/png"
    return f"data:{mime};base64,{base64.b64encode(buf.getvalue()).decode('ascii')}"


def jpeg_data_uri(rgb: np.ndarray, *, max_bytes: int = MAX_DATA_URI_BYTES, allow_downscale: bool = True) -> str:
    """JPEG data URI under ``max_bytes``: lower the quality first, then (if allowed) the size."""
    img = rgb
    while True:
        for quality in (95, 90, 85, 80, 70):
            uri = to_data_uri(img, "JPEG", quality)
            if len(uri) <= max_bytes:
                return uri
        if not allow_downscale or max(img.shape[:2]) <= 256:
            return uri
        img = downscale_to(img, int(max(img.shape[:2]) * 0.8))


def _retry_after(resp: httpx.Response) -> float | None:
    """Seconds to wait before retrying a 429 (``retry_after`` in the body, else the header)."""
    value: Any = None
    try:
        body = resp.json()
        value = body.get("retry_after") if isinstance(body, dict) else None
    except ValueError:
        pass
    if value is None:
        value = resp.headers.get("retry-after")
    try:
        return min(max(float(value), 0.0), 60.0) + 0.5
    except (TypeError, ValueError):
        return None


class ReplicateClient:
    """Minimal Replicate predictions client (create with ``Prefer: wait``, then poll)."""

    def __init__(
        self, token: str, timeout_s: float, *, poll_interval_s: float = 1.0, client: httpx.Client | None = None
    ) -> None:
        self._client = client or httpx.Client(timeout=httpx.Timeout(90.0, connect=10.0))
        self._headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
        self.timeout_s = timeout_s
        self.poll_interval_s = poll_interval_s

    def run(self, version: str, inputs: dict[str, Any], *, model: str = "replicate", usd_per_s: float = 0.0) -> Any:
        """Run a prediction to completion and return its ``output``.

        Every prediction that was created is recorded (REPLICATE_CALL log + the request's
        processing trace) with its billed prediction time, whether it succeeded or not.
        """
        start = time.monotonic()
        seen: list[dict[str, Any]] = []  # states of the prediction, once it exists
        try:
            return self._run(version, inputs, start + self.timeout_s, seen)
        finally:
            if seen:
                prediction = seen[-1]
                predict_time = (prediction.get("metrics") or {}).get("predict_time")
                status = prediction.get("status") or "unknown"
                record_replicate_call(
                    model=model,
                    version=version,
                    predict_time_s=float(predict_time) if isinstance(predict_time, int | float) else None,
                    usd_per_s=usd_per_s,
                    duration_ms=round((time.monotonic() - start) * 1000),
                    status=status if status in TERMINAL else "timeout",
                )

    def _run(self, version: str, inputs: dict[str, Any], deadline: float, seen: list[dict[str, Any]]) -> Any:
        try:
            while True:
                resp = self._client.post(
                    API_URL,
                    json={"version": version, "input": inputs},
                    headers={**self._headers, "Prefer": "wait=60"},
                )
                # Accounts under $5 of credit get 6 predictions/minute: wait as told, within the deadline.
                wait = _retry_after(resp) if resp.status_code == 429 else None
                if wait is None or time.monotonic() + wait > deadline:
                    break
                log.info("replicate_throttled", extra={"retry_after_s": wait})
                time.sleep(wait)
            if resp.status_code >= 400:
                raise backend_failed(f"Replicate create failed: HTTP {resp.status_code} {resp.text[:300]}")
            prediction = resp.json()
            seen.append(prediction)
            while prediction.get("status") not in TERMINAL:
                if time.monotonic() > deadline:
                    self._cancel(prediction)
                    raise backend_failed("Replicate prediction timed out")
                time.sleep(self.poll_interval_s)
                get_url = (prediction.get("urls") or {}).get("get")
                if not get_url:
                    raise backend_failed("Replicate prediction has no urls.get")
                poll = self._client.get(get_url, headers=self._headers)
                if poll.status_code >= 500 or poll.status_code == 429:
                    continue  # transient; keep polling until the deadline
                if poll.status_code >= 400:
                    raise backend_failed(f"Replicate poll failed: HTTP {poll.status_code}")
                prediction = poll.json()
                seen.append(prediction)
        except httpx.HTTPError as exc:
            raise backend_failed(f"Replicate request error: {exc}") from exc
        if prediction.get("status") != "succeeded":
            raise backend_failed(f"Replicate prediction {prediction.get('status')}: {prediction.get('error')}")
        return prediction.get("output")

    def _cancel(self, prediction: dict[str, Any]) -> None:
        cancel_url = (prediction.get("urls") or {}).get("cancel")
        if cancel_url:
            try:
                self._client.post(cancel_url, headers=self._headers)
            except httpx.HTTPError:
                pass

    def fetch_image(self, output: Any) -> Image.Image:
        """Download the (first) output file; accepts a URL, a data URI, or a list of them."""
        if isinstance(output, list):
            output = output[0] if output else None
        if isinstance(output, dict):  # some models return {"image": url, ...}
            output = next((v for v in output.values() if isinstance(v, str)), None)
        if not isinstance(output, str):
            raise backend_failed(f"Unexpected Replicate output: {type(output).__name__}")
        try:
            if output.startswith("data:"):
                data = base64.b64decode(output.split(",", 1)[1])
            else:
                resp = self._client.get(output, follow_redirects=True)
                resp.raise_for_status()
                data = resp.content
            img = Image.open(io.BytesIO(data))
            img.load()
            return img
        except (httpx.HTTPError, OSError, ValueError) as exc:
            raise backend_failed(f"Could not read Replicate output: {exc}") from exc

    def close(self) -> None:
        self._client.close()


class ReplicateSegmenter(Segmenter):
    in_process = False  # every call costs money: no optional extra calls

    def __init__(self, client: ReplicateClient, version: str, *, usd_per_s: float = 0.0) -> None:
        self.client = client
        self.version = version
        self.usd_per_s = usd_per_s
        self.name = f"BiRefNet@replicate:{version}"

    def predict(self, rgb: np.ndarray) -> np.ndarray:
        small = downscale_to(rgb, SEGMENT_LONG_SIDE)
        # JPEG keeps real photos under the data-URI limit; the mask is resized to full size later.
        output = self.client.run(
            self.version, {"image": jpeg_data_uri(small)}, model=BIREFNET_MODEL, usd_per_s=self.usd_per_s
        )
        img = self.client.fetch_image(output)
        has_alpha = img.mode in ("RGBA", "LA", "PA") or (img.mode == "P" and "transparency" in img.info)
        if has_alpha:
            mask = np.asarray(img.convert("RGBA").getchannel("A"))
        else:
            mask = np.asarray(img.convert("L"))
        return (mask.astype(np.float32) / 255.0).clip(0.0, 1.0)


class ReplicateUpscaler(Upscaler):
    is_ai = True

    def __init__(self, client: ReplicateClient, version: str, *, usd_per_s: float = 0.0) -> None:
        self.client = client
        self.version = version
        self.usd_per_s = usd_per_s

    def model_name(self, scale: UpscaleFactor) -> str:
        return f"RealESRGAN@replicate:{self.version}"

    def upscale(self, rgb: np.ndarray, scale: UpscaleFactor) -> np.ndarray:
        # Never shrink what we're about to enlarge; only trade JPEG quality for size.
        inputs = {"image": jpeg_data_uri(rgb, allow_downscale=False), "scale": scale, "face_enhance": False}
        output = self.client.run(self.version, inputs, model=ESRGAN_MODEL, usd_per_s=self.usd_per_s)
        img = self.client.fetch_image(output)
        out = np.asarray(img.convert("RGB"), dtype=np.uint8)
        return ensure_scale(rgb, out, scale)


def build_replicate_backend(cfg: ServiceConfig) -> Backend:
    assert cfg.replicate_api_token and cfg.replicate_birefnet_version and cfg.replicate_esrgan_version
    client = ReplicateClient(cfg.replicate_api_token, cfg.replicate_timeout_s)
    segmenter = ReplicateSegmenter(client, cfg.replicate_birefnet_version, usd_per_s=cfg.replicate_birefnet_usd_per_s)
    upscaler = ReplicateUpscaler(client, cfg.replicate_esrgan_version, usd_per_s=cfg.replicate_esrgan_usd_per_s)
    return Backend(
        kind="replicate",
        device="cpu",
        segmenter=segmenter,
        upscaler=upscaler,
        models_loaded=["segmentation", "upscaler_x2", "upscaler_x4"],
        closers=[client.close],
    )
