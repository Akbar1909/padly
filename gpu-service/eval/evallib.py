"""Shared helpers for the evaluation set (``fetch.py``, ``run.py``): paths, manifest and
labels, the production-like service configuration, and the machine-wide compute-slot lock.

Nothing here is imported by the service itself.
"""

from __future__ import annotations

import fcntl
import json
import os
import sys
import time
from pathlib import Path
from typing import Any

EVAL_DIR = Path(__file__).resolve().parent
SERVICE_DIR = EVAL_DIR.parent  # gpu-service/
REPO_DIR = SERVICE_DIR.parent
MANIFEST = EVAL_DIR / "manifest.json"
LABELS = EVAL_DIR / "labels.json"

if str(SERVICE_DIR) not in sys.path:
    sys.path.insert(0, str(SERVICE_DIR))

# The request every expected_no_change / label in this set refers to (the app's default preset:
# app/lib/presets.ts DEFAULT_PRESET).
REQUEST: dict[str, Any] = {
    "aspect": "1:1",
    "margin_pct": 8,
    "remove_bg": True,
    "bg_color": "#FFFFFF",
    "upscale": False,
    "upscale_threshold_px": 1200,
    "target_px": 2048,
    "output_format": "jpeg",
    "jpeg_quality": 90,
}

SLOTS = 3  # at most three heavy model runs on this machine at once (RAM / CPU)


def default_cache() -> Path:
    return Path(os.environ.get("PADLY_EVAL_CACHE") or Path.home() / ".cache" / "padly-eval").expanduser()


def load_manifest() -> list[dict[str, Any]]:
    return json.loads(MANIFEST.read_text())["images"]


def load_labels() -> dict[str, dict[str, Any]]:
    if not LABELS.exists():
        return {}
    return {row["id"]: row for row in json.loads(LABELS.read_text())["labels"]}


def image_path(cache: Path, entry: dict[str, Any]) -> Path:
    return cache / "images" / entry["file"]


def ref_path(cache: Path, image_id: str) -> Path:
    """Cached reference cut-out of the paid model (Replicate full BiRefNet) for the whole photo."""
    return cache / "refs" / f"{image_id}.npy"


def labelmask_path(cache: Path, image_id: str, which: str) -> Path:
    """The cut-out a label was given for (``which`` = "local" | "paid"), as the service's own
    640 px mask artifact (RGBA PNG, background tinted, product transparent)."""
    return cache / "labelmasks" / f"{image_id}.{which}.png"


def select(entries: list[dict[str, Any]], only: str | None) -> list[dict[str, Any]]:
    if not only:
        return entries
    wanted = {x.strip() for x in only.split(",") if x.strip()}
    unknown = wanted - {e["id"] for e in entries}
    if unknown:
        raise SystemExit(f"unknown ids: {', '.join(sorted(unknown))}")
    return [e for e in entries if e["id"] in wanted]


def eval_config(models_dir: Path | None = None, **overrides: Any):  # -> ServiceConfig
    """The production CPU configuration (docker-compose.vps.yml + Dockerfile.cpu-ml): local
    BiRefNet-lite at 512 px, Real-ESRGAN x2 only for <= 0.25 MP, the same input caps.

    Quality thresholds are not set here, so they come from the ServiceConfig defaults or from
    the environment exactly as in the service (e.g. ESCALATE_FLIP_DISAGREEMENT=0.02 to try a
    different gate). The escalation backend is injected by run.py (a cached fake), so it is
    "none" here and no Replicate token is needed.
    """
    from app.config import ServiceConfig

    kwargs: dict[str, Any] = {
        "model_backend": "local",
        "escalation_backend": "none",
        "fallback_backend": "none",
        "device": "cpu",
        "allow_unsigned": True,
        "local_max_ai_scale": 2,
        "local_max_ai_upscale_pixels": 250_000,
        "upscale_tile_size": 128,
        "upscale_tile_pad": 16,
        "max_source_pixels": 30_000_000,
        "max_working_pixels": 16_000_000,
        "max_source_bytes": 26_214_400,
        "fallback_cooldown_s": 0,  # every image is judged on its own (no provider outage here)
        "escalation_daily_max_calls": 0,
    }
    if models_dir is not None:
        kwargs.update(
            models_dir=models_dir,
            birefnet_model_id=str(models_dir / "birefnet"),
            birefnet_input_size=int(os.environ.get("BIREFNET_INPUT_SIZE", "512")),
            east_model_path=models_dir / "frozen_east_text_detection.pb",
        )
    kwargs.update(overrides)
    return ServiceConfig(**kwargs)


class ComputeSlot:
    """One of ``SLOTS`` machine-wide slots (flock on ``<slot_dir>/.sweep-slot-<i>.lock``, the
    same files the scratch sweep scripts use), held while models are loaded."""

    def __init__(self, slot_dir: Path, slots: int = SLOTS) -> None:
        self.slot_dir = slot_dir
        self.slots = slots
        self._f = None

    def __enter__(self) -> ComputeSlot:
        self.slot_dir.mkdir(parents=True, exist_ok=True)
        waited = False
        while True:
            for i in range(self.slots):
                f = open(self.slot_dir / f".sweep-slot-{i}.lock", "w")  # noqa: SIM115 - held until exit
                try:
                    fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    self._f = f
                    if waited:
                        print(json.dumps({"slot": i, "acquired": True}), flush=True)
                    return self
                except BlockingIOError:
                    f.close()
            if not waited:
                print(json.dumps({"waiting_for_compute_slot": str(self.slot_dir)}), flush=True)
                waited = True
            time.sleep(10)

    def __exit__(self, *exc: object) -> None:
        if self._f is not None:
            fcntl.flock(self._f, fcntl.LOCK_UN)
            self._f.close()
            self._f = None
