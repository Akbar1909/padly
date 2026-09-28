"""Model backends. Heavy dependencies are imported only for the selected backend."""

from __future__ import annotations

from ..config import ServiceConfig
from .base import Backend, Segmenter, Upscaler


def build_backend(cfg: ServiceConfig) -> Backend:
    """Instantiate (and load models for) the backend selected by ``MODEL_BACKEND``."""
    if cfg.model_backend == "local":
        from .local import build_local_backend

        return build_local_backend(cfg)
    if cfg.model_backend == "replicate":
        from .replicate import build_replicate_backend

        return build_replicate_backend(cfg)
    from .classic import build_classic_backend

    return build_classic_backend()


__all__ = ["Backend", "Segmenter", "Upscaler", "build_backend"]
