# AGENT.md — Working Instructions for AI Agents & Collaborators

This file tells any AI coding agent (Claude Code, Copilot, etc.) or human collaborator how to work in this repository. Read it fully before writing code.

## What this project is

An Operations Research decision-support system for air-cargo terminal operations, built on the Kaggle "Air Cargo Resource Allocation Data" dataset (5,000 records, bundled as `air_cargo_resource_allocation_dataset.csv`). Two optimization models solved with PuLP, exposed through a **FastAPI** backend and consumed by a **React** frontend:

- **Part 1 — LP: Workforce & Equipment Allocation.** Allocate limited workers and equipment across 4 terminals (T1–T4) to maximize throughput or minimize cost.
- **Part 2 — IP: Cargo Processing Selection.** A 0-1 multi-dimensional knapsack selecting which shipments to process under limited capacity, maximizing priority-weighted value.

The two parts share one data/parameter layer and are otherwise independent — they can be built in parallel. Full problem definition, formulations, and milestones live in [SCOPE.md](SCOPE.md). **Keep both documents in sync when scope changes.**

## Critical dataset fact (do not rediscover this)

The dataset is **synthetic**: every numeric column is uniformly distributed on a clean range, and **all pairwise correlations are ≈ 0** (max |r| = 0.036; e.g., Workforce_Assigned vs Throughput_Rate r = −0.007). Binding rules that follow:

- **Never estimate model coefficients by regression** on this data — the results are noise. Use the closed-form share-based derivation in SCOPE.md §3.
- **Never claim empirical validity** of "improvement" numbers in code, API responses, UI text, or docs. Improvements are model-world gains under stated assumptions. The UI must carry a persistent caveat banner.
- **Watch for degeneracy.** Because terminals are statistically near-identical, naive parameters make every terminal equally productive and the LP collapses to "fill bounds in arbitrary order." The congestion multiplier in SCOPE.md §3 exists to prevent this — do not remove it without a replacement.
- Data is otherwise clean: no missing values, no duplicates, Record_ID unique. Real_Time_Load is on a 10–150 scale (not a percentage); Demand_Forecast (mean ≈ 80) and Throughput_Rate (mean ≈ 65) are on different scales and must be rescaled before appearing in the same constraint.

## Architecture

```
air_cargo_resource_allocation_dataset.csv
requirements.txt
README.md
backend/
├── main.py                 # FastAPI app: CORS, static mount, router include — thin
├── api/
│   ├── datasets.py         # upload, summary, EDA aggregates
│   ├── lp.py               # /api/lp/parameters, /solve, /sensitivity
│   └── ip.py               # /api/ip/batch, /solve
├── schemas/                # Pydantic request/response models (the API contract)
│   ├── common.py           #   SolveStatus, ComparisonBlock, ErrorDetail
│   ├── lp.py
│   └── ip.py
├── core/
│   ├── config.py           # column names, category sets, priority weights, defaults
│   ├── data_loader.py      # CSV load + schema validation for uploads
│   ├── preprocessing.py    # aggregation + parameter estimation (the intellectual core)
│   ├── store.py            # in-memory dataset registry keyed by dataset_id
│   ├── baseline.py         # baseline KPIs (observed allocation / FCFS)
│   └── comparison.py       # baseline-vs-optimized deltas
└── models/
    ├── lp_resource_allocation.py
    └── ip_shipment_selection.py
frontend/                   # no build step — served by FastAPI StaticFiles
├── index.html              # CDN: React, ReactDOM, Babel-standalone, Tailwind, Plotly.js
├── api.js                  # fetch wrappers, one per endpoint
├── components.jsx          # Card, StatTile, DataTable, SliderRow, SolveStatus, CaveatBanner, Chart…
├── page-explorer.jsx       # Home + Data Explorer
├── page-lp-results.jsx     # Part 1 results: outcome, plan, duals, sensitivity
├── page-lp.jsx             # Part 1 controls + derived parameters
└── app.jsx                 # shell, hash routing, theme, dataset state
tests/
├── test_preprocessing.py
├── test_api.py
├── test_lp.py
├── test_lp_api.py
└── test_ip.py              # (with Part 2)
notebooks/eda.ipynb         # EDA for the report appendix (matplotlib OK here only)
```

