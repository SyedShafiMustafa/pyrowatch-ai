# Fire detection triage (AI/ML 1)
Explainable ranking of NASA FIRMS active-fire detections for analyst review. **Decision support only; detections are not confirmed fires and this is not an emergency-response system.**

## Run (offline, ~2 min)
```bash
python -m venv .venv && source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
python scripts/make_synthetic.py
uvicorn backend.app.main:app --reload --app-dir .
# open http://127.0.0.1:8000
pytest backend/tests
```
(If the import path fails, run from `backend/`: `cd backend && uvicorn app.main:app --reload`, and serve the frontend from the repo root.)

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
0-100 weighted mean of recency, confidence, FRP (log vs P95), repeats (~2 km, 72 h), brightness. Weights are judgement, not learned. See `docs/LIMITATIONS.md`.
