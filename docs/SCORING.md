# Explainable triage score

The score ranks supplied thermal-anomaly observations for analyst review. It is a
heuristic priority from 0 to 100, not a probability of fire, calibrated confidence,
fire confirmation, prediction, or emergency-response guidance. The factors and
weights are analyst choices; no scientific validation or real-world accuracy claim
is made.

Each normalized factor is in [0, 1]. The API retains `f_*` factor and `c_*`
contribution columns. Default weights are:

| Factor | Weight | Transformation |
| --- | ---: | --- |
| `recency` | 0.25 | `2 ** (-age_hours / half_life_hours)`, 24-hour default half-life; age is floored at zero so future observations do not exceed 1 |
| `confidence` | 0.20 | Ingestion's analyst mapping: VIIRS low/nominal/high = 0.2/0.6/1.0; numeric 0–100 = value / 100 |
| `frp` | 0.25 | `clip(log1p(FRP_MW) / log1p(100 MW), 0, 1)`; fixed reference makes the feature comparable across upload batches |
| `repeats` | 0.20 | `clip(distinct_acquisition_times_within_72h / 4, 0, 1)` in the same rounded 0.02-degree spatial bin |
| `brightness` | 0.10 | `clip((brightness_K - 300) / 100, 0, 1)`; ingestion currently accepts 200–500 K |

For normalized effective weights `w_i` summing to one, contribution `c_i =
100 * w_i * f_i`; the final score is `clip(sum(c_i), 0, 100)`. Contributions
therefore sum to the total (up to floating-point precision). `why` reports each
existing named contribution in descending order. `score_missing_factors` lists
missing optional factors for that row; those factors contribute zero.

Scoring requires valid latitude, longitude, and timestamps. FRP, brightness and
confidence may be absent at the direct scoring boundary, but present malformed,
non-finite, out-of-range values raise `ValueError`. The ingestion API requires its
existing fields and rejects invalid rows before scoring. Zero is permitted for an
individual weight; unknown, negative, non-finite, malformed, or all-zero effective
weights are rejected. Partial overrides use defaults for unspecified factors, then
all weights are normalized to sum to one.

The default reference time is the latest observation time in the supplied scoring
batch, so the same batch gives deterministic recency without consulting the machine
clock. Tests and callers may supply `ref_time`; future records relative to that time
receive the maximum recency factor. Input timestamps are interpreted as UTC by
scoring; ingestion already normalizes acquisition timestamps to UTC.

Repeats count distinct acquisition times in the same rounded coordinate bin within
72 hours, excluding simultaneous pixels from the repeat count. Exact duplicate rows
are removed during a single-file ingestion before scoring. The bin is approximate,
not a footprint; this is upload-local and does not link events across requests.
Counts saturate at four for the factor. These rules can still group unrelated
observations and cannot distinguish a fire from persistent industrial, agricultural,
volcanic, or other heat sources.

An absent optional factor is reported and assigned zero for that row. In a direct
call with one globally missing feature, its default weight remains in the denominator;
the missing factor therefore lowers the score instead of redistributing weight.
This conservative rule keeps identical observations comparable when other rows
contain the feature. No population, infrastructure, weather, land-cover, or external
context feature is used. FRP is not fire size or danger, and confidence mappings are
not calibrated probabilities. Cloud, smoke, overpass timing, sensor properties,
and observation geometry create important gaps; no detection does not mean no fire.
