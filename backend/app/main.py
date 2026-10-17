from pathlib import Path
import hashlib
import hmac
import io
import os
import pandas as pd
from fastapi import FastAPI, File, UploadFile, HTTPException, Query, Header
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from .validation import load_csv_text
from .scoring import score, explain, DEFAULT_WEIGHTS
from .clustering import cluster_events
from .persistent import flag_static
from .evaluation import compare
from .event_features import extract_event_features
from .trends import analyze_trend
from .anomaly import predict_events
from .firms_client import fetch_area_csv
from .live_cache import LiveAreaCache, LiveFetchBusy

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_MAX_UPLOAD_BYTES = 10 * 1024 * 1024
live_area_cache = LiveAreaCache()


def _configured_max_upload_bytes():
    raw = os.environ.get("PYROWATCH_MAX_UPLOAD_BYTES", str(DEFAULT_MAX_UPLOAD_BYTES))
    try:
        limit = int(raw)
    except ValueError:
        raise ValueError("PYROWATCH_MAX_UPLOAD_BYTES must be a positive integer") from None
    if limit <= 0:
        raise ValueError("PYROWATCH_MAX_UPLOAD_BYTES must be a positive integer")
    return limit


MAX_UPLOAD_BYTES = _configured_max_upload_bytes()


class UploadSizeLimitMiddleware:
    """Bound upload request bytes while multipart parsing streams the body."""

    def __init__(self, app, max_bytes=MAX_UPLOAD_BYTES):
        self.app = app
        self.max_bytes = max_bytes

    async def __call__(self, scope, receive, send):
        if (scope["type"] != "http" or scope.get("method") != "POST"
                or scope.get("path") != "/api/upload"):
            return await self.app(scope, receive, send)

        headers = dict(scope.get("headers", ()))
        try:
            content_length = int(headers.get(b"content-length", b""))
        except ValueError:
            content_length = None
        if content_length is not None and content_length > self.max_bytes:
            return await self._too_large(send)

        received = 0

        async def limited_receive():
            nonlocal received
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > self.max_bytes:
                    raise _UploadTooLarge
            return message

        response_started = False

        async def tracked_send(message):
            nonlocal response_started
            if message["type"] == "http.response.start":
                response_started = True
            await send(message)

        try:
            await self.app(scope, limited_receive, tracked_send)
        except _UploadTooLarge:
            if response_started:
                raise
            await self._too_large(send)

    async def _too_large(self, send):
        body = (f'{{"detail":"Upload request exceeds the {self.max_bytes}-byte limit"}}'
                .encode("ascii"))
        await send({"type": "http.response.start", "status": 413,
                    "headers": [(b"content-type", b"application/json"),
                                (b"content-length", str(len(body)).encode("ascii"))]})
        await send({"type": "http.response.body", "body": body})


class _UploadTooLarge(Exception):
    pass


app = FastAPI(title="Fire detection triage", description="Decision support for review only. Not an emergency-response system.")
# Register the limiter inside CORS so browser uploads receive CORS headers on 413.
app.add_middleware(UploadSizeLimitMiddleware, max_bytes=MAX_UPLOAD_BYTES)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://127.0.0.1:5500",
        "http://localhost:5500",
    ],
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type", "Authorization"],
)


