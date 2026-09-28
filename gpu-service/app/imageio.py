"""Decode + normalise source images, encode outputs/previews, and embed XMP metadata."""

from __future__ import annotations

import io
import logging
import struct
import warnings
from dataclasses import dataclass

import numpy as np
from PIL import ExifTags, Image, ImageCms, ImageOps, PngImagePlugin, UnidentifiedImageError

from .errors import image_too_large, unsupported_image
from .ops import fit_long_side, fit_max_pixels, image_size, resize_mask, resize_rgb
from .schemas import CONTENT_TYPES

log = logging.getLogger(__name__)

# We enforce our own pixel limit explicitly (→ image_too_large); Pillow's hard error at 2x
# MAX_IMAGE_PIXELS remains as a second line of defence against decompression bombs.
warnings.filterwarnings("ignore", category=Image.DecompressionBombWarning)

SRGB_PROFILE = ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB"))
SRGB_ICC: bytes = SRGB_PROFILE.tobytes()

AI_DIGITAL_SOURCE_TYPE = "http://cv.iptc.org/newscodes/digitalsourcetype/compositeWithTrainedAlgorithmicMedia"
_XMP_APP1_HEADER = b"http://ns.adobe.com/xap/1.0/\x00"

# Pillow format names we accept, keyed by the sniffed container type.
_PIL_FORMATS: dict[str, list[str]] = {
    "JPEG": ["JPEG", "MPO"],
    "PNG": ["PNG"],
    "GIF": ["GIF"],
    "WEBP": ["WEBP"],
    "TIFF": ["TIFF"],
    "BMP": ["BMP"],
    "AVIF": ["AVIF"],
}
_ANIMATABLE = {"GIF", "PNG", "WEBP", "AVIF"}
ALPHA_HINT_MIN_TRANSPARENT = 0.01  # ≥1% transparent pixels → the alpha channel is a cut-out
_STRIP_PIXELS = 1 << 20  # float work on high-bit-depth sources runs in strips of ~1 MP


@dataclass
class NormalizedImage:
    """A decoded source image in canonical form.

    ``rgb`` is sRGB uint8 HxWx3 with any transparency flattened onto white; ``alpha`` is
    kept (uint8 HxW, same geometry) only when the source genuinely has transparent regions,
    as a hint that the image is already cut out.
    """

    rgb: np.ndarray
    alpha: np.ndarray | None
    width: int  # normalised (EXIF-rotated) source size, before any working downscale
    height: int
    format: str
    mode: str
    icc_converted: bool


@dataclass
class EncodedImage:
    data: bytes
    width: int
    height: int
    format: str  # "jpeg" | "png" | "webp"
    content_type: str


# --------------------------------------------------------------------------------------
# Decoding
# --------------------------------------------------------------------------------------
def sniff_format(data: bytes) -> str | None:
    """Identify the container from magic bytes (ignores any declared MIME type)."""
    head = data[:32]
    if head.startswith(b"\xff\xd8\xff"):
        return "JPEG"
    if head.startswith(b"\x89PNG\r\n\x1a\n"):
        return "PNG"
    if head[:6] in (b"GIF87a", b"GIF89a"):
        return "GIF"
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "WEBP"
    if head[:4] in (b"II*\x00", b"MM\x00*"):
        return "TIFF"
    if head[:2] == b"BM":
        return "BMP"
    if head[4:8] == b"ftyp":
        box_len = struct.unpack(">I", head[:4])[0]
        brands = data[8 : min(max(box_len, 16), 64)]
        brand_list = {brands[i : i + 4] for i in range(0, len(brands) - 3, 4)}
        if brand_list & {b"avif", b"avis"}:
            return "AVIF"
        if brand_list & {b"heic", b"heix", b"hevc", b"hevx", b"mif1", b"msf1"}:
            return "HEIC"
    return None


