# MODEL.md — Mathematical Formulation

The complete, canonical formulation for both optimization models. Where this file and any
other document disagree, **this file wins**. Where this file and the code disagree, the
gap is listed in [AGENT.md](AGENT.md) §Open defects — the code has not caught up yet.

Course: 23MNG336 Operations Research. Team AB07.

---

## 1. The decision problem

An air-cargo facility runs four terminals (T1–T4) from one pool of workers and one pool of
ground equipment. Two decisions have to be made, and they are different in kind:

| | Part 1 | Part 2 |
|---|---|---|
| Question | Where do the workers and machines go? | Which shipments get processed this window? |
| Quantity | Divisible — 26.4 workers at T2 is a meaningful answer | Indivisible — a shipment is processed or it is not |
| Model | Linear Programming | 0-1 multi-dimensional knapsack (Integer Programming) |
| Solved by | CBC via PuLP | CBC via PuLP |

The two are **sequential, not parallel**. Part 1 decides `w_t*`; Part 2 spends it. See §3.3.

### Planning horizon

Every scenario covers a window of **`H` hours** (config, default 8). `H` is not decoration:
it is what makes a demand level and a throughput rate comparable, and it sets the
worker-minute budget Part 2 draws on. Every quantity below is either a rate (per hour) or a
level (over the window `H`), and the formulation says which.

---

## 2. The dataset, and what it permits

Kaggle "Air Cargo Resource Allocation Data" — CC0, 5,000 records, 28 columns, four
terminals, calendar year 2024. Bundled in the repo root.

**The data is synthetic and carries no signal.** Every one of the 15 continuous numeric
columns is statistically indistinguishable from uniform (KS p-values 0.31–0.97). Across all
144 numeric pairs the largest correlation is |r| = 0.044, inside the noise band for
n = 5,000. Across 108 group-mean ANOVAs, exactly 4 came out p < 0.05 against a chance
expectation of 5.4. The categorical columns are equi-frequent.

The one deliberate design feature is `Shipment_Priority`, which is genuinely non-uniform
(χ² = 320.9, p < 0.001) — Critical 746, High 1,215, Medium 1,537, Low 1,502. Part 2 leans
on it correctly.

**What follows from this, and governs everything below:**

1. **No coefficient may be estimated by regression.** OLS of `Throughput_Rate` on
   `Workforce_Assigned` and `Equipment_Used` gives R² = 0.0001, with a workforce
   coefficient of −0.0176 (p = 0.61). Every parameter is derived in closed form from group
   means plus a small number of stated assumptions.
2. **No result may be claimed as an empirical finding.** Improvements are model-world gains
   under stated assumptions. The UI carries a standing caveat banner
   (`config.MODEL_WORLD_CAVEAT`).
3. **Degeneracy is the default failure mode.** The terminals are near-identical, so a naive
   parameterisation makes the LP indifferent between them. §3.4 is the fix.

This is a limitation to state plainly, not to hide. The modelling is the assessed work; the
data is a vehicle for it.

---

## 3. Part 1 — LP: workforce and equipment allocation

### 3.1 Decision variables

For each terminal `t ∈ {T1, T2, T3, T4}`:

| Variable | Domain | Meaning |
|---|---|---|
| `w_t` | continuous, ≥ 0 | workers assigned to terminal `t` |
| `e_t` | **integer**, ≥ 0 | equipment units assigned to terminal `t` |
| `s_t` | continuous, ≥ 0 | unmet demand at terminal `t` (soft-constraint slack) |

**Why `w_t` is continuous.** It reads as a staffing level over the window: 26.4 means a
worker's shift is split across terminals, which is how ground handling actually rosters.
That is a defensible planning-level answer.

**Why `e_t` is not.** Equipment runs 1–14 per terminal against a pool of about 30, so
`e_T2 = 7.43` is a real slice of the decision rather than a rounding nuisance. You cannot
run 0.43 of a forklift.

**The consequence, which must be stated when reporting duals.** Once `e_t` is integer the
problem is a MILP, and `constraint.pi` is no longer a shadow price — CBC returns the duals
of the final LP relaxation at the incumbent node. The model is therefore **solved twice**:
the relaxation gives the duals and the sensitivity ranges, the MILP gives the allocation
that gets reported. Every response says which numbers came from which solve.

