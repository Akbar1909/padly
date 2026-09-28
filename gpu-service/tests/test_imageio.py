"""Decoding / normalisation / export tests."""

from __future__ import annotations

import io
import subprocess
import sys
from pathlib import Path

import numpy as np
import pytest
from PIL import Image, ImageCms

from app import imageio
from app.errors import ServiceError
from app.imageio import (
    AI_DIGITAL_SOURCE_TYPE,
    SRGB_ICC,
    build_ai_xmp,
    encode_mask_overlay,
    encode_output,
    encode_preview_jpeg,
    insert_jpeg_xmp,
    load_image,
    sniff_format,
)

from .helpers import decode, product_on_white, to_bytes

LIMITS = {"max_source_pixels": 50_000_000, "max_working_pixels": 40_000_000}
ADOBE_RGB = Path("/System/Library/ColorSync/Profiles/AdobeRGB1998.icc")
GENERIC_CMYK = Path("/System/Library/ColorSync/Profiles/Generic CMYK Profile.icc")


def test_sniff_formats() -> None:
    img = product_on_white(64, 48)
    assert sniff_format(to_bytes(img, "JPEG")) == "JPEG"
    assert sniff_format(to_bytes(img, "PNG")) == "PNG"
    assert sniff_format(to_bytes(img, "WEBP")) == "WEBP"
    assert sniff_format(to_bytes(img, "GIF")) == "GIF"
    assert sniff_format(to_bytes(img, "TIFF")) == "TIFF"
    assert sniff_format(b"<html>nope</html>") is None


def test_load_basic_jpeg() -> None:
    src = load_image(to_bytes(product_on_white(640, 480)), **LIMITS)
    assert (src.width, src.height) == (640, 480)
    assert src.rgb.shape == (480, 640, 3) and src.rgb.dtype == np.uint8
    assert src.format == "JPEG" and src.mode == "RGB"
    assert src.alpha is None and src.icc_converted is False


def test_exif_orientation_is_applied() -> None:
    img = np.zeros((100, 200, 3), np.uint8)
    img[:, :100] = (255, 0, 0)  # left half red, right half blue (as stored)
    img[:, 100:] = (0, 0, 255)
    exif = Image.Exif()
    exif[0x0112] = 6  # rotate 90° CW to display
    data = to_bytes(img, "JPEG", exif=exif.tobytes(), quality=95)
    src = load_image(data, **LIMITS)
    assert (src.width, src.height) == (100, 200)
    top, bottom = src.rgb[20, 50], src.rgb[180, 50]
    assert top[0] > 200 and top[2] < 60  # stored-left (red) is now on top
    assert bottom[2] > 200 and bottom[0] < 60


def test_png_alpha_flattened_and_kept_as_hint() -> None:
    rgba = np.zeros((200, 300, 4), np.uint8)
    rgba[50:150, 100:200] = (10, 200, 30, 255)
    src = load_image(to_bytes(rgba, "PNG"), **LIMITS)
    assert src.mode == "RGBA"
    assert src.alpha is not None and src.alpha.shape == (200, 300)
    assert tuple(src.rgb[10, 10]) == (255, 255, 255)  # transparent → white
    assert tuple(src.rgb[100, 150]) == (10, 200, 30)


def test_opaque_rgba_has_no_alpha_hint() -> None:
    rgba = np.full((50, 50, 4), 255, np.uint8)
    assert load_image(to_bytes(rgba, "PNG"), **LIMITS).alpha is None


def test_cmyk_jpeg_without_profile() -> None:
    cmyk = Image.new("CMYK", (120, 80), (0, 255, 255, 0))  # pure red in CMYK
    buf = io.BytesIO()
    cmyk.save(buf, "JPEG", quality=95)
    src = load_image(buf.getvalue(), **LIMITS)
    assert src.mode == "CMYK"
    r, g, b = src.rgb[40, 60].astype(int)
    assert r > 200 and g < 60 and b < 60


