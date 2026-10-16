"""Optional event-level Isolation Forest; independent of heuristic priority."""
from pathlib import Path
import hashlib
import json
import math
import os
import platform
import tempfile

import joblib
import numpy as np
import pandas as pd
import sklearn
from sklearn.ensemble import IsolationForest
from sklearn.impute import SimpleImputer
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler

from .event_features import FEATURE_SCHEMA

MODEL_VERSION = "phase4-event-iforest-v1"
MODEL_PATH = Path(__file__).resolve().parents[2] / "models" / "phase4_event_iforest.joblib"
RANDOM_SEED = 17
MIN_TRAIN_EVENTS = 20
CONTAMINATION = 0.05
THRESHOLD = 0.0
PREPROCESSING_VERSION = "median-imputer-standard-scaler-v1"


def manifest_path(path):
    return Path(str(path) + ".manifest.json")


def _sha256(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def feature_matrix(records):
    """Validate names and numbers; missing values stay NaN for fitted imputation."""
    rows = []
    for record in records:
        features = record.get("features", record)
        if set(features) != set(FEATURE_SCHEMA):
            raise ValueError("event feature schema mismatch")
        row = []
        for name in FEATURE_SCHEMA:
            value = features[name]
            if value is None or pd.isna(value):
                row.append(np.nan)
                continue
            try:
                number = float(value)
            except (TypeError, ValueError, OverflowError):
                raise ValueError(f"invalid event feature: {name}") from None
            if not math.isfinite(number):
                raise ValueError(f"non-finite event feature: {name}")
            row.append(number)
        rows.append(row)
    return pd.DataFrame(rows, columns=FEATURE_SCHEMA, dtype=float)


def train_model(records, path=MODEL_PATH, reference="unknown", dataset=None):
    """Fit only on the supplied reference records and persist a trusted local artifact."""
    features = feature_matrix(records)
    if len(features) < MIN_TRAIN_EVENTS:
        raise ValueError(f"need at least {MIN_TRAIN_EVENTS} reference events")
    if features.dropna(how="all").shape[0] < MIN_TRAIN_EVENTS:
        raise ValueError("insufficient nonempty reference features")
    pipeline = Pipeline([
        ("imputer", SimpleImputer(strategy="median", keep_empty_features=True)),
        ("scaler", StandardScaler()),
        ("forest", IsolationForest(contamination=CONTAMINATION, random_state=RANDOM_SEED)),
    ])
    pipeline.fit(features)
    metadata = {"version": MODEL_VERSION, "feature_schema": list(FEATURE_SCHEMA),
                "sklearn_version": sklearn.__version__, "training_events": len(features),
                "reference": reference, "random_seed": RANDOM_SEED,
                "contamination": CONTAMINATION, "decision_threshold": THRESHOLD,
                "granularity": "event"}
    dataset = dataset or {}
    manifest = {
        "manifest_version": 1,
        "dataset": {"source": dataset.get("source", reference),
                    "kind": dataset.get("kind", "unknown"),
                    "checksum_algorithm": "sha256" if dataset.get("sha256") else None,
                    "checksum": dataset.get("sha256"),
                    "time_range_utc": dataset.get("time_range_utc"),
                    "row_count": dataset.get("row_count"),
                    "event_count": len(features)},
        "features": {"names_in_order": list(FEATURE_SCHEMA),
                     "schema_version": MODEL_VERSION,
                     "preprocessing_version": PREPROCESSING_VERSION},
        "model": {"type": "IsolationForest", "contamination": CONTAMINATION,
                  "random_seed": RANDOM_SEED, "decision_threshold": THRESHOLD,
                  "parameters": pipeline.named_steps["forest"].get_params()},
        "runtime": {"python": platform.python_version(),
                    "numpy": np.__version__, "pandas": pd.__version__,
                    "scikit_learn": sklearn.__version__, "joblib": joblib.__version__},
        "evaluation": {"split": None, "method": None,
                       "genuine_labelled_evaluation": False},
        "limitations": ["unsupervised anomaly indicator, not fire probability",
                        "candidate groups are not confirmed fires",
                        "no genuine labelled evaluation in this training command"],
    }
    metadata["manifest"] = manifest
    artifact = {"metadata": metadata, "pipeline": pipeline}
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=target.parent, suffix=".joblib", delete=False) as handle:
        temporary = Path(handle.name)
    try:
        joblib.dump(artifact, temporary)
        os.replace(temporary, target)
    finally:
        temporary.unlink(missing_ok=True)
    sidecar = manifest_path(target)
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=target.parent,
                                     suffix=".json", delete=False) as handle:
        sidecar_temp = Path(handle.name)
        json.dump({"manifest": manifest, "artifact_sha256": _sha256(target)}, handle,
                  indent=2, sort_keys=True)
    try:
        os.replace(sidecar_temp, sidecar)
    finally:
        sidecar_temp.unlink(missing_ok=True)
    return metadata


