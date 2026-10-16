# Fire detection triage (AI/ML 1)
Explainable ranking of NASA FIRMS active-fire detections for analyst review. **Decision support only; detections are not confirmed fires and this is not an emergency-response system.**

## Run locally (Windows PowerShell)

From the repository root, start the backend on the port used by the dashboard:

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe -m uvicorn backend.app.main:app --app-dir . --host 127.0.0.1 --port 8010
```

Then open <http://127.0.0.1:8010/>. FastAPI serves the frontend from this URL,
so the page and API share an origin. Do not open `frontend/index.html` directly:
browser requests from a `file://` page have an opaque `null` origin and are not
allowed by the API's local development CORS policy.

To serve the frontend separately for development, run
`python -m http.server 5500 --bind 127.0.0.1 --directory frontend` from the
repository root and open <http://127.0.0.1:5500/>. The API explicitly allows
that local origin. Run tests with
`.\.venv\Scripts\python.exe -m pytest backend/tests -q`.

## Layout
Phase 1 ingestion audit and conventions: [docs/AUDIT.md](docs/AUDIT.md).
Inspect an existing CSV offline with `python scripts/inspect_firms.py path/to/file.csv`.
For generated fixtures add `--synthetic`. The JSON report accounts for every record
with physical source lines. API uploads expose this report under `ingestion`.
Live fetching is optional; set `MAP_KEY` in the process environment (a `.env` file
is not loaded automatically). Never commit credentials.

- `backend/app/validation.py` import + validation | `scoring.py` explainable score | `clustering.py` event grouping | `persistent.py` static-source flag | `evaluation.py` precision@k | `firms_client.py` live API
- `frontend/` Leaflet map + table (needs internet for tiles; TODOs inside)
- `prototype/fire-triage.html` standalone single-file dashboard (filters, sliders, evaluation already built; works with no server)
- `docs/` limitations, roadmap, demo script, evaluation log
- `scripts/` synthetic generator, FIRMS fetch

## Data sources
FIRMS download https://firms.modaps.eosdis.nasa.gov/active_fire | API https://firms.modaps.eosdis.nasa.gov/web-services/ | Worldview https://worldview.earthdata.nasa.gov/

## Score
0-100 weighted heuristic of recency, confidence, FRP, repeats, and brightness. Weights are analyst choices, not learned or calibrated. See [docs/SCORING.md](docs/SCORING.md) for the formula and [docs/PHASE2_API_CONTRACT.md](docs/PHASE2_API_CONTRACT.md) for verified API behavior; see `docs/LIMITATIONS.md` for interpretation limits.
