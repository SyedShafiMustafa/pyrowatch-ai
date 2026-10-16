"""Chronological, upload-local measurements for candidate review events."""
import math

import numpy as np
import pandas as pd


FEATURE_SCHEMA = (
    "detection_count", "distinct_observation_times", "duration_h",
    "peak_frp", "mean_frp", "mean_confidence", "peak_brightness",
    "mean_brightness", "frp_delta_mw", "detection_frequency_delta",
    "observed_footprint_delta_km2", "median_revisit_h",
)


def _optional_numeric(group, name):
    if name not in group:
        return pd.Series(np.nan, index=group.index, dtype=float)
    raw = group[name]
    values = pd.to_numeric(raw, errors="coerce").astype(float)
    if (raw.notna() & values.isna()).any() or not np.isfinite(values.dropna()).all():
        raise ValueError(f"{name} must be finite numeric data or missing")
    return values


def _observed_bbox_km2(group):
    if len(group) < 2:
        return None
    lat = group["latitude"].to_numpy(dtype=float)
    lon = group["longitude"].to_numpy(dtype=float)
    if (not np.isfinite(lat).all() or not np.isfinite(lon).all()
            or (lat < -90).any() or (lat > 90).any()):
        raise ValueError("coordinates must be finite and latitude must be in range")
    lat_km = (lat.max() - lat.min()) * 111.32
    # Longitude is circular: take the complement of the largest gap between
    # sorted longitudes so a small cluster spanning +/-180 degrees stays small.
    circular_lon = np.sort(np.mod(lon, 360.0))
    gaps = np.diff(np.r_[circular_lon, circular_lon[0] + 360.0])
    lon_span = float(np.clip(360.0 - gaps.max(), 0.0, 360.0))
    lon_km = lon_span * 111.32 * max(0.0, math.cos(math.radians(float(lat.mean()))))
    area = float(max(0.0, lat_km * lon_km))
    if not math.isfinite(area):
        raise ValueError("observed coordinate bounding-box area must be finite")
    return area


def extract_event_features(observations: pd.DataFrame):
    """Return one feature record per event, without inferring fire spread."""
    if observations.empty:
        return []
    required = {"event_id", "time", "latitude", "longitude"}
    if not required.issubset(observations):
        raise ValueError("event_id, time, latitude and longitude are required")
    data = observations.copy()
    data["time"] = pd.to_datetime(data["time"], utc=True, errors="coerce")
    if data["time"].isna().any():
        raise ValueError("event timestamps must be valid")
    for name, low, high in (("latitude", -90, 90), ("longitude", -180, 180)):
        values = _optional_numeric(data, name)
        if values.isna().any() or not values.between(low, high).all():
            raise ValueError(f"{name} must be finite and in range")
        data[name] = values
    data = data.sort_values(["time", "event_id"], kind="stable")
    records = []
    for event_id, group in data.groupby("event_id", sort=True):
        frp = _optional_numeric(group, "frp")
        confidence = _optional_numeric(group, "confidence")
        brightness = _optional_numeric(group, "brightness")
        group = group.assign(_frp=frp, _confidence=confidence, _brightness=brightness)
        times = group["time"].drop_duplicates().sort_values()
        first, last = times.iloc[0], times.iloc[-1]
        gaps = times.diff().dropna().dt.total_seconds() / 3600
        first_group = group[group["time"] == first]
        last_group = group[group["time"] == last]
        frp_first, frp_last = first_group["_frp"].mean(), last_group["_frp"].mean()
        frp_delta = float(frp_last - frp_first) if pd.notna(frp_first) and pd.notna(frp_last) and first != last else None
        footprint_first = _observed_bbox_km2(first_group)
        footprint_last = _observed_bbox_km2(last_group)
        footprint_delta = (footprint_last - footprint_first
                           if footprint_first is not None and footprint_last is not None and first != last else None)
        per_time = group.groupby("time").size().to_numpy(dtype=float)
        split = len(per_time) // 2
        frequency_delta = (float(per_time[split:].mean() - per_time[:split].mean())
                           if split and len(per_time) >= 3 else None)
        values = {
            "detection_count": int(len(group)),
            "distinct_observation_times": int(len(times)),
            "duration_h": float((last - first).total_seconds() / 3600),
            "peak_frp": float(frp.max()) if frp.notna().any() else None,
            "mean_frp": float(frp.mean()) if frp.notna().any() else None,
            "mean_confidence": float(confidence.mean()) if confidence.notna().any() else None,
            "peak_brightness": float(brightness.max()) if brightness.notna().any() else None,
            "mean_brightness": float(brightness.mean()) if brightness.notna().any() else None,
            "frp_delta_mw": frp_delta,
            "detection_frequency_delta": frequency_delta,
            "observed_footprint_delta_km2": footprint_delta,
            "median_revisit_h": float(gaps.median()) if not gaps.empty else None,
        }
        records.append({"event_id": int(event_id), "first_seen": first.isoformat(),
                        "last_seen": last.isoformat(), "features": values,
                        "missing_features": [name for name, value in values.items() if value is None]})
    return records
