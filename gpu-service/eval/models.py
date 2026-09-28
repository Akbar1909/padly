"""Compare self-hosted background-removal (segmentation) models with the paid model's cut-out
of the same photos: quality (IoU, boundary F), speed and memory at the production VPS's 3 threads.

    python gpu-service/eval/models.py [--models-dir DIR] [--candidates NAME,NAME] [--only ID,ID] [--out DIR]
    python gpu-service/eval/models.py --report-only     # re-aggregate the saved results
    python gpu-service/eval/models.py --list            # candidates, licences, exclusions

Run it with the ML venv (torch, transformers, onnxruntime), e.g. ~/.cache/padly-eval/mlvenv/bin/python.

Candidates (``--candidates``, default all), weights under ``--models-dir`` (default <cache>/models):
  birefnet-lite-512 / -768 / -1024  BiRefNet-lite (MIT) through the service's own BiRefNetSegmenter
                                    (app/backends/local.py) at that input size; ``birefnet/`` is the
                                    production snapshot (Dockerfile.cpu-ml). 512 is production.
  isnet-general-use                 IS-Net with the DIS general-use weights (Apache-2.0), 1024 px,
                                    ``onnx/isnet-general-use.onnx``
  u2net                             U2-Net (Apache-2.0), 320 px, ``onnx/u2net.onnx``
The ONNX files are rembg's exports (MIT), https://github.com/danielgatis/rembg/releases/download/
v0.0.0/<name>.onnx, checked against rembg's md5. They run as rembg runs them (input / its max,
then mean / std; output min-max stretched to 0..1) on onnxruntime's CPU provider; the resize to the
model's input is the service's (cv2 area when shrinking, linear otherwise), as for BiRefNet.
RMBG-1.4 and RMBG-2.0 (briaai) are not run: their licences forbid commercial use.

Reference: ``<cache>/refs/<id>.npy``, the paid model's (Replicate, full BiRefNet at 1024 px)
cut-out of the photo as the pipeline sees it (fetch.py --refs). It is a proxy, not ground truth: a
candidate that is better than the paid model somewhere scores lower there. Photos without a
reference and expected_no_change photos are skipped.

Per photo, the model's mask and the reference are resized to the photo's frame with the long side
at most ``--eval-long-side`` (1024; the references are that size already) and binarised at 0.5:
IoU, boundary precision / recall / F (contour pixels within ``--tolerance-px``, 3, of the other
mask's contour), MAE of the soft masks, and failure = IoU < ``--fail-iou`` (0.9). ``latency_s`` is
one ``predict`` from the decoded working image to the model-size mask (resize, normalise, forward,
post-process); decoding and scoring are not timed, and one untimed warm-up runs first. The service
runs the model twice per cut-out (the mirrored stability pass), so its segmentation time is ~2x.

Each candidate runs in its own process, one after another, so peak RSS (``getrusage``) is per model;
it holds one of the machine's compute slots (evallib.ComputeSlot) while its model is loaded, with
``--threads`` (3) for torch / onnxruntime / OpenCV and OMP_NUM_THREADS as in Dockerfile.cpu-ml.
Rows are appended to ``<out>/<candidate>.jsonl`` (a re-run resumes; ``--fresh`` starts over), then a
``"kind": "process"`` row with the memory high-water marks; masks go to ``<out>/masks/<candidate>/``.
RSS depends on the platform (macOS reports far more than Linux for the same work), so the summary's
estimate of the service's peak against its 2 GB limit is made only from a Linux run (e.g. in a
container built like Dockerfile.cpu-ml plus onnxruntime, with the code and cache mounted).
``<out>/summary.json`` and ``<out>/summary.md`` compare the candidates on the photos all of them
have a result for (overall, per tier, per category; failures; changes against production).
``<out>`` defaults to ``<cache>/model-eval``.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import platform
import resource
import shutil
import statistics
import subprocess
import sys
import time
from collections import defaultdict
from pathlib import Path
from typing import Any

os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")

import evallib  # noqa: E402  (puts gpu-service/ on sys.path)
import numpy as np  # noqa: E402

IMAGENET_MEAN = (0.485, 0.456, 0.406)
IMAGENET_STD = (0.229, 0.224, 0.225)
REMBG_URL = "https://github.com/danielgatis/rembg/releases/download/v0.0.0/{}"
BIREFNET_LICENCE = "MIT (huggingface.co/ZhengPeng7/BiRefNet_lite model card)"

CANDIDATES: dict[str, dict[str, Any]] = {
    "birefnet-lite-512": {"kind": "birefnet", "size": 512, "weights": "birefnet", "licence": BIREFNET_LICENCE},
    "birefnet-lite-768": {"kind": "birefnet", "size": 768, "weights": "birefnet", "licence": BIREFNET_LICENCE},
    "birefnet-lite-1024": {"kind": "birefnet", "size": 1024, "weights": "birefnet", "licence": BIREFNET_LICENCE},
    "isnet-general-use": {
        "kind": "onnx",
        "size": 1024,
        "weights": "onnx/isnet-general-use.onnx",
        "md5": "fc16ebd8b0c10d971d3513d564d01e29",
        "mean": (0.5, 0.5, 0.5),
        "std": (1.0, 1.0, 1.0),
        "licence": "Apache-2.0 (github.com/xuebinqin/DIS; ONNX export: rembg, MIT)",
    },
    "u2net": {
        "kind": "onnx",
        "size": 320,
        "weights": "onnx/u2net.onnx",
        "md5": "60024c5c889badc19c04ad937298a77b",
        "mean": IMAGENET_MEAN,
        "std": IMAGENET_STD,
        "licence": "Apache-2.0 (github.com/xuebinqin/U-2-Net; ONNX export: rembg, MIT)",
    },
}
EXCLUDED = {
    "RMBG-1.4 (briaai)": "licence bria-rmbg-1.4: source-available for non-commercial use only",
    "RMBG-2.0 (briaai)": "licence bria-rmbg-2.0 (CC BY-NC 4.0): non-commercial use only",
}
BASELINE = "birefnet-lite-512"  # production (docker-compose.vps.yml)
# docker-compose.vps.yml: the image service (BiRefNet-lite 512 + Real-ESRGAN x2/x4 + EAST, torch
# on CPU) peaks at ~1.35 GB on normal photos under a 2 GB limit.
SERVICE_PEAK_MB = 1350
SERVICE_LIMIT_MB = 2048


# ------------------------------------------------------------------------------------------
# Models
# ------------------------------------------------------------------------------------------
class OnnxSegmenter:
    """An ONNX salient-object model, pre- and post-processed as rembg does (sessions/u2net.py,
    sessions/dis_general_use.py), returning the model-size mask like BiRefNetSegmenter."""

    def __init__(self, path: Path, size: int, mean, std, threads: int) -> None:
        import onnxruntime as ort

        opts = ort.SessionOptions()
        opts.intra_op_num_threads = threads
        opts.inter_op_num_threads = 1
        self.session = ort.InferenceSession(str(path), sess_options=opts, providers=["CPUExecutionProvider"])
        self.input = self.session.get_inputs()[0].name
        self.output = self.session.get_outputs()[0].name  # the fused mask; side outputs aren't computed
        self.size = size
        self.mean = np.array(mean, np.float32)
        self.std = np.array(std, np.float32)
        self.name = path.name

    def predict(self, rgb: np.ndarray) -> np.ndarray:
        import cv2

        size = (self.size, self.size)
        shrinking = rgb.shape[0] * rgb.shape[1] > size[0] * size[1]
        x = cv2.resize(rgb, size, interpolation=cv2.INTER_AREA if shrinking else cv2.INTER_LINEAR)
        x = x.astype(np.float32) / max(float(x.max()), 1e-6)
        x = (x - self.mean) / self.std
        x = np.ascontiguousarray(x.transpose(2, 0, 1)[None])
        pred = self.session.run([self.output], {self.input: x})[0][0, 0]
        lo, hi = float(pred.min()), float(pred.max())
        if hi <= lo:
            return np.zeros(pred.shape, np.float32)
        return np.clip((pred - lo) / (hi - lo), 0.0, 1.0).astype(np.float32)

    def close(self) -> None:
        del self.session


def check_weights(name: str, models_dir: Path) -> str | None:
    """Why the candidate's weights can't be used, or None."""
    spec = CANDIDATES[name]
    path = models_dir / spec["weights"]
    if spec["kind"] == "birefnet":
        return None if (path / "model.safetensors").is_file() else f"no BiRefNet snapshot at {path}"
    if not path.is_file():
        return f"no weights at {path} (download {REMBG_URL.format(path.name)})"
    h = hashlib.md5(usedforsecurity=False)  # rembg pins md5
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    if h.hexdigest() != spec["md5"]:
        return f"{path} has md5 {h.hexdigest()}, expected {spec['md5']} (rembg's)"
    return None


def load_segmenter(spec: dict[str, Any], models_dir: Path, threads: int, mem: dict[str, float]):
    """(segmenter, versions); records the RSS high-water mark after importing the framework."""
    if spec["kind"] == "birefnet":
        import torch
        import transformers

        torch.set_num_threads(threads)
        mem["after_framework_mb"] = peak_rss_mb()
        from app.backends.local import BiRefNetSegmenter

        seg = BiRefNetSegmenter(str(models_dir / spec["weights"]), "main", "cpu", spec["size"])
        return seg, {"torch": torch.__version__, "transformers": transformers.__version__, "model": seg.name}
    import onnxruntime as ort

    mem["after_framework_mb"] = peak_rss_mb()
    seg = OnnxSegmenter(models_dir / spec["weights"], spec["size"], spec["mean"], spec["std"], threads)
    return seg, {"onnxruntime": ort.__version__, "model": f"{seg.name} md5:{spec['md5']}"}


# ------------------------------------------------------------------------------------------
# Scoring
# ------------------------------------------------------------------------------------------
def peak_rss_mb() -> float:
    peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss  # bytes on macOS, KiB on Linux
    return round(peak / (1 << 20 if sys.platform == "darwin" else 1 << 10), 1)


def contour(mask: np.ndarray) -> np.ndarray:
    """The inner 1 px contour of a boolean mask (erode pads with foreground: the frame's edge
    is not a contour)."""
    import cv2

    m = mask.astype(np.uint8)
    return (m - cv2.erode(m, np.ones((3, 3), np.uint8))).astype(bool)


def score(pred: np.ndarray, ref: np.ndarray, tolerance_px: float) -> dict[str, float]:
    """IoU and boundary P / R / F of the binarised masks (same size), MAE of the soft ones."""
    import cv2

    p, r = pred > 0.5, ref > 0.5
    union = int((p | r).sum())
    iou = float((p & r).sum() / union) if union else 1.0
    cp, cr = contour(p), contour(r)
    if not cp.any() or not cr.any():
        prec = rec = f = 1.0 if cp.any() == cr.any() else 0.0
    else:
        # distance of every pixel to the nearest contour pixel of the other mask
        to_ref = cv2.distanceTransform((~cr).astype(np.uint8), cv2.DIST_L2, cv2.DIST_MASK_PRECISE)
        to_pred = cv2.distanceTransform((~cp).astype(np.uint8), cv2.DIST_L2, cv2.DIST_MASK_PRECISE)
        prec = float((to_ref[cp] <= tolerance_px).mean())
        rec = float((to_pred[cr] <= tolerance_px).mean())
        f = 2 * prec * rec / (prec + rec) if prec + rec else 0.0
    return {
        "iou": iou,
        "boundary_f": f,
        "boundary_p": prec,
        "boundary_r": rec,
        "mae": float(np.abs(pred - ref).mean()),
        "fg_pred": float(p.mean()),
        "fg_ref": float(r.mean()),
    }


def eligible(entries: list[dict[str, Any]], cache: Path) -> tuple[list[dict[str, Any]], dict[str, list[str]]]:
    """The photos to score, and the others by reason."""
    keep: list[dict[str, Any]] = []
    skipped: dict[str, list[str]] = {"expected_no_change": [], "no_reference": [], "no_image": []}
    for e in entries:
        if e.get("expected_no_change"):
            skipped["expected_no_change"].append(e["id"])
        elif not evallib.ref_path(cache, e["id"]).exists():
            skipped["no_reference"].append(e["id"])
        elif not evallib.image_path(cache, e).exists():
            skipped["no_image"].append(e["id"])
        else:
            keep.append(e)
    return keep, skipped


def load_rows(path: Path) -> tuple[dict[str, dict[str, Any]], list[dict[str, Any]]]:
    """(last photo row per id, process rows) of a candidate's JSONL."""
    photos: dict[str, dict[str, Any]] = {}
    procs: list[dict[str, Any]] = []
    if path.exists():
        for line in path.read_text().splitlines():
            try:
                row = json.loads(line)
            except json.JSONDecodeError:  # blank, or cut off by a crash
                continue
            if row.get("kind") == "process":
                procs.append(row)
            else:
                photos[row["id"]] = row
    return photos, procs


