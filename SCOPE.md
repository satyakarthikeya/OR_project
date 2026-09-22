# SCOPE.md — What We Are Building

Air Cargo Resource Allocation and Operational Optimizer. Operations Research course project,
23MNG336, team AB07.

A decision-support web application for air-cargo terminal operations: load a dataset, explore
statistics on demand, and run either of two optimizations with scenario controls of your own
choosing.

Three documents, and only three:

| File | Holds |
|---|---|
| **SCOPE.md** (this file) | What to build, why, and in what order |
| **[MODEL.md](MODEL.md)** | The complete mathematical formulation — the canonical source for all maths |
| **[AGENT.md](AGENT.md)** | How to work in this repo: architecture, rules, open defects |

---

## 1. The assignment, traced

The course requirement, and where each clause is satisfied. This table is the first thing to
check before the review — every row must be demonstrable live.

| Requirement | How it is met | Where |
|---|---|---|
| "Choose a publicly available dataset" | Kaggle *Air Cargo Resource Allocation Data*, CC0 / public domain, 5,000 records, 28 columns, bundled in the repo | `air_cargo_resource_allocation_dataset.csv` |
| "Do optimisation by applying some of the techniques discussed in this course" | Linear Programming and 0-1 Integer Programming, formulated in PuLP, solved with CBC. Duality and sensitivity analysis on the LP | [MODEL.md](MODEL.md) §3, §4, §6 |
| "The domain can be anything of your choice" | Air-cargo ground handling | — |
| "The questions you ask and answer can vary by context" | Four questions, stated in §2, all answered from the dataset | §2 |
| **"Create a user interface through which the data can be loaded"** | Home page: load the bundled CSV in one click, or upload your own with schema validation and a readable error report | `POST /api/datasets`, `/api/datasets/bundled` |
| **"…some statistics about the data can be generated on demand"** | Data Explorer page: KPI tiles, per-column distributions, per-terminal box plots, categorical breakdowns and a correlation heatmap, all computed server-side per request against the loaded dataset | `GET /api/datasets/{id}/summary` |
| **"…and at least two optimisations can be done (which can be chosen by the user)"** | Two models, user-selected from the navigation: **Part 1 · LP** allocation and **Part 2 · IP** shipment selection. Within Part 1 the user further chooses between two objectives (max throughput / min cost) | Part 1 and Part 2 pages |
| "You can choose any tool (not just spreadsheets)" | Python, pandas, NumPy, PuLP + CBC, FastAPI, React, Plotly. No spreadsheet anywhere | §5 |

**Two things the wording makes non-optional**, so treat them as acceptance criteria rather
than polish:

- *"generated on demand"* — statistics are computed when the user asks, against whatever
  dataset is loaded. Not precomputed, not hard-coded, not a static image.
- *"which can be chosen by the user"* — the choice of optimization is the user's, made in
  the interface at run time. Both models must be reachable and runnable from the UI.

---

## 2. The questions we answer

1. **How many workers and how much equipment should each terminal get?** → Part 1, LP.
2. **Which resource is limiting, and what would one more unit of it be worth?** → Part 1,
   shadow prices on the binding constraints.
3. **When capacity cannot clear all waiting cargo, which shipments go first?** → Part 2, IP.
4. **How much better is an optimized decision than the status quo?** → both parts, against
   baselines we implement and document ourselves (equal/observed split for Part 1, FCFS for
   Part 2), because the dataset carries no usable baseline outcome. See [MODEL.md](MODEL.md) §5.

---

## 3. The two optimizations

Full formulation in [MODEL.md](MODEL.md). Summary only here.

| | Part 1 | Part 2 |
|---|---|---|
| Model | Linear Programming (MILP — equipment is integer) | 0-1 multi-dimensional knapsack |
| Decision | Workers and equipment per terminal | Which shipments to process this window |
| Objective | Max throughput, **or** min cost subject to demand — user picks | Max priority-weighted value |
| Constraints | Resource pools, soft demand, terminal ceilings, staffing coupling, optional budget, per-terminal bounds | Volume, worker-minutes **from Part 1**, equipment-minutes, optional policy rules |
| Baseline | Observed allocation in the same objective | FCFS by arrival time |
| Key output | Allocation, shadow prices, sensitivity curve | Accepted/rejected set, priority mix, capacity utilisation |

**They are sequential, not parallel.** Part 1 decides `w_t*`; Part 2's worker-minute
constraint is indexed by terminal and takes its right-hand side from that allocation.
Presenting this as a two-stage model — *allocate, then select under the allocation you chose*
— is considerably stronger than presenting two unrelated models, and it is the single most
valuable structural idea in the project.

---

## 4. The dataset, and the limitation we state up front

5,000 shipment-handling records, four terminals (T1–T4), calendar year 2024, 28 columns.

