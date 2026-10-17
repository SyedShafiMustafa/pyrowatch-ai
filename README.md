# PyroWatch AI

Satellite thermal-anomaly triage and observation intelligence for analyst review. **Decision support only: detections are unconfirmed observations, not confirmed fires or emergency-response guidance.**

## Use PyroWatch

The deployed application is available at **[pyrowatch-ai-phi.vercel.app](https://pyrowatch-ai-phi.vercel.app)**.

It provides the PyroWatch Command Deck with the geospatial workspace, ranked observations, timeline controls, event dossiers, CSV upload, and export tools.

## Run locally for development

The deployed app is the normal entry point. Use the local setup only when developing or testing the repository.

```bash
python -m venv .venv
# Windows PowerShell:
.venv\Scripts\Activate.ps1
pip install -r requirements.txt

# Terminal 1: FastAPI backend
uvicorn backend.app.main:app --reload --host 127.0.0.1 --port 8010

# Terminal 2: static frontend
python -m http.server 5500 --directory frontend
```

Open `http://127.0.0.1:5500` after both services are running. Run the checks with:

```bash
python -m pytest backend/tests -q
python scripts/verify_phase1.py
node --check frontend/app.js
node --test frontend/tests/counts.test.cjs
```

## Layout
Phase 1 ingestion audit and conventions: [docs/AUDIT.md](docs/AUDIT.md).
Inspect an existing CSV offline with `python scripts/inspect_firms.py path/to/file.csv`.
For generated fixtures add `--synthetic`. The JSON report accounts for every record
with physical source lines. API uploads expose this report under `ingestion`.
Live fetching is optional; set `MAP_KEY` in the process environment (a `.env` file
is not loaded automatically). Never commit credentials.

- `backend/app/validation.py` import + validation | `scoring.py` explainable score | `clustering.py` event grouping | `persistent.py` static-source flag | `evaluation.py` precision@k | `firms_client.py` live API
- `frontend/` PyroWatch Command Deck: Leaflet map, timeline, ranked observations, filters, uploads, event dossiers, and CSV export
- `prototype/fire-triage.html` standalone single-file dashboard (filters, sliders, evaluation already built; works with no server)
- `docs/` limitations, roadmap, demo script, evaluation log
- `scripts/` synthetic generator, FIRMS fetch

## Data sources
FIRMS download https://firms.modaps.eosdis.nasa.gov/active_fire | API https://firms.modaps.eosdis.nasa.gov/web-services/ | Worldview https://worldview.earthdata.nasa.gov/

## Score
0-100 weighted heuristic of recency, confidence, FRP, repeats, and brightness. Weights are analyst choices, not learned or calibrated. See [docs/SCORING.md](docs/SCORING.md) for the formula and [docs/PHASE2_API_CONTRACT.md](docs/PHASE2_API_CONTRACT.md) for verified API behavior; see `docs/LIMITATIONS.md` for interpretation limits.