def cpu_name() -> str:
    try:
        if sys.platform == "darwin":
            cmd = ["sysctl", "-n", "machdep.cpu.brand_string"]
            return subprocess.run(cmd, capture_output=True, text=True, check=True).stdout.strip()
        for line in Path("/proc/cpuinfo").read_text().splitlines():
            if line.startswith("model name"):
                return line.split(":", 1)[1].strip()
    except (OSError, subprocess.SubprocessError):
        pass
    return platform.processor() or platform.machine()


# ------------------------------------------------------------------------------------------
# One candidate (runs in its own process)
# ------------------------------------------------------------------------------------------
def run_worker(args: argparse.Namespace) -> int:
    import cv2

    from app.imageio import load_image
    from app.ops import fit_long_side, image_size, resize_mask

    name = args.worker
    spec = CANDIDATES[name]
    cv2.setNumThreads(args.threads)
    mem: dict[str, float] = {"after_imports_mb": peak_rss_mb()}
    cache = args.cache.expanduser().resolve()
    log = args.out / f"{name}.jsonl"
    done, _ = load_rows(log)
    entries, _ = eligible(evallib.select(evallib.load_manifest(), args.only), cache)
    todo = [e for e in entries if e["id"] not in done or "error" in done[e["id"]]]
    if not todo:
        print(json.dumps({"candidate": name, "todo": 0}), flush=True)
        return 0
    cfg = evallib.eval_config()
    masks = args.out / "masks" / name
    masks.mkdir(parents=True, exist_ok=True)

    def working(entry: dict[str, Any]) -> np.ndarray:
        data = evallib.image_path(cache, entry).read_bytes()
        return load_image(data, max_source_pixels=cfg.max_source_pixels, max_working_pixels=cfg.max_working_pixels).rgb

    def append(row: dict[str, Any]) -> None:
        with log.open("a") as f:
            f.write(json.dumps(row) + "\n")

    started = time.strftime("%Y-%m-%dT%H:%M:%S%z")
    loads: list[float] = []
    ok = 0
    with evallib.ComputeSlot(args.slot_dir or cache.parent):
        t = time.perf_counter()
        try:
            seg, versions = load_segmenter(spec, args.models_dir, args.threads, mem)
        except Exception as exc:  # noqa: BLE001 - reported in the summary
            append({"kind": "process", "candidate": name, "error": f"{type(exc).__name__}: {exc}"[:500]})
            raise
        load_s = time.perf_counter() - t
        mem["after_load_mb"] = peak_rss_mb()
        seg.predict(working(todo[0]))  # warm-up, not timed
        mem["after_warmup_mb"] = peak_rss_mb()
        for i, entry in enumerate(todo, 1):
            row: dict[str, Any] = {"kind": "photo", "id": entry["id"], "candidate": name}
            try:
                rgb = working(entry)
                ref = np.load(evallib.ref_path(cache, entry["id"])).astype(np.float32)
                w, h = image_size(rgb)
                if abs(w / h - ref.shape[1] / ref.shape[0]) >= 0.01:
                    raise ValueError(f"reference is {ref.shape[1]}x{ref.shape[0]}, the photo {w}x{h}")
                t0 = time.perf_counter()
                mask = seg.predict(rgb)
                latency = time.perf_counter() - t0
                frame = fit_long_side(w, h, min(args.eval_long_side, max(w, h)))
                pred = resize_mask(mask, frame)
                row.update(
                    latency_s=round(latency, 4),
                    working=[w, h],
                    frame=list(frame),
                    model_mask=list(image_size(mask)),
                    **{k: round(v, 5) for k, v in score(pred, resize_mask(ref, frame), args.tolerance_px).items()},
                )
                cv2.imwrite(str(masks / f"{entry['id']}.png"), np.round(pred * 255).astype(np.uint8))
                ok += 1
            except Exception as exc:  # noqa: BLE001 - reported per photo
                row["error"] = f"{type(exc).__name__}: {exc}"[:300]
            loads.append(os.getloadavg()[0])
            row["loadavg_1m"] = round(loads[-1], 2)
            append(row)
            brief = {k: row[k] for k in ("iou", "boundary_f", "latency_s", "error") if k in row}
            print(f"[{i}/{len(todo)}] {name} {entry['id']} {json.dumps(brief)}", flush=True)
        mem["peak_mb"] = peak_rss_mb()
        seg.close()
    append(
        {
            "kind": "process",
            "candidate": name,
            "photos": ok,
            "threads": args.threads,
            "input_size": spec["size"],
            "load_s": round(load_s, 2),
            **mem,
            "loadavg_1m_mean": round(statistics.fmean(loads), 2),
            "started": started,
            "finished": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
            "platform": platform.platform(),
            "cpu": cpu_name(),
            "cpu_count": os.cpu_count(),
            "versions": {"python": platform.python_version(), "numpy": np.__version__, **versions},
        }
    )
    return 0