### 3.2 Objective functions

The user picks one. Both are exposed in the UI.

**Maximise throughput:**

```latex
\max \; Z \;=\; \sum_{t} \bigl(\alpha_t w_t + \beta_t e_t\bigr) \;-\; M \sum_{t} s_t
```

**Minimise operational cost subject to demand:**

```latex
\min \; Z \;=\; \sum_{t} \bigl(c^{w}_{t} w_t + c^{e}_{t} e_t\bigr) \;+\; M \sum_{t} s_t
```

The min-cost objective is the more interesting of the two on this data, because differing
`D_t` and `c_t` drive genuine trade-offs even when the terminals are near-identical in
productivity. Lead with it in the report.

### 3.3 Constraints

```latex
\begin{aligned}
\sum_{t} w_t &\le W &&\text{(1) workforce pool}\\[2pt]
\sum_{t} e_t &\le E &&\text{(2) equipment pool}\\[2pt]
\alpha_t w_t + \beta_t e_t + s_t &\ge D_t &&\forall t \quad\text{(3) demand, \textbf{soft}}\\[2pt]
\alpha_t w_t + \beta_t e_t &\le \mathrm{Cap}_t &&\forall t \quad\text{(4) terminal ceiling}\\[2pt]
w_t &\ge \rho\, e_t &&\forall t \quad\text{(5) staffing coupling}\\[2pt]
\sum_{t} \bigl(c^{w}_{t} w_t + c^{e}_{t} e_t\bigr) &\le B &&\text{(6) budget, optional}\\[2pt]
w_t^{\min} \le w_t \le w_t^{\max}, \quad
e_t^{\min} &\le e_t \le e_t^{\max} &&\forall t \quad\text{(7) allocation limits}\\[2pt]
w_t,\; e_t,\; s_t &\ge 0 &&\forall t \quad\text{(8) non-negativity}
\end{aligned}
```

**Everything in (3) and (4) is a rate, per hour.** `D_t` is already divided by the horizon
in §3.4, and `Cap_t` is a percentile of `Throughput_Rate`, so the production function meets
them in tons/hour and no `H` appears. `H` does its work in two other places: converting the
demand *level* into `D_t`, and setting Part 2's worker-minute budget. The objective is the
same rate, unscaled — multiplying it by `H` would leave the argmax untouched but would
scale `Z` and every shadow price by 8, so the code does not.

**(3) is soft on purpose.** Slack `s_t` plus a penalty means the model degrades gracefully
and reports a shortfall instead of returning Infeasible. A scenario the user builds with
sliders should never hand back "Infeasible" and nothing else.

**(4) and (7) are hard, and they can conflict.** If `Cap_t < α_t w_t^min + β_t e_t^min`
the box is empty and CBC returns Infeasible for a reason the user cannot see. Check this
before solving and say so. (`check_problem` does this for the pool and budget cases
already; the capacity-vs-floor case needs adding alongside constraint 5.)

**(5) is why machines have operators.** Without it the objective is separable in `w` and
`e`, and inside the per-terminal box the LP freely substitutes equipment for labour — it
pushes `e_t` to its ceiling while `w_t` sits on its floor and still books throughput
through `β_t e_t`, with nobody driving the cranes. Every equipment type in the data
(Crane, Loader, Forklift, Conveyor) needs an operator.

`ρ = 1.5` is a stated operational assumption, not a data finding. The observed means — about
27 workers against 7.5 equipment units, a ratio of ≈3.6 — clear it comfortably, so the
observed baseline stays feasible and baseline-vs-optimized stays a fair comparison. That is
the answer to "does your baseline survive the new constraint?"

### 3.4 Parameter derivation

Let `w̄_t`, `ē_t`, `T̄_t`, `C̄_t` be the per-terminal means of `Workforce_Assigned`,
`Equipment_Used`, `Throughput_Rate` and `Operational_Cost` over the scenario slice.

#### Productivity and cost coefficients — the closed-form share method

