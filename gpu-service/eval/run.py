"""Run the real image pipeline over the labelled evaluation set and report how often a bad
cut-out would reach a merchant, what escalation costs, and how long it takes.

    python gpu-service/eval/run.py --cache DIR --models DIR [--only ID,ID] [--fresh]
    python gpu-service/eval/run.py --cache DIR --report-only        # re-score saved results
    python gpu-service/eval/run.py --cache DIR --models DIR --sheets OUT   # labelling sheets

The pipeline runs exactly as in production (local BiRefNet-lite first, the quality gate,
escalation, canvas and export: evallib.eval_config), except that the paid escalation backend is
a stand-in that returns the cached Replicate cut-out of the photo (``<cache>/refs/<id>.npy``,
made once by ``fetch.py --refs``), so a run costs nothing. It records every call as a
Replicate call priced at ``--usd-per-call``. A paid call on anything other than the whole photo
(a crop, say, if the pipeline starts doing that) has no cached answer: it fails like a Replicate
outage unless ``--live-replicate`` is given (then it is made for real and cached).

Holds one of the machine's compute slots (evallib.ComputeSlot) while the models are loaded.
Results are appended to ``<out>/results.jsonl`` (a re-run resumes); the report is printed and
written to ``<out>/report.json``. ``<out>`` defaults to
``<cache>/runs/<pipeline_version>-<config fingerprint>-<code hash>``, so a code or threshold
change starts a new run instead of mixing results.

Labels (labels.json) grade the local cut-out and the paid model's cut-out of each photo as
good / minor / bad. A label counts only while the pipeline still makes the cut-out it was
given for: the kept mask is compared with the mask saved at labelling time
(``<cache>/labelmasks/<id>.<local|paid>.png``); if they differ (a changed local stage), the
result is reported as needing a new label instead of being scored.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib
import io
import json
import logging
import math
import os
import shutil
import statistics
import sys
import textwrap
import time
from collections import defaultdict
from pathlib import Path
from typing import Any

os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")

import evallib  # noqa: E402  (puts gpu-service/ on sys.path)
import numpy as np  # noqa: E402
from PIL import Image, ImageDraw, ImageFont  # noqa: E402

GRADES = {"good": 0, "minor": 1, "bad": 2}
PAID_KIND = "replicate"


def is_paid(method: str) -> bool:
    """replicate, replicate_zoom (the AI gate's retry on a crop)."""
    return method == PAID_KIND or method.startswith(f"{PAID_KIND}_")


MASK_ALPHA = 0.45  # app.imageio.encode_mask_overlay: background alpha = (1 - m) * 0.45
SAME_RESULT_MAX_DIFF = 0.01  # kept mask vs labelled mask: <= 1% of their union differs
NO_CHANGE_CODES = {"no_change", "already_optimized", "already_meets_request", "already_done", "unchanged"}
BLUE = (91, 127, 166)


# ------------------------------------------------------------------------------------------
# Stand-in for the paid backend
# ------------------------------------------------------------------------------------------
def build_cached_paid_backend(cfg, cache: Path, usd_per_call: float, usd_per_upscale: float, live: bool):
    from app.backends.base import Backend, Segmenter, Upscaler, ensure_scale
    from app.backends.replicate import BIREFNET_MODEL, ESRGAN_MODEL
    from app.errors import backend_failed
    from app.ops import lanczos_upscale
    from app.trace import record_replicate_call

    live_backend = None
    if live:
        from app.backends.replicate import build_replicate_backend

        token = os.environ.get("REPLICATE_API_TOKEN")
        if not token:
            raise SystemExit("--live-replicate needs REPLICATE_API_TOKEN")
        live_backend = build_replicate_backend(
            evallib.eval_config(escalation_backend="replicate", replicate_api_token=token, replicate_timeout_s=600)
        )

    version = cfg.replicate_birefnet_version or "unpinned"

    class CachedPaidSegmenter(Segmenter):
        in_process = False  # a paid model: the pipeline never calls it twice

        def __init__(self) -> None:
            self.name = f"BiRefNet@replicate:{version}"
            self.image_id: str | None = None
            self.ref: np.ndarray | None = None
            self.misses = 0

        def use(self, image_id: str) -> None:
            self.image_id = image_id
            path = evallib.ref_path(cache, image_id)
            self.ref = np.load(path).astype(np.float32) if path.exists() else None

        def predict(self, rgb: np.ndarray) -> np.ndarray:
            ref = self.ref
            same_frame = ref is not None and abs(rgb.shape[1] / rgb.shape[0] - ref.shape[1] / ref.shape[0]) < 0.01
            if same_frame:
                record_replicate_call(
                    model=BIREFNET_MODEL,
                    version=version,
                    predict_time_s=1.0,
                    usd_per_s=usd_per_call,
                    duration_ms=0,
                    status="succeeded",
                )
                return ref  # type: ignore[return-value]
            key = hashlib.sha1(np.ascontiguousarray(rgb[::8, ::8]).tobytes()).hexdigest()[:10]
            extra = cache / "refs" / f"{self.image_id}__{key}.npy"
            if extra.exists():
                record_replicate_call(
                    model=BIREFNET_MODEL,
                    version=version,
                    predict_time_s=1.0,
                    usd_per_s=usd_per_call,
                    duration_ms=0,
                    status="succeeded",
                )
                return np.load(extra).astype(np.float32)
            if live_backend is not None:
                mask = live_backend.segmenter.predict(rgb)  # records the real call
                extra.parent.mkdir(parents=True, exist_ok=True)
                np.save(extra, mask.astype(np.float32))
                return mask
            self.misses += 1
            raise backend_failed(
                f"eval: no cached Replicate cut-out for {self.image_id} ({rgb.shape[1]}x{rgb.shape[0]} input)"
            )

    class CachedPaidUpscaler(Upscaler):
        is_ai = True

        def model_name(self, scale) -> str:
            return f"RealESRGAN@replicate:{cfg.replicate_esrgan_version} (eval: Lanczos stand-in)"

        def upscale(self, rgb: np.ndarray, scale) -> np.ndarray:
            record_replicate_call(
                model=ESRGAN_MODEL,
                version=str(cfg.replicate_esrgan_version),
                predict_time_s=1.0,
                usd_per_s=usd_per_upscale,
                duration_ms=0,
                status="succeeded",
            )
            return ensure_scale(rgb, lanczos_upscale(rgb, float(scale)), scale)

    closers = [live_backend.close] if live_backend is not None else []
    return Backend(
        kind=PAID_KIND,
        device="cpu",
        segmenter=CachedPaidSegmenter(),
        upscaler=CachedPaidUpscaler(),
        models_loaded=["segmentation"],
        closers=closers,
    )


# ------------------------------------------------------------------------------------------
# Reading a result
# ------------------------------------------------------------------------------------------
def mask_from_artifact(png: bytes | None) -> np.ndarray | None:
    """The product mask (0..1) from the service's 640 px mask artifact."""
    if not png:
        return None
    alpha = np.asarray(Image.open(io.BytesIO(png)).convert("RGBA").getchannel("A"), dtype=np.float32)
    return np.clip(1.0 - alpha / (MASK_ALPHA * 255.0), 0.0, 1.0)


def mask_difference(a: np.ndarray | None, b: np.ndarray | None) -> float | None:
    """Share of the union of two masks that only one of them covers (0 = same cut-out)."""
    if a is None or b is None:
        return None
    if a.shape != b.shape:
        b = (
            np.asarray(Image.fromarray((b * 255).astype(np.uint8)).resize((a.shape[1], a.shape[0]), Image.NEAREST))
            / 255.0
        )
    ab, bb = a > 0.5, b > 0.5
    union = int((ab | bb).sum())
    return float((ab ^ bb).sum() / union) if union else 0.0


def pipeline_no_change(result) -> tuple[bool | None, str | None]:
    """A no-change decision, if the pipeline reports one (any of the likely shapes)."""
    p = getattr(result, "processing", None)
    final = getattr(p, "final_status", None)
    if isinstance(final, str):  # image service 2026-09-28.1 on
        return final == "NO_CHANGE", "processing.final_status"
    for obj, name in ((result, "result"), (p, "processing")):
        for attr in ("no_change", "unchanged", "already_meets_request"):
            v = getattr(obj, attr, None) if obj is not None else None
            if isinstance(v, dict):
                v = next((v[k] for k in ("decision", "value", "no_change", "unchanged") if k in v), None)
            if isinstance(v, bool):
                return v, f"{name}.{attr}"
    if p is not None and getattr(p, "method", None) in NO_CHANGE_CODES:
        return True, "processing.method"
    codes = {f.code for f in getattr(result, "flags", [])}
    if codes & NO_CHANGE_CODES:
        return True, "flag"
    checks = getattr(p, "quality_checks", None) or {}
    for key in ("no_change", "already_meets_request"):
        if isinstance(checks.get(key), bool):
            return bool(checks[key]), f"quality_checks.{key}"
    return None, None


def summarise(entry: dict[str, Any], result, latency_s: float, no_change_hook) -> dict[str, Any]:
    p = result.processing
    seg = [a for a in p.attempts if a.operation == "background_removal"] if p else []
    used = next((a for a in seg if a.outcome == "used"), None)
    paid = [a for a in seg if is_paid(a.method)]
    final = "none" if used is None else ("paid" if is_paid(used.method) else "local")
    if used is not None and used.method == "source_alpha":
        final = "source_alpha"
    final_status = getattr(p, "final_status", None) if p else None
    if final_status == "NO_CHANGE":
        final = "no_change"
    nc, signal = pipeline_no_change(result)
    return {
        "id": entry["id"],
        "ok": True,
        "latency_s": round(latency_s, 3),
        "timings_ms": {k: round(v) for k, v in result.timings_ms.items()},
        "method": p.method if p else None,
        "paid_calls": p.replicate_calls if p else 0,
        "cost_usd": p.estimated_cost_usd if p else 0.0,
        "escalated": bool(paid),
        "paid_failed": any(a.outcome == "failed" for a in paid),
        "final": final,
        # the local attempt that was kept, or the best one before escalating
        "local_method": used.method
        if final == "local"
        else next((a.method for a in seg if not is_paid(a.method)), None),
        "attempts": [f"{a.method}:{a.outcome}:{a.reason or ''}" for a in seg],
        "fallback_reason": p.fallback_reason if p else None,
        "quality_score": p.quality_score if p else None,
        "cutout_checks": {k: v for k, v in (p.quality_checks.items() if p else []) if k.startswith("cutout_")},
        "flags": [f.code for f in result.flags],
        "status": (
            {"READY": "ready", "NO_CHANGE": "no_change"}.get(final_status, "flagged")
            if final_status
            else ("flagged" if result.flags else "ready")
        ),
        "final_status": final_status,
        "route": getattr(p, "route", None),
        "gate": getattr(p, "gate", None),
        "ai_gate": getattr(p, "ai_gate", None),
        "reason_codes": getattr(p, "reason_codes", None),
        "replicate_attempts": getattr(p, "replicate_attempts", None),
        "quality_scores": getattr(p, "quality_scores", None),
        "complexity": (getattr(p, "analysis", None) or {}).get("background_complexity"),
        "no_change_pred": no_change_hook[1] if no_change_hook else nc,
        "no_change_signal": no_change_hook[0] if no_change_hook else signal,
    }


# ------------------------------------------------------------------------------------------
# Labelling sheets
# ------------------------------------------------------------------------------------------
def _font(size: int):
    try:
        return ImageFont.load_default(size=size)
    except TypeError:  # Pillow < 10.1
        return ImageFont.load_default()


def _fit(img: Image.Image, w: int, h: int, bg=(255, 255, 255)) -> Image.Image:
    img = img.copy()
    img.thumbnail((w, h), Image.LANCZOS)
    out = Image.new("RGB", (w, h), bg)
    out.paste(img, ((w - img.width) // 2, (h - img.height) // 2))
    return out


def cutout_panel(rgb: np.ndarray, mask: np.ndarray | None, size: int) -> Image.Image:
    """The cut-out on a blue background (shows kept shadows, halos and holes that white hides)."""
    if mask is None:
        return _fit(Image.new("RGB", (size, size), (200, 0, 0)), size, size)
    if mask.shape[:2] != rgb.shape[:2]:
        mask = (
            np.asarray(
                Image.fromarray((mask * 255).astype(np.uint8)).resize((rgb.shape[1], rgb.shape[0]), Image.BILINEAR)
            )
            / 255.0
        )
    ys, xs = np.where(mask > 0.5)
    if len(xs) == 0:
        return _fit(Image.new("RGB", (size, size), BLUE), size, size, BLUE)
    pad = int(0.04 * max(rgb.shape[:2]))
    y0, y1 = max(0, ys.min() - pad), min(rgb.shape[0], ys.max() + pad)
    x0, x1 = max(0, xs.min() - pad), min(rgb.shape[1], xs.max() + pad)
    m = mask[y0:y1, x0:x1, None].astype(np.float32)
    comp = rgb[y0:y1, x0:x1].astype(np.float32) * m + np.array(BLUE, np.float32) * (1 - m)
    return _fit(Image.fromarray(np.clip(comp, 0, 255).astype(np.uint8)), size, size, BLUE)


def write_sheet(out: Path, entry, rgb, local, paid) -> None:
    """original | local output | paid output, then the two cut-outs on blue."""
    h = 460
    w0 = min(max(1, round(rgb.shape[1] * h / rgb.shape[0])), 700)
    sheet = Image.new("RGB", (w0 + 2 * h + 20, 2 * h + 60), (60, 60, 60))
    draw = ImageDraw.Draw(sheet)
    font = _font(15)
    sheet.paste(_fit(Image.fromarray(rgb), w0, h, (60, 60, 60)), (0, 30))
    # Blind: the gate's verdict isn't shown, so it can't bias the grade (it is in results.jsonl).
    for i, (name, res) in enumerate((("A: LOCAL model", local), ("B: REPLICATE model", paid))):
        x = w0 + 10 + i * (h + 10)
        draw.text((x, 6), name, fill=(255, 255, 255), font=font)
        sheet.paste(_fit(Image.open(io.BytesIO(res["output"])).convert("RGB"), h, h), (x, 30))
        sheet.paste(cutout_panel(rgb, res["mask"], h), (x, h + 50))
    info = [entry["id"], f"{entry['tier']} {' '.join(entry['categories'])}", " ".join(entry["conditions"])]
    width = max(24, w0 // 8)
    info = [line[:width] for line in info] + textwrap.wrap(entry.get("notes", ""), width)[:18]
    for j, line in enumerate(info):
        draw.text((8, h + 50 + j * 20), line, fill=(255, 255, 255), font=font)
    sheet.save(out, quality=88)


# ------------------------------------------------------------------------------------------
# Metrics
# ------------------------------------------------------------------------------------------
def _rate(num: int, den: int) -> float | None:
    return round(num / den, 4) if den else None


def _pct(values: list[float], q: float) -> float | None:
    if not values:
        return None
    s = sorted(values)
    return round(s[min(len(s) - 1, max(0, math.ceil(q * len(s)) - 1))], 2)


def score_rows(rows: list[dict[str, Any]], labels: dict[str, dict[str, Any]], cache: Path) -> list[dict[str, Any]]:
    """Attach the label of the result each row actually shipped (and whether it still applies)."""
    scored = []
    for r in rows:
        r = dict(r)
        lab = labels.get(r["id"])
        r["label_state"] = "missing"
        if r.get("final") == "no_change":
            r["label_state"] = "no_change"  # the source itself shipped: judged by expected_no_change
        elif lab and r.get("ok"):
            r["local_grade"] = lab["local"]["grade"]
            r["paid_grade"] = lab["paid"]["grade"]
            r["local_reason"] = lab["local"].get("reason")
            r["paid_reason"] = lab["paid"].get("reason")
            which = "paid" if r["final"] == "paid" else "local"
            diff = r.get(f"diff_vs_{which}_label")
            if diff is None:
                r["label_state"] = "unverified"  # no labelling mask in the cache: trusted as is
            elif diff <= SAME_RESULT_MAX_DIFF:
                r["label_state"] = "valid"
            else:
                r["label_state"] = "stale"  # the pipeline now makes a different cut-out
            r["final_grade"] = lab[which]["grade"]
        scored.append(r)
    return scored


def metrics(rows: list[dict[str, Any]], usd_per_call: float, paid_latency_s: float) -> dict[str, Any]:
    ok = [r for r in rows if r.get("ok")]
    scored = [r for r in ok if r["label_state"] in ("valid", "unverified")]
    n = len(scored)
    accepted = [r for r in scored if not r["escalated"]]
    esc = [r for r in scored if r["escalated"]]
    bad = lambda g: g == "bad"  # noqa: E731
    fa = [r for r in accepted if bad(r["local_grade"])]
    shipped_bad = [r for r in scored if bad(r["final_grade"])]
    shipped_bad_ready = [r for r in shipped_bad if r["status"] == "ready"]
    both_bad = [r for r in scored if bad(r["local_grade"]) and bad(r["paid_grade"])]
    lat = [r["latency_s"] for r in ok]
    lat_paid = [r["latency_s"] + r["paid_calls"] * paid_latency_s for r in ok]
    calls = sum(r["paid_calls"] for r in ok)
    nc_rows = [r for r in ok if r.get("expected_no_change") is not None]
    detector = any(r.get("no_change_pred") is not None for r in nc_rows)
    tp = sum(1 for r in nc_rows if r.get("no_change_pred") and r["expected_no_change"])
    fp = sum(1 for r in nc_rows if r.get("no_change_pred") and not r["expected_no_change"])
    fn = sum(1 for r in nc_rows if not r.get("no_change_pred") and r["expected_no_change"])
    return {
        "images": len(rows),
        "errors": len(rows) - len(ok),
        "scored": n,
        "needs_label": len([r for r in ok if r["label_state"] in ("stale", "missing")]),
        "no_change_images": len([r for r in ok if r["label_state"] == "no_change"]),
        "needs_review_rate": _rate(len([r for r in scored if r["status"] == "flagged"]), n),
        "paid_attempts_per_escalation": round(
            sum(r.get("replicate_attempts") or 0 for r in scored) / max(1, len([r for r in scored if r["escalated"]])),
            3,
        ),
        "local_accept_rate": _rate(len(accepted), n),
        "false_accepts": len(fa),
        "false_accept_rate": _rate(len(fa), n),
        "false_accept_share_of_accepted": _rate(len(fa), len(accepted)),
        "minor_accepts": len([r for r in accepted if r["local_grade"] == "minor"]),
        "fallback_rate": _rate(len(esc), n),
        # the gate's view: of the bad local cut-outs, how many it escalated; of the good ones,
        # how many it didn't need to
        "gate_recall_on_bad_local": _rate(
            len([r for r in esc if bad(r["local_grade"])]), len([r for r in scored if bad(r["local_grade"])])
        ),
        "gate_false_alarm_on_good_local": _rate(
            len([r for r in esc if r["local_grade"] == "good"]), len([r for r in scored if r["local_grade"] == "good"])
        ),
        "needless_escalations": len([r for r in esc if r["local_grade"] == "good"]),
        "escalations_that_fixed_a_bad_local": len(
            [r for r in esc if bad(r["local_grade"]) and not bad(r["final_grade"])]
        ),
        "escalations_kept_worse_paid": len(
            [r for r in esc if r["final"] == "paid" and GRADES[r["paid_grade"]] > GRADES[r["local_grade"]]]
        ),
        "shipped_bad_rate": _rate(len(shipped_bad), n),
        "shipped_bad_unflagged": len(shipped_bad_ready),
        "shipped_bad_unflagged_rate": _rate(len(shipped_bad_ready), n),
        "flagged_rate": _rate(len([r for r in scored if r["status"] == "flagged"]), n),
        "both_bad": len(both_bad),
        "both_bad_rate": _rate(len(both_bad), n),
        "no_change": {
            "detector": "reported" if detector else "absent (no decision in the pipeline result)",
            "expected": sum(1 for r in nc_rows if r["expected_no_change"]),
            "predicted": tp + fp,
            "tp": tp,
            "fp": fp,
            "fn": fn,
            "precision": _rate(tp, tp + fp),
            "recall": _rate(tp, tp + fn),
        },
        "latency_s": {
            "mean": round(statistics.fmean(lat), 2) if lat else None,
            "p50": _pct(lat, 0.5),
            "p90": _pct(lat, 0.9),
            "max": _pct(lat, 1.0),
        },
        "latency_with_paid_s": {
            "mean": round(statistics.fmean(lat_paid), 2) if lat_paid else None,
            "p90": _pct(lat_paid, 0.9),
            "paid_latency_s": paid_latency_s,
        },
        "paid_calls": calls,
        "estimated_cost_usd": round(calls * usd_per_call, 4),
        "estimated_cost_per_1000_images_usd": round(1000 * calls * usd_per_call / len(ok), 3) if ok else None,
        "usd_per_call": usd_per_call,
    }


def breakdown(rows, key: str, usd: float, lat: float) -> dict[str, Any]:
    groups: dict[str, list] = defaultdict(list)
    for r in rows:
        vals = r.get(key)
        for v in vals if isinstance(vals, list) else [vals]:
            groups[str(v)].append(r)
    keep = (
        "scored",
        "local_accept_rate",
        "false_accepts",
        "false_accept_rate",
        "fallback_rate",
        "shipped_bad_unflagged",
        "both_bad",
        "estimated_cost_usd",
    )
    out = {}
    for g in sorted(groups):
        m = metrics(groups[g], usd, lat)
        out[g] = {k: m[k] for k in keep}
    return out


def build_report(rows, labels, cache: Path, args, meta: dict[str, Any]) -> dict[str, Any]:
    scored = score_rows(rows, labels, cache)
    report = {"meta": meta, "overall": metrics(scored, args.usd_per_call, args.paid_latency_s)}
    for key in ("tier", "categories", "conditions", "complexity"):
        report[f"by_{key}"] = breakdown(scored, key, args.usd_per_call, args.paid_latency_s)
    counts: dict[str, int] = defaultdict(int)
    for r in scored:
        for code in r.get("reason_codes") or []:
            counts[code] += 1
    report["reason_codes"] = dict(sorted(counts.items(), key=lambda kv: -kv[1]))
    report["final_statuses"] = {
        k: len([r for r in scored if r.get("final_status") == k]) for k in ("READY", "NEEDS_REVIEW", "NO_CHANGE")
    }
    usable = [r for r in scored if r.get("label_state") in ("valid", "unverified")]
    report["false_accepts"] = [
        {
            "id": r["id"],
            "tier": r["tier"],
            "reason": r.get("local_reason"),
            "local_method": r.get("local_method"),
            "status": r["status"],
            "flags": r["flags"],
            "cutout_checks": r.get("cutout_checks"),
        }
        for r in usable
        if not r["escalated"] and r.get("local_grade") == "bad"
    ]
    report["shipped_bad_unflagged"] = [
        {"id": r["id"], "final": r["final"], "reason": r.get("paid_reason" if r["final"] == "paid" else "local_reason")}
        for r in usable
        if r.get("final_grade") == "bad" and r["status"] == "ready"
    ]
    report["both_bad"] = [r["id"] for r in usable if r.get("local_grade") == "bad" and r.get("paid_grade") == "bad"]
    report["needless_escalations"] = [
        {"id": r["id"], "reason": r["fallback_reason"]}
        for r in usable
        if r["escalated"] and r.get("local_grade") == "good"
    ]
    report["needs_label"] = [
        {"id": r["id"], "state": r["label_state"], "final": r.get("final")}
        for r in scored
        if r.get("label_state") in ("stale", "missing") and r.get("ok")
    ]
    report["no_change_mistakes"] = [
        {"id": r["id"], "expected": r["expected_no_change"], "predicted": r.get("no_change_pred")}
        for r in scored
        if r.get("ok") and r.get("no_change_pred") is not None and bool(r["no_change_pred"]) != r["expected_no_change"]
    ]
    report["errors"] = [{"id": r["id"], "error": r.get("error")} for r in scored if not r.get("ok")]
    return report


def print_report(rep: dict[str, Any]) -> None:
    o = rep["overall"]
    print("\n=== Padly eval:", rep["meta"].get("pipeline_version"), rep["meta"].get("config_fingerprint"), "===")
    print(f"images {o['images']}  scored {o['scored']}  needs label {o['needs_label']}  errors {o['errors']}")
    for k in (
        "local_accept_rate",
        "false_accept_rate",
        "false_accepts",
        "false_accept_share_of_accepted",
        "minor_accepts",
        "fallback_rate",
        "gate_recall_on_bad_local",
        "gate_false_alarm_on_good_local",
        "needless_escalations",
        "escalations_that_fixed_a_bad_local",
        "escalations_kept_worse_paid",
        "shipped_bad_rate",
        "shipped_bad_unflagged",
        "flagged_rate",
        "both_bad_rate",
    ):
        print(f"  {k:38s} {o[k]}")
    nc = o["no_change"]
    print(
        f"  {'no_change':38s} detector {nc['detector']}; expected {nc['expected']}, "
        f"predicted {nc['predicted']}, precision {nc['precision']}, recall {nc['recall']}"
    )
    print(f"  {'latency_s (measured, paid = cache)':38s} {o['latency_s']}")
    print(f"  {'latency_s (+ paid latency per call)':38s} {o['latency_with_paid_s']}")
    print(
        f"  {'paid calls / est. cost':38s} {o['paid_calls']} / ${o['estimated_cost_usd']} "
        f"(${o['estimated_cost_per_1000_images_usd']} per 1000 images at ${o['usd_per_call']}/call)"
    )
    print(f"  {'final statuses':38s} {rep.get('final_statuses')}")
    print(f"  {'reason codes':38s} {rep.get('reason_codes')}")
    for key in ("by_tier", "by_categories", "by_conditions", "by_complexity"):
        print(f"\n  {key}: scored / local_accept / false_accepts / fallback / shipped_bad_unflagged / both_bad")
        for g, m in rep[key].items():
            print(
                f"    {g:22s} {m['scored']:4d}  {m['local_accept_rate']}  {m['false_accepts']}  "
                f"{m['fallback_rate']}  {m['shipped_bad_unflagged']}  {m['both_bad']}"
            )
    print("\n  false accepts (local kept, labelled bad):")
    for fa in rep["false_accepts"]:
        print(f"    {fa['id']:36s} {fa['status']:8s} {fa['reason']}")
    if rep["shipped_bad_unflagged"]:
        print("  bad results shipped without a flag:")
        for x in rep["shipped_bad_unflagged"]:
            print(f"    {x['id']:36s} ({x['final']}) {x['reason']}")
    if rep["needs_label"]:
        print("  needs a (new) label:", ", ".join(x["id"] for x in rep["needs_label"]))
    if rep["errors"]:
        print("  errors:", rep["errors"])


# ------------------------------------------------------------------------------------------
def code_hash() -> str:
    h = hashlib.sha256()
    for path in sorted((evallib.SERVICE_DIR / "app").rglob("*.py")):
        h.update(path.relative_to(evallib.SERVICE_DIR).as_posix().encode())
        h.update(path.read_bytes())
    return h.hexdigest()[:8]


def load_hook(spec: str | None):
    if not spec:
        return None
    module, _, fn = spec.partition(":")
    sys.path.insert(0, str(evallib.EVAL_DIR))
    return getattr(importlib.import_module(module), fn)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--cache", type=Path, default=evallib.default_cache())
    ap.add_argument(
        "--models",
        type=Path,
        default=Path(os.environ["EVAL_MODELS_DIR"]) if os.environ.get("EVAL_MODELS_DIR") else None,
        help="models dir with birefnet/, frozen_east_text_detection.pb, RealESRGAN_x2plus.pth ($EVAL_MODELS_DIR)",
    )
    ap.add_argument("--only", help="comma-separated ids")
    ap.add_argument("--tier", choices=["EASY", "MEDIUM", "HARD"])
    ap.add_argument("--out", type=Path, help="results dir (default: <cache>/runs/<version>-<fingerprint>-<code hash>)")
    ap.add_argument("--fresh", action="store_true", help="discard saved results in --out first")
    ap.add_argument("--report-only", action="store_true", help="re-score the saved results with the current labels")
    ap.add_argument(
        "--sheets", type=Path, help="also write labelling sheets + masks (runs local-only and paid-only too)"
    )
    ap.add_argument(
        "--usd-per-call", type=float, default=0.0015, help="price of one paid cut-out (README: $0.0003-0.0015)"
    )
    ap.add_argument("--usd-per-upscale", type=float, default=0.011, help="price of one paid upscale")
    ap.add_argument("--paid-latency-s", type=float, default=4.0, help="added per paid call in latency_with_paid")
    ap.add_argument(
        "--live-replicate", action="store_true", help="make paid calls that have no cached answer (costs money)"
    )
    ap.add_argument(
        "--no-change-hook",
        help="module:function(data: bytes, settings) -> bool, evaluated instead of the pipeline's own decision",
    )
    ap.add_argument("--threads", type=int, default=3, help="CPU threads for the models (production VPS: 3)")
    ap.add_argument(
        "--slot-dir",
        type=Path,
        default=Path(os.environ["EVAL_SLOT_DIR"]) if os.environ.get("EVAL_SLOT_DIR") else None,
        help="compute-slot lock dir ($EVAL_SLOT_DIR; default: the cache's parent dir)",
    )
    args = ap.parse_args()

    cache = args.cache.expanduser().resolve()
    entries = evallib.select(evallib.load_manifest(), args.only)
    if args.tier:
        entries = [e for e in entries if e["tier"] == args.tier]
    labels = evallib.load_labels()

    from app.pipeline import PIPELINE_VERSION

    models = args.models.expanduser().resolve() if args.models else None
    cfg = evallib.eval_config(models)
    meta = {
        "pipeline_version": PIPELINE_VERSION,
        "config_fingerprint": cfg.output_fingerprint(),
        "code_hash": code_hash(),
        "request": evallib.REQUEST,
        "escalate_flip_disagreement": cfg.escalate_flip_disagreement,
        "birefnet_input_size": cfg.birefnet_input_size,
        "threads": args.threads,
    }
    out = (
        args.out or cache / "runs" / f"{PIPELINE_VERSION}-{meta['config_fingerprint']}-{meta['code_hash']}"
    ).resolve()
    if args.fresh and out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True, exist_ok=True)
    log = out / "results.jsonl"
    saved = {}
    if log.exists():
        for line in log.read_text().splitlines():
            if line.strip():
                row = json.loads(line)
                saved[row["id"]] = row

    todo = [e for e in entries if e["id"] not in saved]
    if todo and not args.report_only:
        if models is None:
            raise SystemExit("--models (or $EVAL_MODELS_DIR) is required to run the pipeline")
        missing = [e["id"] for e in todo if not evallib.image_path(cache, e).exists()]
        if missing:
            raise SystemExit(f"not in the cache (run fetch.py): {', '.join(missing[:10])}")
        no_refs = [e["id"] for e in todo if not evallib.ref_path(cache, e["id"]).exists()]
        if no_refs:
            print(
                f"warning: no cached Replicate cut-out for {len(no_refs)} photos (fetch.py --refs); "
                "their escalations fail",
                file=sys.stderr,
            )
        with evallib.ComputeSlot(args.slot_dir or cache.parent):
            run_all(todo, cache, cfg, args, log, saved)
    rows = []
    for e in entries:
        if e["id"] in saved:
            row = dict(saved[e["id"]])
            row.update({k: e[k] for k in ("tier", "categories", "conditions", "expected_no_change")})
            rows.append(row)
    # masks are compared at report time, so --report-only picks up new labelling masks
    for row in rows:
        for which in ("local", "paid"):
            lm = evallib.labelmask_path(cache, row["id"], which)
            fm = out / "masks" / f"{row['id']}.png"
            row[f"diff_vs_{which}_label"] = (
                mask_difference(mask_from_artifact(fm.read_bytes()), mask_from_artifact(lm.read_bytes()))
                if lm.exists() and fm.exists() and (row.get("final") == "paid") == (which == "paid")
                else None
            )
    report = build_report(rows, labels, cache, args, {**meta, "out": str(out), "labels": len(labels)})
    (out / "report.json").write_text(json.dumps(report, indent=1) + "\n")
    print_report(report)
    print(f"\nreport: {out / 'report.json'}")
    return 0


def run_all(todo, cache: Path, cfg, args, log: Path, saved: dict) -> None:
    import cv2
    import torch

    from app.backends.local import build_local_backend
    from app.escalation import EscalationGate
    from app.imageio import load_image
    from app.pipeline import Pipeline
    from app.schemas import ProcessSettings
    from app.text_detect import load_text_detector

    logging.getLogger("app").setLevel(logging.WARNING)  # the service's per-attempt INFO logs
    torch.set_num_threads(args.threads)
    cv2.setNumThreads(args.threads)
    settings = ProcessSettings(**evallib.REQUEST)
    local = build_local_backend(cfg)
    paid = build_cached_paid_backend(cfg, cache, args.usd_per_call, args.usd_per_upscale, args.live_replicate)
    text = load_text_detector(cfg.east_path)
    hook = load_hook(args.no_change_hook)

    def gate():
        return EscalationGate(cooldown_s=0, daily_max_calls=0)

    class Capturing(Pipeline):
        """Keeps the full-resolution cut-out mask for the labelling sheets."""

        captured = None

        def _segment(self, *a, **kw):  # type: ignore[override]
            res = super()._segment(*a, **kw)
            self.captured = getattr(res, "mask", None)
            if self.captured is None and isinstance(res, tuple) and len(res) > 1:  # older pipelines
                self.captured = res[1]
            return res

    pipeline = Pipeline(cfg, local, text, escalation=paid, gate=gate())
    masks = log.parent / "masks"
    masks.mkdir(exist_ok=True)
    try:
        for i, entry in enumerate(todo, 1):
            data = evallib.image_path(cache, entry).read_bytes()
            paid.segmenter.use(entry["id"])
            pipeline.gate = gate()
            try:
                t = time.perf_counter()
                result = pipeline.run(data, settings)
                latency = time.perf_counter() - t
                hooked = None
                if hook is not None:
                    hooked = (args.no_change_hook, bool(hook(data, settings)))
                row = summarise(entry, result, latency, hooked)
                (masks / f"{entry['id']}.png").write_bytes(result.artifacts["mask"])
            except Exception as exc:  # noqa: BLE001 - reported per image
                row = {"id": entry["id"], "ok": False, "error": f"{type(exc).__name__}: {exc}"[:300]}
            if args.sheets and row.get("ok"):
                src = load_image(
                    data, max_source_pixels=cfg.max_source_pixels, max_working_pixels=cfg.max_working_pixels
                )
                views = {}
                for name, backend in (("local", local), ("paid", paid)):
                    p = Capturing(cfg, backend, text, escalation=None, gate=gate())
                    res = p.run(data, settings)
                    seg = [a for a in res.processing.attempts if a.operation == "background_removal"]
                    views[name] = {
                        "output": res.artifacts["output"],
                        "mask": p.captured if p.captured is not None else mask_from_artifact(res.artifacts["mask"]),
                        "method": next((a.method for a in seg if a.outcome == "used"), "?"),
                        "reasons": ",".join(a.reason for a in seg if a.reason),
                    }
                    args.sheets.mkdir(parents=True, exist_ok=True)
                    (args.sheets / f"{entry['id']}.{name}.png").write_bytes(res.artifacts["mask"])
                write_sheet(args.sheets / f"{entry['id']}.jpg", entry, src.rgb, views["local"], views["paid"])
            saved[entry["id"]] = row
            with log.open("a") as f:
                f.write(json.dumps(row) + "\n")
            brief = {
                k: row.get(k)
                for k in ("id", "latency_s", "method", "final", "fallback_reason", "status", "error")
                if row.get(k) is not None
            }
            print(f"[{i}/{len(todo)}] {json.dumps(brief)}", flush=True)
    finally:
        local.close()
        paid.close()


if __name__ == "__main__":
    raise SystemExit(main())