# ------------------------------------------------------------------------------------------
# Summary
# ------------------------------------------------------------------------------------------
def _pct(values: list[float], q: float) -> float | None:
    """Nearest-rank percentile."""
    if not values:
        return None
    s = sorted(values)
    return s[min(len(s) - 1, max(0, math.ceil(q * len(s)) - 1))]


def _r(x: float | None, n: int = 4) -> float | None:
    return None if x is None else round(x, n)


def aggregate(rows: list[dict[str, Any]], fail_iou: float) -> dict[str, Any]:
    iou = [r["iou"] for r in rows]
    bf = [r["boundary_f"] for r in rows]
    lat = [r["latency_s"] for r in rows]
    fails = sorted(r["id"] for r in rows if r["iou"] < fail_iou)
    n = len(rows)
    return {
        "photos": n,
        "iou_mean": _r(statistics.fmean(iou)) if n else None,
        "iou_median": _r(statistics.median(iou)) if n else None,
        "boundary_f_mean": _r(statistics.fmean(bf)) if n else None,
        "boundary_f_median": _r(statistics.median(bf)) if n else None,
        "mae_mean": _r(statistics.fmean(r["mae"] for r in rows), 5) if n else None,
        "failures": len(fails),
        "failure_rate": _r(len(fails) / n) if n else None,
        "failed_ids": fails,
        "latency_p50_s": _r(_pct(lat, 0.5), 3),
        "latency_p90_s": _r(_pct(lat, 0.9), 3),
        "latency_mean_s": _r(statistics.fmean(lat), 3) if n else None,
    }


