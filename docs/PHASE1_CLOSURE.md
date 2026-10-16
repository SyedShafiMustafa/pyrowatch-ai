# Phase 1 closure evidence — 2026-10-16

This report records the Phase 1 milestone as assessed on 2026-10-16. Its
then-pending checks and findings below are historical; later status is called
out explicitly and supported by the linked Phase 4.2 report. The later work does
not establish wildfire classification accuracy.

Functional acceptance: satisfied in the working environment. All 29 existing tests
passed without exclusions; the API contract passed independently and in the module
and full suite. Lint/formatting and genuine FIRMS validation remain unverified.
Security observations below prevent an unconditional security sign-off. No Phase 2
work was performed. No application defect requiring a code change was established.

## Audit and go/no-go

Inspected all backend modules, all three test files, ingestion/fetch/inspection
scripts, frontend API rendering, README, prior audit, dependencies, ignore rules,
data inventory, branch and Git status before editing. Branch: master; no commits or
tracked files; origin is https://github.com/SyedShafiMustafa/pyrowatch-ai.git.
All original project files were untracked before and after this work. Empty staged
and unstaged diffs therefore do not represent a committed clean baseline.

`test_upload_and_sample_contract` was previously deselected deliberately with `-k
'not upload_and_sample_contract'` to run ingestion checks independently of the
unverified native-library/API environment. It is not skipped in the test definition.
It imports the real app, posts duplicate observations, verifies keys, duplicate and
repeat counts, nullable labels and finite JSON, requests the labelled sample, and
checks invalid UTF-8 produces 400. No test was deleted, weakened or rewritten here.

Prior evidence: pandas `_libs/interval.pyx` import reported a blocked `_cyutility`
DLL; scikit-learn `_pairwise_distances_reduction/_base.pyx` reported a blocked
`_cython_blas` DLL. Both tracebacks explicitly said Windows Application Control
blocked the file. These were dependency load failures before application assertions.
The DLL failure did not reproduce this turn: the direct imports below succeeded.
Its underlying Windows policy decision has not been diagnosed or altered.

The isolated contract test did reproduce a separate sandbox hang. At 30 seconds,
faulthandler showed Python socket.py `accept` → `_fallback_socketpair` → asyncio
Proactor event-loop initialization → AnyIO portal creation → Starlette TestClient
entry at test_ingestion.py:67. No application HTTP request had been dispatched.
The waiting test was interrupted (exit 1), never counted as passed. The exact same
test in the same .venv outside the sandbox passed in 2.57 seconds. No package or
event-loop changes were needed. This establishes an execution-environment blocker
for the hang, not a contract failure. The precise OS sandbox mechanism is unknown.

Go decision preceded edits: ingestion tests were runnable; direct imports and
pipeline worked; the contract passed outside the sandbox; Ruff/Black were absent;
real data was absent. Only a repeatable smoke verifier and this report were added.

## Ran and passed

Working directory for every command: `C:\Users\faizan\Downloads\fire-triage-skeleton\fire-triage`.
In commands below, `PY` means exactly `.\.venv\Scripts\python.exe` (Python 3.12.10).
The outside-sandbox test commands used the same interpreter and installed packages.

| Command (replace PY with the path above) | Exit | Measured result |
| --- | --- | --- |
| `PY -m pytest backend/tests/test_ingestion.py -q -k 'not upload_and_sample_contract'` | 0 | 24 passed, 1 deselected, 1.03 s; baseline only |
| `PY -c "import pandas; print('pandas OK',pandas.__version__); from sklearn.metrics import _pairwise_distances_reduction; print('sklearn native imports OK')"` | 0 | pandas 3.0.6 and sklearn native imports succeeded |
| `PY -m pytest backend/tests/test_ingestion.py::test_upload_and_sample_contract -vv -o faulthandler_timeout=30` (outside sandbox) | 0 | 1 passed, 2.57 s |
| `PY -m pytest backend/tests/test_ingestion.py -q` (outside sandbox) | 0 | 25 passed, 2.62 s; no exclusions |
| `PY -m pytest backend/tests -q` (outside sandbox) | 0 | 29 passed, 2.72 s; no exclusions |
| `PY scripts/verify_phase1.py` (outside sandbox) | 0 | Real localhost Uvicorn smoke run, five HTTP requests; details below |
| `PY -m compileall -q backend scripts` | 0 | Python compilation successful |
| `PY -m pip check` | 0 | No broken requirements found |

Every pytest run emitted one existing Starlette warning: httpx use with TestClient
is deprecated in this installed version. It did not prevent tests from passing.
No dependency was added, upgraded or removed in this closure work.

Synthetic inspector command reproduced (exit 0):

```powershell
.\.venv\Scripts\python.exe scripts/inspect_firms.py data/sample/synthetic_sample.csv --synthetic | .\.venv\Scripts\python.exe -c "import json,sys; d=json.load(sys.stdin); r=d['ingestion']; print({k:v for k,v in r.items() if k not in ('outcomes','columns')}); print('issues:',len(d['issues']))"
```

Measured: 232 total, 232 accepted, 0 rejected, 0 deduplicated, 233 physical lines,
0 issues, data_kind=synthetic. These are generated observations, not real NASA data.

## API smoke results

