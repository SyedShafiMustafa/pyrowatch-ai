"""Descriptive ranking checks; synthetic labels do not establish fire accuracy."""
import numpy as np
import pandas as pd
from sklearn.metrics import average_precision_score


def precision_at_k(df: pd.DataFrame, order_col: str, k: int) -> float:
    top = df.sort_values(order_col, ascending=False).head(k)
    return float(top["label"].mean())


def compare(df: pd.DataFrame, ks=(10, 25)):
    lab = df.dropna(subset=["label"]).copy()
    if len(lab) < 20:
        return {"error": "need >= 20 labelled rows"}
    lab["t_num"] = lab["time"].astype("int64")
    rankings = {"triage_score": "score", "frp_only": "frp", "newest_first": "t_num", "confidence_only": "confidence"}
    out = {name: {f"p@{k}": precision_at_k(lab, col, k) for k in ks} for name, col in rankings.items()}
    out["random_baseline"] = float(lab["label"].mean())
    rng = np.random.default_rng(17)
    lab["_random_order"] = rng.random(len(lab))
    out["random_order"] = {f"p@{k}": precision_at_k(lab, "_random_order", k) for k in ks}
    out["n_labelled"] = int(len(lab))
    out["interpretation"] = "descriptive ranking check; labels require independent provenance"
    return out


def split_event_holdout(df: pd.DataFrame, test_fraction=0.25):
    """Keep whole event IDs together; reserve the latest event groups for testing."""
    if not 0 < test_fraction < 1:
        raise ValueError("test_fraction must be between zero and one")
    if not {"event_id", "first_seen"}.issubset(df):
        raise ValueError("event_id and first_seen are required")
    if df.empty or df["event_id"].nunique() < 2:
        raise ValueError("need at least two event groups")
    groups = df.groupby("event_id")["first_seen"].min()
    times = pd.to_datetime(groups, utc=True, errors="coerce")
    if times.isna().any():
        raise ValueError("event first_seen must be valid")
    ordered = times.sort_values(kind="stable").index.to_list()
    n_test = max(1, int(np.ceil(len(ordered) * test_fraction)))
    train_ids, test_ids = set(ordered[:-n_test]), set(ordered[-n_test:])
    return df[df["event_id"].isin(train_ids)].copy(), df[df["event_id"].isin(test_ids)].copy()


def evaluate_heldout_rankings(test_events: pd.DataFrame, ks=(10, 25),
                              model_reference_event_ids=None):
    """Evaluate a separately held-out, labelled event set; never fit here."""
    required = {"event_id", "label", "score", "peak_frp", "first_seen"}
    if not required.issubset(test_events):
        raise ValueError("held-out events need event_id, label, score, peak_frp and first_seen")
    if test_events.empty or test_events["label"].isna().any() or not set(test_events["label"]).issubset({0, 1}):
        raise ValueError("held-out binary labels are required")
    if test_events["event_id"].duplicated().any():
        raise ValueError("each held-out row must represent one event")
    data = test_events.copy()
    times = pd.to_datetime(data["first_seen"], utc=True, errors="coerce")
    if times.isna().any():
        raise ValueError("held-out event times must be valid")
    data["newest_first"] = times.astype("int64")
    if not np.isfinite(data[["score", "peak_frp"]].to_numpy(dtype=float)).all():
        raise ValueError("ranking values must be finite")
    data["random_order"] = np.random.default_rng(17).random(len(data))
    columns = {"heuristic": "score", "frp_only": "peak_frp",
               "newest_first": "newest_first", "random_order": "random_order"}
    if "anomaly_score" in data and model_reference_event_ids is not None:
        if set(data["event_id"]) & set(model_reference_event_ids):
            raise ValueError("model reference and held-out event IDs overlap")
        if np.isfinite(pd.to_numeric(data["anomaly_score"], errors="coerce")).all():
            columns["anomaly_only"] = "anomaly_score"
    positives = int(data["label"].sum())
    output = {}
    for name, column in columns.items():
        ranked = data.sort_values(column, ascending=False, kind="stable")
        metrics = {"average_precision": float(average_precision_score(data["label"], data[column]))
                   if positives else None}
        for k in ks:
            n = min(k, len(ranked))
            found = int(ranked.head(n)["label"].sum())
            precision = found / n if n else 0.0
            recall = found / positives if positives else 0.0
            metrics[f"precision@{k}"] = precision
            metrics[f"recall@{k}"] = recall
            metrics[f"f1@{k}"] = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
        output[name] = metrics
    return {"n_events": len(data), "n_positive": positives,
            "rankings": output, "interpretation": "held-out event ranking; label provenance must be documented"}