def grouped(rows: list[dict[str, Any]], key: str, fail_iou: float) -> dict[str, dict[str, Any]]:
    groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for r in rows:
        vals = r[key]
        for v in vals if isinstance(vals, list) else [vals]:
            groups[str(v)].append(r)
    out = {}
    for g in sorted(groups):
        m = aggregate(groups[g], fail_iou)
        out[g] = {k: m[k] for k in ("photos", "iou_mean", "boundary_f_mean", "failures", "failure_rate", "failed_ids")}
    return out


def memory(spec: dict[str, Any], procs: list[dict[str, Any]]) -> dict[str, Any]:
    procs = [p for p in procs if "peak_mb" in p]
    if not procs:
        return {}
    top = max(procs, key=lambda p: p["peak_mb"])
    # What the model adds to a process that already has its framework imported; ONNX also counts
    # onnxruntime itself (the service keeps torch for Real-ESRGAN either way).
    base = top["after_imports_mb"] if spec["kind"] == "onnx" else top["after_framework_mb"]
    return {
        "peak_rss_mb": top["peak_mb"],
        "after_imports_mb": top["after_imports_mb"],
        "after_framework_mb": top["after_framework_mb"],
        "after_load_mb": top["after_load_mb"],
        "model_share_mb": round(top["peak_mb"] - base, 1),
        "load_s": top["load_s"],
        "processes": len(procs),
        "loadavg_1m_mean": statistics.fmean(p["loadavg_1m_mean"] for p in procs),
        "cpu": top.get("cpu"),
        "platform": top.get("platform"),
        "versions": top.get("versions"),
    }