Assume a **labour share** `θ = 0.6` of throughput attributable to workers, and a cost share
`θ_c = 0.6`. Then:

```latex
\alpha_t = \frac{\theta\,\bar{T}_t}{\bar{w}_t}, \qquad
\beta_t  = \frac{(1-\theta)\,\bar{T}_t}{\bar{e}_t}, \qquad
c^{w}_{t} = \frac{\theta_c\,\bar{C}_t}{\bar{w}_t}, \qquad
c^{e}_{t} = \frac{(1-\theta_c)\,\bar{C}_t}{\bar{e}_t}
```

This is **self-calibrating**: by construction `α_t w̄_t + β_t ē_t = T̄_t` exactly, so the
model reproduces observed mean throughput at observed mean inputs and the baseline is always
feasible. It needs exactly one assumption (`θ`), which is stated, UI-adjustable and testable
by sensitivity analysis. It is preferred over a mean of per-row ratios, which is inflated by
small denominators.

**Say this honestly, because an examiner will press on it.** That identity holds for *any*
`θ` and *any* dataset, including pure noise — it is an algebraic identity, not evidence of
fit. At record level the linear form has R² = −0.55 against this data. `α` and `β` are a
**declared linear production assumption**, not estimated coefficients. Owning that is
survivable; being caught by it is not.

Uncongested values on the full dataset:

| Terminal | `w̄_t` | `ē_t` | `T̄_t` | `α_t` | `β_t` |
|---|---|---|---|---|---|
| T1 | 27.430 | 7.541 | 64.570 | 1.4124 | 3.4251 |
| T2 | 26.657 | 7.470 | 65.909 | 1.4835 | 3.5294 |
| T3 | 26.847 | 7.358 | 64.610 | 1.4440 | 3.5123 |
| T4 | 27.281 | 7.264 | 65.037 | 1.4304 | 3.5814 |

#### The degeneracy problem, and the congestion multiplier

Those `α` values span 2.1% (CV). Bootstrapped, all 12 pairwise differences in `α` and `β`
have 95% CIs straddling zero. P(T2 has the largest α) = 0.77; for `β` the ranking flips to
T4. With productivities that close, a max-throughput LP has no reason to prefer any terminal
and collapses into "push every variable to its bound in whatever order the solver scans" —
technically optimal, analytically empty.

**The fix: a documented congestion multiplier**, scaling each terminal's productivity by its
observed operational health:

```latex
\gamma_t = \bigl(1 - \text{bottleneck\_rate}_t\bigr)\cdot
           \Bigl(1 - \tfrac{\text{facility\_util}_t}{100}\Bigr)^{\delta}
\qquad
k = \frac{\sum_t \bar{T}_t}{\sum_t \gamma_t \bar{T}_t}
\qquad
\alpha_t \leftarrow k\,\gamma_t\,\alpha_t,\quad
\beta_t \leftarrow k\,\gamma_t\,\beta_t
```

Bottleneck rate (27.6%–31.0%) and facility utilisation genuinely differ across terminals, so
`γ_t` creates real, data-grounded differentiation: congested terminals convert resources into
throughput less efficiently, the LP shifts resources toward healthier ones, and the shadow
prices become interpretable. `δ` is a config constant, default 1, UI-exposed 0–4.

**What the renormalisation preserves.** Before congestion the calibration identity holds
*per terminal*. After it, it holds *in aggregate*:
`Σ_t (α_t w̄_t + β_t ē_t) = Σ_t T̄_t`. That is the intended trade — congestion redistributes
productivity between terminals without inventing or destroying system throughput, so the
baseline total is reproduced exactly and the comparison stays fair. Both identities are
asserted in `tests/test_preprocessing.py`.

**This is a stated modelling assumption, not an empirical finding.** The UI exposes a switch
(`apply_congestion`, default on) that turns it off and reproduces the degenerate model it
exists to prevent — and says so on screen. That switch is the honest way to present it: here
is the problem, here is the fix, here is the problem again with the fix removed.

#### Demand — a level over the horizon, not a rescaled mean

