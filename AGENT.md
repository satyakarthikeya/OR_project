# AGENT.md — Working Instructions

For any AI coding agent (Claude Code, Copilot, Cursor) or human collaborator working in this
repository. **Read this file fully before writing code.**

Three documents, and only three. Do not create a fourth.

| File | Holds | Read it when |
|---|---|---|
| [SCOPE.md](SCOPE.md) | What to build, the assignment requirements, milestones | Deciding *what* to work on |
| [MODEL.md](MODEL.md) | The complete mathematical formulation | Touching any parameter, constraint or objective |
| **AGENT.md** (this file) | Architecture, layering rules, conventions, defect history | Before every change |

**MODEL.md is canonical for all mathematics.** If the code disagrees with it, the code is
behind. Never "fix" MODEL.md to match the code. As of M9 they agree — see §Open defects for
the seven that were closed and the tests that keep them closed.

---

## What this project is

An Operations Research decision-support system for air-cargo terminal operations, built on a
bundled 5,000-record Kaggle dataset. Two optimization models solved with PuLP, exposed
through FastAPI and consumed by a React frontend served from the same origin.

- **Part 1 — LP: workforce and equipment allocation** across four terminals, maximising
  throughput or minimising cost.
- **Part 2 — IP: shipment selection**, a 0-1 multi-dimensional knapsack choosing which
  shipments to process under limited capacity.

They are **sequential**: Part 2's worker-minute constraint is fed by Part 1's solved `w_t*`.

---

## Four facts that will save you a wasted afternoon

**1. The dataset is synthetic and carries no signal.** Every numeric column is uniform; the
largest correlation across all 144 numeric pairs is |r| = 0.044. Therefore:

- **Never estimate a coefficient by regression.** OLS of throughput on workforce and
  equipment gives R² = 0.0001. Use the closed-form share method in [MODEL.md](MODEL.md) §3.4.
- **Never claim empirical validity** for an improvement — in code, API responses, UI text or
  docs. Gains are model-world under stated assumptions. The UI carries a standing caveat
  banner (`config.MODEL_WORLD_CAVEAT`).
- **Watch for degeneracy.** Near-identical terminals make the LP indifferent. The congestion
  multiplier exists to prevent this; do not remove it without a replacement.

**2. Demand and throughput differ in *dimension*, not scale.** `Demand_Forecast` is a
per-shipment tonnage; `Throughput_Rate` is tons per hour. Before they can meet in a
constraint, demand is **summed per terminal and divided by the planning horizon `H`**. Do
**not** rescale by `mean(Throughput)/mean(Demand)` — that keeps tons as tons and pins `D_t`
to baseline capability by construction. Do **not** take a mean — a mean of a per-shipment
column makes a busy terminal and a quiet one identical.

**3. The congestion multiplier is IN the model and ON by default.** `apply_congestion=True`
at `preprocessing.py` and in `schemas/lp.py`; `CONGESTION_DELTA = 1.0`; four tests assert it
is live and differentiating. Older drafts of the docs claimed it had been dropped — they were
wrong and have been deleted. The UI switch that turns it off exists to *demonstrate* the
degenerate model, not because the multiplier is optional.

**4. Data is otherwise clean.** No missing values, no duplicates, `Record_ID` unique.
`Real_Time_Load` is on a 10–150 scale, not a percentage. `Storage_Occupancy` and
`Facility_Utilization` **are** percentages and cannot supply an absolute capacity.

---

## Architecture