def build_summary(args: argparse.Namespace, chosen: list[str], problems: dict[str, str]) -> dict[str, Any]:
    cache = args.cache.expanduser().resolve()
    selected = evallib.select(evallib.load_manifest(), args.only)
    entries, skipped = eligible(selected, cache)
    by_id = {e["id"]: e for e in entries}
    results: dict[str, dict[str, dict[str, Any]]] = {}
    procs: dict[str, list[dict[str, Any]]] = {}
    not_run = dict(problems)
    errors: dict[str, dict[str, str]] = {}
    for name in chosen:
        photos, procs[name] = load_rows(args.out / f"{name}.jsonl")
        results[name] = {i: r for i, r in photos.items() if i in by_id and "error" not in r}
        errors[name] = {i: r["error"] for i, r in photos.items() if i in by_id and "error" in r}
        failed_loads = [p["error"] for p in procs[name] if "error" in p]
        if not results[name] and name not in not_run:
            not_run[name] = failed_loads[-1] if failed_loads else "no results"
    ran = [n for n in chosen if results[n]]
    common = sorted(set.intersection(*(set(results[n]) for n in ran))) if ran else []
    missing = {n: sorted(set(by_id) - set(results[n])) for n in ran if set(by_id) - set(results[n])}

    def rows_of(name: str) -> list[dict[str, Any]]:
        return [{**results[name][i], **{k: by_id[i][k] for k in ("tier", "categories", "conditions")}} for i in common]

    models: dict[str, Any] = {}
    for name in ran:
        spec = CANDIDATES[name]
        rows = rows_of(name)
        mem = memory(spec, procs[name])
        by_cat = grouped(rows, "categories", args.fail_iou)
        worst = sorted((c for c in by_cat if by_cat[c]["photos"] >= 3), key=lambda c: by_cat[c]["iou_mean"])[:3]
        models[name] = {
            "licence": spec["licence"],
            "input_px": spec["size"],
            "runtime": "torch" if spec["kind"] == "birefnet" else "onnxruntime",
            "overall": aggregate(rows, args.fail_iou),
            "memory": mem,
            "by_tier": grouped(rows, "tier", args.fail_iou),
            "by_category": by_cat,
            "by_condition": grouped(rows, "conditions", args.fail_iou),
            "worst_categories": [{"category": c, **by_cat[c]} for c in worst],
            "errors": errors[name],
        }
    # SERVICE_PEAK_MB is a Linux container figure; macOS RSS of the same work is far higher, so
    # the estimate is made only from Linux measurements.
    base_mem = models.get(BASELINE, {}).get("memory", {})
    for m in models.values():
        share, base_share = m["memory"].get("model_share_mb"), base_mem.get("model_share_mb")
        linux = all(str(x.get("platform", "")).startswith("Linux") for x in (m["memory"], base_mem))
        m["memory"]["est_service_peak_mb"] = (
            round(SERVICE_PEAK_MB - base_share + share) if linux and share is not None and base_share else None
        )
    if BASELINE in models:
        base = {r["id"]: r for r in rows_of(BASELINE)}
        for name in ran:
            if name == BASELINE:
                continue
            rows = rows_of(name)
            d_iou = [r["iou"] - base[r["id"]]["iou"] for r in rows]
            d_bf = [r["boundary_f"] - base[r["id"]]["boundary_f"] for r in rows]
            models[name]["vs_baseline"] = {
                "baseline": BASELINE,
                "iou_delta_mean": _r(statistics.fmean(d_iou)),
                "boundary_f_delta_mean": _r(statistics.fmean(d_bf)),
                "iou_better_by_0.01": sum(d > 0.01 for d in d_iou),
                "iou_worse_by_0.01": sum(d < -0.01 for d in d_iou),
                "fixed": sorted(
                    r["id"] for r in rows if base[r["id"]]["iou"] < args.fail_iou <= r["iou"]
                ),  # production fails, this one doesn't
                "broken": sorted(r["id"] for r in rows if r["iou"] < args.fail_iou <= base[r["id"]]["iou"]),
            }
    every = sorted(set.intersection(*(set(m["overall"]["failed_ids"]) for m in models.values()))) if models else []
    return {
        "meta": {
            "reference": "Replicate full BiRefNet (1024 px) cut-out, <cache>/refs/<id>.npy (a proxy, not ground truth)",
            "eval_long_side": args.eval_long_side,
            "tolerance_px": args.tolerance_px,
            "fail_iou": args.fail_iou,
            "threads": args.threads,
            "timed": "one predict(): working image -> model-size mask; warm-up excluded; the service runs it twice",
            "service_peak_mb": SERVICE_PEAK_MB,
            "service_limit_mb": SERVICE_LIMIT_MB,
            "est_service_peak": "service_peak_mb - model_share_mb(baseline) + model_share_mb(candidate), Linux only",
        },
        "photos_in_manifest": len(selected),
        "photos_compared": len(common),
        "skipped": skipped,
        "missing_results": missing,
        "every_model_fails": every,
        "models": models,
        "not_run": not_run,
        "excluded_for_licence": EXCLUDED,
    }


