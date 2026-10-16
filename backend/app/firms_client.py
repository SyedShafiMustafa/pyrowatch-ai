"""Optional live pull from FIRMS Web Services. Needs MAP_KEY in the environment.
Verify the URL pattern against https://firms.modaps.eosdis.nasa.gov/web-services/ before relying on it."""
import os
import math
import re
import requests

BASE = "https://firms.modaps.eosdis.nasa.gov/api/area/csv"


def fetch_area_csv(west, south, east, north, days=3, source="VIIRS_SNPP_NRT"):
    key = os.getenv("MAP_KEY") or os.getenv("FIRMS_MAP_KEY")
    if not key:
        raise RuntimeError("Set MAP_KEY in the environment (legacy FIRMS_MAP_KEY also supported)")
    try:
        west, south, east, north = map(float, (west, south, east, north))
    except (TypeError, ValueError):
        raise ValueError("Bounding box must be numeric") from None
    if not all(math.isfinite(v) for v in (west, south, east, north)) or not (-180 <= west < east <= 180 and -90 <= south < north <= 90):
        raise ValueError("Invalid west,south,east,north bounding box")
    if isinstance(days, bool) or not isinstance(days, int) or not 1 <= days <= 5:
        raise ValueError("days must be an integer from 1 to 5")
    if source not in {"MODIS_NRT", "MODIS_SP", "VIIRS_SNPP_NRT", "VIIRS_SNPP_SP", "VIIRS_NOAA20_NRT", "VIIRS_NOAA20_SP", "VIIRS_NOAA21_NRT"}:
        raise ValueError("Unsupported FIRMS source")
    if not re.fullmatch(r"[A-Za-z0-9_-]+", key):
        raise RuntimeError("Invalid MAP_KEY format")
    url = f"{BASE}/{key}/{source}/{west},{south},{east},{north}/{days}"
    try:
        r = requests.get(url, timeout=30, allow_redirects=False)
        if not 200 <= r.status_code < 300:
            raise RuntimeError("FIRMS request failed; check service availability and credentials")
    except requests.RequestException:
        raise RuntimeError("FIRMS request failed; check service availability and credentials") from None
    from .validation import inspect_csv_text
    _, _, report = inspect_csv_text(r.text)
    if not {"latitude", "longitude", "acq_date", "acq_time", "confidence", "frp"}.issubset(report["columns"]) or not ({"bright_ti4", "brightness"} & set(report["columns"])):
        raise RuntimeError("FIRMS returned an unsupported CSV schema")
    return r.text
