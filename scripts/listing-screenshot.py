"""Fit raw app screenshots onto exact 1600 x 900 canvases for the Shopify App Store listing.

The listing wants 3-6 desktop screenshots at 1600 x 900 (16:9) with the browser chrome
cropped out (docs/app-store/screenshots.md says which screens to capture). This script:

- optionally crops each raw screenshot first (--crop, in raw pixels), e.g. to cut the
  browser bar or the Shopify admin sidebar;
- converts it to sRGB (macOS screenshots carry a Display P3 profile);
- scales it DOWN to fit inside the canvas minus a margin, never up (a small capture is
  centred as is, with a warning: recapture it bigger rather than blur it);
- centres it on a solid background from the landing palette, optionally with a subtle
  frame (hairline border, rounded corners and a soft shadow);
- writes <name>-1600x900.png and checks the size is exact.

Uses Pillow only. Run it with the GPU service's virtualenv, which already has Pillow:

    gpu-service/.venv/bin/python scripts/listing-screenshot.py raw/*.png --out listing/
    gpu-service/.venv/bin/python scripts/listing-screenshot.py raw/03-review.png \\
        --crop 0,140,0,0 --bg ink --frame --out listing/

--crop takes LEFT,TOP,RIGHT,BOTTOM pixels to remove from each edge of the raw image (Retina
captures are 2x, so a 70 px browser bar is 140 raw pixels). --bg is paper (default), ink,
card, white or any #rrggbb. --margin is the minimum space around the screenshot in output
pixels (default 48; 0 fills the canvas edge to edge when the capture is exactly 16:9).
"""

from __future__ import annotations

import argparse
import io
import sys
from pathlib import Path

from PIL import Image, ImageChops, ImageCms, ImageDraw, ImageFilter, ImageOps

WIDTH, HEIGHT = 1600, 900

# Landing palette (app/components/landing/landing.module.css).
PALETTE = {
    "paper": "#f3efe6",
    "ink": "#16130f",
    "card": "#fffdf8",
    "white": "#ffffff",
}
FRAME_LINE = {"light": (216, 207, 190), "dark": (59, 53, 45)}  # --line / --ink-2
RADIUS = 12


def parse_colour(value: str) -> tuple[int, int, int]:
    hex_value = PALETTE.get(value.lower(), value).lstrip("#")
    if len(hex_value) != 6:
        raise argparse.ArgumentTypeError(f"not a palette name or #rrggbb colour: {value}")
    try:
        return tuple(int(hex_value[i : i + 2], 16) for i in (0, 2, 4))  # type: ignore[return-value]
    except ValueError as exc:
        raise argparse.ArgumentTypeError(f"not a palette name or #rrggbb colour: {value}") from exc


def parse_crop(value: str) -> tuple[int, int, int, int]:
    try:
        parts = tuple(int(p) for p in value.split(","))
    except ValueError as exc:
        raise argparse.ArgumentTypeError("--crop needs four integers: LEFT,TOP,RIGHT,BOTTOM") from exc
    if len(parts) != 4 or min(parts) < 0:
        raise argparse.ArgumentTypeError("--crop needs four integers >= 0: LEFT,TOP,RIGHT,BOTTOM")
    return parts  # type: ignore[return-value]


def to_srgb(image: Image.Image) -> Image.Image:
    """Convert to RGB in sRGB, honouring an embedded ICC profile (Display P3 on macOS)."""
    image = ImageOps.exif_transpose(image)
    icc = image.info.get("icc_profile")
    if image.mode not in ("RGB", "RGBA"):
        image = image.convert("RGBA" if "A" in image.getbands() or "transparency" in image.info else "RGB")
    if image.mode == "RGBA":
        # Screenshots have no meaningful transparency; flatten onto white like the admin.
        flat = Image.new("RGB", image.size, (255, 255, 255))
        flat.paste(image, mask=image.getchannel("A"))
        image = flat
    if icc:
        try:
            source = ImageCms.ImageCmsProfile(io.BytesIO(icc))
            image = ImageCms.profileToProfile(image, source, ImageCms.createProfile("sRGB"), outputMode="RGB")
        except (ImageCms.PyCMSError, OSError) as exc:
            print(f"  warning: could not apply the embedded colour profile ({exc}); using pixels as is")
    return image


def rounded_mask(size: tuple[int, int], radius: int) -> Image.Image:
    mask = Image.new("L", size, 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, size[0] - 1, size[1] - 1), radius=radius, fill=255)
    return mask


