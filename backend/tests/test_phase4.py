"""Offline Phase 4 checks; all observations and labels here are synthetic."""
import hashlib
import json
import joblib
import numpy as np
import pandas as pd
import pytest
from fastapi.testclient import TestClient

from app.anomaly import (FEATURE_SCHEMA, MODEL_VERSION, feature_matrix, load_model,
                         manifest_path,
                         predict_events, train_model)
from app.clustering import cluster_events
from app.event_features import extract_event_features
from app.evaluation import compare, evaluate_heldout_rankings, split_event_holdout
from app.persistent import flag_static
from app.trends import analyze_trend


def observations(frps=(2, 4, 8), hours=(0, 8, 20)):
    return pd.DataFrame({
        "event_id": [0] * len(frps), "latitude": [10.0] * len(frps),
        "longitude": [20.0] * len(frps),
        "time": pd.to_datetime([f"2026-10-10T{h:02d}:00:00Z" for h in hours], utc=True),
        "frp": list(frps), "confidence": [0.6] * len(frps),
        "brightness": [340.0] * len(frps), "score": [40.0] * len(frps),
    })


def test_clustering_uses_temporal_gap_as_well_as_distance():
    frame = observations().iloc[[0]].copy()
    later = frame.copy()
    later["time"] += pd.Timedelta(days=10)
    together, events = cluster_events(pd.concat([frame, later], ignore_index=True))
    assert len(events) == 2
    assert together.event_id.nunique() == 2
    with pytest.raises(ValueError):
        cluster_events(frame, max_gap_h=0)


def test_candidate_groups_do_not_chain_and_ids_ignore_input_order():
    frame = observations(frps=(2, 3, 4))
    frame["time"] = pd.Timestamp("2026-10-10T00:00:00Z") + pd.to_timedelta([0, 40, 80], unit="h")
    frame["latitude"] = [10.0, 10.01, 10.02]  # Adjacent pairs ~1.1 km; endpoints >2 km.
    frame["satellite"] = ["A", "B", "A"]
    frame["instrument"] = ["X", "Y", "X"]
    first, _ = cluster_events(frame)
    shuffled, _ = cluster_events(frame.iloc[[2, 0, 1]].reset_index(drop=True))
    assert first.event_id.tolist() == [0, 0, 1]
    assert dict(zip(first.latitude, first.event_id)) == dict(zip(shuffled.latitude, shuffled.event_id))
    assert first.loc[0, "event_id"] == first.loc[1, "event_id"]  # Cross-sensor candidate only.
    same_place = observations(frps=(2, 3, 4))
    same_place["time"] = frame["time"]
    assert cluster_events(same_place)[0].event_id.tolist() == [0, 0, 1]
    same_place["time"] = same_place["time"].astype("datetime64[us, UTC]")
    assert cluster_events(same_place)[0].event_id.tolist() == [0, 0, 1]
    with pytest.raises(ValueError, match="timestamps"):
        cluster_events(frame.assign(time=[pd.NaT] * 3))


def test_nearby_independent_sources_are_not_asserted_as_distinct():
    frame = observations(frps=(2, 3), hours=(0, 0))
    frame["latitude"] = [10.0, 10.005]
    grouped, events = cluster_events(frame)
    assert len(events) == 1  # Spatial/time fields cannot prove separate fire identity.
    assert grouped.event_id.nunique() == 1


def test_event_features_are_chronological_and_mark_missing_measurements():
    frame = observations(frps=(8, 4, 2), hours=(20, 0, 8)).iloc[[2, 0, 1]].copy()
    frame.loc[frame.index[0], "confidence"] = np.nan
    result = extract_event_features(frame)[0]
    assert tuple(result["features"]) == FEATURE_SCHEMA
    assert result["features"]["detection_count"] == 3
    assert result["features"]["distinct_observation_times"] == 3
    assert result["features"]["frp_delta_mw"] == 4
    assert result["features"]["median_revisit_h"] == 10
    assert "observed_footprint_delta_km2" in result["missing_features"]
    invalid = frame.copy()
    invalid["brightness"] = np.inf
    with pytest.raises(ValueError, match="brightness"):
        extract_event_features(invalid)


def test_observed_footprint_change_uses_timestamp_groups():
    frame = observations(frps=(2, 3, 4, 5), hours=(0, 0, 8, 8))
    frame["latitude"] = [10, 10.001, 10, 10.02]
    frame["longitude"] = [20, 20.001, 20, 20.02]
    features = extract_event_features(frame)[0]["features"]
    assert features["distinct_observation_times"] == 2
    assert features["observed_footprint_delta_km2"] > 0
    assert features["detection_frequency_delta"] is None