def load_model(path=MODEL_PATH):
    """Return an explicit unavailable status for missing or incompatible artifacts."""
    target = Path(path)
    if not target.is_file():
        return None, {"status": "unavailable", "version": MODEL_VERSION,
                      "reason": "model artifact is missing"}
    try:
        with manifest_path(target).open(encoding="utf-8") as handle:
            sidecar = json.load(handle)
        if sidecar.get("artifact_sha256") != _sha256(target):
            raise ValueError("model artifact checksum mismatch")
        artifact = joblib.load(target)  # Only load locally generated, trusted files.
        metadata = artifact["metadata"]
        pipeline = artifact["pipeline"]
        compatible = (metadata.get("version") == MODEL_VERSION
                      and metadata.get("manifest") == sidecar.get("manifest")
                      and sidecar["manifest"]["features"]["names_in_order"] == list(FEATURE_SCHEMA)
                      and sidecar["manifest"]["features"]["preprocessing_version"] == PREPROCESSING_VERSION
                      and metadata.get("feature_schema") == list(FEATURE_SCHEMA)
                      and metadata.get("sklearn_version") == sklearn.__version__
                      and metadata.get("granularity") == "event"
                      and metadata.get("decision_threshold") == THRESHOLD
                      and isinstance(pipeline, Pipeline)
                      and isinstance(pipeline.named_steps.get("imputer"), SimpleImputer)
                      and isinstance(pipeline.named_steps.get("scaler"), StandardScaler)
                      and isinstance(pipeline.named_steps.get("forest"), IsolationForest)
                      and pipeline.n_features_in_ == len(FEATURE_SCHEMA))
        if not compatible:
            raise ValueError("model metadata or fitted schema is incompatible")
    except Exception:
        return None, {"status": "unavailable", "version": MODEL_VERSION,
                      "reason": "model artifact is invalid or incompatible"}
    return pipeline, {"status": "available", "version": MODEL_VERSION,
                      "reason": None}


def predict_events(records, path=MODEL_PATH):
    pipeline, status = load_model(path)
    if pipeline is None:
        return status, [{"event_id": record["event_id"], "status": "unavailable",
                         "model_version": MODEL_VERSION, "anomaly_score": None,
                         "anomaly_flag": None} for record in records]
    try:
        features = feature_matrix(records)
        decisions = pipeline.decision_function(features) if records else []
        if not np.isfinite(decisions).all():
            raise ValueError("model returned non-finite decisions")
    except Exception:
        unavailable = {"status": "unavailable", "version": MODEL_VERSION,
                       "reason": "event features are incompatible with model"}
        return unavailable, [{"event_id": record["event_id"], "status": "unavailable",
                              "model_version": MODEL_VERSION, "anomaly_score": None,
                              "anomaly_flag": None} for record in records]
    output = [{"event_id": record["event_id"], "status": "available",
               "model_version": MODEL_VERSION, "anomaly_score": float(-decision),
               "anomaly_flag": bool(decision < THRESHOLD)}
              for record, decision in zip(records, decisions)]
    return status, output
