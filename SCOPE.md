# SCOPE.md — Air Cargo Resource Allocation and Operational Optimization

Operations Research course project: a decision-support system for air-cargo terminal operations that optimally allocates limited resources and prioritizes cargo processing. Delivered as a FastAPI backend + React frontend.

The work splits into **two parts that share one data layer**:

| | Part 1 | Part 2 |
|---|---|---|
| **Model** | Linear Programming | Integer Programming (0-1 multi-knapsack) |
| **Question** | Given limited workers and equipment, where should we allocate them? | If we can't process all cargo now, which shipments go first? |
| **Decision** | How many workers/equipment per terminal | Which shipments to accept this window |
| **Baseline** | Observed mean allocation per terminal | Greedy FCFS by arrival time |
| **Files** | `models/lp_resource_allocation.py`, `api/lp.py` | `models/ip_shipment_selection.py`, `api/ip.py` |

## 1. Dataset

**Air Cargo Resource Allocation Data** — Kaggle, CC0/Public Domain, 5,000 records, 28 columns. Bundled as `air_cargo_resource_allocation_dataset.csv`.

| Aspect | Finding |
|---|---|
| Terminals | T1–T4 (1,200–1,301 records each) |
| Priorities | Low 1,502 · Medium 1,537 · High 1,215 · Critical 746 |
| Cargo types | General, Express, Perishable, Hazardous (~balanced) |
| Equipment types | Crane, Loader, Forklift, Conveyor (~balanced) |
| Ranges | Workforce 5–49, Equipment 1–14, Cargo_Volume 5–120, Throughput_Rate 10–120, Handling_Time 20–180, Waiting_Time 5–120, Queue_Length 1–99, Operational_Cost 500–5,000 |
| Bottleneck_Flag | 29% overall; per-terminal 27.6%–31.0% — one of the few genuinely varying signals |
| Quality | No missing values, no duplicates; Flight_ID repeats (3,841 unique) — treat rows, not flights, as shipments |
| **Limitation** | **Synthetic: all numeric columns uniform, all pairwise correlations ≈ 0** (max \|r\| = 0.036). Demand_Forecast (mean ≈ 80) and Throughput_Rate (mean ≈ 65) are on different scales; Real_Time_Load is 10–150, not a percentage. |

**Implication:** parameters cannot be regression-estimated. They are derived in closed form from group means plus a small number of explicitly documented assumptions. All reported improvements are model-world gains under those assumptions — stated in the UI and the report.

## 2. Objectives

1. Formulate and solve the LP for workforce & equipment allocation across terminals.
2. Formulate and solve the 0-1 IP knapsack for shipment selection under capacity limits.
3. Compare both against honest baselines using the same objective and the same resources.
4. Deliver a working web app: load data → view statistics → choose optimization → set scenario → solve → inspect results vs baseline.

## 3. Part 1 — LP: Workforce & Equipment Allocation

**Scenario framing.** The 5,000 rows span a year, but an LP allocates at a point in time. A *planning scenario* is a user-filtered slice (peak/off-peak, weather, cargo type, date range, or "average day") aggregated to the four terminals.

**Decision variables (continuous):** `w_t ≥ 0` workers and `e_t ≥ 0` equipment units at terminal `t ∈ {T1..T4}`.

**Objectives (user selects one):**
- Maximize throughput: `max Σ_t (α_t·w_t + β_t·e_t) − M·Σ_t s_t`
- Minimize cost subject to demand: `min Σ_t (c^w_t·w_t + c^e_t·e_t) + M·Σ_t s_t`

**Constraints:**