def _pipeline(text: str, data_kind="user_supplied_unverified"):
    clean, issues = load_csv_text(text)
    ingestion = {**clean.attrs["ingestion"], "data_kind": data_kind}
    if clean.empty:
        model, _ = predict_events([])
        return {"issues": issues, "rows": [], "events": [], "evaluation": None,
                "ingestion": ingestion, "intelligence": {"model": model, "events": []}}
    scored = score(clean)
    scored, events = cluster_events(scored)
    archive_path = ROOT / "data" / "archive" / "archive.csv"
    archive = load_csv_text(archive_path.read_text())[0] if archive_path.exists() else None
    scored = flag_static(scored, archive)
    feature_records = extract_event_features(scored)
    model, anomaly_records = predict_events(feature_records)
    anomalies = {record["event_id"]: record for record in anomaly_records}
    intelligence_events = [{**record,
                            "trend": analyze_trend(scored[scored["event_id"] == record["event_id"]]),
                            "anomaly": anomalies[record["event_id"]]}
                           for record in feature_records]
    scored["why"] = scored.apply(explain, axis=1)
    rows = scored.drop(columns=["cell"], errors="ignore").assign(time=lambda x: x["time"].astype(str))
    events = events.assign(first_seen=events["first_seen"].astype(str), last_seen=events["last_seen"].astype(str))
    labelled = scored["label"].notna().sum() >= 20
    return {"issues": issues, "weights": DEFAULT_WEIGHTS, "ingestion": ingestion,
            "intelligence": {"model": model, "events": intelligence_events},
            "rows": rows.astype(object).where(rows.notna(), None).to_dict("records"),
            "events": events.to_dict("records"),
            "evaluation": compare(scored) if labelled else None}


@app.get("/api/health")
def health():
    return {"ok": True}


@app.get("/api/sample")
def sample():
    return _pipeline((ROOT / "data" / "sample" / "synthetic_sample.csv").read_text(), "synthetic")


@app.get("/api/firms/area")
def fetch_live_firms_area(
    west: float = Query(..., ge=-180, le=180),
    south: float = Query(..., ge=-90, le=90),
    east: float = Query(..., ge=-180, le=180),
    north: float = Query(..., ge=-90, le=90),
    days: int = Query(3, ge=1, le=5),
    source: str = Query("VIIRS_SNPP_NRT"),
    authorization: str | None = Header(default=None),
):
    expected_token = os.environ.get("PYROWATCH_LIVE_FETCH_TOKEN")
    if not expected_token:
        raise HTTPException(status_code=503, detail="Live FIRMS fetch is not enabled on this deployment")
    scheme, separator, supplied_token = (authorization or "").partition(" ")
    if (not separator or scheme.lower() != "bearer" or not supplied_token
            or not hmac.compare_digest(supplied_token.encode("utf-8"), expected_token.encode("utf-8"))):
        raise HTTPException(
            status_code=401,
            detail="A valid live-fetch bearer token is required",
            headers={"WWW-Authenticate": "Bearer"},
        )
    if west >= east or south >= north:
        raise HTTPException(status_code=422, detail="Area must have west < east and south < north")
    if (east - west) * (north - south) > 400:
        raise HTTPException(status_code=422, detail="Select a smaller area (at most 400 square degrees)")
    # Partition cached data on credential rotation without storing credentials.
    credential = (os.getenv("NASA_FIRMS_MAP_KEY") or os.getenv("MAP_KEY")
                  or os.getenv("FIRMS_MAP_KEY") or "")
    cache_key = (hashlib.sha256(credential.encode()).digest(), west, south, east, north, days, source)
    try:
        csv_text, fetched_at, cached = live_area_cache.fetch(
            cache_key, lambda: fetch_area_csv(west, south, east, north, days, source))
    except LiveFetchBusy as error:
        raise HTTPException(status_code=429, detail=str(error), headers={"Retry-After": "60"}) from None
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from None
    except RuntimeError as error:
        raise HTTPException(status_code=503, detail=str(error)) from None
    if len(csv_text.encode("utf-8")) > 5 * 1024 * 1024 or len(csv_text.splitlines()) > 5001:
        raise HTTPException(status_code=413, detail="Too many live observations; reduce the area or days")
    result = _pipeline(csv_text, "nasa_firms_live")
    result["live_fetch"] = {
        "source": source,
        "west": west,
        "south": south,
        "east": east,
        "north": north,
        "days": days,
        "fetched_at": fetched_at,
        "cached": cached,
        "cache_ttl_seconds": live_area_cache.ttl,
    }
    return result


@app.post("/api/upload")
async def upload(file: UploadFile = File(...)):
    try:
        text = (await file.read()).decode("utf-8-sig")
    except UnicodeDecodeError:
        raise HTTPException(status_code=400, detail="Upload must be UTF-8 CSV") from None
    return _pipeline(text)


app.mount("/", StaticFiles(directory=ROOT / "frontend", html=True), name="frontend")
