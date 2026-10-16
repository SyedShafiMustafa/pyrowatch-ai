"""Measured change between observed acquisition times, not continuous growth."""
import math

import pandas as pd

MIN_TIMES = 3
MIN_SPAN_H = 6.0
MAX_OBSERVED_GAP_H = 72.0
MIN_ABS_FRP_CHANGE_MW = 2.0
MIN_REL_FRP_CHANGE = 0.25


def analyze_trend(observations: pd.DataFrame):
    """Classify first-to-last mean FRP change with conservative data gates."""
    result = {"status": "insufficient_data", "frp_change_mw": None,
              "frp_change_fraction": None, "early_detections_per_time": None,
              "late_detections_per_time": None, "distinct_observation_times": 0,
              "span_h": 0.0, "reason": "need at least three valid-FRP acquisition times over six hours",
              "sampling_limitation": "observation opportunities and missed overpasses are unknown"}
    if observations.empty or "time" not in observations or "frp" not in observations:
        return result
    data = observations.copy()
    data["time"] = pd.to_datetime(data["time"], utc=True, errors="coerce")
    data["frp"] = pd.to_numeric(data["frp"], errors="coerce")
    data = data[data["time"].notna()].sort_values("time", kind="stable")
    data.loc[~data["frp"].map(lambda value: pd.notna(value) and math.isfinite(value) and value >= 0), "frp"] = float("nan")
    if data.empty:
        return result
    grouped = data.groupby("time", sort=True)
    mean_frp = grouped["frp"].mean()
    counts = grouped.size()
    span_h = float((mean_frp.index[-1] - mean_frp.index[0]).total_seconds() / 3600)
    result.update(distinct_observation_times=len(mean_frp), span_h=span_h)
    if len(mean_frp) < MIN_TIMES or span_h < MIN_SPAN_H:
        return result
    if mean_frp.notna().sum() < MIN_TIMES or pd.isna(mean_frp.iloc[0]) or pd.isna(mean_frp.iloc[-1]):
        result["reason"] = "at least three times including first and last need valid FRP"
        return result
    if (mean_frp.index.to_series().diff().dropna() > pd.Timedelta(hours=MAX_OBSERVED_GAP_H)).any():
        result["reason"] = "observed acquisition gap exceeds 72 hours"
        return result
    half = len(counts) // 2
    first, last = float(mean_frp.iloc[0]), float(mean_frp.iloc[-1])
    change = last - first
    fraction = change / max(first, 1.0)
    result.update(frp_change_mw=change, frp_change_fraction=fraction,
                  early_detections_per_time=float(counts.iloc[:half].mean()),
                  late_detections_per_time=float(counts.iloc[half:].mean()),
                  reason="observed first-to-last mean FRP; gaps and missed passes are unobserved")
    if change >= MIN_ABS_FRP_CHANGE_MW and fraction >= MIN_REL_FRP_CHANGE:
        result["status"] = "rising"
    elif change <= -MIN_ABS_FRP_CHANGE_MW and fraction <= -MIN_REL_FRP_CHANGE:
        result["status"] = "falling"
    else:
        result["status"] = "stable"
    return result