| # | Constraint | Purpose |
|---|---|---|
| 1 | `Σ_t w_t ≤ W_total` | worker pool |
| 2 | `Σ_t e_t ≤ E_total` | equipment pool |
| 3 | `w_t^min ≤ w_t ≤ w_t^max`, same for `e_t` | terminals can't be abandoned or over-stuffed; prevents unbounded/degenerate corners |
| 4 | `α_t·w_t + β_t·e_t + s_t ≥ D_t`, `s_t ≥ 0` | demand, **soft** — unmet demand is reported, never infeasible |
| 5 | `α_t·w_t + β_t·e_t ≤ Cap_t` | physical terminal ceiling |
| 6 | `Σ_t (c^w_t·w_t + c^e_t·e_t) ≤ B` (optional) | budget |

### Parameter derivation — the closed-form share method

Let `w̄_t`, `ē_t`, `T̄_t`, `C̄_t` be the per-terminal means of Workforce_Assigned, Equipment_Used, Throughput_Rate and Operational_Cost in the scenario slice. Assume a **labor share** `θ = 0.6` (config, UI-exposed) of throughput attributable to workers and a cost share `θ_c = 0.6`. Then:

```
α_t = θ · T̄_t / w̄_t          β_t = (1 − θ) · T̄_t / ē_t
c^w_t = θ_c · C̄_t / w̄_t       c^e_t = (1 − θ_c) · C̄_t / ē_t
```

This is **self-calibrating**: by construction `α_t·w̄_t + β_t·ē_t = T̄_t` exactly, so the model reproduces observed mean throughput at observed mean inputs and the baseline is always feasible. It needs exactly one assumption (`θ`), which is stated, adjustable, and testable via sensitivity analysis. Preferred over "mean of per-row ratios," which is inflated by small denominators.

### The degeneracy problem (important)

Because the terminals are statistically near-identical, the formula above yields `α_T1 ≈ α_T2 ≈ α_T3 ≈ α_T4`. With equal productivities, the max-throughput LP has no reason to prefer any terminal and collapses into "push every variable to its upper bound in whatever order the solver scans" — a technically optimal but analytically empty answer.

**Fix — a documented congestion multiplier.** Scale each terminal's productivity by its observed operational health:

```
γ_t = (1 − bottleneck_rate_t) · (1 − facility_utilization_t / 100)^δ
k   = Σ_t T̄_t / Σ_t (γ_t · T̄_t)          ← renormalization constant
α_t ← k · γ_t · α_t        β_t ← k · γ_t · β_t
```

**What the renormalization preserves.** Before congestion, the identity `α_t·w̄_t + β_t·ē_t = T̄_t` holds *per terminal*. After congestion it holds only *in aggregate*: `Σ_t (α_t·w̄_t + β_t·ē_t) = Σ_t T̄_t`. That is the intended trade — congestion redistributes productivity between terminals without inventing or destroying system throughput, so the baseline total is still exactly reproduced and baseline-vs-optimized stays a fair comparison. Both identities are asserted in `tests/test_preprocessing.py`.

Bottleneck rate (27.6%–31.0%) and facility utilization genuinely differ across terminals, so `γ_t` creates real, data-grounded differentiation: congested terminals convert resources into throughput less efficiently, so the LP shifts resources toward healthier ones and shadow prices become interpretable. `δ` is a config constant (default 1). **This is a modeling assumption, documented as such — not an empirical finding.**

Secondary mitigation: make *min-cost-meets-demand* the headline objective in the report, since differing `D_t` and `c_t` drive genuine trade-offs even under equal productivity.

### Remaining parameters

| Parameter | Derivation |
|---|---|
| `W_total`, `E_total` | Σ of per-terminal baseline means (baseline stays feasible); UI slider 80–120% |
| `D_t` | Mean Demand_Forecast per terminal × rescaling factor `mean(Throughput_Rate)/mean(Demand_Forecast)` — factor shown in the parameters panel |
| `Cap_t` | 95th percentile of observed Throughput_Rate per terminal (max is noisy), **raised to the terminal's own modelled baseline throughput where the two collide** — the percentile is computed on observed rows while the baseline runs through the congested production function, so on a lopsided slice the ceiling can otherwise fall below the baseline and make the observed allocation infeasible |
| `w_t^min/max`, `e_t^min/max` | 5th/95th percentile of observed values per terminal |
| `M` (slack penalty) | 10 × the largest coefficient **of the active objective**, so the penalty stays meaningful whether the objective is measured in throughput units or currency |
| Baseline | `w̄_t`, `ē_t` evaluated in the same objective |

