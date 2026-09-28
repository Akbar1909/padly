"""Backend interfaces: the pipeline only talks to :class:`Segmenter` and :class:`Upscaler`."""

from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Literal

import cv2
import numpy as np

BackendKind = Literal["local", "replicate", "classic"]
UpscaleFactor = Literal[2, 4]


class Segmenter(ABC):
    """Foreground (product) segmentation."""

    #: Identifier reported in ``models.segmentation`` (e.g. ``ZhengPeng7/BiRefNet@<rev>``).
    name: str
    #: True when a call runs in this process at no per-call cost (local GPU / classic).
    #: The pipeline only makes "optional" extra calls (e.g. for bbox refinement when the
    #: background is kept) on in-process segmenters.
    in_process: bool
    #: True when :meth:`predict_at` can run the model at another input size.
    supports_input_size: bool = False

    @abstractmethod
    def predict(self, rgb: np.ndarray) -> np.ndarray:
        """Return a float32 foreground probability mask in [0, 1].

        ``rgb`` is sRGB uint8 HxWx3. The mask is returned at the backend's *model
        resolution* (any size; e.g. 1024x1024 for BiRefNet) — the pipeline resizes it to the
        image and measures edge uncertainty on this native-resolution mask.
        """

    def predict_at(self, rgb: np.ndarray, input_size: int) -> np.ndarray | None:
        """The same model run at another input size (a second opinion on a cut-out), or None
        when the backend can't do that (the default)."""
        return None

    def close(self) -> None:  # noqa: B027 - optional hook, no-op by default
        """Release resources."""


class Upscaler(ABC):
    """Super-resolution by an integer factor."""

    #: True when this is a trained model (AI upscaling that is billed / needs XMP disclosure).
    is_ai: bool

    @abstractmethod
    def model_name(self, scale: UpscaleFactor) -> str:
        """Identifier reported in ``models.upscaler`` for the given factor."""

    @abstractmethod
    def upscale(self, rgb: np.ndarray, scale: UpscaleFactor) -> np.ndarray:
        """Return ``rgb`` (uint8 HxWx3) enlarged by exactly ``scale`` in each dimension."""

    def close(self) -> None:  # noqa: B027 - optional hook, no-op by default
        """Release resources."""


@dataclass
class Backend:
    """A configured backend: segmentation + upscaling implementations."""

    kind: BackendKind
    device: str
    segmenter: Segmenter
    upscaler: Upscaler
    models_loaded: list[str] = field(default_factory=list)
    closers: list[Callable[[], None]] = field(default_factory=list)

    def close(self) -> None:
        self.segmenter.close()
        self.upscaler.close()
        for closer in self.closers:
            closer()


def ensure_scale(rgb: np.ndarray, out: np.ndarray, scale: int) -> np.ndarray:
    """Force ``out`` to exactly ``scale``× the input size (remote models may round)."""
    want = (rgb.shape[1] * scale, rgb.shape[0] * scale)
    if (out.shape[1], out.shape[0]) == want:
        return out
    interp = cv2.INTER_AREA if out.shape[1] > want[0] else cv2.INTER_LANCZOS4
    return cv2.resize(out, want, interpolation=interp)