```
air_cargo_resource_allocation_dataset.csv   # bundled; never modify or regenerate
requirements.txt · pytest.ini · .gitignore
SCOPE.md · MODEL.md · AGENT.md              # the only three docs

backend/
├── main.py              # FastAPI app: router includes, StaticFiles mount — thin, no CORS needed
├── api/
│   ├── datasets.py      # upload, bundled, list, summary
│   ├── lp.py            # /api/lp/parameters, /solve, /sensitivity
│   └── ip.py            # /api/ip/batch, /solve
├── schemas/             # Pydantic models — the API contract
│   ├── common.py        #   SolveStatus, SolveOutcome, ScenarioFiltersIn, HealthOut
│   ├── lp.py
│   └── ip.py
├── core/
│   ├── config.py        # column names, vocabularies, tunables, tolerances — no logic
│   ├── data_loader.py   # CSV load + schema validation
│   ├── preprocessing.py # aggregation + parameter derivation — the intellectual core
│   ├── store.py         # in-memory dataset registry keyed by dataset_id
│   ├── baseline.py      # observed-allocation baseline (LP) + FCFS baseline (IP)
│   └── comparison.py    # baseline-vs-optimized deltas
└── models/
    ├── lp_resource_allocation.py
    └── ip_shipment_selection.py

frontend/                # no build step — served by FastAPI StaticFiles
├── index.html           # CDN tags, Tailwind config, CSS theme tokens, Babel preset
├── api.js               # window.api — one wrapper per endpoint
├── components.jsx       # window.UI — Card, Button, Badge, Icon, EmptyState, ThemeContext, cx
├── page-explorer.jsx    # Home + Data Explorer
├── page-lp.jsx          # Part 1 controls + derived parameters
├── page-lp-results.jsx  # Part 1 results: outcome, plan, duals, sensitivity
├── page-ip.jsx          # Part 2 controls + scored batch
├── page-ip-results.jsx  # Part 2 results: IP vs FCFS, capacities, decisions
└── app.jsx              # shell, hash routing, theme, dataset state

tests/                   # 167 collected, all passing
├── test_preprocessing.py  (30)
├── test_lp.py             (43 collected)
├── test_lp_api.py         (39 collected)
├── test_ip.py             (30)
├── test_ip_api.py         (25)
└── test_api.py            (7)

notebooks/eda.ipynb      # EDA for the report appendix; matplotlib allowed here only
```

### Layering rules — hard

- **Models are pure.** `backend/models/*` take plain dicts and dataclasses and return a
  structured result (status, objective, variable values, slacks, duals). They never read the
  CSV, never import FastAPI, never touch the store. `test_lp.py::test_model_module_stays_pure`
  asserts this by scanning the source — it will fail if you add `import pandas`.
- **All parameter estimation lives in `preprocessing.py`.** No magic numbers in model or API
  files; tunables live in `config.py`. (One historical exception:
  `PENALTY_DOMINANCE_THRESHOLD` sits in `comparison.py`. Move it if you touch that file.)
- **The API layer is a translator only:** validate with Pydantic → call preprocessing → call
  the model → shape the response. No business logic in `api/*`.
- **Pydantic schemas are the contract.** The frontend follows the schemas, not the reverse. A
  schema change and its frontend update ship in the same commit.

### FastAPI rules

- **Infeasible is a result, not an HTTP error.** Return `200` with
  `{"status": "Infeasible", "message": "...", "suggestions": [...]}`. Reserve `4xx` for bad
  input and `5xx` for genuine crashes. Note the consequence: a client checking only the
  status code will read a failed solve as success, so `allocation` comes back `[]` and
  `comparison` `null`.
- **Always check `pulp.LpStatus` before reading variable values.**
- **Dataset state is process memory.** `store` is a module singleton; every `dataset_id` dies
  with the server, which is why the frontend re-verifies a cached id on load. No persistence,
  no eviction.
- Parameters are cached per `(dataset_id, filters, tunables)` in `_PARAM_CACHE` (cap 128).
  **The returned `LPParameters` object is shared — treat it as read-only.**
  `test_lp_api.py` reaches into `_PARAM_CACHE` by name, so renaming it breaks a test.
- Solves are fast (CBC, a few hundred variables), so endpoints stay synchronous. Past ~2s,
  move to a background task rather than raising the timeout.
- No CORS middleware, by design — StaticFiles makes the app same-origin. Open it via
  `http://127.0.0.1:8000`, never `file://`.

