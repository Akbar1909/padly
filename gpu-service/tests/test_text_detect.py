"""Text guardrail: MSER fallback (EAST is exercised when a model file is available)."""

from __future__ import annotations

import os
from pathlib import Path

import cv2
import numpy as np
import pytest

from app.text_detect import EastTextDetector, MserTextDetector, load_text_detector

from .helpers import product_on_white, tall_product, text_image


def test_mser_detects_drawn_text() -> None:
    result = MserTextDetector().detect(text_image())
    assert result.found and result.boxes >= 1


def test_mser_detects_light_text_on_dark() -> None:
    img = np.full((400, 900, 3), 30, np.uint8)
    cv2.putText(img, "Organic Tea", (40, 220), cv2.FONT_HERSHEY_DUPLEX, 2.2, (240, 240, 240), 4, cv2.LINE_AA)
    assert MserTextDetector().detect(img).found


@pytest.mark.parametrize("image", [product_on_white(), tall_product(), np.full((300, 300, 3), 255, np.uint8)])
def test_mser_no_text_on_plain_products(image: np.ndarray) -> None:
    assert MserTextDetector().detect(image).found is False


def test_row_of_dots_is_not_text() -> None:
    img = np.full((300, 800, 3), 250, np.uint8)
    for i in range(6):
        cv2.circle(img, (80 + i * 110, 150), 30, (20, 20, 20), -1)
    assert MserTextDetector().detect(img).found is False


def test_loader_falls_back_to_mser(tmp_path: Path) -> None:
    detector = load_text_detector(tmp_path / "nope.pb")
    assert detector.name == "mser-heuristic"
    assert load_text_detector(None).name == "mser-heuristic"


EAST = os.environ.get("EAST_MODEL_PATH")


@pytest.mark.skipif(not EAST or not Path(EAST).is_file(), reason="set EAST_MODEL_PATH to run the EAST test")
def test_east_detects_text() -> None:
    detector = load_text_detector(Path(EAST))  # type: ignore[arg-type]
    assert isinstance(detector, EastTextDetector) and detector.name == "opencv-east"
    assert detector.detect(text_image()).found
    assert not detector.detect(product_on_white()).found
