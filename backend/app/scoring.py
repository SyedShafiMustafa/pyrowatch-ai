"""Explainable score. Every factor is 0-1; weights are analyst-tunable judgement, NOT learned."""
import numpy as np
import pandas as pd

DEFAULT_WEIGHTS = {"recency": 0.25, "confidence": 0.20, "frp": 0.25, "repeats": 0.20, "brightness": 0.10}
CELL_DEG = 0.02  # ~2 km grid for repeat counting
REPEAT_WINDOW_H = 72


def score(df: pd.DataFrame, weights=None, half_life_h=24.0, ref_time=None):
    """Adds factor columns f_*, point contributions c_*, and 'score' (0-100)."""
    if df.empty:
        return df
    w = {**DEFAULT_WEIGHTS, **(weights or {})}
    total_w = sum(w.values()) or 1.0
    d = df.copy()
    ref = ref_time or d["time"].max()
    age_h = (ref - d["time"]).dt.total_seconds() / 3600
    p95 = max(d["frp"].quantile(0.95), 1e-6)

    d["cell"] = list(zip((d["latitude"] / CELL_DEG).round(), (d["longitude"] / CELL_DEG).round()))
    reps = []
    for cell, grp in d.groupby("cell"):
        for idx, t in grp["time"].items():
            n = ((grp["time"] - t).abs() <= pd.Timedelta(hours=REPEAT_WINDOW_H)).sum() - 1
            reps.append((idx, int(n)))
    d["repeat_count"] = pd.Series(dict(reps))

    d["f_recency"] = 0.5 ** (age_h / half_life_h)
    d["f_confidence"] = d["confidence"]
    d["f_frp"] = (np.log1p(d["frp"]) / np.log1p(p95)).clip(0, 1)
    d["f_repeats"] = (d["repeat_count"] / 4).clip(0, 1)
    d["f_brightness"] = ((d["brightness"] - 300) / 100).clip(0, 1)
    for k in w:
        d[f"c_{k}"] = 100 * w[k] * d[f"f_{k}"] / total_w
    d["score"] = sum(d[f"c_{k}"] for k in w)
    return d.sort_values("score", ascending=False).reset_index(drop=True)


def explain(row) -> str:
    parts = sorted(((k, row[f"c_{k}"]) for k in DEFAULT_WEIGHTS), key=lambda x: -x[1])
    return "; ".join(f"+{v:.1f} {k}" for k, v in parts)