### Frontend rules

**Decided: no build step, no npm, no Node.** `index.html` loads React 18.3.1, ReactDOM,
Babel-standalone 7.26.4, Plotly 2.35.2 and Tailwind Play CDN 3.4.16, all pinned. The `.jsx`
files are `type="text/babel"`. One `uvicorn` command runs everything.

- **Colour comes only from semantic tokens.** `index.html` defines 17 CSS variables —
  `ground`, `panel`, `sunken`, `rule`, `rule-firm`, `ink`, `body`, `muted`, `faint`,
  `accent`, `accent-fill`, `accent-ink`, `accent-wash`, `pos`, `pos-wash`, `neg`,
  `neg-wash` — exposed to Tailwind as colour names. Write `bg-panel text-ink border-rule`.
  **Never** a raw palette value (`slate-800`), **never** a `dark:` colour pair. A `dark:`
  colour is a bug: it means one theme was styled and the other inherited.
- **Signal amber is the accent.** Spend it only on active navigation, the primary action,
  focus rings, binding-constraint stripes and the lead chart series. Jade (`pos`) and brick
  (`neg`) are a separate semantic axis and never stand in for it.
- **Square corners.** Every `borderRadius` step is ≤ 3px. Panels are ruled sheets: hairline
  border, no shadows, full-width rule under the header.
- **Typography is IBM Plex.** Sans for prose, Mono for every numeral, symbol, constraint name
  and small-caps label. `.num` applies Plex Mono plus tabular figures; `.field-label` is the
  load-sheet field marker.
- **Structure encodes state.** `DataTable` takes `rowStripe(row)` for a left severity stripe.
  The standing caveat uses `.hazard-edge` apron tape, which nothing else may use. Do not add
  a device that says nothing.
- `chartTheme()` in `components.jsx` holds the only literal colour strings, because Plotly
  cannot read CSS variables. Change a token, change it there too.
- **Build the component vocabulary first**, then compose pages from it. Never style page
  markup ad hoc.
- **Keep Babel's workload small.** A few hundred lines per file. Split by page rather than
  letting one file grow.
- Solve only on an explicit button click, with a loading state. Render solver status
  prominently, including the `suggestions` list on infeasible runs.
- Both themes must be legible, Plotly charts included.

### Honest-comparison invariant

Baseline and optimized KPIs are evaluated with the **same objective function** and the
**same resource totals**, through the same scoring function. Never compare LP output against
raw observed `Throughput_Rate`. Runs that raise resource pools above baseline must be
labelled "expanded-resources scenario" in the response and the UI. When at or above half the
objective delta comes from the slack penalty, say so — that note covers the objective delta
**only**, never the duals.

---

## Open defects — none. All seven are closed.

M6–M9 are done: both models ship end to end and **167 tests pass**. The seven defects that
used to sit here are closed, and the code now matches MODEL.md. Each row below names the test
that stops it coming back.