**Outputs:** solver status, objective value, side-by-side baseline vs optimized allocation table, per-terminal grouped bar chart, unmet demand per terminal, binding constraints with shadow prices (PuLP duals), and an objective-vs-`W_total` sensitivity curve (±20%).

## 4. Part 2 — IP: Cargo Processing Selection (0-1 multi-knapsack)

**Scenario framing.** The user builds a batch via filters plus a size limit (default 30–100 shipments) — e.g. "all Terminal T2 arrivals on 2024-03-22."

**Decision variables:** `x_i ∈ {0,1}` — process shipment `i` in this window.

**Objective:** `max Σ_i v_i·x_i` where

```
v_i = p_i × (1 + λ_w·norm(Waiting_Time_i) + λ_q·norm(Queue_Length_i))
```

`p_i` is the priority weight (Critical 10, High 5, Medium 2, Low 1 — UI-adjustable), `norm(·)` is min-max within the batch, and `λ_w, λ_q ∈ [0,1]` are urgency weights. This encodes "long-waiting, deeply-queued shipments gain urgency" as a deliberate, documented choice.

**Constraints:**

| # | Constraint | Data source |
|---|---|---|
| 1 | `Σ_i Cargo_Volume_i·x_i ≤ V_cap` | storage/volume capacity |
| 2 | `Σ_i (Handling_Time_i × Workforce_Assigned_i)·x_i ≤ H_cap` | worker-minutes available |
| 3 | `Σ_i Equipment_Used_i·x_i ≤ E_cap` | equipment slots |
| 4 | Optional policy: force all Critical in; cap Hazardous count; minimum Perishables | Shipment_Priority, Cargo_Type |

**Capacities** default to a fraction `f` (slider, default 0.6) of batch totals, which guarantees the problem is binding but feasible. Forced-Critical runs get a feasibility pre-check: if Critical volumes alone exceed a cap, the API returns a warning and the suggestion to lower the force toggle or raise `f`, rather than an Infeasible status.

**Baseline:** greedy FCFS by Timestamp under identical capacities and the identical value function — accept shipments in arrival order until any capacity is exhausted. Compare total value, count by priority, capacity utilization per constraint, and mean waiting time of accepted shipments.

**Expected behavior note:** because values and weights are independent uniforms, the knapsack is "flat" — many near-optimal solutions exist. Priority-weighted values make the chosen solution interpretable; mention the flatness in the report rather than treating it as a bug.

## 5. Methodology & honest comparison

Load & validate → preprocess → EDA → derive parameters → solve LP (Part 1) / solve IP (Part 2) → compare vs baseline → serve through API → render in UI.

**Comparison principles (non-negotiable):**
- Baseline evaluated with the *same* objective function at the *observed* allocation — never against raw observed KPIs.
- Same resource totals by default; runs with raised pools are flagged `expanded_resources: true` in the response and labeled in the UI.
- Report absolute and percentage deltas, binding constraints, shadow prices, capacity utilization, unmet demand.
- **Penalty-dominance disclosure.** When more than half the change in the objective comes from the soft-constraint slack penalty rather than from throughput or cost, the response says so and points the reader at the operational rows. On the default scenario the objective improves 120% while throughput improves 0.3%; quoting the 120% unqualified would be exactly the inflated claim this section forbids.
- **Infeasible baselines are named, not guessed at.** If the observed allocation falls outside the constraints of a run (a lowered pool, a budget cap), the response states which constraint it breaks and warns that the optimized value can legitimately look worse than the baseline.
- A persistent caveat banner: parameters are assumptions over synthetic data; gains are model-world, not validated operational gains.

