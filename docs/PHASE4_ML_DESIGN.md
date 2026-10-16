# Phase 4 event intelligence design

All outputs support analyst review of satellite thermal anomalies. They are not
wildfire probabilities, fire confirmations, predictions, perimeter estimates, or
emergency-response guidance. The Phase 2 heuristic and its weights are unchanged;
the event anomaly score is reported separately and never alters the ranking.

## Event grouping and measurements

`cluster_events` sorts valid UTC acquisition times and coordinates, then greedily
forms candidate groups. Every member must be within 2 km (haversine) of every
other member, and the first-to-last acquisition span must be at most 72 hours;
both thresholds can be supplied to the function. This prevents spatial and time
chaining across those bounds. Invalid or missing times and nonfinite coordinates
are rejected. Satellite and instrument fields, where supplied, are retained but
do not establish cross-sensor identity or split groups. Exact duplicate rows are
deduplicated by ingestion using location, time, satellite, and instrument;
remaining repeated detections count as observations, while equal timestamps count
as one acquisition time. IDs are deterministic for reordered rows with distinct
time/coordinate keys, but are local response indexes, not durable identities.
At the threshold, nearby independent heat sources can still be merged; sparse
observations can also split one physical fire. Neither outcome establishes a
confirmed individual fire.

Features are computed in UTC acquisition order. Simultaneous detections count as
one distinct acquisition time. `detection_frequency_delta` compares detections
per acquisition time in the early and late halves; it is a sampling opportunity
count, not a measured overpass opportunity rate. `median_revisit_h` shows the observed
median gap. `frp_delta_mw` compares mean FRP at the first and last acquisition
times. `observed_footprint_delta_km2` compares coordinate bounding-box areas at
those times, and is missing unless each end has at least two detections. This
bounding box is not a mapped fire perimeter or confirmed physical spread.

The stable numeric event feature schema, in order, is:

| Name | Meaning |
| --- | --- |
| `detection_count` | Number of validated observations in the event group |
| `distinct_observation_times` | Number of unique UTC acquisition times |
| `duration_h` | First-to-last observed time span in hours |
| `peak_frp`, `mean_frp` | Maximum and mean supplied FRP in MW |
| `mean_confidence` | Mean normalized confidence mapping, not a probability |
| `peak_brightness`, `mean_brightness` | Maximum and mean brightness in K |
| `frp_delta_mw` | Last minus first acquisition-time mean FRP |
| `detection_frequency_delta` | Late minus early detections per acquisition time |
| `observed_footprint_delta_km2` | Last minus first observed coordinate bounding-box area |
| `median_revisit_h` | Median observed gap between distinct acquisition times |

`missing_features` names measurements unavailable for an event. Invalid present
numeric values and invalid timestamps are rejected at the feature boundary.

## Trend rules

At least three distinct acquisition times with valid, finite, nonnegative FRP,
including the first and last, spanning six hours are required. A gap between
observed times over 72 hours also yields `insufficient_data`. Otherwise, the
first-to-last mean FRP change is `rising` when it is at least +2 MW and +25%,
`falling` when at most -2 MW and -25%, and `stable` otherwise. The relative
denominator is `max(first_mean_frp, 1 MW)`. Detection counts per acquisition time
are supporting measurements, not activity classifications. Zero FRP is valid;
repeated timestamps are combined before the trend gate. Irregular revisit
intervals, clouds and missing passes prevent an inference of continuous growth
or decline. Full observation-opportunity metadata is unavailable, so this code
does not adjust detection counts for revisit frequency. The API includes a
`sampling_limitation` message even when the FRP trend can be computed.

## Historical recurrence

The existing `possible_static_source` boolean retains its default rule: at least
10 distinct historical dates in the same rounded 0.01-degree coordinate bin.
The new status is `possible_persistent_source`, `not_flagged`, or
`insufficient_history`. No archive, or fewer than 10 distinct dates in the
overall archive, yields insufficient history. Evidence includes distinct times,
distinct dates, first/last historical observations, coverage days and thresholds.
Only archive observations at or before each current observation are considered.
Optional `cell_deg`, `min_days`, `min_distinct_times`, `min_coverage_days` and
`lookback_days` parameters change the decision rule. The default optional limits
are zero/none to preserve the Phase 1 boolean. No physical source type is inferred;
a recurring location can also have a genuine fire. The flag never suppresses a
record or changes its heuristic score.

## Isolation Forest model

The model operates on event features, not raw rows. `scripts/train_phase4_model.py`
loads a CSV through the validated ingestion pipeline, forms event groups, extracts
the schema above, fits median imputation and scaling on that reference set only,
then fits `IsolationForest(contamination=0.05, random_state=17)`. At least 20
event groups with nonempty features are required. Inference uses the fitted
preprocessing pipeline; it does not refit on an uploaded batch. The model is
unsupervised and does not use fire labels.

For a reproducible **synthetic software check**:

```powershell
.\.venv\Scripts\python.exe scripts/train_phase4_model.py data/sample/synthetic_sample.csv --synthetic
```

The default local artifact is `models/phase4_event_iforest.joblib`, ignored by Git,
with a companion `.joblib.manifest.json` file that is also ignored.
For another reference, supply a provenance-documented CSV path and an optional
`--output` path. Artifact metadata records model version
`phase4-event-iforest-v1`, exact feature schema, scikit-learn version, reference,
training count, seed, contamination and decision threshold. The machine-readable
manifest records source, data kind, SHA-256 of the raw input CSV, accepted row
count, event count, UTC time range, ordered features, preprocessing version,
model parameters, runtime versions, and the absence of a train/evaluation split
or genuine labelled evaluation. Direct programmatic training without a CSV records
unknown/null dataset details. `--synthetic` declares generated data; omission
leaves the kind unknown, not verified genuine. It records no performance metric.
The sidecar stores the artifact SHA-256 and must match the embedded manifest.
The loader requires that consistency, the exact model/schema/scikit-learn version,
preprocessing version, and a fitted pipeline. Missing or
incompatible artifacts produce `unavailable`, without changing the heuristic API.
Only load artifacts generated locally from trusted sources: joblib uses pickle
and must not be used on untrusted files.

`anomaly_score = -IsolationForest.decision_function(features)`. Larger scores
are more anomalous; `anomaly_flag` is true when the decision function is below
zero, equivalent to `anomaly_score > 0`. Zero is the fitted Isolation Forest
threshold, not a calibrated wildfire risk threshold. An anomalous event may be
non-fire, and an ordinary score does not rule out danger. Missing feature values
are imputed with training medians; the per-event missing list remains visible.
The contamination setting defines a fitted score offset for the reference sample;
it is not a measured prevalence of fires or anomalies in the world. Scores from
different artifacts or reference datasets are not directly comparable.

Known failure modes include incomplete historical archives, mixed sensor
properties, unstable event grouping, unrepresentative training references,
nonstationary seasons/regions, and sparse acquisition times. Synthetic training
and tests do not establish real-world classification accuracy.
