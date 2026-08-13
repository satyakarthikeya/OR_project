# Air Cargo Resource Allocation and Operational Optimization

An Operations Research decision-support system for air-cargo terminal operations, built on the Kaggle *Air Cargo Resource Allocation* dataset (5,000 records, CC0).

Two optimization models, solved with PuLP/CBC and served through FastAPI:

- **Part 1 — Linear Programming.** Allocate a limited pool of workers and equipment across four terminals to maximize throughput or minimize cost. *Given limited resources, where should we put them?* **Built.**
- **Part 2 — Integer Programming.** A 0-1 multi-dimensional knapsack selecting which shipments to process when capacity is short. *If we cannot process everything now, what goes first?* **Specified; data layer built, model pending.**

Problem definition and formulations: [SCOPE.md](SCOPE.md). Development conventions: [AGENT.md](AGENT.md).

---

## Quick start

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe -m uvicorn backend.main:app --reload
```

That single command runs the whole application — there is no build step and no npm.

| Endpoint | URL |
|---|---|
| App | <http://127.0.0.1:8000> |
| Interactive API docs | <http://127.0.0.1:8000/docs> |
| Health and solver check | <http://127.0.0.1:8000/api/health> |

```powershell
.\.venv\Scripts\python.exe -m pytest      # 86 tests
```

> Open the app through `http://127.0.0.1:8000`, never by double-clicking `frontend/index.html`. The frontend is served same-origin by FastAPI; loaded from `file://` it cannot reach the API.
>
> After editing a `.jsx` file, hard-refresh with **Ctrl+F5** — browsers cache them aggressively.

---

## Using the app

1. **Home** — load the bundled CSV (one click) or upload your own with the same 28 columns. Uploads are schema-validated: missing columns are rejected, unexpected categories and duplicates come back as warnings. The frame lives in an in-memory registry keyed by a `dataset_id`; every later request passes that id.
2. **Data explorer** — KPI tiles, per-terminal aggregates, category distributions, numeric ranges, and the correlation heatmap. The heatmap is presented as a *finding*, not decoration — it is the reason nothing in this project is fitted.
3. **Part 1 · LP** — pick a planning scenario, inspect the derived coefficients *before* solving, then solve. Results show the optimized plan against the observed allocation, binding constraints with shadow prices, and a worker-pool sensitivity sweep.

---

## Part 1 — the LP

### Formulation

For terminals `t ∈ {T1…T4}`:

#### Decision variables

```text
w_t ≥ 0    workers assigned to terminal t
e_t ≥ 0    equipment units assigned to terminal t
s_t ≥ 0    unmet demand at terminal t   (soft-constraint slack)
```

#### Objective (the user picks one)

```text
maximize    Σ_t (α_t·w_t + β_t·e_t)  −  M·Σ_t s_t              [throughput]
minimize    Σ_t (c^w_t·w_t + c^e_t·e_t)  +  M·Σ_t s_t          [cost]
```

#### Subject to

| # | Constraint | Meaning |
|---|---|---|
| 1 | `Σ_t w_t ≤ W_total` | worker pool |
| 2 | `Σ_t e_t ≤ E_total` | equipment pool |
| 3 | `w_t^min ≤ w_t ≤ w_t^max`, likewise `e_t` | a terminal can be neither abandoned nor over-stuffed |
| 4 | `α_t·w_t + β_t·e_t + s_t ≥ D_t` | demand — **soft**, so a shortfall is reported rather than returned as Infeasible |
| 5 | `α_t·w_t + β_t·e_t ≤ Cap_t` | physical ceiling |
| 6 | `Σ_t (c^w_t·w_t + c^e_t·e_t) ≤ B` | budget, optional |

Implemented in [`backend/models/lp_resource_allocation.py`](backend/models/lp_resource_allocation.py), which is pure: it takes plain numbers and returns a structured result. It never reads the CSV, never imports FastAPI and never touches the dataset store.

### Where the coefficients come from

The dataset is synthetic. Every numeric column is uniform on a clean range and **every pairwise correlation is ≈ 0** (strongest |r| = 0.036). Fitting coefficients on it would produce noise dressed up as a result, so nothing here is fitted. Instead, with per-terminal means `w̄_t, ē_t, T̄_t, C̄_t`:

```text
α_t = θ · T̄_t / w̄_t          β_t = (1 − θ) · T̄_t / ē_t
c^w_t = θ_c · C̄_t / w̄_t       c^e_t = (1 − θ_c) · C̄_t / ē_t
```

