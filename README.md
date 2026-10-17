# PyroWatch AI — Fire detection triage
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

If port 8010 is already in use, leave its process running and start this checkout
on another free port, for example:

```powershell
.\.venv\Scripts\python.exe -m uvicorn backend.app.main:app --app-dir . --host 127.0.0.1 --port 8012
```

Open <http://127.0.0.1:8012/> in that case. The combined app uses its own origin
for API requests; no frontend URL or backend endpoint changes are needed.

To serve the frontend separately for development, run
`python -m http.server 5500 --bind 127.0.0.1 --directory frontend` from the
repository root and open <http://127.0.0.1:5500/>. The API explicitly allows
that local origin when the backend is on port 8010.

## Deploy to Vercel

Import this repository into Vercel with the repository root as the project root.
Vercel reads the `tool.vercel.entrypoint` and runtime dependencies in
`pyproject.toml` to deploy `backend.app.main:app` as the Python FastAPI
application. The root `StaticFiles` mount serves the frontend on the same
origin; Vercel promotes its files to the CDN. `vercel.json` explicitly bundles
the synthetic sample CSV, which the `/api/sample` route reads at runtime.
`requirements.txt` remains the local development and test dependency list.

No frontend API URL or secrets are required for the combined deployment. The
dashboard uses the deployed page's origin for `/api/health`, `/api/sample`, and
`/api/upload`. CSV uploads remain subject to Vercel's request-body limit in
addition to the application's configured upload limit.

After importing, leave the Build Command and Output Directory unset so Vercel
uses its Python/FastAPI detection, and deploy the `feature/pyrowatch-full-integration`
branch for a preview. Verify the deployment URL's `/`, `/api/health`, and
`/api/sample` routes and test a small CSV upload before promoting it.

Run backend tests with
`.\.venv\Scripts\python.exe -m pytest backend/tests -q`. Run frontend tests
from PowerShell with:

```powershell
$frontendTests = Get-ChildItem .\frontend\tests -Filter *.test.cjs | ForEach-Object { $_.FullName }
node --test $frontendTests
```

## Layout
Phase 1 ingestion audit and conventions: [docs/AUDIT.md](docs/AUDIT.md).
Inspect an existing CSV offline with `python scripts/inspect_firms.py path/to/file.csv`.
For generated fixtures add `--synthetic`. The JSON report accounts for every record
with physical source lines. API uploads expose this report under `ingestion`.
The browser dashboard has no live-fetch endpoint or continuous satellite feed.
The optional `scripts/fetch_firms.py` CLI can retrieve FIRMS data when `MAP_KEY`
is set in the process environment (`.env` files are not loaded automatically);
the synthetic sample is clearly marked as synthetic. Never commit credentials.

- `backend/app/` validation, official explainable priority, candidate-event grouping, historical evidence and intelligence, and the FastAPI health/sample/upload routes
- `frontend/` analyst workspace with event history, filters, timeline, map/globe, analytics and evidence report preview/download
- `prototype/fire-triage.html` standalone single-file dashboard (filters, sliders, evaluation already built; works with no server)
- `docs/` limitations, roadmap, demo script, evaluation log
- `scripts/` synthetic generator, FIRMS fetch

## Data sources
FIRMS download https://firms.modaps.eosdis.nasa.gov/active_fire | API https://firms.modaps.eosdis.nasa.gov/web-services/ | Worldview https://worldview.earthdata.nasa.gov/

## Score
0-100 weighted heuristic of recency, confidence, FRP, repeats, and brightness. Weights are analyst choices, not learned or calibrated. See [docs/SCORING.md](docs/SCORING.md) for the formula and [docs/PHASE2_API_CONTRACT.md](docs/PHASE2_API_CONTRACT.md) for verified API behavior; see `docs/LIMITATIONS.md` for interpretation limits.