The verifier launches the existing Uvicorn app on an ephemeral IPv4 loopback port,
uses requests with environment proxies disabled, and stops its own server afterward.
It removes MAP_KEY and FIRMS_MAP_KEY from the child environment, so these checks
cannot exercise a live FIRMS request. Inline CSV fixtures are explicitly synthetic.

| Request | HTTP | Observed response |
| --- | --- | --- |
| GET /api/health | 200 | `{"ok": true}` |
| GET /api/sample | 200 | keys: evaluation, events, ingestion, issues, rows, weights; 232 rows, 44 events, 232 labelled; synthetic metadata |
| POST /api/upload, three synthetic records | 200 | same six keys; 1 accepted (line 2), 1 duplicate of line 2 (line 3), 1 rejected latitude (line 4); total 3; one scored row, repeat_count 0 |
| POST /api/upload, duplicate-column schema | 200 | rows empty; one rejected data record at line 2; separate header issue at line 1 and row issue at line 2 |
| POST /api/upload, invalid UTF-8 | 400 | `{"detail":"Upload must be UTF-8 CSV"}` |

Record accounting balances. Schema issues share the legacy `issues` array but are
distinct from data outcomes: the header is not counted as a rejected observation.
There is no dedicated structured `file_issues` field. UTF-8 failure is a file-level
HTTP error; no record count is asserted for undecodable input. The sample's label
evaluation verifies pipeline behavior only; no real-world accuracy is claimed.
Observed Uvicorn logs contained method/path/status, not CSV bodies or credentials.

## Ran and failed / interrupted

- `PY -m pytest backend/tests/test_ingestion.py::test_upload_and_sample_contract -vv -o faulthandler_timeout=30`
  inside sandbox: stack dump at 30 s, then manually interrupted, exit 1. Socket-pair
  initialization hang described above; superseded by successful outside-sandbox run.
- `PY -m pip show ruff black`: exit 1, neither package installed.
- `PY -m ruff check backend scripts`: exit 1, `No module named ruff`.
- `PY -m ruff format --check backend scripts`: exit 1, `No module named ruff`.

The Ruff commands failed to launch the tool; this is not evidence of lint or format
violations, nor is it a pass. No tool was installed to bypass the dependency constraint.

## Not run / could not verify

- Ruff lint and formatting analysis: unavailable until a permitted Ruff installation
  or an existing CI environment is supplied. Black also absent from .venv and PATH.
- At the Phase 1 milestone, real-data validation was **PENDING**: only the
  synthetic sample was available in that checkout. This status was superseded
  by the genuine NASA FIRMS compatibility work documented in
  [Phase 4.2](PHASE4_2_FIRMS_VALIDATION.md). That later check validated a
  provenance-documented VIIRS/Suomi NPP sample and regional subset for data and
  pipeline compatibility; it did not evaluate labelled wildfire accuracy.
- A historical archive was still not present at the Phase 1 milestone. The later
  FIRMS validation also did not supply a historical recurrence archive.
- Live FIRMS endpoint, key validity and actual upstream request logs: intentionally
  not exercised. No key was printed/read from .env; no real observation request made.
- Browser rendering/security exploitation: not executed; static security review only.

## Remaining defects and proposed remediation

1. **Historical frontend security finding — superseded:** the Phase 1 review
   identified possible unsafe HTML sinks in the then-current frontend. The current
   `frontend/app.js` uses `textContent` and DOM construction for API-provided text;
   the old `innerHTML` line references do not describe the current implementation.
   Static inspection is not a browser security test, and no broader exploitability
   claim is made here.
2. **Historical credential logging finding — addressed later:** the Phase 1 review
   noted that upstream HTTP DEBUG records could include a FIRMS key. The current
   implementation has synthetic-sentinel redaction regression coverage in
   `backend/tests/test_firms_logging.py`; live FIRMS requests and real credentials
   were not used to establish that result.
3. **Historical rejection-count finding — addressed later:** the current frontend
   reads `ingestion.rejected` separately from duplicate and schema issue counts.
   Frontend count regression coverage is in `frontend/tests/counts.test.cjs`.
4. **P3 / low, test client deprecation:** backend/tests/test_ingestion.py:6 imports
   TestClient which warns about httpx under installed Starlette. Plan a compatible
   dependency review separately; current tests pass and dependencies were preserved.

## Changed files and hygiene

Exact closure-task additions:

- scripts/verify_phase1.py — repeatable offline localhost smoke verification.
- docs/PHASE1_CLOSURE.md — this evidence report.

No pre-existing application, test, frontend, scoring, clustering, dependency or data
file was edited. Runtime caches may be regenerated by tests/compilation and are
ignored. All original untracked user files are preserved. No staging, commit, push,
destructive Git operation, secret file access, dependency installation or Phase 2
implementation occurred. `git check-ignore .env .venv/Scripts/python.exe` confirmed
both paths ignored. `git ls-files` was empty; no secrets or environments are staged.
Final status/diffs and both added files were reread; empty git diffs alone do not
establish preservation because the repository has no commits.

## Next milestone at the Phase 1 close

The next milestone was genuine, provenance-documented FIRMS CSV compatibility.
That milestone was completed later as described in [Phase 4.2](PHASE4_2_FIRMS_VALIDATION.md).
Labelled wildfire accuracy, live FIRMS service/key verification, and browser
rendering/security testing remain separate checks and are not established by that
data-compatibility result.
