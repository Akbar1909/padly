"""Local GPU backend: BiRefNet (transformers remote code) + Real-ESRGAN x2/x4 via spandrel.

torch / transformers / spandrel are imported lazily inside this module's functions so the
service (and the test-suite) import cleanly without the GPU requirements installed.
"""

from __future__ import annotations

import logging
import math
from pathlib import Path
from typing import TYPE_CHECKING, Any

import cv2
import numpy as np

from .base import Backend, Segmenter, UpscaleFactor, Upscaler

if TYPE_CHECKING:  # pragma: no cover
    from ..config import ServiceConfig

log = logging.getLogger(__name__)

IMAGENET_MEAN = (0.485, 0.456, 0.406)
IMAGENET_STD = (0.229, 0.224, 0.225)


def detect_device(preference: str = "auto") -> str:
    """cuda → mps → cpu (or the explicit preference)."""
    import torch

    if preference != "auto":
        return preference
    if torch.cuda.is_available():
        return "cuda"
    mps = getattr(torch.backends, "mps", None)
    if mps is not None and mps.is_available():
        return "mps"
    return "cpu"


class BiRefNetSegmenter(Segmenter):
    """``ZhengPeng7/BiRefNet``: 1024x1024 input, ImageNet normalisation, ``model(x)[-1].sigmoid()``."""

    in_process = True
    supports_input_size = True

    def __init__(self, model_id: str, revision: str, device: str, input_size: int = 1024) -> None:
        import torch
        from transformers import AutoModelForImageSegmentation

        self._torch = torch
        torch.set_float32_matmul_precision("high")
        self.device = torch.device(device)
        self.dtype = torch.float16 if device == "cuda" else torch.float32
        self.input_size = input_size
        model = AutoModelForImageSegmentation.from_pretrained(model_id, trust_remote_code=True, revision=revision)
        model.to(self.device)
        model.eval()
        if self.dtype == torch.float16:
            model.half()
        self.model = model
        commit = getattr(getattr(model, "config", None), "_commit_hash", None)
        self.revision = str(commit or revision)
        self.name = f"{model_id}@{self.revision}"
        self._mean = torch.tensor(IMAGENET_MEAN, device=self.device).view(1, 3, 1, 1)
        self._std = torch.tensor(IMAGENET_STD, device=self.device).view(1, 3, 1, 1)

    def predict(self, rgb: np.ndarray) -> np.ndarray:
        return self._predict(rgb, self.input_size)

    def predict_at(self, rgb: np.ndarray, input_size: int) -> np.ndarray:
        return self._predict(rgb, input_size)

    def _predict(self, rgb: np.ndarray, input_size: int) -> np.ndarray:
        torch = self._torch
        size = (input_size, input_size)
        shrinking = rgb.shape[0] * rgb.shape[1] > size[0] * size[1]
        resized = cv2.resize(rgb, size, interpolation=cv2.INTER_AREA if shrinking else cv2.INTER_LINEAR)
        x = torch.from_numpy(np.ascontiguousarray(resized)).to(self.device)
        x = x.permute(2, 0, 1).unsqueeze(0).float().div_(255.0)
        x = ((x - self._mean) / self._std).to(self.dtype)
        with torch.inference_mode():
            pred = self.model(x)[-1].sigmoid()
        # Out-of-place: on CPU/MPS (fp32) .float() is a no-op, and an in-place op on an
        # inference tensor outside inference mode raises.
        return pred[0, 0].float().clamp(0, 1).cpu().numpy().astype(np.float32)

    def close(self) -> None:
        del self.model
        if self.device.type == "cuda":
            self._torch.cuda.empty_cache()