@pytest.mark.parametrize("frps,expected", [
    ((2, 3, 8), "rising"), ((8, 4, 2), "falling"),
    ((3, 3.2, 3.5), "stable"),
])
def test_trend_categories(frps, expected):
    result = analyze_trend(observations(frps=frps))
    assert result["status"] == expected
    assert result["late_detections_per_time"] == 1


def test_trend_insufficient_and_repeated_timestamps():
    single = observations().iloc[[0]].copy()
    assert analyze_trend(single)["status"] == "insufficient_data"
    repeated = pd.concat([single] * 3, ignore_index=True)
    assert analyze_trend(repeated)["distinct_observation_times"] == 1
    assert analyze_trend(repeated)["status"] == "insufficient_data"
    missing = observations().copy()
    missing.loc[missing.index[-1], "frp"] = np.nan
    assert analyze_trend(missing)["status"] == "insufficient_data"


def test_trend_gates_sparse_frp_irregular_gaps_and_sampling():
    frame = observations(frps=(0, 2, 8))
    assert analyze_trend(frame)["status"] == "rising"
    assert analyze_trend(frame)["sampling_limitation"]
    frame.loc[1, "frp"] = np.nan
    assert analyze_trend(frame)["status"] == "insufficient_data"
    frame.loc[1, "frp"] = np.inf
    assert analyze_trend(frame)["status"] == "insufficient_data"
    frame.loc[1, "frp"] = -2
    assert analyze_trend(frame)["status"] == "insufficient_data"
    gap = observations(frps=(2, 4, 8), hours=(0, 8, 20))
    gap.loc[2, "time"] += pd.Timedelta(days=10)
    assert analyze_trend(gap)["status"] == "insufficient_data"
    repeated = pd.concat([observations(frps=(2, 4, 8)),
                          observations(frps=(2, 4, 8)).iloc[[2]]], ignore_index=True)
    assert analyze_trend(repeated)["distinct_observation_times"] == 3
    assert analyze_trend(repeated)["late_detections_per_time"] > 1


def test_persistent_evidence_and_insufficient_history():
    current = observations().iloc[[0]].copy()
    archive = pd.concat([current.assign(time=current.time + pd.Timedelta(days=i))
                         for i in range(10)], ignore_index=True)
    current["time"] += pd.Timedelta(days=10)
    flagged = flag_static(current, archive)
    assert bool(flagged.iloc[0].possible_static_source)
    assert flagged.iloc[0].persistent_source_status == "possible_persistent_source"
    assert flagged.iloc[0].persistent_source_evidence["distinct_times"] == 10
    assert flag_static(current, archive.iloc[:2]).iloc[0].persistent_source_status == "insufficient_history"
    assert flag_static(current, None).iloc[0].persistent_source_status == "insufficient_history"
    assert not bool(flag_static(current, archive, min_coverage_days=20).iloc[0].possible_static_source)
    assert flag_static(current, archive, lookback_days=3).iloc[0].persistent_source_status == "insufficient_history"
    earlier = current.copy()
    earlier["time"] -= pd.Timedelta(days=11)
    assert not bool(flag_static(earlier, archive).iloc[0].possible_static_source)
    away = current.assign(latitude=11.0)
    assert flag_static(away, archive).iloc[0].persistent_source_status == "not_flagged"


def synthetic_feature_records(n=24):
    records = []
    for i in range(n):
        features = {name: float(i + j / 10) for j, name in enumerate(FEATURE_SCHEMA)}
        features["observed_footprint_delta_km2"] = None if i % 4 == 0 else float(i)
        records.append({"event_id": i, "features": features})
    return records


def test_model_training_persistence_and_deterministic_inference(tmp_path):
    path = tmp_path / "model.joblib"
    records = synthetic_feature_records()
    metadata = train_model(records, path, reference="SYNTHETIC unit test")
    assert metadata["version"] == MODEL_VERSION and metadata["training_events"] == 24
    assert load_model(path)[1]["status"] == "available"
    status, first = predict_events(records, path)
    _, second = predict_events(records, path)
    assert status["status"] == "available" and first == second
    assert all(isinstance(record["anomaly_flag"], bool) for record in first)
    assert all(np.isfinite(record["anomaly_score"]) for record in first)
    artifact = joblib.load(path)
    decisions = artifact["pipeline"].decision_function(feature_matrix(records))
    assert np.allclose([row["anomaly_score"] for row in first], -decisions)
    assert [row["anomaly_flag"] for row in first] == list(decisions < 0)
    sidecar = json.loads(manifest_path(path).read_text(encoding="utf-8"))
    assert sidecar["artifact_sha256"] == hashlib.sha256(path.read_bytes()).hexdigest()
    assert sidecar["manifest"] == metadata["manifest"]
    assert sidecar["manifest"]["dataset"]["kind"] == "unknown"
    assert sidecar["manifest"]["evaluation"]["genuine_labelled_evaluation"] is False