### Layering rules (hard)

- **Models are pure.** `backend/models/*` accept plain dicts/dataclasses of parameters and return a structured result (status, objective, variable values, slacks, duals). They never read the CSV, never import FastAPI, never touch the dataset store.
- **All parameter estimation lives in `preprocessing.py`.** No magic numbers in model or API files — tunables (priority weights, labor share, capacity fractions) live in `config.py`.
- **API layer is a translator only:** validate with Pydantic → call preprocessing → call model → shape response. No business logic in `api/*`.
- **The Pydantic schemas are the contract.** Frontend shapes follow the schemas, not the other way round. Change a schema and you must update the frontend in the same commit.

### FastAPI-specific rules

- **Infeasible/unbounded is a result, not an HTTP error.** Return `200` with `{"status": "Infeasible", "message": "...", "suggestions": [...]}`. Reserve `4xx` for bad input (schema violation, unknown dataset_id) and `5xx` for genuine crashes.
- **Always check `pulp.LpStatus` before reading variable values.** Use soft demand constraints (slack + penalty) in the LP so it degrades gracefully instead of returning Infeasible.
- **Dataset state:** uploads go into an in-memory registry (`core/store.py`) keyed by a generated `dataset_id`; every later request passes that id. Never re-upload the CSV per solve, and never rely on a global "current dataset."
- Cache derived parameter frames per `(dataset_id, scenario filters)` with `functools.lru_cache` or an explicit dict — parameter estimation should not re-run on every slider move.
- Solves are fast (CBC, ≤ a few hundred variables), so endpoints stay synchronous. If a solve ever exceeds ~2s, move it to a background task rather than raising the timeout.
- FastAPI serves `frontend/` via `StaticFiles`, so the app is same-origin and **no CORS middleware is needed**. If you ever open `index.html` directly from disk instead of through uvicorn, you will hit CORS errors — load it via `http://127.0.0.1:8000`, not `file://`.

### Frontend rules

**Decided: no build step, no npm, no Node.** `frontend/index.html` loads React, ReactDOM, Babel-standalone, Tailwind and Plotly.js from CDN; the `.jsx` files are included as `type="text/babel"`. FastAPI mounts the folder with `StaticFiles`, so one `uvicorn` command runs the entire app. Vite + shadcn/ui was considered and rejected — the toolchain cost is not worth it for a four-page course project.

Looking good without a build step comes down to these:

- **Tailwind Play CDN does the styling.** One `<script src="https://cdn.tailwindcss.com">` tag gives the full utility set plus dark mode. Set the palette inline via `tailwind.config = {...}` in a following script block. It logs a "not for production" console warning — expected, and fine here.
- **Constrain the design so it reads as intentional:** one accent color, a neutral gray scale, `rounded-xl` cards on a subtly tinted page background, consistent `p-6` padding and `gap-6` grid spacing, two heading sizes and one body size, `tabular-nums` on every numeric column. Restraint is what separates "designed" from "student project."
- **Build a small component vocabulary first** in `components.jsx` — `Card`, `StatTile`, `ParameterTable`, `SliderRow`, `SolveStatus`, `CaveatBanner`, `Chart` — then compose pages from it. Never style page markup ad hoc; that is what makes hand-rolled UIs look inconsistent.
- **Charts are Plotly.js** via a thin `Chart` wrapper (`useEffect` + `Plotly.react`). It covers the correlation heatmap and box plots that lighter libraries can't. Set `paper_bgcolor: 'transparent'` and theme-matched font colors so charts sit inside cards cleanly. The backend returns JSON data, never rendered images; matplotlib stays in `notebooks/eda.ipynb`.
- **Keep Babel's workload small.** In-browser JSX compilation is fine for a few hundred lines per file but degrades past that. Split across `components.jsx` and `app.jsx`; if a third file is needed, split by page rather than letting one file grow.
- Solve only on an explicit button click, with a loading state on the button while the request is in flight. Render solver status prominently, including the actionable `suggestions` list the API returns on infeasible runs.
- Dark mode via Tailwind's `class` strategy; both themes must be legible, Plotly charts included.

