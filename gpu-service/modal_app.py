"""Modal deployment: the same FastAPI app on a GPU, weights baked into the image.

Deploy from this directory:

    modal secret create gpu-service-secret GPU_SERVICE_SECRET=<shared secret>
    MODAL_GPU=L4 MODAL_MIN_CONTAINERS=0 modal deploy modal_app.py

Deploy-time configuration (environment of the ``modal deploy`` process):

    MODAL_APP_NAME             app name                              (visual-image-optimizer-gpu)
    MODAL_GPU                  GPU type, e.g. L4, A10G, L40S          (L4)
    MODAL_SECRET_NAME          Modal secret with GPU_SERVICE_SECRET   (gpu-service-secret)
    MODAL_MIN_CONTAINERS       warm containers outside busy hours     (0)
    MODAL_BUSY_MIN_CONTAINERS  warm containers during busy hours      (1)
    MODAL_BUSY_HOURS_UTC       busy window "start-end" in UTC hours, e.g. "13-23"; empty = off
    MODAL_MAX_INPUTS           concurrent requests per container      (4)
    MODAL_SCALEDOWN_S          idle seconds before a container stops  (300)
    BIREFNET_REVISION          BiRefNet commit to bake in (pin it!)   (main)

Service env vars (MAX_CONCURRENCY, thresholds, ALLOWED_URL_HOSTS, ...) can be added to the
same Modal secret; see README.md.
"""

from __future__ import annotations

import os
from datetime import UTC, datetime
from pathlib import Path

import modal

HERE = Path(__file__).parent

APP_NAME = os.environ.get("MODAL_APP_NAME", "visual-image-optimizer-gpu")
GPU = os.environ.get("MODAL_GPU", "L4")
SECRET_NAME = os.environ.get("MODAL_SECRET_NAME", "gpu-service-secret")
MIN_CONTAINERS = int(os.environ.get("MODAL_MIN_CONTAINERS", "0"))
BUSY_MIN_CONTAINERS = int(os.environ.get("MODAL_BUSY_MIN_CONTAINERS", "1"))
BUSY_HOURS_UTC = os.environ.get("MODAL_BUSY_HOURS_UTC", "")
MAX_INPUTS = int(os.environ.get("MODAL_MAX_INPUTS", "4"))
SCALEDOWN_S = int(os.environ.get("MODAL_SCALEDOWN_S", "300"))
BIREFNET_REVISION = os.environ.get("BIREFNET_REVISION", "main")

EAST_URL = "https://www.dropbox.com/s/r2ingd0l3zt8hxs/frozen_east_text_detection.tar.gz?dl=1"
EAST_SHA256 = "9b486f3c3eee77b4c8cc91a83892c37026cca7d29b79bf3b93772ccd2db58454"
X4_URL = "https://github.com/xinntao/Real-ESRGAN/releases/download/v0.1.0/RealESRGAN_x4plus.pth"
X4_SHA256 = "4fa0d38905f75ac06eb49a7951b426670021be3018265fd191d2125df9d682f1"
X2_URL = "https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.1/RealESRGAN_x2plus.pth"
X2_SHA256 = "49fafd45f8fd7aa8d31ab2a22d14d91b536c34494a5cfe31eb5d89c2fa266abb"

image = (
    modal.Image.from_registry("nvidia/cuda:12.4.1-cudnn-runtime-ubuntu22.04", add_python="3.11")
    .apt_install("curl", "ca-certificates", "libgomp1")
    .add_local_file(HERE / "requirements.txt", "/build/requirements.txt", copy=True)
    .add_local_file(HERE / "requirements-gpu.txt", "/build/requirements-gpu.txt", copy=True)
    .run_commands("pip install --no-cache-dir -r /build/requirements-gpu.txt")
    .env({"MODELS_DIR": "/models", "HF_HOME": "/models/hf", "BIREFNET_REVISION": BIREFNET_REVISION})
    .run_commands(
        "mkdir -p /models",
        f"curl -fsSL --retry 3 -o /models/RealESRGAN_x4plus.pth {X4_URL}",
        f"echo '{X4_SHA256}  /models/RealESRGAN_x4plus.pth' | sha256sum -c -",
        f"curl -fsSL --retry 3 -o /models/RealESRGAN_x2plus.pth {X2_URL}",
        f"echo '{X2_SHA256}  /models/RealESRGAN_x2plus.pth' | sha256sum -c -",
        f"curl -fsSL --retry 3 -o /tmp/east.tar.gz '{EAST_URL}'",
        "tar -xzf /tmp/east.tar.gz -C /models frozen_east_text_detection.pb && rm /tmp/east.tar.gz",
        f"echo '{EAST_SHA256}  /models/frozen_east_text_detection.pb' | sha256sum -c -",
        'python -c "from huggingface_hub import snapshot_download; '
        f"snapshot_download('ZhengPeng7/BiRefNet', revision='{BIREFNET_REVISION}')\"",
    )
    .env(
        {
            "MODEL_BACKEND": "local",
            "EAST_MODEL_PATH": "/models/frozen_east_text_detection.pb",
            "HF_HUB_OFFLINE": "1",
            "TRANSFORMERS_OFFLINE": "1",
        }
    )
    .add_local_python_source("app")
)

# The scheduler needs the deploy-time settings inside its own container.
scheduler_image = modal.Image.debian_slim(python_version="3.11").env(
    {
        "MODAL_APP_NAME": APP_NAME,
        "MODAL_MIN_CONTAINERS": str(MIN_CONTAINERS),
        "MODAL_BUSY_MIN_CONTAINERS": str(BUSY_MIN_CONTAINERS),
        "MODAL_BUSY_HOURS_UTC": BUSY_HOURS_UTC,
    }
)

app = modal.App(APP_NAME)


@app.function(
    image=image,
    gpu=GPU,
    secrets=[modal.Secret.from_name(SECRET_NAME)],
    min_containers=MIN_CONTAINERS,
    scaledown_window=SCALEDOWN_S,
    timeout=600,
)
@modal.concurrent(max_inputs=MAX_INPUTS)
@modal.asgi_app()
def web():  # type: ignore[no-untyped-def]
    """Serve the FastAPI app; models load once per container in the app lifespan."""
    from app.main import create_app

    return create_app()


def _in_busy_window(hour: int, window: str) -> bool:
    start, end = (int(part) for part in window.split("-", 1))
    return start <= hour < end if start <= end else (hour >= start or hour < end)


@app.function(image=scheduler_image, schedule=modal.Cron("*/15 * * * *"))
def adjust_warm_pool() -> None:
    """Keep ``MODAL_BUSY_MIN_CONTAINERS`` warm during ``MODAL_BUSY_HOURS_UTC``, else the base."""
    window = os.environ.get("MODAL_BUSY_HOURS_UTC", "")
    if not window:
        return
    busy = _in_busy_window(datetime.now(UTC).hour, window)
    target = int(os.environ["MODAL_BUSY_MIN_CONTAINERS" if busy else "MODAL_MIN_CONTAINERS"])
    fn = modal.Function.from_name(os.environ["MODAL_APP_NAME"], "web")
    fn.update_autoscaler(min_containers=target)
    print(f"warm pool → {target} (busy={busy})")