```latex
D_t \;=\; \frac{1}{H}\sum_{i \,\in\, \text{slice},\; \text{terminal } t} \text{Demand\_Forecast}_i
\qquad [\text{tons/hour}]
```

`Demand_Forecast` is a **per-shipment tonnage**. Summing it over a terminal gives the total
tons arriving there in the window — a level. Dividing by `H` makes it a rate directly
comparable to `α_t w_t + β_t e_t`.

**Two errors this replaces, both worth being able to explain:**

1. **A mean is not a workload.** The mean of a per-shipment column is the average forecast of
   one shipment, so a terminal handling 1,301 shipments and one handling 1,200 came out
   identical. How busy a terminal is never reached the model.
2. **Rescaling does not convert units.** Demand is in tons, throughput in tons per hour — a
   difference of *dimension*, not of scale. Multiplying tons by a factor gives smaller tons.
   Only dividing by a time makes a rate. The old `× mean(Throughput)/mean(Demand) ≈ 0.8132`
   also pinned `D_t ≈ T̄_t` by construction, so the demand constraint sat nearly tight at
   every terminal on every scenario and the reported shortfall meant nothing.

At `H = 8` hours, from the bundled CSV:

| Scenario slice | `D_T1` | `D_T2` | `D_T3` | `D_T4` | Capability `T̄_t` |
|---|---|---|---|---|---|
| Average day | 33.96 | 36.60 | 34.96 | 35.57 | 64.57 / 65.91 / 64.61 / 65.04 |
| 95th-percentile day | 70.06 | 72.16 | 74.00 | 72.21 | same |

Daily tonnage behind those: mean 271.65 / 292.83 / 279.71 / 284.53; p95 560.49 / 577.29 /
592.02 / 577.71; at roughly 3.5 shipments per terminal per day.

**This is the scenario story worth presenting.** On an average day every terminal carries
about 45% headroom and unmet demand is zero. On a busy day demand runs 8–14% past capability
and the slack variables switch on. Peak-day scenarios are where the LP earns its keep, and
terminal arrival rates now reach the model instead of being averaged away.

#### The remaining parameters

| Parameter | Derivation |
|---|---|
| `H` | Planning horizon in hours. Config, default 8, shown in the parameters panel |
| `W`, `E` | Σ of per-terminal baseline means — 108.21 workers, 29.63 equipment units — so the baseline is always feasible. UI slider 80–120% |
| `Cap_t` | 95th percentile of observed `Throughput_Rate` per terminal (the max is noisy), **raised to the terminal's own modelled baseline throughput where the two collide**. The percentile is computed on observed rows while the baseline runs through the congested production function, so on a lopsided slice the ceiling can otherwise fall below the baseline and make the observed allocation infeasible |
| `w_t^min/max`, `e_t^min/max` | 5th / 95th percentile of observed values per terminal. Equipment bounds are floored/ceiled to integers, since CBC will tighten a fractional bound on an integer variable anyway |
| `ρ` | 1.5 workers per equipment unit. Stated operational assumption |
| `M` | `10 ×` the largest coefficient of the active objective — a large number chosen to dominate. See the warning below |
| `demand_scale` | User stress multiplier on `D_t`, default 1.0, up to 5.0. A scenario control, not a derived parameter |
| Baseline | `w̄_t`, `ē_t` evaluated in the same objective |

### 3.5 Outputs, and one health warning

Per solve: solver status, objective value, baseline vs optimized allocation side by side,
per-terminal grouped bar chart, unmet demand per terminal, binding constraints with shadow
prices, and an objective-vs-`W` sensitivity curve (±20%).

**Shadow prices carry a health warning, and this is the single most important caveat in the
project** — because "how much would one more worker give us?" is the headline research
question, and the dual is the answer.

When a demand constraint binds with `s_t > 0`, the dual on the resource-pool constraints is
driven by `M·α_t` rather than by marginal throughput, and the dual on `demand_t` pins to
exactly `M`. At `M = 10 ×` the largest coefficient, the reported "shadow price of a worker"
overstates true marginal throughput by roughly an order of magnitude.

Two requirements follow:

1. Duals are reported with a **penalty-inflated flag** whenever `Σ s_t > 0`.
2. Clean duals come from a **second solve** with `s_t` fixed at zero where demand is met.