This is **self-calibrating**: by construction `α_t·w̄_t + β_t·ē_t = T̄_t` exactly, so the model reproduces observed mean throughput at observed mean inputs, the observed allocation is feasible by construction, and no separate calibration step is needed. It rests on exactly one assumption — the labour share `θ` — which is stated, exposed as a slider, and testable by sensitivity analysis.

`θ` and `θ_c` are separate sliders on purpose. When `θ = θ_c`, `α_t/c^w_t = β_t/c^e_t` identically, so workers and equipment are *equally cost-efficient* inside a terminal and the min-cost model is indifferent between them. Moving the two apart is what creates a real substitution trade-off.

### The degeneracy problem, and the congestion multiplier

Because the four terminals are statistically near-identical, the formula above yields `α_T1 ≈ α_T2 ≈ α_T3 ≈ α_T4`. With equal productivities the max-throughput LP has no reason to prefer any terminal and collapses into "push every variable to its bound in whatever order the solver scans" — technically optimal, analytically empty.

The fix is a documented congestion multiplier built from the two per-terminal signals that genuinely vary (bottleneck rate 27.6–31.0%, facility utilisation):

```text
γ_t = (1 − bottleneck_rate_t) · (1 − facility_utilisation_t / 100)^δ
k   = Σ_t T̄_t / Σ_t (γ_t · T̄_t)
α_t ← k · γ_t · α_t          β_t ← k · γ_t · β_t
```

The renormalisation constant `k` matters: before congestion the calibration identity holds *per terminal*; after congestion it holds *in aggregate*, `Σ_t (α_t·w̄_t + β_t·ē_t) = Σ_t T̄_t`. Congestion therefore redistributes productivity between terminals without inventing or destroying system throughput, so the baseline total is reproduced exactly and baseline-vs-optimized stays a fair comparison. Both identities are asserted in `tests/test_preprocessing.py`.

**This is a stated modelling assumption, not an empirical finding.** The UI exposes a switch to turn it off, which reproduces the degenerate model it exists to prevent — and says so on screen.

### Remaining parameters

| Parameter | Derivation |
|---|---|
| `W_total`, `E_total` | Σ of per-terminal observed means, so the default run re-allocates rather than adds. UI slider 80–120%. |
| `D_t` | Mean `Demand_Forecast` per terminal × `mean(Throughput_Rate)/mean(Demand_Forecast)`. The two columns are on different scales (means ≈ 80 and ≈ 65), so the rescaling factor is mandatory — and shown in the parameters panel. |
| `Cap_t` | 95th percentile of observed `Throughput_Rate` per terminal, raised to the terminal's own modelled baseline throughput where the two collide (see below). |
| bounds | 5th/95th percentile of observed values per terminal. |
| `M` | `10 × ` the largest coefficient **of the active objective**, so the penalty stays meaningful whether the objective is in throughput units or currency. |
| Baseline | `w̄_t, ē_t` scored through the identical objective function. |

The capacity floor is a deliberate correction: `Cap_t` is a percentile of *observed row-level* throughput, while the baseline is evaluated through the *congested production function*. On a lopsided scenario slice the ceiling can therefore land below the baseline itself, which would make the observed allocation infeasible and void every comparison. Raising the ceiling to the baseline where they collide keeps the honest-comparison invariant intact.

### Honest comparison

Three rules, enforced in code rather than by convention:

1. **One scoring function.** The baseline and the optimum are both scored by `evaluate_allocation()`. There is no second code path in which a flattering number could hide, and a test re-scores the solver's own output to confirm it reproduces the solver's objective.
2. **Same resources by default.** A run with a raised pool is flagged `expanded_resources: true` in the response and labelled in the UI — a gain that was bought is not the same claim as a gain that was earned.
3. **No inflated headlines.** When most of the objective delta comes from the soft-constraint penalty rather than from throughput or cost, the response says so explicitly and points the reader at the operational rows. On the default scenario the objective improves 120% while throughput improves 0.3% — the API states that plainly rather than quoting the 120%.

Every optimisation response also carries the standing caveat (`config.MODEL_WORLD_CAVEAT`), which the UI renders as a persistent banner.

---