| Aspect | Finding |
|---|---|
| Terminals | T1–T4, 1,200–1,301 records each |
| Priorities | Low 1,502 · Medium 1,537 · High 1,215 · Critical 746 |
| Cargo types | General, Express, Perishable, Hazardous (~balanced) |
| Equipment types | Crane, Loader, Forklift, Conveyor (~balanced) |
| Bottleneck_Flag | 29% overall; 27.6–31.0% per terminal — one of the few genuinely varying signals |
| Quality | No missing values, no duplicates, `Record_ID` unique. `Flight_ID` repeats (3,841 unique) — treat rows, not flights, as shipments |
| **Limitation** | **Synthetic.** Every numeric column is uniform; the largest correlation across all 144 numeric pairs is \|r\| = 0.044. `Demand_Forecast` is a per-shipment tonnage; `Throughput_Rate` is tons/hour — different *dimensions*, reconciled by the planning horizon `H`, never by a rescaling factor |

**Implication, stated in the UI and the report:** parameters cannot be regression-estimated.
They are derived in closed form from group means plus a small number of explicitly documented
assumptions, and all reported improvements are model-world gains under those assumptions.

This is a limitation to own, not to hide. The modelling is the assessed work.

---

## 5. Technology

**Backend:** Python · pandas · NumPy · PuLP (CBC) · FastAPI · Pydantic · Uvicorn.
**Frontend:** React 18 + Tailwind + Plotly.js + IBM Plex, all via CDN — no build step, no
npm — served by FastAPI `StaticFiles`. One `uvicorn` command runs the whole app.
**Notebook:** Jupyter + matplotlib, for the report appendix only.

Vite + shadcn/ui was evaluated and deliberately rejected: the toolchain cost outweighs the
polish gain for a four-page project whose marks live in the OR work.

**Visual design — "dispatch desk".** Grounded in air-side ground handling rather than
dashboard convention: ruled square-cornered panels like a load sheet, IBM Plex Mono on every
figure and label, signal amber (taxiway-signage yellow) as the sole accent, semantic
jade/brick on a separate axis. Structural devices carry meaning — a left stripe marks a
binding constraint, apron hazard tape marks the standing model-world caveat. Colour lives
entirely in CSS-variable tokens, so both themes are designed rather than one being an
inversion of the other. Rules in [AGENT.md](AGENT.md) §Frontend.

