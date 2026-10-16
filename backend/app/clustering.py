"""Group nearby observations into response-local review events."""
import numpy as np
import pandas as pd
from sklearn.metrics.pairwise import haversine_distances

EPS_KM = 2.0
MAX_GAP_H = 72.0


def cluster_events(df: pd.DataFrame, eps_km=EPS_KM, max_gap_h=MAX_GAP_H):
    """Form deterministic candidate groups with bounded pairwise distance and span.

    These are candidate review groups, not confirmed fire perimeters or identities.
    """
    if df.empty:
        return df, pd.DataFrame()
    if not np.isfinite(eps_km) or eps_km <= 0 or not np.isfinite(max_gap_h) or max_gap_h <= 0:
        raise ValueError("spatial radius and temporal gap must be positive and finite")
    d = df.copy().reset_index(drop=True)
    d["time"] = pd.to_datetime(d["time"], utc=True, errors="coerce")
    if d["time"].isna().any():
        raise ValueError("event timestamps must be valid")
    coords = np.radians(d[["latitude", "longitude"]].to_numpy())
    if not np.isfinite(coords).all():
        raise ValueError("event coordinates must be finite")
    # Small uploads benefit from a single vectorized calculation; large ones
    # avoid allocating a quadratic distance matrix.
    distances = haversine_distances(coords) * 6371.0 if len(d) <= 1000 else None
    groups = []
    times_ns = d["time"].astype("datetime64[ns, UTC]").array.asi8
    max_gap_ns = pd.Timedelta(hours=max_gap_h).value
    positions = sorted(range(len(d)), key=lambda i: (times_ns[i], coords[i, 0], coords[i, 1]))
    for position in positions:
        for group in groups:
            if times_ns[position] - times_ns[group[0]] > max_gap_ns:
                continue
            if distances is None:
                others = coords[group]
                delta = others - coords[position]
                arc = (np.sin(delta[:, 0] / 2) ** 2
                       + np.cos(coords[position, 0]) * np.cos(others[:, 0])
                       * np.sin(delta[:, 1] / 2) ** 2)
                within_radius = np.all(2 * 6371.0 * np.arcsin(np.sqrt(np.clip(arc, 0, 1))) <= eps_km)
            else:
                within_radius = np.all(distances[position, group] <= eps_km)
            if within_radius:
                group.append(position)
                break
        else:
            groups.append([position])
    event_ids = np.empty(len(d), dtype=int)
    for event_id, positions in enumerate(groups):
        event_ids[positions] = event_id
    d["event_id"] = event_ids
    ev = d.groupby("event_id").agg(
        pixels=("score", "size"), top_score=("score", "max"), peak_frp=("frp", "max"),
        first_seen=("time", "min"), last_seen=("time", "max"),
        lat=("latitude", "mean"), lon=("longitude", "mean")).reset_index()
    ev["duration_h"] = (ev["last_seen"] - ev["first_seen"]).dt.total_seconds() / 3600
    return d, ev.sort_values("top_score", ascending=False).reset_index(drop=True)
