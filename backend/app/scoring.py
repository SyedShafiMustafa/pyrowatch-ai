"""Deterministic, explainable heuristic priority for analyst review."""
from collections.abc import Mapping
import math

import numpy as np
import pandas as pd

DEFAULT_WEIGHTS = {
    "recency": 0.25,
    "confidence": 0.20,
    "frp": 0.25,
    "repeats": 0.20,
    "brightness": 0.10,
}
CELL_DEG = 0.02  # Approximate spatial bins; not pixel boundaries.
REPEAT_WINDOW_H = 72
RECENCY_HALF_LIFE_H = 24.0
FRP_REFERENCE_MW = 100.0
BRIGHTNESS_BASE_K = 300.0
BRIGHTNESS_SPAN_K = 100.0
MAX_REPEAT_FACTOR_COUNT = 4


def _effective_weights(weights):
    if weights is None:
        supplied = {}
    elif isinstance(weights, Mapping):
        supplied = weights
    else:
        raise ValueError("weights must be a mapping")
    unknown = set(supplied) - set(DEFAULT_WEIGHTS)
    if unknown:
        raise ValueError(f"unknown scoring weights: {', '.join(sorted(map(str, unknown)))}")
    effective = dict(DEFAULT_WEIGHTS)
    for name, value in supplied.items():
        try:
            numeric = float(value)
        except (TypeError, ValueError, OverflowError):
            raise ValueError(f"weight {name} must be finite and non-negative") from None
        if not math.isfinite(numeric) or numeric < 0:
            raise ValueError(f"weight {name} must be finite and non-negative")
        effective[name] = numeric
    try:
        total = math.fsum(effective.values())
    except OverflowError:
        raise ValueError("scoring weights must have a finite total") from None
    if not math.isfinite(total) or total <= 0:
        raise ValueError("at least one scoring weight must be positive")
    return {name: value / total for name, value in effective.items()}


def _numeric_feature(df, name, *, minimum=None, maximum=None):
    if name not in df:
        return pd.Series(np.nan, index=df.index, dtype="float64")
    raw = df[name]
    values = pd.to_numeric(raw, errors="coerce").astype("float64")
    present = raw.notna() & raw.astype(str).str.strip().ne("")
    if (present & values.isna()).any():
        raise ValueError(f"{name} values must be numeric or missing")
    finite = values.dropna().to_numpy()
    if not np.isfinite(finite).all():
        raise ValueError(f"{name} values must be finite or missing")
    if minimum is not None and (values.dropna() < minimum).any():
        raise ValueError(f"{name} values must be at least {minimum}")
    if maximum is not None and (values.dropna() > maximum).any():
        raise ValueError(f"{name} values must be at most {maximum}")
    return values


def _timestamps(df, ref_time):
    if "time" not in df:
        raise ValueError("time is required for scoring")
    times = pd.to_datetime(df["time"], utc=True, errors="coerce")
    if times.isna().any():
        raise ValueError("time values must be valid UTC timestamps")
    if ref_time is None:
        ref = times.max()
    else:
        ref = pd.to_datetime(ref_time, utc=True, errors="coerce")
        if pd.isna(ref):
            raise ValueError("ref_time must be a valid timestamp")
    return times, ref


def _repeat_counts(d):
    """Count distinct acquisition times in the same approximate bin, +/- 72 h."""
    cells = list(zip((d["latitude"] / CELL_DEG).round(),
                     (d["longitude"] / CELL_DEG).round()))
    unique_times_by_cell = {}
    for cell, timestamp in zip(cells, d["time"]):
        unique_times_by_cell.setdefault(cell, set()).add(timestamp)
    window = pd.Timedelta(hours=REPEAT_WINDOW_H)
    counts = []
    for cell, timestamp in zip(cells, d["time"]):
        counts.append(sum(
            1 for other in unique_times_by_cell[cell]
            if other != timestamp and abs(other - timestamp) <= window
        ))
    return pd.Series(counts, index=d.index, dtype="int64")


