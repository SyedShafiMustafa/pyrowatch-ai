"""INNOVATION 1: group neighbouring pixels into fire EVENTS so one fire doesn't flood the list."""
import numpy as np
import pandas as pd
from sklearn.cluster import DBSCAN

EPS_KM = 2.0


def cluster_events(df: pd.DataFrame, eps_km=EPS_KM):
    if df.empty:
        return df, pd.DataFrame()
    d = df.copy()
    coords = np.radians(d[["latitude", "longitude"]].to_numpy())
    d["event_id"] = DBSCAN(eps=eps_km / 6371.0, min_samples=1, metric="haversine").fit_predict(coords)
    ev = d.groupby("event_id").agg(
        pixels=("score", "size"), top_score=("score", "max"), peak_frp=("frp", "max"),
        first_seen=("time", "min"), last_seen=("time", "max"),
        lat=("latitude", "mean"), lon=("longitude", "mean")).reset_index()
    ev["duration_h"] = (ev["last_seen"] - ev["first_seen"]).dt.total_seconds() / 3600
    return d, ev.sort_values("top_score", ascending=False).reset_index(drop=True)
