# Phase 4 API handoff

Existing routes remain `GET /api/health`, `GET /api/sample`, and
`POST /api/upload` (UTF-8 CSV multipart field `file`). Their existing status
codes, `issues`, `rows`, `events`, `evaluation`, `ingestion`, `weights`, score,
factor and contribution fields remain. See [PHASE2_API_CONTRACT.md](PHASE2_API_CONTRACT.md).
Phase 4 adds response fields; it has no new endpoint or upload parameter.
Accepted rows also expose the source `instrument` value when supplied, so the
Phase 3 satellite/instrument filter can use genuine FIRMS CSVs. When that
column is absent, the value is `null`; `source_fields` still retains
the original source columns.

For a successful nonempty sample or upload, the new shape is:

```json
{
  "rows": [{
    "score": 64.2,
    "f_frp": 0.7,
    "c_frp": 17.5,
    "possible_static_source": false,
    "persistent_source_status": "insufficient_history",
    "persistent_source_evidence": {
      "reason": "no historical archive", "distinct_times": 0,
      "distinct_days": 0, "coverage_days": 0.0
    }
  }],
  "events": [{"event_id": 0, "pixels": 3, "top_score": 64.2}],
  "intelligence": {
    "model": {"status": "unavailable", "version": "phase4-event-iforest-v1",
              "reason": "model artifact is missing"},
    "events": [{
      "event_id": 0,
      "first_seen": "2026-10-10T00:00:00+00:00",
      "last_seen": "2026-10-11T00:00:00+00:00",
      "features": {"detection_count": 3, "mean_frp": 12.0},
      "missing_features": ["observed_footprint_delta_km2"],
      "trend": {"status": "rising", "frp_change_mw": 5.0,
                 "frp_change_fraction": 0.5,
                 "early_detections_per_time": 1.0,
                 "late_detections_per_time": 1.0,
                 "distinct_observation_times": 3,
                 "span_h": 24.0,
                 "reason": "observed first-to-last mean FRP; gaps and missed passes are unobserved",
                 "sampling_limitation": "observation opportunities and missed overpasses are unknown"},
      "anomaly": {"event_id": 0, "status": "unavailable",
                  "model_version": "phase4-event-iforest-v1",
                  "anomaly_score": null, "anomaly_flag": null}
    }]
  }
}
```

This example is schematic: the actual response retains all Phase 2 fields and
each feature record contains every name listed in [PHASE4_ML_DESIGN.md](PHASE4_ML_DESIGN.md).
`event_id` joins `events` to `intelligence.events` and is stable only inside one
response. For an empty or invalid upload, `intelligence.events` is empty and
`intelligence.model` still reports availability. Existing ingestion errors keep
their Phase 2 behavior; an invalid UTF-8 upload still returns HTTP 400.

`score` remains the 0–100 uncalibrated heuristic review priority. Its `f_*`,
`c_*`, `why` and `score_missing_factors` fields have not changed. The event
`anomaly_score` is a separate uncalibrated Isolation Forest value: larger is more
anomalous, and `anomaly_flag` is true above zero. When the model is unavailable,
the score and flag are `null`, while all heuristic output remains available.
Model status is `available` or `unavailable`; reason explains missing, invalid or
incompatible local artifacts. The model version is explicit in both model and
per-event anomaly results.
Scores are not comparable across different trained artifacts or reference datasets.
The contamination setting is a fitted reference threshold choice, not a measured
fire prevalence. No anomaly value is a fire probability.

Trend status is `rising`, `falling`, `stable`, or `insufficient_data`. It describes
observed first-to-last mean FRP change under the documented thresholds, not
continuous fire behavior. Frequency measurements are detections per observed
acquisition time; revisit opportunities are unknown. Footprint change is a coordinate bounding-box proxy, not
confirmed physical spread. Unavailable measurements are `null` and named in
`missing_features`; present invalid numeric inputs are rejected before scoring.

Persistent status is `possible_persistent_source`, `not_flagged`, or
`insufficient_history`, with distinct historical times/dates, coverage and
thresholds in `persistent_source_evidence`. This is recurrence evidence, not a
source-type classification. No observation is suppressed or penalized.

Suggested dashboard labels: **Heuristic review priority**, **Anomaly compared
with reference events**, **Observed FRP trend**, **Historical recurrence**, and
**Missing measurements**. Show model-unavailable and insufficient-history states
as such. Keep the satellite-detection and non-emergency limitations visible.
