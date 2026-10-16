"""Compatibility checks using an unmodified-record subset of NASA FIRMS data.

Provenance and selection bounds: docs/PHASE4_2_FIRMS_VALIDATION.md.
These observations have no ground-truth fire labels.
"""
from pathlib import Path

from fastapi.testclient import TestClient

from app.main import app
from app.validation import load_csv_text


FIXTURE = (Path(__file__).resolve().parents[2] / "data" / "validation"
           / "viirs_snpp_20230712_california_bbox.csv")


def test_nasa_firms_viirs_subset_ingests_and_preserves_sensor_metadata():
    clean, issues = load_csv_text(FIXTURE.read_text(encoding="utf-8"))
    report = clean.attrs["ingestion"]
    assert (report["total_records"], report["accepted"], report["rejected"],
            report["deduplicated"]) == (73, 73, 0, 0)
    assert issues == []
    assert set(clean["satellite"]) == {"N"}
    assert set(clean["instrument"]) == {"VIIRS"}
    assert clean["label"].isna().all()


def test_nasa_firms_viirs_subset_runs_without_unavailable_values_becoming_scores():
    with TestClient(app) as client:
        response = client.post("/api/upload", files={"file": (
            FIXTURE.name, FIXTURE.read_bytes(), "text/csv")})
    assert response.status_code == 200
    result = response.json()
    assert result["ingestion"]["data_kind"] == "user_supplied_unverified"
    assert len(result["rows"]) == 73
    assert len(result["events"]) == len(result["intelligence"]["events"]) == 46
    assert result["evaluation"] is None  # FIRMS detections are not fire labels.
    assert all(row["instrument"] == "VIIRS" for row in result["rows"])
    assert all(event["trend"]["status"] == "insufficient_data"
               for event in result["intelligence"]["events"])
    assert all(event["anomaly"]["status"] in {"available", "unavailable"}
               for event in result["intelligence"]["events"])
    if result["intelligence"]["model"]["status"] == "unavailable":
        assert all(event["anomaly"]["anomaly_score"] is None
                   for event in result["intelligence"]["events"])