| # | Defect, as it was | How it is now | Guarded by |
|---|---|---|---|
| 1 | `D_t` was a rescaled mean — wrong dimension, blind to how busy a terminal is | `D_t` = tons arriving at the terminal in one window ÷ `H`. `demand_day` chooses the average day or the p95 busy day | `test_preprocessing.py::test_demand_is_a_level_over_the_horizon_not_a_rescaled_mean`, `::test_peak_day_demand_switches_the_slack_on` |
| 2 | Duals were penalty-inflated whenever `s_t > 0` | Duals come from a relaxation; if that leaves demand unmet, the unreachable demand constraints are dropped and it is re-solved with no penalty term at all. `duals_source` and `duals_penalty_inflated` say which | `test_lp.py::test_unmet_demand_forces_clean_duals_from_a_second_solve` |
| 3 | Urgency tied with, or outranked, a priority class | Uplift capped at `U = 0.9`, normalised by `λ_w + λ_q`, λ clamped to [0,1] in both `build_batch` and the schema | `test_preprocessing.py::test_urgency_uplift_is_capped_below_the_tightest_priority_ratio`, `::test_lambdas_are_clamped` |
| 4 | The IP charged equipment as if consumed | Equipment-**minutes** (`Handling_Time × Equipment_Used`) | `test_preprocessing.py::test_equipment_is_charged_as_minutes_not_machines` |
| 5 | Part 2 did not consume Part 1's allocation | Worker-minutes indexed per terminal, RHS `w_t* · H · 60`, fed by `lp_workforce` on `/api/ip/solve`. Standalone still works and says so | `test_ip.py::test_starving_one_terminal_in_part_one_shuts_it_out_in_part_two` |
| 6 | No staffing coupling — equipment ran unattended | `w_t ≥ ρ·e_t`, `ρ = 1.5`, plus the empty-box pre-checks in `check_problem` | `test_lp.py::test_every_machine_has_an_operator`, `::test_unstaffable_equipment_floor_is_pre_detected` |
| 7 | All variables continuous | `e_t` is `LpInteger` with floored/ceiled bounds; `w_t` stays continuous | `test_lp.py::test_equipment_is_whole_machines` |

**Two consequences worth carrying forward.**

- **The model is solved up to three times per request.** The MILP gives the reportable
  allocation; a continuous relaxation gives the duals; and when demand is unmet a third solve
  strips the penalty out. `allocation_source` and `duals_source` are on the response and on
  screen. Never quote a dual without saying which solve it came from.
- **Demand is a level, so the default scenario now has headroom.** On the average day unmet
  demand is zero at every terminal and no dual is penalty-inflated. Slack switches on at
  `demand_day: "p95"` or `demand_scale` above roughly 1.8. Tests that need a shortfall must
  ask for one; the old ones got it by accident from the rescaling bug.

---

## Smaller inconsistencies worth knowing

Not defects, but they will surprise you.

- `SolveOutcome` in `schemas/common.py` is defined and never used. Infeasibility is folded
  into `LPSolveOut`'s own `status`/`message`/`suggestions`.
- `WINSOR_LOW` / `WINSOR_HIGH` in `config.py` are dead — no winsorisation happens anywhere.
- `problem_from_parameters` silently raises `Cap_t` to `max(Cap_t, baseline throughput)`, so
  `/solve` can report a different `Cap_t` than `/parameters` attributes to the p95 derivation.
  The derivation note mentions it; the two endpoints still print different numbers.
- `/sensitivity` accepts `workforce_pool_factor` but then recomputes `workforce_total` from
  the *unscaled* total per sweep point, so that factor only affects the equipment pool and
  budget carried over from the base problem.
- Pool factors are hard-bounded to [0.8, 1.2] in the schema; `/sensitivity`'s
  `factor_min`/`factor_max` allow [0.1, 3.0].
- `data_loader.load_and_clean` is unused — the upload route inlines the three steps so it can
  return 422 instead of raising.
- `baseline._infeasibility_reason` still hard-codes `tol = 1e-6` rather than using
  `config.BINDING_ABS_TOL`. `AllocationEvaluation.feasible_against` no longer does.
- **An IP capacity "binds" on a different test than an LP constraint.** An LP constraint
  binds when it is exactly full; an integer one almost never is, because the items are
  indivisible. `ip_shipment_selection._is_binding` therefore asks whether the headroom left
  is too small for any *rejected* shipment to fit into — which is what "this is what limits
  the plan" means when the decision is 0-1. Reading it as "used ≈ available" will confuse you.
- Tests hard-code dataset facts: `len(df) == 5000`, four terminals, `max off-diagonal
  correlation < 0.05`. They are assertions about *this* CSV, by design.

---

## Environment and conventions

- Windows 11, PowerShell. Python 3.11+, venv at `.venv`.
- All 11 dependencies pinned with `==` in `requirements.txt`. `jupyter` and `matplotlib` are
  for the notebook only.