## 6. Technology stack & API surface

**Backend:** Python · pandas · NumPy · PuLP (CBC) · FastAPI · Pydantic · Uvicorn.
**Frontend:** React + Tailwind + Plotly.js, all via CDN — no build step, no npm — served by FastAPI `StaticFiles`. Tailwind carries the visual design; a small shared component vocabulary (`Card`, `StatTile`, `DataTable`, `SliderRow`, `SolveStatus`, `CaveatBanner`, `Chart`) keeps the four pages consistent. The JSX runtime is pinned to `classic` via a registered Babel preset, because Babel 8's react preset defaults to the automatic runtime and emits `import` statements a classic `<script>` cannot run. Vite + shadcn/ui was evaluated and deliberately rejected: the toolchain cost outweighs the polish gain for a four-page project whose marks live in the OR work.
**Notebook:** Jupyter + matplotlib, for the report appendix only.

Repository layout is specified in [AGENT.md](AGENT.md) §Architecture.

### Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health` | service up, CBC availability |
| POST | `/api/datasets` | upload CSV → `dataset_id` + schema validation report |
| POST | `/api/datasets/bundled` | register the bundled CSV, so the UI works with no upload |
| GET | `/api/datasets` | list registered datasets (lets the UI re-verify a cached id) |
| GET | `/api/datasets/{id}/summary` | KPI tiles, distributions, per-terminal aggregates, correlation matrix |
| POST | `/api/lp/parameters` | scenario filters → derived α, β, costs, D_t, Cap_t, bounds, baseline (shown *before* solving) |
| POST | `/api/lp/solve` | status, objective, allocation, baseline comparison, duals, unmet demand |
| POST | `/api/lp/sensitivity` | objective vs `W_total` grid |
| POST | `/api/ip/batch` | batch preview with computed value scores and capacity defaults |
| POST | `/api/ip/solve` | selected/rejected shipments, IP vs FCFS comparison, capacity utilization |

Splitting `/parameters` from `/solve` is deliberate: it lets the UI show how every coefficient was derived before any optimization runs, which is exactly what a grader wants to see.

### UI pages

**Home** — load bundled dataset or upload, validation feedback, caveat banner.
**Data Explorer** — KPI tiles, filters, distribution charts, per-terminal box plots, correlation heatmap (presented as a *finding*, not decoration).
**Part 1 / LP** — scenario filters, objective toggle, resource + `θ` sliders, derived-parameters table, Solve button, results with duals and sensitivity chart.
**Part 2 / IP** — batch filters and size, capacity fraction, priority weights, `λ` sliders, force-Critical toggle, Solve button, IP vs FCFS comparison and accepted/rejected table.

## 7. Milestones

**Status: M1–M5 complete — Part 1 ships end to end. M6–M8 (Part 2) are next; M9–M11 remain.**

### Shared foundation

| # | Milestone | Deliverable | Done when |
|---|---|---|---|
| M1 | Setup & EDA | `.venv`, `requirements.txt`, folder skeleton, `notebooks/eda.ipynb`, `GET /api/health` returning CBC status | Notebook reproduces the §1 table incl. the correlation heatmap; `pulp.PULP_CBC_CMD().available()` is `True`; `uvicorn` serves a hello-world app |
| M2 | Data layer | `core/config.py`, `core/data_loader.py`, `core/store.py`, `core/preprocessing.py` with `terminal_summary()`, `estimate_lp_params()`, `build_batch()`; `tests/test_preprocessing.py`; `POST /api/datasets`, `GET /api/datasets/{id}/summary` | Uploading the CSV returns a `dataset_id`; summary endpoint returns per-terminal aggregates; a test asserts `α_t·w̄_t + β_t·ē_t == T̄_t` (the calibration identity) and that all parameters are finite and positive |

