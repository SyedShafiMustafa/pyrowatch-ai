# PyroWatch AI — Fire detection triage
Explainable ranking of NASA FIRMS active-fire detections for analyst review. **Decision support only; detections are not confirmed fires and this is not an emergency-response system.**

## Run locally (Windows PowerShell)

From the repository root, start the backend on the port used by the dashboard:

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
$secureKey = Read-Host "NASA FIRMS MAP_KEY" -AsSecureString
$keyPtr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
try { $env:NASA_FIRMS_MAP_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($keyPtr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($keyPtr); $secureKey.Dispose() }
$env:PYROWATCH_LIVE_FETCH_TOKEN = [guid]::NewGuid().ToString("N")
Write-Host "Enter this live-fetch token in Data Operations: $env:PYROWATCH_LIVE_FETCH_TOKEN"
$env:PYTHONPATH = "backend"
.\.venv\Scripts\python.exe -m uvicorn backend.app.main:app --app-dir . --host 127.0.0.1 --port 8013
```

The commands securely prompt for the NASA key and generate a separate random
live-fetch access token. The token must be entered into the Data Operations
form for each browser session. Never put either value in frontend source or a
committed `.env`; only the separate access token is sent in the authorized live
fetch request. The server also accepts legacy NASA key environment names
`MAP_KEY` and `FIRMS_MAP_KEY`. Leave the NASA key unset to use sample and CSV
workflows without live fetch.

Then open <http://127.0.0.1:8013/>. FastAPI serves the frontend from this URL,
so the page and API share an origin. Do not open `frontend/index.html` directly:
browser requests from a `file://` page have an opaque `null` origin and are not
allowed by the API's local development CORS policy.

If port 8010 is already in use, leave its process running and start this checkout
on another free port, for example:

```powershell
.\.venv\Scripts\python.exe -m uvicorn backend.app.main:app --app-dir . --host 127.0.0.1 --port 8013
```

Open <http://127.0.0.1:8013/> in that case. The combined app uses its own origin
for API requests; no frontend URL or backend endpoint changes are needed.

To serve the frontend separately for development, run
`python -m http.server 5500 --bind 127.0.0.1 --directory frontend` from the
repository root and open <http://127.0.0.1:5500/>. For this origin the frontend
uses `http://127.0.0.1:8013` as its API base URL; the backend explicitly allows
that local origin and the Authorization header.

## Deploy to Vercel

Import this repository into Vercel with the repository root as the project root.
Vercel reads the `tool.vercel.entrypoint` and runtime dependencies in
`pyproject.toml` to deploy `backend.app.main:app` as the Python FastAPI
application. The root `StaticFiles` mount serves the frontend on the same
origin; Vercel promotes its files to the CDN. `vercel.json` explicitly bundles
the synthetic sample CSV, which the `/api/sample` route reads at runtime.
`requirements.txt` remains the local development and test dependency list.

The dashboard uses the deployed page's origin for `/api/health`, `/api/sample`,
`/api/upload`, and `/api/firms/area`. To enable live requests, add both
`NASA_FIRMS_MAP_KEY` and a separate high-entropy `PYROWATCH_LIVE_FETCH_TOKEN`
to the Vercel project's Environment Variables for each deployment environment
that needs it, then redeploy. Enter the latter in the Data Operations token
field to authorize a request; the NASA key is never sent to the browser. The
existing FastAPI entrypoint and Python dependencies (`requests`) serve this route;
no separate function or frontend API URL is needed. The NASA client has a
30-second upstream timeout; `vercel.json` allows up to 60 seconds for the Python
function so the upstream request and normal observation processing can finish.
The Vercel plan must permit that configured duration. CSV uploads
remain subject to Vercel's request-body limit in addition to the application's
configured upload limit.

Live fetches require the separate bearer token even on cache hits. Each running
Python instance caches up to eight area/source/day requests for five minutes,
preserving the original `live_fetch.fetched_at` and exposing `cached` and
`cache_ttl_seconds`. Cached CSV is rescored by the existing pipeline. Each instance
allows six upstream attempts per minute and one upstream request at a time;
429 responses include `Retry-After`. These are per-instance safeguards, not a
distributed NASA quota guarantee: keep the access token private and use a shared
rate limiter before opening live fetches to a large public audience.
Requests cover at most 400 square degrees; responses above 5 MiB or 5,000 data
lines are rejected before clustering with 413. Narrow the area or day range.

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
The Data Operations view can fetch a bounded recent snapshot from the official
NASA FIRMS Area API using `/api/firms/area` and the server-side
`NASA_FIRMS_MAP_KEY`. Supply west, south, east and north coordinates, a 1–5 day
lookback and a supported FIRMS feed. The response is processed by the same CSV
validation, deduplication, scoring and clustering pipeline as uploaded data;
NASA acquisition times are interpreted as UTC. This is an on-demand snapshot,
not a continuous feed. The optional `scripts/fetch_firms.py` CLI uses the same
credential configuration. The synthetic sample remains separately labelled.
Never commit credentials.

- `backend/app/` validation, official explainable priority, candidate-event grouping, historical evidence and intelligence, and the FastAPI health/sample/upload routes
- `frontend/` analyst workspace with event history, filters, timeline, map/globe, analytics and evidence report preview/download
- `prototype/fire-triage.html` standalone single-file dashboard (filters, sliders, evaluation already built; works with no server)
- `docs/` limitations, roadmap, demo script, evaluation log
- `scripts/` synthetic generator, FIRMS fetch

## Analytics
The Analytics view summarizes accepted observations that match the dashboard filters
and playback cursor. Acquisition history shows daily observation counts against a
zero-based axis; the plotted counts and date labels are descriptive summaries, not
fire-growth measurements. Expand **Inspect daily values** for exact UTC dates,
detection counts, and available mean FRP. The official priority distribution uses
scores returned by the API and does not recalculate or calibrate them. Event
comparisons use complete event histories independently of the table filters.

## Data sources
FIRMS download https://firms.modaps.eosdis.nasa.gov/active_fire | API https://firms.modaps.eosdis.nasa.gov/web-services/ | Worldview https://worldview.earthdata.nasa.gov/

## Score
0-100 weighted heuristic of recency, confidence, FRP, repeats, and brightness. Weights are analyst choices, not learned or calibrated. See [docs/SCORING.md](docs/SCORING.md) for the formula and [docs/PHASE2_API_CONTRACT.md](docs/PHASE2_API_CONTRACT.md) for verified API behavior; see `docs/LIMITATIONS.md` for interpretation limits.