The penalty-dominance note in `comparison.py` covers the *objective delta* only and must not
be described as covering the duals.

A dimensional wrinkle in `M` worth knowing: in the `min_cost` branch the scale is
`max(c^w, c^e)`, a cost per resource unit, but `M` multiplies `s_t`, which is in throughput
units. So `unmet_penalty` as reported is not a currency figure and must never be quoted as
money.

---

## 4. Part 2 — IP: shipment selection

A **0-1 multi-dimensional knapsack**: one window, three simultaneous resource dimensions.
(With constraint (2) indexed per terminal it is also a *multiple* knapsack over four bins.
"Multi-knapsack" alone means several bins and is the wrong name for the single-bin form.)

### 4.1 Scenario framing

The user builds a batch from filters plus a size limit (default 50, max 500) — for example
"all Terminal T2 arrivals on 2024-03-22". The batch is the item set; the window is `H`.

### 4.2 Decision variable

`x_i ∈ {0, 1}` — process shipment `i` in this window, or do not. No partial processing.

### 4.3 Objective

```latex
\max \; Z = \sum_i v_i x_i
\qquad\text{where}\qquad
v_i = p_i \cdot \left[\, 1 + U \cdot
\frac{\lambda_w\,\widehat{\text{wait}}_i + \lambda_q\,\widehat{\text{queue}}_i}
     {\lambda_w + \lambda_q} \,\right]
```

- `p_i` — priority weight: Critical 10, High 5, Medium 2, Low 1 (UI-adjustable).
- `wait`, `queue` — min-max normalised to [0,1] **within the batch**.
- `λ_w, λ_q ∈ [0,1]` — set the *balance between* the two urgency signals.
- `U = 0.9` — caps the multiplier at `[1, 1.9]` for any λ.

**Why the uplift is capped, and this is a real bug that was found and fixed.** The tightest
adjacent priority ratio is Critical:High = 2. Under the uncapped form `1 + λ_w·ŵ + λ_q·q̂`
the multiplier spanned `[1, 1+λ_w+λ_q]`, so at the shipped default of `λ = 0.5` each, a
maximally-urgent High scored `5 × 2 = 10.0` against a non-urgent Critical's `10 × 1 = 10.0`
— an exact tie, broken arbitrarily by CBC's branching order. Any λ above 0.5 made it a
strict inversion, and Low-over-Medium tied at the same point. The model was not enforcing
the priority ordering it is built around. Nothing clamped λ either.

Capping the uplift below the tightest ratio means urgency orders shipments **within** a
priority class and can never lift one class above the class above it.

**Priority is lexicographic. Urgency is a tiebreaker.** That is the design intent, and it
should be stated in one sentence rather than left to be discovered.

### 4.4 Constraints

```latex
\begin{aligned}
\sum_i \text{Vol}_i\, x_i &\le V_{\text{cap}}
  &&\text{(1) storage / volume}\\[2pt]
\sum_{i \,\in\, \text{terminal } t} \bigl(\text{Handling}_i \times \text{Workers}_i\bigr) x_i
  &\le w_t^{*}\, H \cdot 60 &&\forall t \quad\text{(2) worker-minutes, \textbf{from Part 1}}\\[2pt]
\sum_i \bigl(\text{Handling}_i \times \text{Equip}_i\bigr) x_i &\le E_{\text{cap}}
  &&\text{(3) equipment-minutes}\\[2pt]
x_i &\in \{0,1\} &&\text{(4)}
\end{aligned}
```

Optional policy constraints (UI toggles): force all Critical in; cap the Hazardous count;
require a minimum number of Perishables.

**(2) is where Part 2 consumes Part 1, and it is the most valuable single idea in the
project.** Both models draw on the same workforce. The earlier form set the worker-minute
cap to a fraction of the batch's *own observed consumption* — self-referential — and charged
a batch spanning four terminals against one undifferentiated pool. Part 1 could staff T1
with 15 workers while Part 2 accepted a T1 shipment needing 45, and nothing noticed.