@pytest.mark.skipif(not GENERIC_CMYK.exists(), reason="system CMYK ICC profile not available")
def test_cmyk_jpeg_with_icc_is_converted() -> None:
    cmyk = Image.new("CMYK", (120, 80), (0, 255, 255, 0))
    buf = io.BytesIO()
    cmyk.save(buf, "JPEG", quality=95, icc_profile=GENERIC_CMYK.read_bytes())
    src = load_image(buf.getvalue(), **LIMITS)
    assert src.icc_converted is True
    r, g, b = src.rgb[40, 60].astype(int)
    assert r > 180 and g < 90 and b < 90


@pytest.mark.skipif(not ADOBE_RGB.exists(), reason="system AdobeRGB ICC profile not available")
def test_adobe_rgb_is_converted_to_srgb() -> None:
    img = np.zeros((40, 40, 3), np.uint8)
    img[:] = (0, 255, 0)  # AdobeRGB green is outside sRGB → clipped, but still very green
    data = to_bytes(img, "JPEG", quality=95, icc_profile=ADOBE_RGB.read_bytes())
    src = load_image(data, **LIMITS)
    assert src.icc_converted is True
    r, g, b = src.rgb[20, 20].astype(int)
    assert g > 200 and r < 80


def test_srgb_tagged_image_is_not_reconverted() -> None:
    img = product_on_white(64, 64)
    src = load_image(to_bytes(img, "PNG", icc_profile=SRGB_ICC), **LIMITS)
    assert src.icc_converted is False
    assert np.array_equal(src.rgb, img)


def test_palette_gif() -> None:
    img = Image.fromarray(product_on_white(80, 60)).convert("P", palette=Image.Palette.ADAPTIVE)
    buf = io.BytesIO()
    img.save(buf, "GIF")
    src = load_image(buf.getvalue(), **LIMITS)
    assert src.mode == "P" and src.rgb.shape == (60, 80, 3)


def test_sixteen_bit_grayscale_png() -> None:
    arr = (np.linspace(0, 65535, 64 * 64).reshape(64, 64)).astype(np.uint16)
    buf = io.BytesIO()
    Image.fromarray(arr).save(buf, "PNG")
    src = load_image(buf.getvalue(), **LIMITS)
    assert src.rgb.shape == (64, 64, 3)
    assert src.rgb[-1, -1, 0] > 250 and src.rgb[0, 0, 0] < 5


def test_animated_gif_rejected() -> None:
    frames = [Image.new("RGB", (20, 20), c) for c in ("red", "blue")]
    buf = io.BytesIO()
    frames[0].save(buf, "GIF", save_all=True, append_images=frames[1:], duration=100, loop=0)
    with pytest.raises(ServiceError) as err:
        load_image(buf.getvalue(), **LIMITS)
    assert err.value.code == "unsupported_image" and 400 <= err.value.status < 500


def test_non_image_rejected() -> None:
    with pytest.raises(ServiceError) as err:
        load_image(b"%PDF-1.7 not an image", **LIMITS)
    assert err.value.code == "unsupported_image"