### Part 1 — LP track

| # | Milestone | Deliverable | Done when |
|---|---|---|---|
| M3 | LP standalone | `models/lp_resource_allocation.py` + a runner script; `tests/test_lp.py` | Solves to Optimal on the default scenario; baseline allocation is feasible; optimized objective ≥ baseline objective; duals extracted; congestion multiplier demonstrably changes the allocation (a test asserts allocations differ across terminals) |
| M4 | LP API | `schemas/lp.py`, `api/lp.py` — `/parameters`, `/solve`, `/sensitivity` | All three respond correctly in `/docs`; infeasible-ish inputs return `200` with status + suggestions, not a 500 |
| M5 | LP UI | LP page in `app.jsx` | Full round trip: adjust sliders → parameters table updates → Solve → allocation chart, duals, sensitivity curve render |

### Part 2 — IP track (independent of Part 1 after M2)

| # | Milestone | Deliverable | Done when |
|---|---|---|---|
| M6 | IP standalone | `models/ip_shipment_selection.py` + FCFS baseline in `core/baseline.py`; `tests/test_ip.py` | Solves to Optimal on a 50-shipment batch; IP value ≥ FCFS value under identical capacities; policy constraints toggle correctly; forced-Critical infeasibility is pre-detected |
| M7 | IP API | `schemas/ip.py`, `api/ip.py` — `/batch`, `/solve` | Round trip verified in `/docs` |
| M8 | IP UI | IP page in `app.jsx` | Batch preview → Solve → accepted/rejected table, priority-mix comparison, capacity utilization bars |

### Close-out

| # | Milestone | Deliverable |
|---|---|---|
| M9 | Home + Data Explorer | Upload flow, KPI tiles, EDA charts, caveat banner |
| M10 | Polish | README with LaTeX formulations, `/docs` screenshots, sensitivity analysis write-up |
| M11 | Report | Formulations, results, honest limitations section |

Parallelization: after M2, one person takes M3→M5 and the other M6→M8.

## 8. Out of scope

- Forecasting/ML (Demand_Forecast is used as given).
- Stochastic/robust optimization, queueing theory, simulation (future work).
- Multi-period/dynamic allocation — single planning-window scenarios only.
- Auth, databases, persistence beyond the in-memory dataset registry, deployment.
- Gate assignment and flight-delay modeling (those columns appear in EDA only).

## 9. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Synthetic, uncorrelated data → meaningless fitted coefficients | Closed-form share method (§3); document assumptions; present the correlation heatmap as an explicit limitation |
| **LP degeneracy — identical terminals → arbitrary allocation** | Congestion multiplier `γ_t` from bottleneck rate and facility utilization (§3); lead with the min-cost objective |
| Unbounded LP | Pool constraints + per-terminal upper bounds always active; assert solver status before reading values |
| Infeasibility (demand sliders, forced Criticals) | Soft demand constraints with penalized slack; IP feasibility pre-checks; `200` + suggestions, never a 500 |
| Units mismatch (demand vs throughput scale) | Explicit rescaling factor, surfaced in the parameters panel |
| Inflated improvement claims | Same-objective, same-resources invariant (§5); `expanded_resources` flag |
| Extreme derived rates | Group means over per-row ratios; clip denominators; winsorize 5th/95th pct |
| Frontend/backend contract drift | Pydantic schemas are the single source of truth; schema change and frontend update ship together |
| Babel-in-browser gets slow as UI grows | Split JSX across `components.jsx` / `app.jsx` and keep each file to a few hundred lines; Vite migration remains available but is not planned |
| Hand-rolled CSS looks inconsistent | Tailwind Play CDN + a fixed component vocabulary built before any page markup; one accent color, one spacing scale |
| Re-deriving parameters on every widget change | Cache by `(dataset_id, scenario)`; solve only on button click |