def score(df: pd.DataFrame, weights=None, half_life_h=RECENCY_HALF_LIFE_H,
          ref_time=None):
    """Add bounded factors, normalized weighted contributions and total score.

    Required input: latitude, longitude, time. Missing optional confidence, FRP,
    and brightness contribute zero and are listed in ``score_missing_factors``.
    Present invalid values are rejected with ValueError so one bad batch cannot
    silently produce NaN scores. Weight overrides are additive to defaults and
    normalized to sum to one.
    """
    effective_weights = _effective_weights(weights)
    try:
        half_life = float(half_life_h)
    except (TypeError, ValueError, OverflowError):
        raise ValueError("half_life_h must be finite and positive") from None
    if not math.isfinite(half_life) or half_life <= 0:
        raise ValueError("half_life_h must be finite and positive")
    if df.empty:
        return df.copy()

    required = ("latitude", "longitude")
    missing_required = [name for name in required if name not in df]
    if missing_required:
        raise ValueError(f"missing required scoring columns: {', '.join(missing_required)}")

    d = df.copy()
    lat = _numeric_feature(d, "latitude", minimum=-90, maximum=90)
    lon = _numeric_feature(d, "longitude", minimum=-180, maximum=180)
    if lat.isna().any():
        raise ValueError("latitude is required for scoring")
    if lon.isna().any():
        raise ValueError("longitude is required for scoring")
    d["latitude"], d["longitude"] = lat, lon
    times, ref = _timestamps(d, ref_time)
    d["time"] = times
    d["repeat_count"] = _repeat_counts(d.assign(latitude=lat, longitude=lon))

    frp = _numeric_feature(d, "frp", minimum=0)
    brightness = _numeric_feature(d, "brightness", minimum=200, maximum=500)
    confidence = _numeric_feature(d, "confidence", minimum=0, maximum=1)
    for name, values in (("frp", frp), ("brightness", brightness),
                         ("confidence", confidence)):
        if name in d:
            d[name] = values

    missing_by_row = [
        [name for name, values in (("frp", frp), ("brightness", brightness),
                                   ("confidence", confidence)) if pd.isna(values.iloc[i])]
        for i in range(len(d))
    ]

    age_h = ((ref - times).dt.total_seconds() / 3600).clip(lower=0)
    d["f_recency"] = np.exp2(-age_h / half_life).clip(0, 1)
    d["f_confidence"] = confidence.fillna(0).clip(0, 1)
    d["f_frp"] = (
        np.log1p(frp.fillna(0)) / math.log1p(FRP_REFERENCE_MW)
    ).clip(0, 1)
    d["f_repeats"] = (
        d["repeat_count"] / MAX_REPEAT_FACTOR_COUNT
    ).clip(0, 1)
    d["f_brightness"] = (
        (brightness.fillna(BRIGHTNESS_BASE_K) - BRIGHTNESS_BASE_K)
        / BRIGHTNESS_SPAN_K
    ).clip(0, 1)
    d["score_missing_factors"] = missing_by_row

    for name, weight in effective_weights.items():
        d[f"c_{name}"] = 100 * weight * d[f"f_{name}"]
    contribution_columns = [f"c_{name}" for name in DEFAULT_WEIGHTS]
    d["score"] = d[contribution_columns].sum(axis=1).clip(0, 100)
    d.attrs["effective_weights"] = effective_weights
    return d.sort_values("score", ascending=False, kind="stable").reset_index(drop=True)


def explain(row) -> str:
    """Preserve the API's contribution explanation using actual contributions."""
    parts = sorted(
        ((name, float(row[f"c_{name}"])) for name in DEFAULT_WEIGHTS),
        key=lambda item: (-item[1], item[0]),
    )
    return "; ".join(f"+{value:.1f} {name}" for name, value in parts)
