"""Synthetic test images and encoding helpers (no network, deterministic)."""

from __future__ import annotations

import io

import cv2
import numpy as np
from PIL import Image

SECRET = "test-secret"


# --------------------------------------------------------------------------------------
# Synthetic images
# --------------------------------------------------------------------------------------
def product_on_white(width: int = 1000, height: int = 800, bg: int = 247) -> np.ndarray:
    """A red disc + blue block product, off-centre, on a near-white background."""
    img = np.full((height, width, 3), bg, np.uint8)
    cx, cy = int(width * 0.68), int(height * 0.42)
    r = int(min(width, height) * 0.2)
    cv2.circle(img, (cx, cy), r, (200, 40, 40), -1, cv2.LINE_AA)
    cv2.rectangle(img, (cx - r // 2, cy + r // 2), (cx + r // 2, cy + int(r * 1.5)), (40, 60, 180), -1)
    return img


def product_bbox_on_white(width: int = 1000, height: int = 800) -> tuple[int, int, int, int]:
    """Ground-truth bbox (x0, y0, x1, y1) of :func:`product_on_white`."""
    cx, cy = int(width * 0.68), int(height * 0.42)
    r = int(min(width, height) * 0.2)
    return cx - r, cy - r, cx + r + 1, cy + int(r * 1.5) + 1


def tall_product(width: int = 600, height: int = 900) -> np.ndarray:
    img = np.full((height, width, 3), 250, np.uint8)
    cv2.rectangle(img, (250, 80), (330, 820), (30, 120, 60), -1)  # bottle-like
    cv2.ellipse(img, (290, 80), (40, 25), 0, 0, 360, (30, 120, 60), -1)
    return img


def text_image(width: int = 900, height: int = 700) -> np.ndarray:
    img = product_on_white(width, height)
    cv2.putText(img, "SALE 50% OFF", (30, 90), cv2.FONT_HERSHEY_SIMPLEX, 2.0, (0, 0, 0), 5, cv2.LINE_AA)
    return img


def to_bytes(img: np.ndarray, fmt: str = "JPEG", **save_kwargs: object) -> bytes:
    buf = io.BytesIO()
    mode = "RGBA" if img.ndim == 3 and img.shape[2] == 4 else ("L" if img.ndim == 2 else "RGB")
    Image.fromarray(img, mode).save(buf, fmt, **save_kwargs)
    return buf.getvalue()


def decode(data: bytes) -> Image.Image:
    img = Image.open(io.BytesIO(data))
    img.load()
    return img