def test_truncated_image_rejected() -> None:
    data = to_bytes(product_on_white(400, 300), "PNG")
    with pytest.raises(ServiceError) as err:
        load_image(data[: len(data) // 2], **LIMITS)
    assert err.value.code == "unsupported_image"


def test_decompression_bomb_guard() -> None:
    data = to_bytes(np.zeros((2000, 2000, 3), np.uint8), "PNG")
    with pytest.raises(ServiceError) as err:
        load_image(data, max_source_pixels=1_000_000, max_working_pixels=1_000_000)
    assert err.value.code == "image_too_large" and err.value.status == 413


def test_working_downscale_keeps_reported_size() -> None:
    src = load_image(to_bytes(product_on_white(2000, 1500)), max_source_pixels=50_000_000, max_working_pixels=1_000_000)
    assert (src.width, src.height) == (2000, 1500)
    assert src.rgb.shape[0] * src.rgb.shape[1] <= 1_000_000


# --------------------------------------------------------------------------------------
# Decompression bombs: memory stays bounded for tiny files that decode to huge images
# --------------------------------------------------------------------------------------
@pytest.mark.parametrize("orientation", [1, 6])
def test_large_jpeg_is_decoded_at_reduced_scale(orientation: int, monkeypatch: pytest.MonkeyPatch) -> None:
    decoded: list[tuple[int, ...]] = []
    real_resize = imageio.resize_rgb
    monkeypatch.setattr(imageio, "resize_rgb", lambda arr, size: (decoded.append(arr.shape), real_resize(arr, size))[1])
    exif = Image.Exif()
    exif[0x0112] = orientation
    data = to_bytes(product_on_white(4000, 3000), "JPEG", quality=90, exif=exif.tobytes())
    src = load_image(data, max_source_pixels=50_000_000, max_working_pixels=1_000_000)
    rotated = orientation == 6
    assert (src.width, src.height) == ((3000, 4000) if rotated else (4000, 3000))  # true source size
    assert decoded[-1][:2] == ((2000, 1500) if rotated else (1500, 2000))  # libjpeg decoded at 1/2
    assert src.rgb.shape[0] * src.rgb.shape[1] <= 1_000_000
    assert (src.rgb.shape[0] > src.rgb.shape[1]) == rotated


def test_alpha_flattening_is_exact() -> None:
    # Every (colour, alpha) pair: the 8-bit flattening must equal round(c·a + 255·(1−a)).
    c = np.tile(np.arange(256, dtype=np.uint8), (256, 1))
    a = np.tile(np.arange(256, dtype=np.uint8)[:, None], (1, 256))
    rgb = np.stack([c, 255 - c, c // 2], axis=-1)
    src = load_image(to_bytes(np.dstack([rgb, a]), "PNG"), **LIMITS)
    af = a.astype(np.float64)[..., None] / 255.0
    expected = np.round(rgb * af + 255.0 * (1.0 - af)).astype(np.uint8)
    assert np.array_equal(src.rgb, expected)
    assert src.alpha is not None and np.array_equal(src.alpha, a)


def test_tall_sixteen_bit_image_converts_across_strips() -> None:
    arr = np.random.default_rng(5).integers(0, 65536, (40_000, 64)).astype(np.uint16)  # 3 strips
    buf = io.BytesIO()
    Image.fromarray(arr).save(buf, "PNG")
    src = load_image(buf.getvalue(), **LIMITS)
    assert src.mode.startswith("I")
    expected = np.round(arr / 257.0).astype(np.uint8)
    assert np.array_equal(src.rgb[..., 0], expected)


def test_transparent_png_bomb_memory_is_bounded(tmp_path: Path) -> None:
    # 30 MP, mostly transparent: ~0.1 MB on disk. The old float32 flattening peaked at
    # ~1.5 GB above baseline for this; decoding in 8-bit stays well under 0.8 GB.
    img = Image.new("RGBA", (6000, 5000), (0, 0, 0, 0))
    img.paste((200, 30, 30, 255), (2000, 1500, 4000, 3500))
    path = tmp_path / "bomb.png"
    img.save(path, optimize=True)
    del img
    code = f"""
import resource, sys
from app.imageio import load_image
scale = 1 if sys.platform == "darwin" else 1024  # ru_maxrss: bytes on macOS, KiB on Linux
data = open({str(path)!r}, "rb").read()
before = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * scale
src = load_image(data, max_source_pixels=30_000_000, max_working_pixels=16_000_000)
assert src.alpha is not None and src.rgb.shape[0] * src.rgb.shape[1] <= 16_000_000
print((resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * scale - before) / 2**20)
"""
    root = Path(__file__).resolve().parents[1]
    out = subprocess.run([sys.executable, "-c", code], cwd=root, capture_output=True, text=True, check=True)
    assert float(out.stdout.strip()) < 800


# --------------------------------------------------------------------------------------
# Export
# --------------------------------------------------------------------------------------
@pytest.mark.parametrize("fmt", ["jpeg", "png", "webp"])
def test_encode_output_embeds_srgb_and_strips_exif(fmt: str) -> None:
    enc = encode_output(
        product_on_white(300, 300), fmt, jpeg_quality=90, xmp=None, max_bytes=20_000_000, max_pixels=20_000_000
    )
    img = decode(enc.data)
    assert img.format == {"jpeg": "JPEG", "png": "PNG", "webp": "WEBP"}[fmt]
    assert (img.width, img.height) == (enc.width, enc.height) == (300, 300)
    profile = ImageCms.ImageCmsProfile(io.BytesIO(img.info["icc_profile"]))
    assert "srgb" in ImageCms.getProfileDescription(profile).lower()
    assert not img.getexif()
    assert "xmp" not in img.info or not img.info["xmp"]


def test_jpeg_is_progressive_444() -> None:
    enc = encode_output(
        product_on_white(300, 300), "jpeg", jpeg_quality=90, xmp=None, max_bytes=20_000_000, max_pixels=20_000_000
    )
    img = decode(enc.data)
    assert img.info.get("progressive") or img.info.get("progression")
    from PIL import JpegImagePlugin

    assert JpegImagePlugin.get_sampling(img) == 0  # 4:4:4


@pytest.mark.parametrize("fmt", ["jpeg", "png", "webp"])
def test_ai_xmp_embedded(fmt: str) -> None:
    enc = encode_output(
        product_on_white(200, 200),
        fmt,
        jpeg_quality=90,
        xmp=build_ai_xmp(),
        max_bytes=20_000_000,
        max_pixels=20_000_000,
    )
    assert AI_DIGITAL_SOURCE_TYPE.encode() in enc.data
    img = decode(enc.data)
    xmp = img.info.get("xmp") or img.info.get("XML:com.adobe.xmp")
    assert xmp is not None
    text = xmp.decode() if isinstance(xmp, bytes) else xmp
    assert "Iptc4xmpExt:DigitalSourceType" in text and AI_DIGITAL_SOURCE_TYPE in text


def test_jpeg_xmp_segment_follows_soi_and_jfif() -> None:
    raw = to_bytes(product_on_white(50, 50), "JPEG")
    out = insert_jpeg_xmp(raw, build_ai_xmp())
    assert out[:2] == b"\xff\xd8"
    app0_len = int.from_bytes(raw[4:6], "big")
    pos = 4 + app0_len
    assert out[2:4] == b"\xff\xe0"  # JFIF kept first
    assert out[pos : pos + 2] == b"\xff\xe1"
    assert out[pos + 4 : pos + 4 + 29] == b"http://ns.adobe.com/xap/1.0/\x00"
    decode(out)  # still a valid JPEG


def test_output_steps_down_to_fit_byte_limit() -> None:
    rng = np.random.default_rng(1)
    noise = rng.integers(0, 256, (800, 800, 3), dtype=np.uint8)  # incompressible
    big = encode_output(noise, "jpeg", jpeg_quality=95, xmp=None, max_bytes=50_000_000, max_pixels=20_000_000)
    limit = len(big.data) // 3
    small = encode_output(noise, "jpeg", jpeg_quality=95, xmp=None, max_bytes=limit, max_pixels=20_000_000)
    assert len(small.data) <= limit


def test_output_pixel_cap() -> None:
    enc = encode_output(
        np.full((1000, 1000, 3), 200, np.uint8),
        "png",
        jpeg_quality=90,
        xmp=None,
        max_bytes=20_000_000,
        max_pixels=250_000,
    )
    assert enc.width * enc.height <= 250_000


def test_preview_and_mask_overlay() -> None:
    data, w, h = encode_preview_jpeg(product_on_white(1000, 800))
    img = decode(data)
    assert img.format == "JPEG" and (w, h) == (640, 512) == img.size

    mask = np.zeros((80, 100), np.float32)
    mask[20:60, 30:70] = 1.0
    overlay = decode(encode_mask_overlay(mask, (w, h)))
    assert overlay.mode == "RGBA" and overlay.size == (w, h)
    arr = np.asarray(overlay)
    assert arr[5, 5, 3] == round(0.45 * 255) and tuple(arr[5, 5, :3]) == (255, 0, 0)  # background tinted
    assert arr[h // 2, w // 2, 3] == 0  # product transparent

    blank = np.asarray(decode(encode_mask_overlay(None, (w, h))))
    assert blank.shape == (h, w, 4) and blank[..., 3].max() == 0