Indexing by terminal and taking the right-hand side from the solved `w_t*` turns two
parallel exercises into a genuine two-stage model: **allocate, then select under the
allocation you chose.** That is a considerably stronger thing to present than two models
side by side. The API accepts an optional LP result so Part 2 can still be solved standalone
for testing.

**(3) charges machine-minutes, not machines.** Equipment is reusable: a forklift serving
shipment A and then shipment B was being charged twice, and `E_cap` was set to a fraction of
that double-counted total — about 355 "slots" summed across a 50-shipment batch, capped to
roughly 213, against a real terminal fleet of about 30 units. Two numbers describing
different universes. Machine-minutes genuinely are consumable, so the constraint becomes
honest and stays linear, mirroring (2)'s treatment of labour.

Modelling peak concurrency instead would need shipment overlap in time and a multi-period
formulation, which is out of scope (§7).

**Capacities.** `V_cap` and `E_cap` default to a fraction `f` (slider, default 0.6) of batch
totals, which keeps the problem binding but feasible. Constraint (2)'s right-hand side comes
from Part 1 and does not use `f`. Forced-Critical runs get a feasibility pre-check: if
Critical volumes alone exceed a cap, the API returns a warning and a suggestion rather than
an Infeasible status.

### 4.5 An IP has no shadow prices

Part 2 reports binding capacities and re-solve curves, never duals. An integer program's
value function is a non-convex step function, and LP-relaxation duals are not valid marginal
values because of the integrality gap. Sensitivity for Part 2 means **parametric re-solve**:
plot the optimal objective against `V_cap`, `E_cap` and the worker-minute budget over a
range. That is the correct tool and it makes a better visual anyway.

---

## 5. Baselines and honest comparison

Non-negotiable, and the thing most likely to be probed.

| | Baseline |
|---|---|
| Part 1 | The **observed allocation** — per-terminal mean `w̄_t`, `ē_t` — scored through the **same objective function** with the **same resource totals** |
| Part 2 | **Two of them.** **FCFS**: accept shipments in `Timestamp` order until any capacity is exhausted. **Best greedy**: the strongest of four value-density rankings (plain value, and value per unit of each of the three resources), each skipping past what will not fit. Both under identical capacities and the identical value function |

**Rules:**

- The baseline is evaluated with the same objective at the observed allocation — **never**
  against raw observed KPIs. Both go through one scoring function
  (`evaluate_allocation`), and a test asserts it.
- **Part 2 reports both baselines, and leads with the harder one.** FCFS answers "what does
  the dispatcher do today?"; the greedy rule answers "what does the optimizer buy over an
  obvious sensible policy?". Quoting only FCFS inflates the optimizer by two orders of
  magnitude on this data, which is the same offence as quoting a penalty-driven objective
  delta.
- **A min-cost saving that comes with a fall in throughput is labelled as one.** Minimising
  cost only requires demand to be met, and demand sits well below observed capability here,
  so the cheapest plan stops at the demand line and cost falls roughly in proportion with
  output. `comparison.SERVICE_LEVEL_DROP_THRESHOLD` triggers the disclosure.
- Same resource totals by default. Runs with raised pools are flagged
  `expanded_resources: true` and labelled in the UI.
- Report absolute and percentage deltas, binding constraints, shadow prices, capacity
  utilisation and unmet demand.
- **Penalty-dominance disclosure.** When at or above half the objective delta comes from the
  slack penalty rather than from throughput or cost, the response says so and points at the
  operational rows. On the default scenario the objective improves 120% while throughput
  improves 0.3%; quoting the 120% unqualified would be exactly the inflated claim this rule
  forbids.
- **Infeasible baselines are named, not guessed at.** If the observed allocation falls
  outside a run's constraints, the response states which constraint it breaks and warns that
  the optimized value can legitimately look worse.
- A persistent caveat banner: parameters are assumptions over synthetic data; gains are
  model-world, not validated operational gains.

