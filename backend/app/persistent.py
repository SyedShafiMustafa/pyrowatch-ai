"""Historical recurrence evidence; never suppresses the current observation."""
import math

import pandas as pd

CELL_DEG = 0.01  # Approximate coordinate bin, not a physical site boundary.
MIN_DAYS = 10


def flag_static(current: pd.DataFrame, archive: pd.DataFrame, min_days=MIN_DAYS,
                cell_deg=CELL_DEG, lookback_days=None, min_distinct_times=0,
                min_coverage_days=0):
    """Preserve the Phase 1 boolean and add status and supporting evidence.

    Optional thresholds default to the original distinct-date rule. An archive
    with too little overall history is explicitly marked insufficient.
    """
    for name, value, allow_zero in (("min_days", min_days, False),
                                    ("cell_deg", cell_deg, False),
                                    ("min_distinct_times", min_distinct_times, True),
                                    ("min_coverage_days", min_coverage_days, True)):
        if not isinstance(value, (int, float)) or not math.isfinite(value) or (value < 0 if allow_zero else value <= 0):
            raise ValueError(f"{name} must be finite and positive")
    if lookback_days is not None and (not isinstance(lookback_days, (int, float))
                                     or not math.isfinite(lookback_days) or lookback_days <= 0):
        raise ValueError("lookback_days must be finite and positive")
    d = current.copy()
    if d.empty:
        d["possible_static_source"] = pd.Series(dtype=bool)
        d["persistent_source_status"] = pd.Series(dtype=str)
        d["persistent_source_evidence"] = pd.Series(dtype=object)
        return d
    if archive is None or archive.empty:
        d["possible_static_source"] = False
        d["persistent_source_status"] = "insufficient_history"
        d["persistent_source_evidence"] = [{"reason": "no historical archive", "distinct_times": 0,
                                             "distinct_days": 0, "coverage_days": 0.0} for _ in range(len(d))]
        return d
    a = archive.copy()
    for frame in (d, a):
        if not {"latitude", "longitude", "time"}.issubset(frame):
            raise ValueError("history and current observations need latitude, longitude and time")
        frame["time"] = pd.to_datetime(frame["time"], utc=True, errors="coerce")
        if frame["time"].isna().any():
            raise ValueError("historical timestamps must be valid")
        for name in ("latitude", "longitude"):
            frame[name] = pd.to_numeric(frame[name], errors="coerce")
            if not frame[name].map(math.isfinite).all():
                raise ValueError("historical coordinates must be finite")
    a["_cell"] = list(zip((a["latitude"] / cell_deg).round(), (a["longitude"] / cell_deg).round()))
    statuses, evidence, flags = [], [], []
    for _, row in d.iterrows():
        eligible = a[a["time"] <= row["time"]]
        if lookback_days is not None:
            eligible = eligible[eligible["time"] >= row["time"] - pd.Timedelta(days=lookback_days)]
        overall_days = eligible["time"].dt.date.nunique()
        overall_span = ((eligible["time"].max() - eligible["time"].min()).total_seconds() / 86400
                        if not eligible.empty else 0.0)
        global_insufficient = overall_days < min_days or overall_span < min_coverage_days
        cell = (round(row["latitude"] / cell_deg), round(row["longitude"] / cell_deg))
        part = eligible[eligible["_cell"] == cell]
        distinct_times = int(part["time"].nunique())
        distinct_days = int(part["time"].dt.date.nunique())
        coverage_days = float((part["time"].max() - part["time"].min()).total_seconds() / 86400) if not part.empty else 0.0
        flagged = (distinct_days >= min_days and distinct_times >= min_distinct_times
                   and coverage_days >= min_coverage_days)
        status = ("possible_persistent_source" if flagged else
                  "insufficient_history" if global_insufficient else "not_flagged")
        flags.append(flagged)
        statuses.append(status)
        evidence.append({"distinct_times": distinct_times, "distinct_days": distinct_days,
                         "coverage_days": coverage_days,
                         "first_seen": part["time"].min().isoformat() if not part.empty else None,
                         "last_seen": part["time"].max().isoformat() if not part.empty else None,
                         "spatial_bin_degrees": cell_deg, "min_days": min_days,
                         "min_distinct_times": min_distinct_times,
                         "min_coverage_days": min_coverage_days,
                         "lookback_days": lookback_days})
    d["possible_static_source"] = flags
    d["persistent_source_status"] = statuses
    d["persistent_source_evidence"] = evidence
    return d
