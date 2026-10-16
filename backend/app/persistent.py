"""INNOVATION 2: flag likely static heat sources (flares, factories) using a longer archive.
TODO(team): tune MIN_DAYS and add a toggleable score penalty in scoring.py."""
import pandas as pd

CELL_DEG = 0.01  # ~1 km
MIN_DAYS = 10    # detected on >= this many distinct dates => "possible static source"


def flag_static(current: pd.DataFrame, archive: pd.DataFrame, min_days=MIN_DAYS):
    d = current.copy()
    if archive is None or archive.empty:
        d["possible_static_source"] = False
        return d
    a = archive.copy()
    a["cell"] = list(zip((a["latitude"] / CELL_DEG).round(), (a["longitude"] / CELL_DEG).round()))
    a["day"] = a["time"].dt.date
    days = a.groupby("cell")["day"].nunique()
    d["cell1"] = list(zip((d["latitude"] / CELL_DEG).round(), (d["longitude"] / CELL_DEG).round()))
    d["possible_static_source"] = d["cell1"].map(days).fillna(0) >= min_days
    return d.drop(columns="cell1")
