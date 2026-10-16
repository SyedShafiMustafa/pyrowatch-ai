# Fire Triage API contract — Phase 2 baseline

This note describes the current FastAPI implementation. It does not promise future
routes or persistence. A score is a heuristic analyst-review priority for satellite
thermal anomalies; it is not fire confirmation, prediction, a probability, or an
emergency-response system. See [SCORING.md](SCORING.md) for its formula and limits.

## Routes

| Method and route | Request | Response |
| --- | --- | --- |
| `GET /api/health` | None | 200, `{"ok": true}` |
| `GET /api/sample` | None | 200, pipeline response with `ingestion.data_kind = "synthetic"` |
| `POST /api/upload` | `multipart/form-data`, required file field `file`; UTF-8 CSV | 200, pipeline response; invalid UTF-8 returns 400 with `{"detail":"Upload must be UTF-8 CSV"}` |

CSV schema/row errors are returned in a successful 200 pipeline response. Empty or
unsupported-schema uploads have no scored rows and include `issues` and `ingestion`.
The API does not expose a scoring-weight request parameter; `weights` reports defaults.

## Pipeline response

| Field | Type | Presence and meaning |
| --- | --- | --- |
| `issues` | array of strings | Present; file/schema and row-level validation messages, including duplicate notices. Not a rejected-row count. |
| `rows` | array of observation objects | Present; valid, nonduplicate observations sorted by score; empty when none can be scored. |
| `events` | array of event objects | Present; current-upload spatial clusters; IDs are local to that response. |
| `evaluation` | object or null | Present; non-null only when at least 20 observations have labels. Sample results are synthetic-only. |
| `ingestion` | object | Present; record counts, physical line count, columns, outcomes and data kind. |
| `weights` | object | Present for nonempty scored results; absent when no records reach scoring. Default weights only. |

Observation objects preserve source/score fields. Common fields include numeric
`latitude`, `longitude`, `frp`, `brightness`, normalized `confidence`, `score` in
[0,100], factors `f_recency`, `f_confidence`, `f_frp`, `f_repeats`, `f_brightness`,
contributions `c_recency`, `c_confidence`, `c_frp`, `c_repeats`, `c_brightness`,
integer `repeat_count`, integer response-local `event_id`, explanation string `why`,
UTC ISO timestamp string `time`, raw `confidence_raw`, `satellite`, `daynight`,
nullable integer `label`, integer `source_line`, `source_fields` object, and boolean
`possible_static_source`. The additive `score_missing_factors` string array names
missing optional factors in direct scoring. API ingestion requires score inputs, so
normal API rows should have no missing factors.

Event objects contain `event_id`, `pixels`, `top_score`, `peak_frp`, `first_seen`,
`last_seen`, `lat`, `lon`, and `duration_h`. Times are serialized as strings.

Ingestion metadata fields: integer `total_records`, `accepted`, `rejected`,
`deduplicated`, `physical_lines`; string-array `columns`; string `data_kind`; array
`outcomes`. Every outcome has integer `line` and `end_line`, string `status` from
accepted/rejected/deduplicated, and a string `reason`. The primary header is not a
record. Schema/header issues can appear in `issues` without being counted as data
records. Synthetic sample data is labelled synthetic; uploaded data is
`user_supplied_unverified`.

Scoring defaults: recency .25, confidence .20, FRP .25, repeats .20, brightness .10.
Weights are analyst-selected and normalized by the scoring function. The HTTP API
currently exposes no weight override and returns defaults. `why` explains weighted
contributions; no calibration or accuracy guarantee is implied.

No review-note or persistence API exists. The optional local archive affects the
`possible_static_source` annotation only. No new API route, identifier stability, or
cross-request repeat/event identity is promised.

## Phase 3 integration notes

- Render `issues` as messages. Use `ingestion.accepted`, `rejected`, and
  `deduplicated` for counts. Guard optional or malformed count metadata; do not infer
  rejected records from issue count.
- Handle empty responses where `weights` is absent and `evaluation` is null.
- `event_id` is response-local and may change for a later upload.
- Treat timestamps as UTC. FRP is MW and not fire size or danger; brightness is K
  only where supported by the source channel semantics.
- The malformed-count rendering edge case is frontend-owned and was observed in
  the prior audit. This backend phase leaves frontend files unchanged; the Phase 3
  owner should validate count metadata before displaying it.