def fit(
    raw: Image.Image,
    *,
    bg: tuple[int, int, int],
    margin: int,
    frame: bool,
    crop: tuple[int, int, int, int] | None,
) -> tuple[Image.Image, list[str]]:
    notes: list[str] = []
    shot = to_srgb(raw)
    if crop:
        left, top, right, bottom = crop
        if left + right >= shot.width or top + bottom >= shot.height:
            raise ValueError(f"--crop {crop} removes the whole {shot.width}x{shot.height} image")
        shot = shot.crop((left, top, shot.width - right, shot.height - bottom))

    box_w, box_h = WIDTH - 2 * margin, HEIGHT - 2 * margin
    if box_w <= 0 or box_h <= 0:
        raise ValueError(f"--margin {margin} leaves no room on a {WIDTH}x{HEIGHT} canvas")
    scale = min(box_w / shot.width, box_h / shot.height)
    if scale < 1:
        size = (max(1, round(shot.width * scale)), max(1, round(shot.height * scale)))
        shot = shot.resize(size, Image.Resampling.LANCZOS, reducing_gap=3.0)
    elif scale > 1:
        notes.append(
            f"capture is only {shot.width}x{shot.height}; left at 100% (never upscaled). "
            "For a sharper result, recapture on a larger or Retina screen."
        )

    canvas = Image.new("RGB", (WIDTH, HEIGHT), bg)
    x = (WIDTH - shot.width) // 2
    y = (HEIGHT - shot.height) // 2
    if frame:
        dark = sum(bg) / 3 < 128
        mask = rounded_mask(shot.size, RADIUS)
        # Soft shadow under the screenshot.
        shadow = Image.new("L", (WIDTH, HEIGHT), 0)
        shadow.paste(mask, (x, y + 10))
        shadow = shadow.filter(ImageFilter.GaussianBlur(22))
        shadow = shadow.point(lambda v: int(v * (0.55 if dark else 0.18)))
        canvas = Image.composite(Image.new("RGB", canvas.size, (0, 0, 0)), canvas, shadow)
        canvas.paste(shot, (x, y), mask)
        # Hairline border just inside the rounded edge.
        border = Image.new("L", shot.size, 0)
        ImageDraw.Draw(border).rounded_rectangle(
            (0, 0, shot.width - 1, shot.height - 1), radius=RADIUS, outline=255, width=1
        )
        line = Image.new("RGB", shot.size, FRAME_LINE["dark" if dark else "light"])
        canvas.paste(line, (x, y), ImageChops.multiply(border, mask))
    else:
        canvas.paste(shot, (x, y))

    if shot.width < WIDTH * 0.6 and shot.height < HEIGHT * 0.6:
        notes.append("screenshot fills less than 60% of the canvas; consider cropping tighter with --crop")
    return canvas, notes


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Fit raw screenshots onto exact 1600x900 canvases for the Shopify App Store listing.",
        epilog="See docs/app-store/screenshots.md for which screens to capture.",
    )
    parser.add_argument("inputs", nargs="+", type=Path, help="raw screenshots (PNG or JPEG)")
    parser.add_argument("--out", type=Path, default=Path("listing-screenshots"), help="output folder")
    parser.add_argument(
        "--bg", type=parse_colour, default=parse_colour("paper"), help="paper, ink, card, white or #rrggbb"
    )
    parser.add_argument("--margin", type=int, default=48, help="minimum space around the screenshot, in pixels")
    parser.add_argument("--frame", action="store_true", help="rounded corners, hairline border and a soft shadow")
    parser.add_argument("--crop", type=parse_crop, help="LEFT,TOP,RIGHT,BOTTOM raw pixels to cut before fitting")
    args = parser.parse_args(argv)

    if args.margin < 0:
        parser.error("--margin must be 0 or more")
    args.out.mkdir(parents=True, exist_ok=True)

    failed = 0
    for path in args.inputs:
        try:
            with Image.open(path) as raw:
                raw.load()
                result, notes = fit(raw, bg=args.bg, margin=args.margin, frame=args.frame, crop=args.crop)
        except (OSError, ValueError) as exc:
            print(f"{path}: skipped: {exc}", file=sys.stderr)
            failed += 1
            continue
        target = args.out / f"{path.stem}-{WIDTH}x{HEIGHT}.png"
        result.save(target, optimize=True)
        with Image.open(target) as check:
            if check.size != (WIDTH, HEIGHT):
                print(f"{target}: wrong size {check.size}", file=sys.stderr)
                failed += 1
                continue
        print(f"{path} -> {target}")
        for note in notes:
            print(f"  note: {note}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
