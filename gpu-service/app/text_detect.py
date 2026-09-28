"""Text / label detection used as a guardrail before AI upscaling.

Primary: OpenCV EAST (``frozen_east_text_detection.pb``). Fallback when the model file is
missing: MSER regions filtered to character-like shapes and grouped into text lines.
"""

from __future__ import annotations

import logging
import math
import threading
from abc import ABC, abstractmethod
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np

from .ops import downscale_to

log = logging.getLogger(__name__)

EAST_OUTPUTS = ["feature_fusion/Conv_7/Sigmoid", "feature_fusion/concat_3"]
EAST_MEAN = (123.68, 116.78, 103.94)  # RGB means used to train EAST


Rect = tuple[int, int, int, int]  # x, y, width, height in the detected image's pixels


@dataclass(frozen=True)
class TextResult:
    found: bool
    boxes: int  # detected text boxes (EAST) or text lines (MSER heuristic)
    # Axis-aligned boxes of that text, so a cut-out can be checked for dropped labels/logos.
    rects: tuple[Rect, ...] = ()


class TextDetector(ABC):
    name: str

    @abstractmethod
    def detect(self, rgb: np.ndarray) -> TextResult:
        """Detect text in an sRGB uint8 HxWx3 image."""


# --------------------------------------------------------------------------------------
# EAST
# --------------------------------------------------------------------------------------
def decode_east(scores: np.ndarray, geometry: np.ndarray, min_confidence: float) -> tuple[list, list[float]]:
    """Vectorised decoding of EAST outputs into rotated rects ``((cx, cy), (w, h), angle)``."""
    score_map = scores[0, 0]
    ys, xs = np.nonzero(score_map >= min_confidence)
    if ys.size == 0:
        return [], []
    geo = geometry[0]
    d0, d1, d2, d3 = (geo[i, ys, xs] for i in range(4))
    angle = geo[4, ys, xs]
    cos, sin = np.cos(angle), np.sin(angle)
    h = d0 + d2
    w = d1 + d3
    off_x = xs * 4.0 + cos * d1 + sin * d2
    off_y = ys * 4.0 - sin * d1 + cos * d2
    p1x, p1y = -sin * h + off_x, -cos * h + off_y
    p3x, p3y = -cos * w + off_x, sin * w + off_y
    cx, cy = (p1x + p3x) / 2.0, (p1y + p3y) / 2.0
    deg = -angle * 180.0 / math.pi
    rects = [((float(cx[i]), float(cy[i])), (float(w[i]), float(h[i])), float(deg[i])) for i in range(ys.size)]
    return rects, [float(c) for c in score_map[ys, xs]]


class EastTextDetector(TextDetector):
    name = "opencv-east"

    def __init__(
        self, model_path: Path, *, min_confidence: float = 0.5, nms_threshold: float = 0.4, long_side: int = 640
    ) -> None:
        self._net = cv2.dnn.readNet(str(model_path))
        self._lock = threading.Lock()  # cv2.dnn.Net is not safe for concurrent forward()
        self.min_confidence = min_confidence
        self.nms_threshold = nms_threshold
        self.long_side = long_side

    def detect(self, rgb: np.ndarray) -> TextResult:
        h, w = rgb.shape[:2]
        ratio = self.long_side / max(h, w)
        in_w = max(32, int(round(w * ratio / 32)) * 32)
        in_h = max(32, int(round(h * ratio / 32)) * 32)
        blob = cv2.dnn.blobFromImage(rgb, 1.0, (in_w, in_h), EAST_MEAN, swapRB=False, crop=False)
        with self._lock:
            self._net.setInput(blob)
            scores, geometry = self._net.forward(EAST_OUTPUTS)
        rects_rot, confidences = decode_east(scores, geometry, self.min_confidence)
        if not rects_rot:
            return TextResult(False, 0)
        try:
            keep = cv2.dnn.NMSBoxesRotated(rects_rot, confidences, self.min_confidence, self.nms_threshold)
        except cv2.error:  # fall back to axis-aligned NMS
            aabbs = [cv2.boundingRect(cv2.boxPoints(r).astype(np.float32)) for r in rects_rot]
            keep = cv2.dnn.NMSBoxes(aabbs, confidences, self.min_confidence, self.nms_threshold)
        kept = np.asarray(keep, dtype=np.int64).reshape(-1)
        sx, sy = w / in_w, h / in_h
        rects: list[Rect] = []
        for i in kept:
            x, y, bw, bh = cv2.boundingRect(cv2.boxPoints(rects_rot[int(i)]).astype(np.float32))
            rects.append((int(x * sx), int(y * sy), max(1, int(round(bw * sx))), max(1, int(round(bh * sy)))))
        return TextResult(kept.size > 0, int(kept.size), tuple(rects))