**The dataset cannot supply a baseline.** `Allocation_Strategy` (Baseline / Adaptive /
Optimized) predicts no outcome: Baseline vs Optimized throughput is 65.484 vs 65.619, Welch
t = −0.122, **p = 0.903**, Cohen d = 0.004, every η² < 0.001. There is no processed flag, no
service-start time, no queue-exit record. So the baselines above are ones **we implement and
document ourselves** — which is defensible and entirely within our control. Do not compare
against `Allocation_Strategy`; the comparison would read +0.21% at p = 0.90.

---

## 6. Sensitivity analysis

| Scenario | Vary | Watch |
|---|---|---|
| Resource pool | `W`, `E` at 80–120% | Allocation shift, shadow prices, which constraint binds |
| Demand | `demand_scale` 1.0–5.0, and average-day vs p95-day slices | Unmet demand, when slack switches on |
| Labour share | `θ` 0.1–0.9 | How far the allocation moves on the one free assumption |
| Congestion | `apply_congestion` on/off, `δ` 0–4 | The degenerate model the multiplier prevents |
| Capacity (Part 2) | `V_cap`, `E_cap`, worker-minutes | Parametric re-solve curves, priority mix of the accepted set |
| Priority weights, λ (Part 2) | `p_i`, `λ_w`, `λ_q` | Which shipments change status |

**Report the honest magnitude, and report it against the right baseline.** Measured on the
bundled CSV at base parameters:

| Comparison | Gap |
|---|---|
| LP vs the observed allocation | +1.01% throughput |
| LP vs a naive equal split | +0.96% throughput |
| IP vs the **best greedy** rule | +2.3% value, 20% different set |
| IP vs FCFS | +106% value, 62% different set |

Part 2's figures are the standalone default batch (50 shipments, `f` = 0.6, seed 42). Both
gaps move with the scenario — under a min-cost Part 1 allocation the same batch gives +0.9%
over greedy and +589% over FCFS — which is itself the point: quote the range and the
baseline, never a single number with neither.

Say these yourself, and lead Part 2 with the greedy figure. The +106% over FCFS is real but
flattering: arrival order carries no information about value at all, so beating it is not
evidence that the optimizer is worth running. The +2.3% over a value-density greedy rule is
the number an examiner is actually asking for, and `baseline.greedy_baseline` reports every
rule it tried so "best greedy" can be checked rather than taken on trust. The value of the
optimizer here is guaranteed optimality and the shadow prices, not a large headline gap —
and being asked "your optimizer beat equal-split by half a percent?" is much worse than
saying it first.

**Also report that the allocation is driven by assumed parameters.** Across a 36-scenario
sweep of `W` × `E` × `Cap` × `M`, T1's workforce share ranges 4.6–54.5% and T4's equipment
share 2.4–82.4%. Lead the sensitivity section with that range, not with a single allocation
vector.

---

## 7. Assumptions register

Every assumption in one place. An examiner asking "where did that number come from?" should
find the answer here.

| Symbol | Value | Status | Justification |
|---|---|---|---|
| `θ` | 0.6 | **Assumed** | Labour share of throughput. Free parameter, UI-exposed, primary sensitivity axis |
| `θ_c` | 0.6 | **Assumed** | Labour share of operational cost |
| `α_t`, `β_t` | see §3.4 | **Declared**, anchored to terminal means | Not estimated. Regression gives R² = 0.0001 |
| `γ_t`, `δ` | δ = 1 | **Assumed** functional form, data-grounded inputs | Bottleneck rate and facility utilisation genuinely vary |
| `H` | 8 h | **Assumed** | Planning window. Converts demand level to rate |
| `W`, `E` | 108.21, 29.63 | **Derived** | Σ of per-terminal observed means |
| `D_t` | see §3.4 | **Derived** | Σ per terminal ÷ `H` |
| `Cap_t` | p95 of terminal throughput, floored at baseline | **Derived** + guard | Max is noisy; guard keeps the baseline feasible |
| bounds | p5 / p95 per terminal | **Derived** | Terminals can be neither abandoned nor over-stuffed |
| `ρ` | 1.5 | **Assumed** | Operators per equipment unit. Observed ratio ≈3.6 clears it |
| `M` | 10 × largest active coefficient | **Assumed** | Chosen to dominate. Not a currency figure |
| `p_i` | 10 / 5 / 2 / 1 | **Assumed** | Priority weights, UI-adjustable |
| `λ_w`, `λ_q` | 0.5, 0.5 | **Assumed** | Balance between urgency signals |
| `U` | 0.9 | **Derived** from the priority weights | Must stay below the tightest adjacent ratio (2) |
| `f` | 0.6 | **Assumed** | Capacity fraction; keeps the knapsack binding but feasible |

