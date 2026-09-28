"""Download (or rebuild) the evaluation photos listed in manifest.json into a cache directory.

    python gpu-service/eval/fetch.py [--cache DIR] [--only ID,ID] [--refs] [--strict]

Sources, per manifest entry:
  * ``download``: a Pexels CDN URL (free Pexels licence), fetched as is;
  * ``repo_file``: a file in this repository (Padly's own landing-page outputs);
  * ``derive``: made from another entry with deterministic edits (``ops`` below), for cases
    Pexels has no photo of: a watermark across the product, an already-processed photo shifted
    off-centre, padded to 4:5, cropped too tight, or put on a cream / light grey background.

Every file is checked against the manifest's ``sha256`` (the bytes the labels were made on);
a mismatch is a warning (``--strict``: an error), since the CDN may re-encode one day.

``--refs`` also makes the paid-model reference cut-outs that run.py's cached escalation
backend returns (``<cache>/refs/<id>.npy``): one Replicate BiRefNet call per missing photo
(about $0.001 each; needs REPLICATE_API_TOKEN). ``--update-manifest`` writes the cached
files' sha256 and size back into manifest.json (when adding photos).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import sys
import time
import urllib.request
from pathlib import Path
from typing import Any

import evallib

USER_AGENT = "padly-eval/1.0 (+https://images.qancha.live)"


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def download(url: str, dest: Path, retries: int = 3) -> None:
    last: Exception | None = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(req, timeout=60) as resp:  # noqa: S310 - fixed https CDN URLs
                data = resp.read()
            tmp = dest.with_suffix(dest.suffix + ".part")
            tmp.write_bytes(data)
            tmp.replace(dest)
            return
        except Exception as exc:  # noqa: BLE001 - retried, then reported
            last = exc
            time.sleep(2 * (attempt + 1))
    raise RuntimeError(f"download failed: {url}: {last}")


# ------------------------------------------------------------------------------------------
# Deterministic edits for derived entries
# ------------------------------------------------------------------------------------------
def _hex(color: str) -> tuple[int, int, int]:
    c = color.lstrip("#")
    return int(c[0:2], 16), int(c[2:4], 16), int(c[4:6], 16)


def _apply(img, op: dict[str, Any]):  # PIL.Image -> PIL.Image
    import numpy as np
    from PIL import Image, ImageDraw, ImageFont

    kind = op["op"]
    w, h = img.size
    if kind == "shift":
        # Move the content by (dx, dy) fractions of the size; the uncovered side gets ``fill``.
        out = Image.new("RGB", (w, h), _hex(op.get("fill", "#FFFFFF")))
        out.paste(img, (round(op.get("dx", 0) * w), round(op.get("dy", 0) * h)))
        return out
    if kind == "pad_to_aspect":
        aw, ah = (int(x) for x in op["aspect"].split(":"))
        tw, th = (w, round(w * ah / aw)) if w * ah / aw >= h else (round(h * aw / ah), h)
        out = Image.new("RGB", (tw, th), _hex(op.get("fill", "#FFFFFF")))
        out.paste(img, ((tw - w) // 2, (th - h) // 2))
        return out
    if kind == "crop":
        x0, y0, x1, y1 = op["box"]  # fractions of the current size
        return img.crop((round(x0 * w), round(y0 * h), round(x1 * w), round(y1 * h)))
    if kind == "recolor_background":
        # Near-white pixels connected to the border become ``color`` (the product's own whites,
        # enclosed by it, are kept); a 1 px blend softens the step at the product's edge.
        import cv2

        a = np.asarray(img.convert("RGB")).astype(np.float32)
        white = (a.min(axis=2) >= op.get("min", 248)).astype(np.uint8)
        n, labels = cv2.connectedComponents(white, connectivity=4)
        rim = np.unique(np.concatenate([labels[0], labels[-1], labels[:, 0], labels[:, -1]]))
        bg = np.isin(labels, rim[rim > 0]).astype(np.float32)
        bg = cv2.GaussianBlur(bg, (0, 0), 0.8)[..., None]
        color = np.array(_hex(op["color"]), np.float32)
        out = a * (1 - bg) + color * bg
        return Image.fromarray(np.clip(np.round(out), 0, 255).astype(np.uint8))
    if kind == "watermark":
        # Semi-transparent text across the product (a supplier / stock watermark).
        size = max(12, round(op.get("size", 0.1) * min(w, h)))
        font = ImageFont.load_default(size=size)
        layer = Image.new("RGBA", (w, h), (0, 0, 0, 0))
        draw = ImageDraw.Draw(layer)
        rgba = (*_hex(op.get("color", "#FFFFFF")), round(255 * op.get("opacity", 0.5)))
        text = op["text"]
        if op.get("tile"):
            step_x, step_y = round(size * op.get("tile_dx", 6)), round(size * op.get("tile_dy", 3))
            for row, y in enumerate(range(-h, 2 * h, step_y)):
                for x in range(-w + (row % 2) * step_x // 2, 2 * w, step_x):
                    draw.text((x, y), text, font=font, fill=rgba)
        else:
            left, top, right, bottom = draw.textbbox((0, 0), text, font=font)
            cx, cy = op.get("center", (0.5, 0.5))
            draw.text((cx * w - (right - left) / 2, cy * h - (bottom - top) / 2), text, font=font, fill=rgba)
        layer = layer.rotate(op.get("angle", 0), resample=Image.BICUBIC, center=(w / 2, h / 2))
        return Image.alpha_composite(img.convert("RGBA"), layer).convert("RGB")
    raise ValueError(f"unknown derive op {kind!r}")


def derive(entry: dict[str, Any], source: Path, dest: Path) -> None:
    from PIL import Image, ImageOps

    img = ImageOps.exif_transpose(Image.open(source)).convert("RGB")
    for op in entry["derive"]["ops"]:
        img = _apply(img, op)
    img.save(dest, "JPEG", quality=entry["derive"].get("quality", 95), subsampling=0)


# ------------------------------------------------------------------------------------------
def fetch_one(entry: dict[str, Any], cache: Path, by_id: dict[str, dict[str, Any]], force: bool) -> str:
    dest = evallib.image_path(cache, entry)
    if dest.exists() and not force and (not entry.get("sha256") or sha256(dest) == entry["sha256"]):
        return "cached"
    dest.parent.mkdir(parents=True, exist_ok=True)
    if "download" in entry:
        download(entry["download"], dest)
    elif "repo_file" in entry:
        shutil.copyfile(evallib.REPO_DIR / entry["repo_file"], dest)
    elif "derive" in entry:
        src_entry = by_id[entry["derive"]["from"]]
        src = evallib.image_path(cache, src_entry)
        if not src.exists():
            fetch_one(src_entry, cache, by_id, force=False)
        derive(entry, src, dest)
    else:
        raise ValueError(f"{entry['id']}: no download, repo_file or derive")
    return "fetched"


def make_ref(entry: dict[str, Any], cache: Path, segmenter, cfg) -> float:
    """One Replicate cut-out of the photo as the pipeline sees it (decoded, EXIF-rotated, sRGB)."""
    import numpy as np

    from app.imageio import load_image
    from app.trace import begin_trace

    src = load_image(
        evallib.image_path(cache, entry).read_bytes(),
        max_source_pixels=cfg.max_source_pixels,
        max_working_pixels=cfg.max_working_pixels,
    )
    trace = begin_trace()
    mask = segmenter.predict(src.rgb)
    out = evallib.ref_path(cache, entry["id"])
    out.parent.mkdir(parents=True, exist_ok=True)
    np.save(out, mask.astype(np.float32))
    return trace.cost_usd


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument(
        "--cache",
        type=Path,
        default=evallib.default_cache(),
        help="dataset cache (default $PADLY_EVAL_CACHE or ~/.cache/padly-eval)",
    )
    ap.add_argument("--only", help="comma-separated ids")
    ap.add_argument("--refs", action="store_true", help="also make missing Replicate reference masks (paid)")
    ap.add_argument("--force", action="store_true", help="re-download / re-derive even when cached")
    ap.add_argument("--strict", action="store_true", help="fail on a sha256 mismatch")
    ap.add_argument("--update-manifest", action="store_true", help="write cached files' sha256/size into manifest.json")
    args = ap.parse_args()

    cache = args.cache.expanduser().resolve()
    entries = evallib.load_manifest()
    by_id = {e["id"]: e for e in entries}
    chosen = evallib.select(entries, args.only)
    mismatched: list[str] = []
    for entry in chosen:
        status = fetch_one(entry, cache, by_id, args.force)
        path = evallib.image_path(cache, entry)
        digest = sha256(path)
        if entry.get("sha256") and digest != entry["sha256"]:
            mismatched.append(entry["id"])
            status += " SHA256-MISMATCH (labels were made on different bytes)"
        print(f"{entry['id']:40s} {status}", flush=True)
    print(f"{len(chosen)} photos in {cache / 'images'}")

    if args.update_manifest:
        from PIL import Image, ImageOps

        raw = json.loads(evallib.MANIFEST.read_text())
        for e in raw["images"]:
            p = evallib.image_path(cache, e)
            if p.exists() and (not args.only or e["id"] in {c["id"] for c in chosen}):
                e["sha256"] = sha256(p)
                with Image.open(p) as im:
                    e["size"] = list(ImageOps.exif_transpose(im).size)
        evallib.MANIFEST.write_text(json.dumps(raw, indent=1, ensure_ascii=False) + "\n")
        print("manifest.json updated")

    if args.refs:
        missing = [e for e in chosen if not evallib.ref_path(cache, e["id"]).exists()]
        if missing:
            token = os.environ.get("REPLICATE_API_TOKEN")
            if not token:
                print("REPLICATE_API_TOKEN is not set: cannot make reference masks", file=sys.stderr)
                return 2
            from app.backends.replicate import build_replicate_backend

            cfg = evallib.eval_config(
                escalation_backend="replicate", replicate_api_token=token, replicate_timeout_s=600
            )
            backend = build_replicate_backend(cfg)
            spent = 0.0
            try:
                for entry in missing:
                    spent += make_ref(entry, cache, backend.segmenter, cfg)
                    print(f"{entry['id']:40s} reference made", flush=True)
            finally:
                backend.close()
            print(f"{len(missing)} Replicate calls, estimated ${spent:.4f}")
        else:
            print("all reference masks cached")

    if mismatched and args.strict:
        print(f"sha256 mismatch: {', '.join(mismatched)}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