# --------------------------------------------------------------------------------------
# MSER heuristic
# --------------------------------------------------------------------------------------
class MserTextDetector(TextDetector):
    """Character-like MSER regions grouped into horizontal lines of ≥ ``min_chars``."""

    name = "mser-heuristic"

    def __init__(self, *, long_side: int = 1024, min_chars: int = 3) -> None:
        self.long_side = long_side
        self.min_chars = min_chars

    def _candidates(self, gray: np.ndarray) -> np.ndarray:
        h, w = gray.shape
        area = h * w
        mser = cv2.MSER_create(5, 20, int(area * 0.02))  # delta, min_area, max_area
        boxes: list[tuple[int, int, int, int]] = []
        for img in (gray, 255 - gray):  # dark-on-light and light-on-dark text
            regions, bboxes = mser.detectRegions(img)
            for pts, (x, y, bw, bh) in zip(regions, bboxes, strict=True):
                if bh < 8 or bh > 0.25 * h or bw < 2:
                    continue
                aspect = bw / bh
                if not 0.1 <= aspect <= 1.5:
                    continue
                fill = len(pts) / float(bw * bh)
                if not 0.15 <= fill <= 0.9:
                    continue
                # Glyphs are drawn with strokes much thinner than their height; solid blobs
                # (buttons, dots, pattern elements) are not.
                local = np.zeros((bh + 2, bw + 2), dtype=np.uint8)
                local[pts[:, 1] - y + 1, pts[:, 0] - x + 1] = 1
                stroke = 2.0 * float(cv2.distanceTransform(local, cv2.DIST_L2, 3).max())
                if stroke > 0.4 * bh:
                    continue
                boxes.append((x, y, bw, bh))
        if not boxes:
            return np.zeros((0, 4), dtype=np.int32)
        arr = np.array(boxes, dtype=np.int32)
        # Deduplicate nested / near-identical MSER boxes (MSER yields many per glyph).
        keep = cv2.dnn.NMSBoxes(arr.tolist(), [float(b[3]) for b in arr], 0.0, 0.5)
        return arr[np.asarray(keep, dtype=np.int64).reshape(-1)]

    @staticmethod
    def _group_lines(boxes: np.ndarray) -> list[list[int]]:
        """Union-find over boxes with similar height, aligned centres and small gaps."""
        n = len(boxes)
        parent = list(range(n))

        def find(i: int) -> int:
            while parent[i] != i:
                parent[i] = parent[parent[i]]
                i = parent[i]
            return i

        x, y, w, h = boxes[:, 0], boxes[:, 1], boxes[:, 2], boxes[:, 3]
        cy = y + h / 2.0
        order = np.argsort(x)
        for a_idx in range(n):
            a = order[a_idx]
            for b in order[a_idx + 1 :]:
                gap = x[b] - (x[a] + w[a])
                max_h = max(h[a], h[b])
                if gap > 1.2 * max_h:
                    break
                if gap < -0.3 * max_h:  # heavy overlap: nested glyph parts, not neighbours
                    continue
                if max_h / min(h[a], h[b]) > 1.8:
                    continue
                if abs(cy[a] - cy[b]) > 0.4 * max_h:
                    continue
                parent[find(int(a))] = find(int(b))
        groups: dict[int, list[int]] = {}
        for i in range(n):
            groups.setdefault(find(i), []).append(i)
        return list(groups.values())

    def detect(self, rgb: np.ndarray) -> TextResult:
        small = downscale_to(rgb, self.long_side)
        gray = cv2.cvtColor(small, cv2.COLOR_RGB2GRAY)
        boxes = self._candidates(gray)
        if len(boxes) < self.min_chars:
            return TextResult(False, 0)
        lines = [g for g in self._group_lines(boxes) if len(g) >= self.min_chars]
        f = rgb.shape[1] / small.shape[1]  # back to the input's pixels
        rects: list[Rect] = []
        for line in lines:
            b = boxes[line]
            x0, y0 = int(b[:, 0].min()), int(b[:, 1].min())
            x1, y1 = int((b[:, 0] + b[:, 2]).max()), int((b[:, 1] + b[:, 3]).max())
            rects.append((int(x0 * f), int(y0 * f), max(1, int((x1 - x0) * f)), max(1, int((y1 - y0) * f))))
        return TextResult(bool(lines), len(lines), tuple(rects))


def load_text_detector(model_path: Path | None, *, min_confidence: float = 0.5) -> TextDetector:
    """EAST when the model file exists and loads, else the MSER heuristic."""
    if model_path is not None and model_path.is_file():
        try:
            detector = EastTextDetector(model_path, min_confidence=min_confidence)
            log.info("text_detector_loaded", extra={"detector": detector.name, "path": str(model_path)})
            return detector
        except cv2.error as exc:
            log.error("east_load_failed", extra={"error": str(exc), "path": str(model_path)})
    else:
        log.warning("east_model_missing", extra={"path": str(model_path)})
    return MserTextDetector()