## API

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health` | service up, CBC availability |
| POST | `/api/datasets` | upload CSV → `dataset_id` + validation report |
| POST | `/api/datasets/bundled` | register the CSV shipped with the project |
| GET | `/api/datasets` | list registered datasets |
| GET | `/api/datasets/{id}/summary` | KPIs, distributions, per-terminal aggregates, correlation matrix |
| POST | `/api/lp/parameters` | derived α, β, costs, `D_t`, `Cap_t`, bounds, baseline — **before** solving, each with the formula that produced it |
| POST | `/api/lp/solve` | status, objective, allocation, baseline comparison, duals, unmet demand |
| POST | `/api/lp/sensitivity` | objective vs `W_total`, one full re-solve per point |

Splitting `/parameters` from `/solve` is deliberate: the UI can show how every coefficient was derived before any optimisation runs.

**Infeasible is a result, not an HTTP error.** Structural problems are detected before the solver runs and returned as `200` with `{"status": "Infeasible", "message": ..., "suggestions": [...]}`. `4xx` is reserved for bad input (unknown `dataset_id`, an empty scenario slice, a schema violation) and `5xx` for genuine crashes.

Example:

```bash
curl -X POST http://127.0.0.1:8000/api/lp/solve \
  -H 'Content-Type: application/json' \
  -d '{"dataset_id": "<id>", "objective": "min_cost", "labor_share": 0.6}'
```

---

## Architecture

```text
backend/
├── main.py                        FastAPI app: routing and static mount only
├── api/          datasets.py, lp.py          translators — no business logic
├── schemas/      common.py, datasets.py, lp.py    the API contract
├── core/         config.py         every tunable constant, no magic numbers elsewhere
│                 data_loader.py    CSV load + schema validation
│                 preprocessing.py  aggregation + parameter estimation (the intellectual core)
│                 store.py          in-memory dataset registry
│                 baseline.py       observed allocation, scored by the model's own objective
│                 comparison.py     baseline-vs-optimized deltas
└── models/       lp_resource_allocation.py   pure LP, no I/O
frontend/         index.html, api.js, components.jsx,
                  page-explorer.jsx, page-lp-results.jsx, page-lp.jsx, app.jsx
tests/            test_preprocessing.py, test_api.py, test_lp.py, test_lp_api.py
notebooks/        eda.ipynb
```

Layering rules, the frontend conventions and the reasoning behind "no build step" are in [AGENT.md](AGENT.md).

The frontend loads React, Tailwind and Plotly from CDN and compiles its JSX in the browser with Babel-standalone, so `uvicorn` alone runs the entire app. Parameters re-derive as you move a slider (debounced, and cached server-side per scenario); solving happens only on an explicit click.

---

## Tests

```powershell
.\.venv\Scripts\python.exe -m pytest
```

86 tests. The ones that matter most are invariants rather than smoke tests:

| Test | Guards |
|---|---|
| `test_uncongested_parameters_reproduce_each_terminal_mean` | the calibration identity `α_t·w̄_t + β_t·ē_t = T̄_t` |
| `test_congestion_preserves_system_throughput` | congestion redistributes productivity without creating it |
| `test_congestion_differentiates_terminals` | the degeneracy fix actually differentiates |
| `test_baseline_is_feasible` | without this, no comparison is valid |
| `test_optimum_is_never_worse_than_baseline` | under each objective |
| `test_baseline_and_optimum_are_scored_by_one_function` | the honest-comparison invariant, structurally |
| `test_shadow_price_predicts_the_gain_from_one_more_worker` | the duals mean what the UI says they mean, checked by re-solving |
| `test_unmet_demand_is_slack_not_infeasibility` | soft demand degrades gracefully |
| `test_model_module_stays_pure` | the model never reaches for pandas, FastAPI or the store |

---

## A note on the data

The dataset is synthetic: every numeric column is uniformly distributed and all pairwise correlations are approximately zero (strongest |r| = 0.036). Model coefficients therefore **cannot** be fitted from it — they are derived in closed form from group means plus a small number of explicitly stated assumptions, documented above and adjustable from the UI.

Every improvement this system reports is a model-world gain under those assumptions, not a validated operational result. That sentence is not boilerplate: it is returned in every optimisation response and displayed as a banner on every optimisation screen.

---

## Status

| Milestone | State |
|---|---|
| M1 — Setup & EDA | done |
| M2 — Data layer | done |
| M3 — LP model | done |
| M4 — LP API | done |
| M5 — LP UI (+ Home, Data Explorer) | done |
| M6–M8 — IP model, API & UI | next |
| M9–M11 — Close-out, polish, report | pending |