def _table(headers: list[str], rows: list[list[Any]]) -> list[str]:
    def cell(v: Any) -> str:
        if v is None:
            return "-"
        return f"{v:.3f}" if isinstance(v, float) else str(v)

    out = ["| " + " | ".join(headers) + " |", "|" + "|".join("---" for _ in headers) + "|"]
    return out + ["| " + " | ".join(cell(v) for v in row) + " |" for row in rows]


def render_markdown(s: dict[str, Any]) -> str:
    meta, models = s["meta"], s["models"]
    names = list(models)
    if not names:
        return f"# Segmentation models vs the paid reference\n\nNo results. Not run: {s['not_run']}\n"
    lines = [
        "# Segmentation models vs the paid reference",
        "",
        f"Reference: {meta['reference']}. {s['photos_compared']} photos compared (of {s['photos_in_manifest']}; "
        f"skipped: {len(s['skipped']['expected_no_change'])} expected_no_change, "
        f"{len(s['skipped']['no_reference'])} without a reference). Masks at <= {meta['eval_long_side']} px long "
        f"side, binarised at 0.5; boundary F within {meta['tolerance_px']} px; failure = IoU < {meta['fail_iou']}. "
        f"Latency: {meta['timed']}, {meta['threads']} threads.",
        "",
        "## Overall",
        "",
    ]
    rows = []
    for n in names:
        o, mem = models[n]["overall"], models[n]["memory"]
        rows.append(
            [
                n,
                models[n]["licence"].split(" (")[0],
                o["iou_mean"],
                o["iou_median"],
                o["boundary_f_mean"],
                o["boundary_f_median"],
                f"{o['failures']}/{o['photos']} ({o['failure_rate']:.1%})",
                o["latency_p50_s"],
                o["latency_p90_s"],
                mem.get("peak_rss_mb"),
                mem.get("model_share_mb"),
                mem.get("est_service_peak_mb"),
            ]
        )
    lines += _table(
        [
            "model",
            "licence",
            "IoU mean",
            "IoU median",
            "BF mean",
            "BF median",
            "failures",
            "p50 s",
            "p90 s",
            "peak RSS MB",
            "model share MB",
            "est. service peak MB",
        ],
        rows,
    )
    first = next((models[n]["memory"] for n in names if models[n]["memory"]), {})
    loads = ", ".join(f"{n} {models[n]['memory'].get('loadavg_1m_mean', 0):.1f}" for n in names)
    lines += [
        "",
        f"Measured on {first.get('cpu')} ({first.get('platform')}); mean 1-min load average during each run: "
        f"{loads}. Peak RSS is the whole segmentation-only process (getrusage); model share = peak minus the "
        "RSS after importing torch (BiRefNet) or before importing onnxruntime (ONNX). Est. service peak (Linux "
        f"runs only) = {meta['service_peak_mb']} MB (the production container with BiRefNet-lite 512, "
        f"Real-ESRGAN and EAST) with the baseline's model share swapped for the candidate's; limit "
        f"{meta['service_limit_mb']} MB.",
        "",
        "## Per tier (IoU mean / BF mean / failures of n)",
        "",
    ]
    tiers = [t for t in ("EASY", "MEDIUM", "HARD") if any(t in models[n]["by_tier"] for n in names)]
    lines += _table(
        ["model", *tiers],
        [
            [n]
            + [
                (
                    f"{g['iou_mean']:.3f} / {g['boundary_f_mean']:.3f} / {g['failures']} of {g['photos']}"
                    if (g := models[n]["by_tier"].get(t))
                    else "-"
                )
                for t in tiers
            ]
            for n in names
        ],
    )
    lines += ["", "## Per category (IoU mean / failures; a photo counts in each of its categories)", ""]
    cats = sorted({c for n in names for c in models[n]["by_category"]})
    lines += _table(
        ["category", "n", *names],
        [
            [c, models[names[0]]["by_category"][c]["photos"]]
            + [
                f"{models[n]['by_category'][c]['iou_mean']:.3f} / {models[n]['by_category'][c]['failures']}"
                for n in names
            ]
            for c in cats
        ],
    )
    lines += ["", "## Worst categories per model (n >= 3, by mean IoU)", ""]
    for n in names:
        worst = ", ".join(
            f"{w['category']} {w['iou_mean']:.3f} ({w['failures']}/{w['photos']} fail)"
            for w in models[n]["worst_categories"]
        )
        lines.append(f"- {n}: {worst}")
    if any("vs_baseline" in models[n] for n in names):
        lines += ["", f"## Against production ({BASELINE}), same photos", ""]
        rows = []
        for n in names:
            v = models[n].get("vs_baseline")
            if v:
                rows.append(
                    [
                        n,
                        f"{v['iou_delta_mean']:+.4f}",
                        f"{v['boundary_f_delta_mean']:+.4f}",
                        v["iou_better_by_0.01"],
                        v["iou_worse_by_0.01"],
                        ", ".join(v["fixed"]) or "-",
                        ", ".join(v["broken"]) or "-",
                    ]
                )
        lines += _table(
            ["model", "IoU delta", "BF delta", "IoU +0.01", "IoU -0.01", "fixes (prod fails)", "breaks"], rows
        )
    lines += ["", f"## Failures (IoU < {meta['fail_iou']})", ""]
    for n in names:
        lines.append(f"- {n}: {', '.join(models[n]['overall']['failed_ids']) or '-'}")
    lines.append(f"- every model: {', '.join(s['every_model_fails']) or '-'}")
    lines += ["", "## Not run", ""]
    for k, v in {**s["not_run"], **s["excluded_for_licence"]}.items():
        lines.append(f"- {k}: {v}")
    if s["missing_results"]:
        lines.append(f"- photos missing for some models (left out of the comparison): {s['missing_results']}")
    return "\n".join(lines) + "\n"


