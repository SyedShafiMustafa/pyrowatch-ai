"""Optional live pull from FIRMS Web Services. Needs a server-side API key.
Verify the URL pattern against https://firms.modaps.eosdis.nasa.gov/web-services/ before relying on it."""
import os
import math
import re
import logging
import traceback
from contextvars import ContextVar
import requests

BASE = "https://firms.modaps.eosdis.nasa.gov/api/area/csv"
_request_key = ContextVar("firms_request_key", default=None)
_key_path = re.compile(r"(/api/area/csv/)[^/\s?'\"]+")


class _CredentialFilter(logging.Filter):
    """Sanitize HTTP-library records before local or ancestor handlers see them."""

    def filter(self, record):
        def redact(text):
            text = _key_path.sub(r"\1[REDACTED]", text)
            key = _request_key.get()
            return text.replace(key, "[REDACTED]") if key else text

        record.msg = redact(record.getMessage())
        record.args = ()
        if record.exc_info:
            record.exc_text = redact("".join(traceback.format_exception(*record.exc_info)))
            record.exc_info = None
        elif record.exc_text:
            record.exc_text = redact(record.exc_text)
        if record.stack_info:
            record.stack_info = redact(record.stack_info)
        return True


_credential_filter = _CredentialFilter()


def _protect_http_logs():
    # Parent logger filters do not filter propagated child records. Attach to
    # the actual emitters; leave handlers, levels and unrelated logging intact.
    for name in ("urllib3.connectionpool", "urllib3.util.retry", "urllib3.connection",
                 "urllib3.poolmanager", "requests.sessions", "requests.adapters"):
        logging.getLogger(name).addFilter(_credential_filter)


def fetch_area_csv(west, south, east, north, days=3, source="VIIRS_SNPP_NRT"):
    key = (os.getenv("NASA_FIRMS_MAP_KEY") or os.getenv("MAP_KEY")
           or os.getenv("FIRMS_MAP_KEY"))
    if not key:
        raise RuntimeError("NASA FIRMS credentials are not configured on this backend")
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
        raise RuntimeError("NASA FIRMS credential has an invalid format")
    url = f"{BASE}/{key}/{source}/{west},{south},{east},{north}/{days}"
    _protect_http_logs()
    token = _request_key.set(key)
    try:
        r = requests.get(url, timeout=30, allow_redirects=False)
        if not 200 <= r.status_code < 300:
            raise RuntimeError("FIRMS request failed; check service availability and credentials")
    except requests.RequestException:
        raise RuntimeError("FIRMS request failed; check service availability and credentials") from None
    finally:
        _request_key.reset(token)
    from .validation import inspect_csv_text
    _, _, report = inspect_csv_text(r.text)
    if not {"latitude", "longitude", "acq_date", "acq_time", "confidence", "frp"}.issubset(report["columns"]) or not ({"bright_ti4", "brightness"} & set(report["columns"])):
        raise RuntimeError("FIRMS returned an unsupported CSV schema")
    return r.text