class RealESRGANUpscaler(Upscaler):
    """Real-ESRGAN ``RealESRGAN_x2plus`` / ``RealESRGAN_x4plus`` loaded with spandrel, with tiled
    inference (``tile`` px input tiles, ``tile_pad`` px overlap) so large images fit in memory."""

    is_ai = True

    def __init__(self, weights: dict[int, Path], device: str, tile: int = 512, tile_pad: int = 32) -> None:
        import torch
        from spandrel import ImageModelDescriptor, ModelLoader

        self._torch = torch
        self.device = torch.device(device)
        self.tile = tile
        self.tile_pad = tile_pad
        self.models: dict[int, Any] = {}
        self.names: dict[int, str] = {}
        self.dtypes: dict[int, Any] = {}
        for scale, path in weights.items():
            if not path.is_file():
                raise FileNotFoundError(f"Real-ESRGAN x{scale} weights not found at {path}")
            descriptor = ModelLoader(device=self.device).load_from_file(str(path))
            if not isinstance(descriptor, ImageModelDescriptor):
                raise TypeError(f"{path} is not an image-to-image model")
            if descriptor.scale != scale:
                raise ValueError(f"{path} has scale {descriptor.scale}, expected {scale}")
            descriptor.to(self.device).eval()
            dtype = torch.float32
            if device == "cuda" and descriptor.supports_half:
                descriptor.half()
                dtype = torch.float16
            self.models[scale] = descriptor
            self.dtypes[scale] = dtype
            self.names[scale] = path.stem  # "RealESRGAN_x2plus"

    def model_name(self, scale: UpscaleFactor) -> str:
        return self.names[scale]

    def _run(self, descriptor: Any, x: Any, dtype: Any) -> Any:
        """Run one tile, padding to the model's size requirements and cropping back."""
        torch = self._torch
        req = getattr(descriptor, "size_requirements", None)
        multiple = int(getattr(req, "multiple_of", 1) or 1)
        minimum = int(getattr(req, "minimum", 0) or 0)
        _, _, h, w = x.shape
        ph = max(minimum, math.ceil(h / multiple) * multiple) - h
        pw = max(minimum, math.ceil(w / multiple) * multiple) - w
        if ph or pw:
            mode = "reflect" if ph < h and pw < w else "replicate"
            x = torch.nn.functional.pad(x, (0, pw, 0, ph), mode=mode)
        out = descriptor.model(x.to(dtype))
        s = descriptor.scale
        return out[:, :, : h * s, : w * s]

    def upscale(self, rgb: np.ndarray, scale: UpscaleFactor) -> np.ndarray:
        torch = self._torch
        descriptor = self.models[scale]
        dtype = self.dtypes[scale]
        img = torch.from_numpy(np.ascontiguousarray(rgb)).permute(2, 0, 1).unsqueeze(0)  # uint8, CPU
        _, _, h, w = img.shape
        out = np.empty((h * scale, w * scale, 3), dtype=np.uint8)  # assembled on the CPU
        tile = self.tile if self.tile > 0 else max(h, w)
        pad = self.tile_pad
        with torch.inference_mode():
            for y0 in range(0, h, tile):
                for x0 in range(0, w, tile):
                    y1, x1 = min(y0 + tile, h), min(x0 + tile, w)
                    py0, px0 = max(y0 - pad, 0), max(x0 - pad, 0)
                    py1, px1 = min(y1 + pad, h), min(x1 + pad, w)
                    tile_in = img[:, :, py0:py1, px0:px1].to(self.device).float().div_(255.0)
                    tile_out = self._run(descriptor, tile_in, dtype)[0]
                    oy, ox = (y0 - py0) * scale, (x0 - px0) * scale
                    core = tile_out[:, oy : oy + (y1 - y0) * scale, ox : ox + (x1 - x0) * scale]
                    core = core.float().clamp_(0, 1).mul_(255.0).round_().to(torch.uint8)
                    out[y0 * scale : y1 * scale, x0 * scale : x1 * scale] = core.permute(1, 2, 0).cpu().numpy()
        return out

    def close(self) -> None:
        self.models.clear()
        if self.device.type == "cuda":
            self._torch.cuda.empty_cache()


def build_local_backend(cfg: ServiceConfig) -> Backend:
    """Load BiRefNet and both Real-ESRGAN models once (called from the app lifespan)."""
    device = detect_device(cfg.device)
    log.info("loading_local_models", extra={"device": device})
    segmenter = BiRefNetSegmenter(cfg.birefnet_model_id, cfg.birefnet_revision, device, cfg.birefnet_input_size)
    upscaler = RealESRGANUpscaler(
        {2: cfg.x2_weights, 4: cfg.x4_weights},
        device,
        tile=cfg.upscale_tile_size,
        tile_pad=cfg.upscale_tile_pad,
    )
    log.info("local_models_loaded", extra={"segmentation": segmenter.name, "device": device})
    return Backend(
        kind="local",
        device=device,
        segmenter=segmenter,
        upscaler=upscaler,
        models_loaded=["segmentation", "upscaler_x2", "upscaler_x4"],
    )