def _to_8bit(img: Image.Image) -> Image.Image:
    """High-bit-depth single-channel modes (I;16, I, F) → 8-bit L.

    Converted in row strips so the float64 temporaries stay a few MB at any image size.
    """
    arr = np.asarray(img)
    out = np.empty(arr.shape[:2], np.uint8)
    if img.mode == "F":
        scale = 255.0 if float(np.nanmax(arr, initial=0.0)) <= 1.0 else 1.0
    else:
        wide = float(arr.max(initial=0)) > 255
    rows = max(1, _STRIP_PIXELS // max(1, arr.shape[1]))
    for y in range(0, arr.shape[0], rows):
        strip = arr[y : y + rows].astype(np.float64)
        if img.mode == "F":
            strip8 = np.clip(np.nan_to_num(strip) * scale, 0, 255)
        else:
            strip8 = np.clip(strip / 257.0 if wide else strip, 0, 255)
        out[y : y + rows] = np.round(strip8)
    return Image.fromarray(out, "L")


def _split_alpha(img: Image.Image) -> tuple[Image.Image, Image.Image | None]:
    """Return (colour image without alpha, alpha channel as an "L" image, or None)."""
    if img.mode in ("I;16", "I;16B", "I;16L", "I;16N", "I", "F"):
        img = _to_8bit(img)
    if img.mode == "1":
        img = img.convert("L")
    if img.mode == "P":
        has_transparency = "transparency" in img.info or img.palette.mode == "RGBA"
        img = img.convert("RGBA" if has_transparency else "RGB")
    if img.mode == "PA":
        img = img.convert("RGBA")
    if img.mode in ("RGBa", "La"):
        img = img.convert("RGBA" if img.mode == "RGBa" else "LA")
    if img.mode == "RGBA":
        return img.convert("RGB"), img.getchannel("A")
    if img.mode == "LA":
        return img.getchannel("L"), img.getchannel("A")
    return img, None


def _to_srgb(img: Image.Image, icc: bytes | None) -> tuple[Image.Image, bool]:
    """Convert to sRGB using the embedded ICC profile when present; returns (img, converted)."""
    if icc:
        try:
            src_profile = ImageCms.ImageCmsProfile(io.BytesIO(icc))
            description = (ImageCms.getProfileDescription(src_profile) or "").strip().lower()
            if img.mode == "RGB" and "srgb" in description:
                return img, False  # already sRGB
            converted = ImageCms.profileToProfile(
                img,
                src_profile,
                SRGB_PROFILE,
                renderingIntent=ImageCms.Intent.RELATIVE_COLORIMETRIC,
                outputMode="RGB",
                flags=ImageCms.Flags.BLACKPOINTCOMPENSATION,
            )
            if converted is not None:
                return converted, True
        except (ImageCms.PyCMSError, OSError, ValueError, TypeError) as exc:
            log.warning("icc_conversion_failed", extra={"error": str(exc), "mode": img.mode})
    if img.mode != "RGB":
        img = img.convert("RGB")
    return img, False


def _to_array(img: Image.Image) -> np.ndarray:
    """uint8 array of an L or RGB image, copied in row strips: ``np.asarray`` goes through
    ``tobytes()``, which briefly holds two full-size copies of the image."""
    w, h = img.size
    bands = len(img.getbands())
    arr = np.empty((h, w) if bands == 1 else (h, w, bands), np.uint8)
    rows = max(1, _STRIP_PIXELS // w)
    for y in range(0, h, rows):
        arr[y : y + rows] = np.asarray(img.crop((0, y, w, min(h, y + rows))))
    return arr


def load_image(data: bytes, *, max_source_pixels: int, max_working_pixels: int) -> NormalizedImage:
    """Decode, EXIF-rotate and convert to sRGB; raise contract errors for bad input.

    Peak memory stays a small multiple of the decoded source (no float copies at full
    resolution), so a highly compressible upload near ``max_source_pixels`` can't exhaust
    the container: large JPEGs are decoded at a reduced scale, transparency is flattened
    in 8-bit, and everything after decoding runs at working size.
    """
    sniffed = sniff_format(data)
    if sniffed is None:
        raise unsupported_image("The file is not a recognised image format")
    if sniffed not in _PIL_FORMATS:
        raise unsupported_image(f"{sniffed} images are not supported")

    Image.MAX_IMAGE_PIXELS = max_source_pixels
    try:
        img = Image.open(io.BytesIO(data), formats=_PIL_FORMATS[sniffed])
        width, height = img.size
        if width * height > max_source_pixels:
            raise image_too_large(f"Image is {width}x{height} ({width * height} px), limit is {max_source_pixels} px")
        pil_format = img.format or sniffed
        if pil_format in _ANIMATABLE and getattr(img, "is_animated", False):
            raise unsupported_image("Animated images are not supported")
        if getattr(img, "n_frames", 1) > 1:
            img.seek(0)  # MPO (camera JPEG with previews) / multi-page TIFF → first frame
        if pil_format in ("JPEG", "MPO") and width * height > max_working_pixels:
            # libjpeg can decode straight to 1/2, 1/4 or 1/8 scale. draft() only picks a scale
            # that still covers the working size, so this helps only from 4x its pixels.
            img.draft(img.mode, fit_max_pixels(width, height, max_working_pixels))
        img.load()
    except Image.DecompressionBombError as exc:
        raise image_too_large(str(exc)) from exc
    except (UnidentifiedImageError, OSError, SyntaxError, ValueError, EOFError) as exc:
        raise unsupported_image(f"Could not decode image: {exc}") from exc

    source_mode = img.mode
    icc = img.info.get("icc_profile")
    swapped = False
    try:
        swapped = img.getexif().get(ExifTags.Base.Orientation, 1) in (5, 6, 7, 8)
        ImageOps.exif_transpose(img, in_place=True)  # in place: no full-size copy
    except Exception as exc:  # malformed EXIF must not fail the job
        log.warning("exif_transpose_failed", extra={"error": str(exc)})
    # Reported size is the EXIF-rotated source, even when the JPEG was decoded smaller.
    norm_w, norm_h = (height, width) if swapped else (width, height)
    work_size = fit_max_pixels(norm_w, norm_h, max_working_pixels)

    base, alpha = _split_alpha(img)
    del img  # frees the decoded RGBA once the channels are split
    base, icc_converted = _to_srgb(base, icc)

    alpha_hint: np.ndarray | None = None
    if alpha is not None and alpha.getextrema()[0] < 255:
        # Flatten onto white in 8-bit, in place: pasting white through the inverted alpha
        # gives exactly round(c·a + 255·(1−a)) without float copies of the image.
        base.paste((255, 255, 255), (0, 0, *base.size), ImageOps.invert(alpha))
        transparent = sum(alpha.histogram()[:128])  # pixels with alpha < 128
        if transparent / (alpha.width * alpha.height) >= ALPHA_HINT_MIN_TRANSPARENT:
            alpha_hint = resize_rgb(_to_array(alpha), work_size)  # area average, like the image
    del alpha

    rgb = _to_array(base)
    del base  # free the full-size image before the resized copy is made
    if rgb.ndim != 3 or rgb.shape[2] != 3:
        raise unsupported_image(f"Unsupported colour layout (mode {source_mode})")
    rgb = resize_rgb(rgb, work_size)

    fmt_name = "JPEG" if pil_format == "MPO" else pil_format
    return NormalizedImage(
        rgb=np.ascontiguousarray(rgb),
        alpha=alpha_hint,
        width=norm_w,
        height=norm_h,
        format=fmt_name,
        mode=source_mode,
        icc_converted=icc_converted,
    )


# --------------------------------------------------------------------------------------
# XMP
# --------------------------------------------------------------------------------------
def build_ai_xmp() -> bytes:
    """XMP packet declaring IPTC DigitalSourceType = compositeWithTrainedAlgorithmicMedia."""
    packet = (
        '<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>\n'
        '<x:xmpmeta xmlns:x="adobe:ns:meta/">\n'
        ' <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">\n'
        '  <rdf:Description rdf:about=""\n'
        '    xmlns:Iptc4xmpExt="http://iptc.org/std/Iptc4xmpExt/2008-02-29/"\n'
        f'    Iptc4xmpExt:DigitalSourceType="{AI_DIGITAL_SOURCE_TYPE}"/>\n'
        " </rdf:RDF>\n"
        "</x:xmpmeta>\n"
        '<?xpacket end="w"?>'
    )
    return packet.encode("utf-8")


def insert_jpeg_xmp(jpeg: bytes, xmp: bytes) -> bytes:
    """Insert an APP1 XMP segment right after SOI (after the JFIF APP0 segment, if present,
    so the file stays JFIF-conformant)."""
    if jpeg[:2] != b"\xff\xd8":
        raise ValueError("not a JPEG stream")
    payload = _XMP_APP1_HEADER + xmp
    if len(payload) + 2 > 0xFFFF:
        raise ValueError("XMP packet too large for a single APP1 segment")
    segment = b"\xff\xe1" + struct.pack(">H", len(payload) + 2) + payload
    pos = 2
    if jpeg[2:4] == b"\xff\xe0":
        pos = 4 + struct.unpack(">H", jpeg[4:6])[0]
    return jpeg[:pos] + segment + jpeg[pos:]


# --------------------------------------------------------------------------------------
# Encoding
# --------------------------------------------------------------------------------------
def _encode_once(img: Image.Image, fmt: str, quality: int, subsampling: int, xmp: bytes | None) -> bytes:
    buf = io.BytesIO()
    if fmt == "jpeg":
        options = {"quality": quality, "subsampling": subsampling, "icc_profile": SRGB_ICC}
        try:
            img.save(buf, "JPEG", progressive=True, optimize=True, **options)
        except OSError:
            # Progressive/optimised encoding needs the whole file in one buffer, which
            # Pillow sizes at ~1-2 bytes/pixel; extremely detailed images can overflow it
            # ("Suspension not allowed here"). Fall back to a streamed baseline JPEG.
            log.info("jpeg_progressive_fallback", extra={"size": img.size, "quality": quality})
            buf = io.BytesIO()
            img.save(buf, "JPEG", **options)
        data = buf.getvalue()
        return insert_jpeg_xmp(data, xmp) if xmp else data
    if fmt == "png":
        pnginfo = PngImagePlugin.PngInfo()
        if xmp:
            pnginfo.add_itxt("XML:com.adobe.xmp", xmp.decode("utf-8"), zip=False)
        img.save(buf, "PNG", optimize=True, icc_profile=SRGB_ICC, pnginfo=pnginfo)
        return buf.getvalue()
    if fmt == "webp":
        kwargs: dict[str, object] = {"quality": quality, "method": 4, "icc_profile": SRGB_ICC}
        if xmp:
            kwargs["xmp"] = xmp
        img.save(buf, "WEBP", **kwargs)
        return buf.getvalue()
    raise ValueError(f"unknown output format {fmt}")


def _quality_ladder(fmt: str, jpeg_quality: int) -> list[tuple[int, int]]:
    """(quality, jpeg subsampling) attempts, best first. 0 = 4:4:4, 2 = 4:2:0."""
    if fmt == "png":
        return [(0, 0)]
    start = jpeg_quality if fmt == "jpeg" else 90
    ladder: list[tuple[int, int]] = [(start, 0)] if fmt == "jpeg" else []
    q = start
    while True:
        ladder.append((q, 2))
        if q <= 50:
            break
        q = max(50, q - 5)
    return ladder


def encode_output(
    rgb: np.ndarray,
    fmt: str,
    *,
    jpeg_quality: int,
    xmp: bytes | None,
    max_bytes: int,
    max_pixels: int,
) -> EncodedImage:
    """Encode the final canvas (sRGB ICC embedded, no EXIF), stepping quality and then
    dimensions down until the file fits ``max_bytes``."""
    img = Image.fromarray(rgb, "RGB")
    w, h = fit_max_pixels(img.width, img.height, max_pixels)
    if (w, h) != img.size:
        img = img.resize((w, h), Image.Resampling.LANCZOS)
    for _ in range(12):
        data = b""
        for quality, subsampling in _quality_ladder(fmt, jpeg_quality):
            data = _encode_once(img, fmt, quality, subsampling, xmp)
            if len(data) <= max_bytes:
                return EncodedImage(data, img.width, img.height, fmt, CONTENT_TYPES[fmt])
        log.info("output_too_large_downscaling", extra={"bytes": len(data), "size": img.size})
        img = img.resize(
            (max(1, int(img.width * 0.85)), max(1, int(img.height * 0.85))),
            Image.Resampling.LANCZOS,
        )
    raise RuntimeError("could not encode output under the byte limit")


def resize_long_side(rgb: np.ndarray, long_side: int) -> np.ndarray:
    """Resize (either direction) so the long side equals ``long_side``."""
    w, h = image_size(rgb)
    return resize_rgb(rgb, fit_long_side(w, h, long_side))


def encode_preview_jpeg(rgb: np.ndarray, long_side: int = 640, quality: int = 80) -> tuple[bytes, int, int]:
    """640 px long-side JPEG q80 preview (sRGB ICC embedded). Returns (bytes, w, h)."""
    small = resize_long_side(rgb, long_side)
    buf = io.BytesIO()
    Image.fromarray(small, "RGB").save(buf, "JPEG", quality=quality, icc_profile=SRGB_ICC)
    return buf.getvalue(), small.shape[1], small.shape[0]


def encode_mask_overlay(mask: np.ndarray | None, size: tuple[int, int], alpha_pct: float = 0.45) -> bytes:
    """RGBA PNG: removed background tinted red at ~45% alpha, product fully transparent.

    ``mask`` is a float product mask in [0, 1] of any size (resized to ``size``);
    ``None`` produces a fully transparent image (used when ``remove_bg`` is false).
    """
    w, h = size
    rgba = np.zeros((h, w, 4), dtype=np.uint8)
    if mask is not None:
        m = resize_mask(mask, size)
        rgba[..., 0] = 255
        rgba[..., 3] = np.round((1.0 - m) * (alpha_pct * 255.0)).astype(np.uint8)
    buf = io.BytesIO()
    Image.fromarray(rgba, "RGBA").save(buf, "PNG", optimize=True)
    return buf.getvalue()
