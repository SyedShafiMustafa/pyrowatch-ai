# Phase 4.2: NASA FIRMS CSV compatibility

This is a data-format and pipeline check, not a wildfire classification or
accuracy evaluation. FIRMS thermal detections are not confirmed fires.

## Source and selection

- Official NASA FIRMS tutorial: <https://firms.modaps.eosdis.nasa.gov/content/academy/data_subset/subSetDataFromShapeFileOrPolygon.html>
- Original CSV: <https://firms.modaps.eosdis.nasa.gov/content/notebooks/sample_viirs_snpp_071223.csv>
- Product described by NASA: VIIRS 375 m, Suomi NPP, near-real-time sample.
  The CSV's `satellite` value is `N` and `instrument` is `VIIRS`.
- Downloaded: 2026-10-16 UTC. Original file: 6,077,404 bytes,
  74,605 records, SHA-256
  `edf79f62b35ba4485d7c85e01be5f6f61d30ab7b4addcf2eea00e2581982c30f`.
- Original coverage: global coordinates, latitude -77.52732 to 71.09212,
  longitude -164.05351 to 178.79655; acquisition 2023-07-12
  00:03–19:50 UTC. These are the observed CSV bounds, not complete orbital
  coverage or a claim that no other detections existed.
- The repository fixture
  `data/validation/viirs_snpp_20230712_california_bbox.csv` retains the
  original header and every source row inside the inclusive rectangle
  latitude 32–42, longitude -125–-114. No observations were fabricated or
  relabelled. It contains 73 records. SHA-256:
  `bd5e3c0e4c970f74e4874d4562e6b9f205ce604c9cb729dbd73e41376994fc1e`.
  The full downloaded CSV is locally ignored by Git to avoid accidentally
  including a 6 MB source file in a commit.

## Validation results

The full original CSV was passed through `inspect_csv_text`: 74,605 input
records, 74,599 accepted, 0 rejected, and 6 deduplicated. Its required fields
(`latitude`, `longitude`, `acq_date`, `acq_time`, `confidence`, `frp`, and
`bright_ti4`) were present. There were no missing values in its 14 columns,
no invalid coordinates, and no timestamp parsing failures. Accepted FRP ranged
from 0 to 584.09 and `bright_ti4` from 208 to 367. This reports only this
specific NASA sample.

The 73-row geographic fixture had 73 accepted, 0 rejected and 0 deduplicated
records. Its accepted acquisition span was 2023-07-12 08:24–19:43 UTC.
Scoring and clustering yielded 46 candidate review groups. Event features
completed for all 46; all trends reported `insufficient_data`, as no group
met the documented temporal evidence rule. Without a historical archive, all
73 rows reported `insufficient_history` for recurrence. The local anomaly
artifact was absent, so the model and all 46 event anomaly results reported
`unavailable` with null scores. The API pipeline produced 73 rows and 46 events.
Uploading the fixture through `POST /api/upload` returned HTTP 200 with those
counts. The API marks any upload `user_supplied_unverified`; provenance is
established by the source URL and checksum documented here, not inferred by
the endpoint.
The heuristic score range was 31.8982–68.9872; it is separate from anomaly
scores and is not a fire probability.

The full 74,605-row global file was validated for schema and row accounting.
Downstream clustering and API processing were exercised on the documented
73-row regional subset. This does not establish throughput for a global upload.
There are no fire/no-fire ground-truth labels in either file, so labelled
precision, recall and model accuracy remain unverified. The data are from
2023 and should not be presented as current activity.
