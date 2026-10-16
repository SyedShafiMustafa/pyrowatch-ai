"""Regression tests for the deterministic heuristic priority formula."""
import math

import numpy as np
import pandas as pd
import pytest

from app.scoring import DEFAULT_WEIGHTS, explain, score


def observations():
    return pd.DataFrame({
        "latitude": [10.0, 10.001, 10.0],
        "longitude": [20.0, 20.001, 20.0],
        "time": pd.to_datetime([
            "2026-10-10T00:00:00Z", "2026-10-10T00:00:00Z",
            "2026-10-11T00:00:00Z",
        ], utc=True),
        "confidence": [1.0, 0.6, 0.2],
        "frp": [100.0, 10.0, 0.0],
        "brightness": [400.0, 350.0, 300.0],
    })


def test_weighted_formula_and_explanation_are_consistent():
    result = score(observations(), ref_time="2026-10-11T00:00:00Z")
    assert result.score.between(0, 100).all()
    for name, weight in DEFAULT_WEIGHTS.items():
        assert np.allclose(result[f"c_{name}"], 100 * weight * result[f"f_{name}"])
    assert np.allclose(result.score, result[[f"c_{name}" for name in DEFAULT_WEIGHTS]].sum(axis=1))
    assert explain(result.iloc[0]).startswith("+")


def test_fixed_frp_scale_is_independent_of_batch_composition():
    one = score(observations().iloc[[0]], ref_time="2026-10-11T00:00:00Z")
    larger = score(observations(), ref_time="2026-10-11T00:00:00Z")
    row = larger.loc[larger.frp == 100].iloc[0]
    assert row.f_frp == one.iloc[0].f_frp == 1
    low = score(observations().iloc[[2]], ref_time="2026-10-11T00:00:00Z")
    assert low.iloc[0].f_frp == 0


def test_reference_time_is_deterministic_and_future_time_is_bounded():
    df = observations().iloc[[0, 2]].copy()
    ref = "2026-10-11T00:00:00Z"
    first = score(df, ref_time=ref)
    second = score(df, ref_time=ref)
    pd.testing.assert_frame_equal(first, second)
    assert first.f_recency.between(0, 1).all()
    assert score(df, ref_time="2026-10-10T12:00:00Z").f_recency.max() == 1
    assert first.f_recency.iloc[0] == pytest.approx(0.5)


def test_repeat_factor_counts_distinct_times_not_simultaneous_pixels():
    result = score(observations(), ref_time="2026-10-11T00:00:00Z")
    simultaneous = result[result.time == pd.Timestamp("2026-10-10T00:00:00Z")]
    assert simultaneous.repeat_count.eq(1).all()
    assert result.f_repeats.max() <= 1


def test_missing_optional_factors_are_neutral_and_reported_per_row():
    df = observations().iloc[:2].copy()
    df.loc[df.index[0], "frp"] = np.nan
    df.loc[df.index[1], "brightness"] = np.nan
    df.loc[df.index[1], "confidence"] = np.nan
    result = score(df, ref_time="2026-10-10T00:00:00Z")
    missing = {row.latitude: row.score_missing_factors for _, row in result.iterrows()}
    assert missing[10.0] == ["frp"]
    assert missing[10.001] == ["brightness", "confidence"]
    assert result.f_frp.notna().all() and result.f_brightness.notna().all()
    assert result.score.notna().all()


@pytest.mark.parametrize("column,value", [
    ("frp", np.inf), ("frp", -1), ("frp", "not numeric"), ("brightness", np.inf),
    ("brightness", 501), ("confidence", np.inf), ("confidence", 1.1),
    ("latitude", np.inf), ("longitude", -181),
])
def test_invalid_scoring_inputs_are_rejected(column, value):
    df = observations().iloc[:1].copy()
    df[column] = df[column].astype(object)
    df.loc[df.index[0], column] = value
    with pytest.raises(ValueError, match=column):
        score(df)


@pytest.mark.parametrize("ref", ["invalid", pd.NaT])
def test_invalid_reference_time_is_rejected(ref):
    with pytest.raises(ValueError, match="ref_time"):
        score(observations(), ref_time=ref)


@pytest.mark.parametrize("weights", [
    {"frp": -1}, {"frp": np.inf}, {"frp": np.nan}, {"frp": "bad"},
    {"recency": 1e308, "confidence": 1e308}, {"unknown": 1},
    {"recency": 0, "confidence": 0, "frp": 0, "repeats": 0, "brightness": 0},
    "bad",
])
def test_invalid_weights_are_rejected(weights):
    with pytest.raises(ValueError):
        score(observations(), weights=weights)


def test_partial_weights_normalize_and_zero_weight_is_supported():
    result = score(observations(), weights={"frp": 0}, ref_time="2026-10-11T00:00:00Z")
    assert result.attrs["effective_weights"]["frp"] == 0
    assert math.fsum(result.attrs["effective_weights"].values()) == pytest.approx(1)
    assert result.c_frp.eq(0).all()


def test_empty_input_and_extreme_valid_values_are_finite():
    empty = score(pd.DataFrame())
    assert empty.empty
    df = observations().iloc[:1].copy()
    df.loc[df.index[0], "frp"] = 1e300
    df.loc[df.index[0], "brightness"] = 500
    result = score(df, ref_time="2026-10-10T00:00:00Z")
    assert np.isfinite(result.score).all()
    assert result.f_frp.iloc[0] == 1 and result.f_brightness.iloc[0] == 1


def test_identical_input_and_reference_give_identical_outputs():
    df = observations()
    first = score(df, weights={"frp": 0.4}, ref_time="2026-10-11T00:00:00Z")
    second = score(df, weights={"frp": 0.4}, ref_time="2026-10-11T00:00:00Z")
    pd.testing.assert_frame_equal(first, second)