**Out of scope, deliberately:** forecasting or ML (`Demand_Forecast` is used as given);
stochastic or robust optimization; queueing theory and simulation; multi-period or dynamic
allocation; gate assignment and flight-delay modelling (those columns appear in EDA only).

---

## 8. What an examiner will ask

The honest answer to each, in one or two sentences.

**"Where do α and β come from?"** A stated labour-share split of observed mean throughput.
They are a declared production assumption, not estimated coefficients — regression on this
data gives R² = 0.0001, which we report rather than hide.

**"Why θ = 0.6?"** It is the one free assumption in the derivation. No value fits better
than another on this data, so we expose it as a slider and make it the primary axis of the
sensitivity analysis.

**"Your terminals look identical. What is the LP actually choosing between?"** Very little,
on the raw means — the α spread is 2.1% and not statistically distinguishable from zero.
That is why the congestion multiplier exists: bottleneck rate and facility utilisation do
differ, and γ_t turns that into real differentiation. The UI can switch it off to show the
degenerate model underneath.

**"What is a shadow price, and what is yours?"** The improvement in the objective from
relaxing a binding constraint by one unit. Ours are read from the LP relaxation with demand
met. When a scenario leaves demand unmet, the reported dual is inflated by the penalty rate
rather than being marginal throughput, and we label it as such rather than quoting it.

**"Can you have 26.4 workers?"** For workers, yes — it is a staffing level over a shift.
Not for machines, which is why equipment is an integer variable.

**"Doesn't making it integer cost you the shadow prices?"** No. We solve twice: the
relaxation gives the duals and the sensitivity ranges, the MILP gives the allocation we
report, and we say which is which.

**"Is demand for the cargo or for the terminal?"** For the terminal — it is the handling
workload arriving there. `Demand_Forecast` is a per-shipment tonnage, summed per terminal
and divided by the horizon to become a rate.

**"Why is your improvement so small?"** Because the terminals are near-identical in
synthetic data, so there is little to reallocate. The optimizer's value here is guaranteed
optimality, the shadow prices and the sensitivity structure — not a large headline gain. We
report +0.96% over equal split and +1.01% over the observed allocation rather than dressing
it up.

**"Why an optimizer instead of a greedy rule for Part 2?"** The IP beats the best of four
value-density greedy rules by 2.3% and selects a 20% different set — plus it gives a provable
optimum and a capacity-utilisation story a heuristic cannot. We report that gap rather than
the +106% over FCFS, because arrival order is a queue discipline, not a heuristic, and
beating it proves nothing.

**"Is this a multi-knapsack?"** A 0-1 **multi-dimensional** knapsack — one window, three
resource dimensions. With the worker-minute constraint indexed per terminal it is also a
multiple knapsack over four bins.

---

## 9. Where this is implemented

| Formulation section | Code |
|---|---|
| §3.4 parameter derivation | `backend/core/preprocessing.py` — `estimate_lp_params`, `terminal_summary`, `_congestion_multipliers` |
| §3.1–3.3 LP | `backend/models/lp_resource_allocation.py` — `problem_from_parameters`, `solve_allocation` |
| §4 IP | `backend/models/ip_shipment_selection.py` — `problem_from_batch`, `solve_selection`; the data layer is `build_batch` / `default_capacities` in `preprocessing.py` |
| §5 baselines | `backend/core/baseline.py` — `observed_allocation_baseline` (LP), `fcfs_baseline` and `greedy_baseline` (IP); deltas and disclosures in `comparison.py` |
| §6 sensitivity | `POST /api/lp/sensitivity`; Part 2 curves not yet written |
| §7 assumptions | `backend/core/config.py` |

Gaps between this file and the code are tracked in [AGENT.md](AGENT.md) §Open defects.