- **Run:** `uvicorn backend.main:app --reload` → app at `http://127.0.0.1:8000`, interactive
  API docs at `/docs` (free deliverable — screenshot it for the report). That is the only
  command; there is nothing to build.
- **Test:** `pytest` from the repo root. `pytest.ini` sets `pythonpath = .`, so it must be
  run from the root.
- Verify CBC early: `pulp.PULP_CBC_CMD().available()`; it is exposed at `GET /api/health`.
- Hard-refresh (Ctrl+F5) after editing `.jsx` — browsers cache them aggressively.
- Guard derived rates: clip denominators; `MIN_WORKFORCE` and `MIN_EQUIPMENT` floor them.
- Default IP batch 30–100 shipments so tables stay readable. CBC handles all 5,000 binaries,
  but the UI should then show summaries only.
- **Do not modify or regenerate the bundled CSV.**

---

## Decisions already taken — do not relitigate

- **Capacity floor.** `Cap_t` is raised to the terminal's own modelled baseline throughput
  where the percentile lands below it. Without this, a lopsided scenario slice makes the
  observed allocation infeasible and voids every comparison.
- **Penalty scaling.** `M` is scaled to the largest coefficient of the *active* objective. It
  is a large number chosen to dominate, not a meaningful figure in either unit — in the
  `min_cost` branch the scale is a cost per resource unit while `s_t` is in throughput units.
  `unmet_penalty` must never be quoted as money.
- **Penalty-dominance note.** When at or above half the objective delta comes from the slack
  penalty, `comparison.py` says so. This is what stops the UI quoting a 120% improvement when
  throughput moved 0.3%. It covers the objective delta only.
- **Infeasible-baseline reason.** `baseline.py` names the specific constraint the observed
  allocation breaks rather than guessing at the cause.
- **JSX runtime is pinned.** `index.html` registers a Babel preset with `runtime: 'classic'`.
  Babel 8's react preset defaults to the automatic runtime, which emits `import` statements a
  classic `<script>` cannot execute. Do not add `data-type` to those script tags —
  babel-standalone then skips them silently.
- **`uppercase` and Greek letters.** Tailwind's `uppercase` turns α into Α and γ into Γ.
  `DataTable` takes a `headerClass` prop so symbol headers opt out. The same trap bites test
  assertions: `innerText` reports transformed case, so match UI text case-insensitively.
- **Light-mode accent text is darker than the accent fill.** `--c-accent` is `#8F5200` while
  `--c-accent-fill` is `#E9A32E`; the bright amber is only ~4.3:1 on the light ground, which
  fails AA for the 10px small-caps labels. Keep the two separate.
- **No Vite, no shadcn/ui.** Evaluated and rejected — toolchain cost over polish gain for a
  four-page project whose marks live in the OR work.

---

## What to work on next

M1–M9 are complete. Both models ship end to end, the code matches
[MODEL.md](MODEL.md), and 167 tests pass. What remains is presentation, not modelling.
Details in [SCOPE.md](SCOPE.md) §6.

1. **M10 — polish.** `/docs` screenshots, the sensitivity write-up, and a rehearsed
   requirements-traceability walkthrough of [SCOPE.md](SCOPE.md) §1.
2. **M11 — the report.** Formulations, results, and an honest limitations section.

Two things worth adding if there is time, both of which the formulation already supports and
neither of which is required:

- **Part 2 parametric re-solve curves.** [MODEL.md](MODEL.md) §4.5 specifies them and says
  why they are the right tool — an IP has no shadow prices, so sensitivity means re-solving
  against `V_cap`, `E_cap` and the worker-minute budget. The pieces are all in place; only
  the endpoint and the chart are missing.
- **A `demand_day` axis in `/api/lp/sensitivity`.** The average-day versus p95-day contrast
  is the scenario story worth presenting and is currently only reachable by two separate
  solves.

Before touching any of it, re-read the relevant [MODEL.md](MODEL.md) section. The formulation
there is the specification.