# ------------------------------------------------------------------------------------------
def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--cache", type=Path, default=evallib.default_cache())
    ap.add_argument(
        "--models-dir",
        type=Path,
        default=Path(os.environ["EVAL_MODELS_DIR"]) if os.environ.get("EVAL_MODELS_DIR") else None,
        help="dir with birefnet/ and onnx/*.onnx ($EVAL_MODELS_DIR; default <cache>/models)",
    )
    ap.add_argument("--candidates", help=f"comma-separated, default all: {','.join(CANDIDATES)}")
    ap.add_argument("--only", help="comma-separated photo ids")
    ap.add_argument("--out", type=Path, help="results dir (default <cache>/model-eval)")
    ap.add_argument("--fresh", action="store_true", help="discard the chosen candidates' saved results first")
    ap.add_argument("--report-only", action="store_true", help="only re-aggregate the saved results")
    ap.add_argument("--list", action="store_true", help="print the candidates and exclusions")
    ap.add_argument("--threads", type=int, default=3, help="CPU threads per model (production VPS: 3)")
    ap.add_argument("--eval-long-side", type=int, default=1024, help="scoring size, long side in px")
    ap.add_argument("--tolerance-px", type=float, default=3.0, help="boundary F tolerance at the scoring size")
    ap.add_argument("--fail-iou", type=float, default=0.9, help="IoU below this is a failure")
    ap.add_argument(
        "--slot-dir",
        type=Path,
        default=Path(os.environ["EVAL_SLOT_DIR"]) if os.environ.get("EVAL_SLOT_DIR") else None,
        help="compute-slot lock dir ($EVAL_SLOT_DIR; default: the cache's parent dir)",
    )
    ap.add_argument("--worker", choices=list(CANDIDATES), help=argparse.SUPPRESS)
    args = ap.parse_args()

    cache = args.cache.expanduser().resolve()
    args.models_dir = (args.models_dir or cache / "models").expanduser().resolve()
    args.out = (args.out or cache / "model-eval").expanduser().resolve()
    if args.worker:
        return run_worker(args)
    if args.list:
        for name, spec in CANDIDATES.items():
            print(f"{name:20s} {spec['size']:5d} px  {spec['licence']}")
        for name, why in EXCLUDED.items():
            print(f"{name:20s} excluded: {why}")
        return 0
    chosen = [c.strip() for c in (args.candidates or ",".join(CANDIDATES)).split(",") if c.strip()]
    unknown = [c for c in chosen if c not in CANDIDATES]
    if unknown:
        raise SystemExit(f"unknown candidates: {', '.join(unknown)} (known: {', '.join(CANDIDATES)})")
    args.out.mkdir(parents=True, exist_ok=True)

    problems: dict[str, str] = {}
    if not args.report_only:
        for name in chosen:
            problem = check_weights(name, args.models_dir)
            if problem:
                problems[name] = problem
                print(f"{name}: not run: {problem}", file=sys.stderr)
                continue
            if args.fresh:
                (args.out / f"{name}.jsonl").unlink(missing_ok=True)
                shutil.rmtree(args.out / "masks" / name, ignore_errors=True)
            cmd = [sys.executable, str(Path(__file__).resolve()), "--worker", name, "--cache", str(cache)]
            cmd += ["--models-dir", str(args.models_dir), "--out", str(args.out), "--threads", str(args.threads)]
            cmd += ["--eval-long-side", str(args.eval_long_side), "--tolerance-px", str(args.tolerance_px)]
            if args.only:
                cmd += ["--only", args.only]
            if args.slot_dir:
                cmd += ["--slot-dir", str(args.slot_dir)]
            env = {**os.environ, "OMP_NUM_THREADS": str(args.threads)}  # as Dockerfile.cpu-ml
            code = subprocess.run(cmd, env=env, check=False).returncode
            if code:
                problems[name] = f"worker exited with status {code}"
                print(f"{name}: {problems[name]}", file=sys.stderr)

    summary = build_summary(args, chosen, problems)
    (args.out / "summary.json").write_text(json.dumps(summary, indent=1) + "\n")
    md = render_markdown(summary)
    (args.out / "summary.md").write_text(md)
    print("\n" + md)
    print(f"summary: {args.out / 'summary.md'}, {args.out / 'summary.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