### Running the app

`uvicorn backend.main:app --reload` → app at `http://127.0.0.1:8000`, API docs at `/docs`. That is the only command; there is nothing to build. Hard-refresh (Ctrl+F5) after editing `.jsx` files, since browsers cache them aggressively.

### Honest-comparison invariant

Baseline and optimized KPIs must be evaluated with the **same objective function** and the **same resource totals**. Never compare LP output against raw observed `Throughput_Rate`. Runs where the user raises resource pools above baseline must be labeled "expanded-resources scenario" in the response and the UI.

## Environment & conventions

- Windows 11, PowerShell. Python 3.11+, venv at `.venv`.
- Dependencies: `pandas`, `numpy`, `pulp`, `fastapi`, `uvicorn[standard]`, `pydantic`, `python-multipart`, `pytest`, plus `jupyter`/`matplotlib` for the notebook. Pin in `requirements.txt`.
- Run: `uvicorn backend.main:app --reload` → app at `http://127.0.0.1:8000`, interactive API docs at `/docs` (free deliverable — screenshot it for the report).
- Verify CBC early: `pulp.PULP_CBC_CMD().available()`; expose it at `GET /api/health`.
- Guard derived rates: clip denominators, winsorize ratio parameters at the 5th/95th percentiles.
- Default IP batch 30–100 shipments so tables stay readable; CBC handles all 5,000 binaries but the UI should then show summaries only.
- No git repository yet; if the user asks for version control, `git init` first.
- Do not modify or regenerate `air_cargo_resource_allocation_dataset.csv`.

## Current status

**Part 1 is complete and verified end to end (M1–M5).** The shared data layer, the LP model, the three LP endpoints, and the UI shell with Home, Data Explorer and the Part 1 page are all built; 86 tests pass and a browser walkthrough runs clean.

**Next: Part 2 (M6–M8).** `core/preprocessing.build_batch()` and `default_capacities()` already exist and are tested, so the IP track starts at the model itself: `models/ip_shipment_selection.py`, the FCFS baseline in `core/baseline.py`, then `schemas/ip.py` + `api/ip.py`, then the IP page. The Part 2 tab currently renders an honest placeholder that says the model is not built yet — replace it, do not leave a dead tab.

### Decisions taken during Part 1 that are not obvious from SCOPE.md

- **Capacity floor.** `Cap_t` is raised to the terminal's own modelled baseline throughput where the percentile lands below it. Without this, a lopsided scenario slice makes the observed allocation infeasible and voids every comparison. In `problem_from_parameters()`.
- **Penalty scaling.** The unmet-demand penalty `M` is scaled to the largest coefficient *of the active objective*, so it stays meaningful in both throughput units and currency.
- **Penalty-dominance note.** When most of the objective delta comes from the slack penalty rather than throughput or cost, `comparison.py` says so in the response. This is what stops the UI quoting a 120% improvement when throughput moved 0.3%.
- **Infeasible-baseline reason.** When the observed allocation falls outside the constraints, `baseline.py` names the specific constraint it breaks rather than guessing at the cause.
- **JSX runtime is pinned.** `index.html` registers a Babel preset with `runtime: 'classic'`. Babel 8's react preset defaults to the automatic runtime, which emits `import` statements a classic `<script>` cannot execute. Do not add `data-type` to those script tags — babel-standalone then skips them silently.
- **`uppercase` and Greek letters.** Tailwind's `uppercase` turns α into Α and γ into Γ. `DataTable` takes a `headerClass` prop so tables with symbol headers opt out.
