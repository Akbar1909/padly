"""Local (torch) backend. Skipped where torch isn't installed, like the default test venv."""

from __future__ import annotations

import numpy as np
import pytest

torch = pytest.importorskip("torch")

from app.backends.local import BiRefNetSegmenter  # noqa: E402


def test_segmenter_returns_mask_on_cpu_fp32() -> None:
    """Regression: on CPU/MPS the model output is an fp32 inference tensor, so the
    post-processing must not modify it in place."""
    seg = BiRefNetSegmenter.__new__(BiRefNetSegmenter)
    seg._torch = torch
    seg.device = torch.device("cpu")
    seg.dtype = torch.float32
    seg.input_size = 64
    seg._mean = torch.zeros(1, 3, 1, 1)
    seg._std = torch.ones(1, 3, 1, 1)
    seg.model = lambda x: [torch.randn(1, 1, 64, 64) * 4]  # logits, like BiRefNet's last output

    mask = seg.predict(np.zeros((120, 90, 3), dtype=np.uint8))

    assert mask.shape == (64, 64) and mask.dtype == np.float32
    assert 0.0 <= float(mask.min()) and float(mask.max()) <= 1.0