def test_model_missing_invalid_and_bad_features(tmp_path):
    path = tmp_path / "missing.joblib"
    assert predict_events(synthetic_feature_records(1), path)[0]["status"] == "unavailable"
    with pytest.raises(ValueError, match="at least"):
        train_model([], path)
    records = synthetic_feature_records()
    records[0]["features"]["mean_frp"] = np.inf
    with pytest.raises(ValueError, match="non-finite"):
        feature_matrix(records)
    records[0]["features"]["mean_frp"] = np.nan
    assert np.isnan(feature_matrix(records).iloc[0]["mean_frp"])
    records = synthetic_feature_records()
    train_model(records, path)
    sidecar_path = manifest_path(path)
    sidecar = json.loads(sidecar_path.read_text(encoding="utf-8"))
    sidecar["manifest"]["features"]["names_in_order"] = ["unexpected"]
    sidecar_path.write_text(json.dumps(sidecar), encoding="utf-8")
    assert predict_events(records, path)[0]["status"] == "unavailable"
    train_model(records, path)
    artifact = joblib.load(path)
    artifact["metadata"]["version"] = "incompatible"
    joblib.dump(artifact, path)
    assert predict_events(records, path)[0]["status"] == "unavailable"
    path.write_bytes(b"invalid local artifact")
    assert predict_events(records, path)[0]["status"] == "unavailable"
    train_model(records, path)
    sidecar_path.unlink()
    assert predict_events(records, path)[0]["status"] == "unavailable"


def test_dataset_manifest_checksum_and_counts(tmp_path):
    path = tmp_path / "model.joblib"
    checksum = hashlib.sha256(b"synthetic CSV bytes").hexdigest()
    metadata = train_model(synthetic_feature_records(), path, dataset={
        "source": "synthetic fixture", "kind": "synthetic", "sha256": checksum,
        "row_count": 30, "time_range_utc": ["2026-01-01", "2026-01-02"]})
    dataset = metadata["manifest"]["dataset"]
    assert dataset["checksum_algorithm"] == "sha256" and dataset["checksum"] == checksum
    assert dataset["row_count"] == 30 and dataset["event_count"] == 24
    assert load_model(path)[1]["status"] == "available"


def test_grouped_temporal_holdout_and_ranking_baselines():
    frame = pd.DataFrame({"event_id": list(range(8)), "first_seen": pd.date_range("2026-01-01", periods=8, tz="UTC"),
                          "label": [0, 1] * 4, "score": list(range(8)),
                          "peak_frp": list(range(8)), "anomaly_score": list(range(8))})
    train, test = split_event_holdout(frame, test_fraction=0.25)
    assert set(train.event_id).isdisjoint(test.event_id)
    assert test.event_id.tolist() == [6, 7]
    result = evaluate_heldout_rankings(test, ks=(1,), model_reference_event_ids=train.event_id)
    assert {"heuristic", "frp_only", "newest_first", "random_order", "anomaly_only"} == set(result["rankings"])
    assert result["rankings"]["heuristic"]["precision@1"] == 1
    assert result["rankings"]["heuristic"]["recall@1"] == 1
    with pytest.raises(ValueError, match="overlap"):
        evaluate_heldout_rankings(test, model_reference_event_ids=test.event_id)
    diagnostic = compare(pd.concat([frame] * 3, ignore_index=True).assign(frp=1,
                          time=pd.Timestamp("2026-01-01T00:00:00Z"), confidence=.6))
    assert "random_order" in diagnostic and diagnostic["n_labelled"] == 24


def test_api_keeps_existing_fields_and_adds_explicit_model_status():
    from app.main import app
    with TestClient(app) as client:
        data = client.get("/api/sample").json()
        assert {"rows", "events", "issues", "ingestion", "weights", "evaluation"} <= data.keys()
        assert "intelligence" in data
        assert data["intelligence"]["model"]["status"] in {"available", "unavailable"}
        assert len(data["intelligence"]["events"]) == len(data["events"])
        assert data["rows"][0]["score"] == pytest.approx(sum(data["rows"][0][f"c_{name}"]
               for name in ("recency", "confidence", "frp", "repeats", "brightness")))
        assert data["rows"][0]["persistent_source_status"] == "insufficient_history"


def test_api_can_report_anomaly_results_from_compatible_model(tmp_path, monkeypatch):
    from app.main import app
    path = tmp_path / "api_model.joblib"
    train_model(synthetic_feature_records(), path)
    monkeypatch.setattr("app.main.predict_events", lambda records: predict_events(records, path))
    with TestClient(app) as client:
        data = client.get("/api/sample").json()
        assert data["intelligence"]["model"]["status"] == "available"
        assert len(data["intelligence"]["events"]) == len(data["events"])
        assert all(record["anomaly"]["status"] == "available"
                   for record in data["intelligence"]["events"])