### API surface

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health` | Service up, CBC availability |
| POST | `/api/datasets` | Upload CSV → `dataset_id` + schema validation report |
| POST | `/api/datasets/bundled` | Register the bundled CSV, so the UI works with no upload |
| GET | `/api/datasets` | List registered datasets (lets the UI re-verify a cached id) |
| GET | `/api/datasets/{id}/summary` | KPI tiles, distributions, per-terminal aggregates, correlation matrix |
| POST | `/api/lp/parameters` | Scenario filters → derived α, β, costs, `D_t`, `Cap_t`, bounds, baseline — shown *before* solving |
| POST | `/api/lp/solve` | Status, objective, allocation, baseline comparison, duals, unmet demand |
| POST | `/api/lp/sensitivity` | Objective vs `W` grid |
| POST | `/api/ip/batch` | Batch preview with computed value scores and capacity defaults |
| POST | `/api/ip/solve` | Selected/rejected shipments, IP vs FCFS comparison, capacity utilisation |

Splitting `/parameters` from `/solve` is deliberate: it lets the UI show how every
coefficient was derived before any optimization runs, which is exactly what a grader wants to
see.

### UI pages

**Home** — load the bundled dataset or upload one, validation feedback, caveat banner.
**Data Explorer** — KPI tiles, filters, distribution charts, per-terminal box plots,
correlation heatmap presented as a *finding*, not decoration.
**Part 1 · LP** — scenario filters, objective toggle, resource + `θ` + congestion sliders,
derived-parameters table, Solve, then results with duals and the sensitivity chart.
**Part 2 · IP** — batch filters and size, capacity fraction, priority weights, λ sliders,
force-Critical toggle, Solve, then IP vs FCFS comparison and the accepted/rejected table.

---

## 6. Milestones

**Status: M1–M9 complete — both parts ship end to end and 167 tests pass. M10–M11 remain.**
The seven defects listed in [AGENT.md](AGENT.md) are all closed, so the code now implements
the model [MODEL.md](MODEL.md) describes.

### Shared foundation

| # | Milestone | Deliverable | Done when |
|---|---|---|---|
| M1 | Setup & EDA | `.venv`, `requirements.txt`, folder skeleton, `notebooks/eda.ipynb`, `GET /api/health` | Notebook reproduces §4's table including the correlation heatmap; `pulp.PULP_CBC_CMD().available()` is `True`; uvicorn serves the app |
| M2 | Data layer | `core/config.py`, `data_loader.py`, `store.py`, `preprocessing.py` with `terminal_summary()`, `estimate_lp_params()`, `build_batch()`; `tests/test_preprocessing.py`; the two dataset endpoints | Uploading the CSV returns a `dataset_id`; summary returns per-terminal aggregates; tests assert the calibration identity `α_t w̄_t + β_t ē_t = T̄_t` and that every parameter is finite and positive |

### Part 1 — LP track

| # | Milestone | Deliverable | Done when |
|---|---|---|---|
| M3 | LP standalone | `models/lp_resource_allocation.py` + runner; `tests/test_lp.py` | Solves to Optimal on the default scenario; baseline is feasible; optimum ≥ baseline on its own objective; duals extracted; congestion multiplier demonstrably changes the allocation |
| M4 | LP API | `schemas/lp.py`, `api/lp.py` — `/parameters`, `/solve`, `/sensitivity` | All three respond in `/docs`; infeasible-ish inputs return `200` with status + suggestions, never a 500 |
| M5 | LP UI | LP pages | Full round trip: adjust sliders → parameters table updates → Solve → allocation chart, duals and sensitivity curve render |

### Part 2 — IP track

Independent of Part 1 **for development sequencing only** — M6 consumes `w_t*`.

| # | Milestone | Deliverable | Done when |
|---|---|---|---|
| M6 ✓ | IP standalone | `models/ip_shipment_selection.py`; FCFS baseline in `core/baseline.py`; `tests/test_ip.py` | Solves to Optimal on a 50-shipment batch; IP value ≥ FCFS under identical capacities; worker-minutes constraint is per-terminal and fed by `w_t*`; policy constraints toggle correctly; forced-Critical infeasibility is pre-detected |
| M7 ✓ | IP API | `schemas/ip.py`, `api/ip.py` — `/batch`, `/solve` | Round trip verified in `/docs`; the optional LP-result input works, so Part 2 is testable standalone |
| M8 ✓ | IP UI | `page-ip.jsx`, `page-ip-results.jsx`, replacing the placeholder | Batch preview → Solve → accepted/rejected table, priority-mix comparison, capacity utilisation bars |

### Close-out

| # | Milestone | Deliverable |
|---|---|---|
| M9 ✓ | Correctness pass | The seven defects in [AGENT.md](AGENT.md) closed, so the code matches [MODEL.md](MODEL.md) |
| M10 | Polish | `/docs` screenshots, sensitivity write-up, requirements-traceability walkthrough (§1) rehearsed |
| M11 | Report | Formulations, results, and an honest limitations section |

M9 is done, so [MODEL.md](MODEL.md) and the code now describe the same model and the report
can quote the formulation directly. Two things it must still say plainly: the allocation and
the shadow prices come from different solves (equipment is integer, so CBC's own duals are
not shadow prices), and every gain is model-world under stated assumptions.

---

## 7. Out of scope

- Forecasting or ML — `Demand_Forecast` is used as given.
- Stochastic or robust optimization, queueing theory, simulation.
- Multi-period or dynamic allocation — single planning-window scenarios only.
- Auth, databases, persistence beyond the in-memory dataset registry, deployment.
- Gate assignment and flight-delay modelling — those columns appear in EDA only.

---

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Synthetic, uncorrelated data → meaningless fitted coefficients | Closed-form share method; document every assumption; present the correlation heatmap as an explicit limitation |
| **LP degeneracy — near-identical terminals → arbitrary allocation** | Congestion multiplier `γ_t` from bottleneck rate and facility utilisation, on by default with a UI switch that shows the degenerate model underneath |
| Units mismatch — demand is tons, throughput is tons/hour (a difference of **dimension**) | Sum `Demand_Forecast` per terminal, divide by the planning horizon `H`; `H` shown in the parameters panel. Never a rescaling factor |
| **Shadow prices inflated by the Big-M penalty** | Flag duals whenever unmet demand is non-zero; take clean duals from a second solve with slack fixed at zero |
| **Priority inversion in the IP value function** | Cap the urgency uplift at `U = 0.9`, below the tightest adjacent priority ratio; clamp λ in the schema |
| Unbounded LP | Pool constraints plus per-terminal upper bounds always active; assert solver status before reading values |
| Infeasibility from user sliders | Soft demand constraints with penalised slack; IP feasibility pre-checks; `200` + suggestions, never a 500 |
| Inflated improvement claims | Same-objective, same-resources invariant; `expanded_resources` flag; penalty-dominance disclosure |
| Extreme derived rates | Group means over per-row ratios; clip denominators |
| Frontend/backend contract drift | Pydantic schemas are the single source of truth; a schema change and its frontend update ship together |
| Babel-in-browser gets slow as the UI grows | Split JSX across `components.jsx` and per-page files; keep each to a few hundred lines |
| Re-deriving parameters on every widget change | Cache by `(dataset_id, scenario, tunables)`; solve only on an explicit button click |
