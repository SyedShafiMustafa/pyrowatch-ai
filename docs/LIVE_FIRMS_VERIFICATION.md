# Live FIRMS verification — 2026-10-17

Status: local real-data integration verified; production deployment blocked by
Vercel's commit-author account check. Do not describe production live data as
verified. The existing production page and health route return 200, but the
deployed API inspected before deployment had no `/api/firms/area` route (404).

## Genuine request

Official NASA FIRMS Area CSV API, `VIIRS_NOAA20_NRT`, bounding box
west=-60, south=-10, east=-58, north=-8, recent days=3. The credential-bearing
upstream URL is deliberately omitted. Fetched at 2026-10-17T06:47:28.657257Z.

- HTTP 200 through the real FastAPI endpoint; no mocked upstream response.
- 5 total records, 5 accepted, 0 rejected, 0 deduplicated; 4 candidate events.
- Acquisition range: 2026-10-15 17:47 UTC to 2026-10-17 04:34 UTC.
- Local browser Data Operations loaded the same cached real response. Observed
  map markers, ranked table, event history (including simultaneous observations),
  supplied confidence/FRP, priority contributions, analytics and report preview.
- Anomaly analysis correctly reports a missing model artifact; no model accuracy
  or wildfire identity was established.
- A larger NOAA-20 area correctly returned 413 before clustering. A separate
  one-day SNPP request returned a valid empty CSV and an empty 200 response.

## Executed checks

Using the existing Python virtual environment, with local networking permitted:

| Command | Actual result |
| --- | --- |
| `python -B -m pytest backend/tests -q --basetemp=<new workspace temporary directory>` | 102 passed, 1 existing Starlette/httpx deprecation warning, 22.34 seconds; exit 0 |
| `node --test frontend/tests/*.test.cjs` | 17 passed, 0 failed; exit 0 |
| `node --check frontend/app.js` | Exit 0 |
| `node --check frontend/workspace.js` | Exit 0 |
| `python -B scripts/verify_phase1.py` | Health/sample/upload 200; sample 232 rows and 70 events; upload 1 accepted/1 rejected/1 duplicate; invalid UTF-8 400; exit 0 |
| `python -m pip check` | No broken requirements; exit 0 |
| `python -m compileall -q backend/app backend/tests scripts` | Exit 0 |
| `git diff --check` | Exit 0; existing LF/CRLF normalization notices |

## Deployment and security

The existing project is `syedshafimustafa06-3579s-projects/pyrowatch-ai`.
`NASA_FIRMS_MAP_KEY` and the separate `PYROWATCH_LIVE_FETCH_TOKEN` were saved as
sensitive production environment variables. Neither value is in this report or
source. Local Vercel authentication/configuration and `.env*` files are ignored.

Deployment `dpl_Dcgg7rwyYaTtKXnzzcFwQ7fgAZk5` was blocked before build because
Vercel could not associate the existing Git author with an authorized account.
The waiting deployment CLI was interrupted after confirming the blocked status;
that run did not succeed. No Git commit, push, or history change was made.

After the owner resolves that account association, deploy this tested working
tree again, verify `/api/firms/area` exists in production OpenAPI, and repeat the
genuine query and browser workflow on `https://pyrowatch-ai-phi.vercel.app/`.
The NASA credential must remain server-side; only the separate access token
belongs in the dashboard password field.

Cache and attempt limits are per process, not distributed quota enforcement.
Live fetching is an on-demand snapshot, not continuous monitoring. Full upstream
HTTP bodies are still buffered by requests; the live CSV size/row bounds protect
pipeline work, rather than implementing a streaming upstream body limit.
