"""Labelled-sample evaluation. Synthetic labels test the pipeline only; they say nothing about real accuracy."""
import pandas as pd


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
    out["n_labelled"] = int(len(lab))
    return out
