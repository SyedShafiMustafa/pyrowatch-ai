# Phase 1 ingestion audit — 2026-10-16

Scope: analyst review of thermal anomalies; not fire confirmation, prediction,
emergency response or evacuation guidance. Phase 1 only, per supplied instructions.

## Initial state

Repository: `fire-triage` inside `fire-triage-skeleton`; branch `master`, no commits.
Origin: https://github.com/SyedShafiMustafa/pyrowatch-ai.git.
Initial `git status --short`: all project files untracked (.env.example, .gitignore,
README.md, backend/, data/, docs/, frontend/, prototype/, requirements.txt, scripts/).
`git diff` was empty because nothing was tracked; this was not a clean committed baseline.
No existing AUDIT.md or repository AGENTS.md was found. Existing user files preserved.

Inspected validation, FIRMS client, API, scoring, clustering, persistent-source logic,
evaluation, frontend API callers, both scripts, requirements, data inventory and all
four existing tests. No real input CSV or historical archive exists. The only input
is `data/sample/synthetic_sample.csv`. No real data validation is claimed.

## Findings and changes

Existing validation returned `(DataFrame, issues)` and the API returned issues,
rows, events, evaluation and weights for nonempty results. These remain available.
The prior validator accepted arbitrary confidence words by first letter, accepted
nonfinite FRP, truncated fractional clock values, lost original fields, did not
deduplicate, and could crash on invalid labels. pandas CSV parsing skipped blank
lines and could throw for malformed input. These paths now have explicit outcomes.

The parser reports physical start/end lines and classifies every record after the
first nonblank header as accepted, rejected or deduplicated. Blank records (including
before the header) and repeated headers are rejected and counted. Multiline quoted
records count once, with their full physical span. Malformed quoted records may consume
multiple lines; the consumed span is rejected, never silently skipped. The primary
header is excluded from record counts. Header-only files have zero records; schema
errors are file issues. Duplicate/empty/reserved headers are rejected as schemas.

Deduplication uses exact normalized latitude, longitude, UTC acquisition timestamp,
satellite and instrument within one upload. First valid record wins; subsequent
records identify its line even when measurements differ. This is a conservative
application convention, not cross-sensor matching or archive deduplication.

Original normalized-header fields are retained as strings in `source_fields`, including
type/source, scan, track and version when present. No type is inferred. API metadata
is additive under `ingestion`. Uploaded provenance is unverified; sample endpoint
explicitly identifies synthetic data. UTF-8 decoding errors return HTTP 400.

Existing brightness gate (200–500 K) remains an application plausibility policy,
not a complete sensor validity model. `bright_ti4` and MODIS `brightness` feed the
existing score; `bright_t31` alone is intentionally unsupported because it is a
different channel. Confidence mapping l/low=.2, n/nominal=.6, h/high=1 and numeric
0–100 divided by 100 is an analyst convention, not a calibrated probability.

FIRMS client reads NASA_FIRMS_MAP_KEY from the environment (MAP_KEY and
FIRMS_MAP_KEY remain supported),
validates bounds/source/day range, disables redirects, and replaces transport/status
errors with messages excluding URLs, keys and response bodies. No .env auto-loading.
The live HTTP route additionally requires a constant-time-checked bearer token from
PYROWATCH_LIVE_FETCH_TOKEN; the frontend never contains the NASA credential. No
live FIRMS observation request was made. Tests mock HTTP.

## References checked live

- https://firms.modaps.eosdis.nasa.gov/api/area/ — CSV endpoint, coordinates,
  documented sources, 1–5 days and optional date. Client retains most-recent mode.
- https://modaps.modaps.eosdis.nasa.gov/services/about/products/viirs-land-c2-nrt/vnp14imgtdl_nrt.html
  — VIIRS fields, UTC, WGS84 pixel centres, kelvin and FRP in MW.
- https://firms.modaps.eosdis.nasa.gov/content/academy/data_ingest/firms_data_ingest.html
  — product-dependent confidence representation.
- Active-fire and web-services landing pages and Worldview were opened; their
  client-rendered content was not fully extractable. Worldview is context, not ingestion.

FRP is not fire size or danger; scan/track are approximate footprint information,
not exact boundaries. Clouds, smoke, sampling and sensor geometry leave gaps.
Thermal anomalies can have non-wildfire causes. No detection does not mean no fire.

## Verification evidence

Initial test attempt failed: system Python had no pytest or project dependencies.
Created project-local .venv and installed requirements. First sandbox test collection
failed because Windows Application Control blocked a pandas DLL. Follow-up results
are recorded below after execution; no browser or real-data checks are implied.

## Noted for later

Verification update: `pytest backend/tests/test_ingestion.py -q -k
'not upload_and_sample_contract'` passed 24 tests (1 deselected). The offline
inspector processed 232 synthetic records: 232 accepted, 0 rejected, 0 duplicates,
233 physical lines. `compileall` and `pip check` passed. Full-suite collection
outside the sandbox failed because Windows Application Control blocked scikit-learn's
`_cython_blas` DLL. This is an environment failure, not a passing integration test.
No real-data validation or browser test was run.
Another sandbox full-suite run advanced through 27 tests but stalled without a
summary; it was interrupted. It is not counted as a passing suite or API check.
NASA's MODIS attribute redirect
returned HTTP 403; the existing brightness mapping was retained rather than adding
an unverified thermal-channel alias.

Installed key package versions: Python 3.12, pandas 3.0.6, numpy 2.5.4,
scikit-learn 1.9.1, FastAPI 0.143.2, pytest 9.1.1, requests 2.34.2, httpx 0.28.1.
Requirements are still the original lower bounds; dependency pinning is future work.

Map/table completion, review notes, export UI, evaluation UI and browser checks are
outside this phase. Existing frontend counts issues as rejected rows and inserts
issue strings via innerHTML; detailed new ingestion counts are available to later UI
work. Static-source heuristics, clustering terminology, scoring design and synthetic
label interpretation remain later work. No model accuracy claims are supported.
