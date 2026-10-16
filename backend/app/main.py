from pathlib import Path
import io
import pandas as pd
from fastapi import FastAPI, File, UploadFile, HTTPException
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

ROOT = Path(__file__).resolve().parents[2]
app = FastAPI(title="Fire detection triage", description="Decision support for review only. Not an emergency-response system.")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://127.0.0.1:5500",
        "http://localhost:5500",
    ],
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
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


@app.post("/api/upload")
async def upload(file: UploadFile = File(...)):
    try:
        text = (await file.read()).decode("utf-8-sig")
    except UnicodeDecodeError:
        raise HTTPException(status_code=400, detail="Upload must be UTF-8 CSV") from None
    return _pipeline(text)


app.mount("/", StaticFiles(directory=ROOT / "frontend", html=True), name="frontend")
