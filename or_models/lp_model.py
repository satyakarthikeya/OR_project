"""Part 1 - the allocation LP.  Modelling only.

Question: how many workers (w) and equipment units (e) should each terminal t
get, so that throughput is as high (or cost as low) as possible?

DECISION VARIABLES   (for every terminal t)
    w_t >= 0            workers          continuous  (26.4 = a shift split across terminals)
    e_t >= 0, integer   equipment units  whole machines
    s_t >= 0            unmet demand     "slack" that keeps the model feasible

OBJECTIVE   (the user picks one)
    max   sum_t ( alpha_t w_t + beta_t e_t )   - M sum_t s_t       throughput
    min   sum_t ( cw_t w_t    + ce_t e_t )     + M sum_t s_t       cost

CONSTRAINTS
    (1) sum_t w_t <= W                              worker pool
    (2) sum_t e_t <= E                              equipment pool
    (3) alpha_t w_t + beta_t e_t + s_t >= D_t       demand (soft - shortfall is s_t)
    (4) alpha_t w_t + beta_t e_t <= Cap_t           terminal ceiling
    (5) w_t >= rho * e_t                            every machine needs operators
    (6) w_min <= w_t <= w_max,  e_min <= e_t <= e_max
    (7) w_t, s_t >= 0 ;  e_t >= 0 and integer
    (+) sum_t ( cw_t w_t + ce_t e_t ) <= B          optional budget cap

Because e_t is an integer this is a MILP.  Shadow prices are only meaningful
for a continuous LP, so the runner builds the same model a second time with
`integer_equipment=False` and reads the duals from that one.
"""

from __future__ import annotations

from typing import NamedTuple

import pulp

from or_models.inputs import AllocationProblem


class ConstraintLabel(NamedTuple):
    """What a named constraint is - used later to explain its shadow price."""

    name: str
    kind: str              # resource_pool / demand / capacity / staffing / budget
    terminal: str | None
    sense: str             # "<=" or ">="
    rhs: float


class LPModel(NamedTuple):
    """The built model together with handles on its variables."""

    prob: pulp.LpProblem
    workers: dict[str, pulp.LpVariable]
    equipment: dict[str, pulp.LpVariable]
    unmet: dict[str, pulp.LpVariable]
    labels: list[ConstraintLabel]


def build_lp(
    problem: AllocationProblem,
    integer_equipment: bool = True,
    drop_demand_for: set[str] | frozenset[str] = frozenset(),
) -> LPModel:
    """Write the model down.

    integer_equipment  False builds the continuous relaxation (for shadow prices).
    drop_demand_for    terminals whose demand constraint (3) - and slack s_t - are
                       left out; used to take the penalty M out of the duals.
    """
    T = problem.terminals
    maximise = problem.objective == "max_throughput"
    prob = pulp.LpProblem(
        "air_cargo_allocation", pulp.LpMaximize if maximise else pulp.LpMinimize
    )

    # ---- Decision variables, with the bounds of constraint (6) ----------------
    w = {t: pulp.LpVariable(f"workers_{t}", *problem.workforce_bounds[t]) for t in T}
    e = {
        t: pulp.LpVariable(
            f"equipment_{t}", *problem.equipment_bounds[t],
            cat=pulp.LpInteger if integer_equipment else pulp.LpContinuous,
        )
        for t in T
    }
    s = {t: pulp.LpVariable(f"unmet_{t}", lowBound=0) for t in T if t not in drop_demand_for}

    # ---- Expressions used more than once --------------------------------------
    throughput = {t: problem.alpha[t] * w[t] + problem.beta[t] * e[t] for t in T}
    cost = {
        t: problem.cost_worker[t] * w[t] + problem.cost_equipment[t] * e[t] for t in T
    }
    penalty = problem.unmet_penalty * pulp.lpSum(s.values())     # M * sum s_t

    # ---- Objective ------------------------------------------------------------
    if maximise:
        prob += pulp.lpSum(throughput.values()) - penalty, "objective"
    else:
        prob += pulp.lpSum(cost.values()) + penalty, "objective"

    # ---- Constraints ----------------------------------------------------------
    labels: list[ConstraintLabel] = []

    prob += pulp.lpSum(w.values()) <= problem.workforce_total, "worker_pool"        # (1)
    labels.append(ConstraintLabel(
        "worker_pool", "resource_pool", None, "<=", problem.workforce_total))

    prob += pulp.lpSum(e.values()) <= problem.equipment_total, "equipment_pool"     # (2)
    labels.append(ConstraintLabel(
        "equipment_pool", "resource_pool", None, "<=", problem.equipment_total))

    for t in T:
        if t not in drop_demand_for:
            prob += throughput[t] + s[t] >= problem.demand[t], f"demand_{t}"      # (3)
            labels.append(ConstraintLabel(
                f"demand_{t}", "demand", t, ">=", problem.demand[t]))

        prob += throughput[t] <= problem.capacity[t], f"capacity_{t}"             # (4)
        labels.append(ConstraintLabel(
            f"capacity_{t}", "capacity", t, "<=", problem.capacity[t]))

        prob += w[t] >= problem.staffing_ratio * e[t], f"staffing_{t}"            # (5)
        labels.append(ConstraintLabel(f"staffing_{t}", "staffing", t, ">=", 0.0))

    if problem.budget is not None:                                                 # (+)
        prob += pulp.lpSum(cost.values()) <= problem.budget, "budget"
        labels.append(ConstraintLabel("budget", "budget", None, "<=", problem.budget))

    return LPModel(prob, w, e, s, labels)


def solve_lp(model: LPModel, time_limit: int | None = None) -> str:
    """Run CBC and return PuLP's status text ('Optimal', 'Infeasible', ...)."""
    model.prob.solve(pulp.PULP_CBC_CMD(msg=False, timeLimit=time_limit))
    return pulp.LpStatus[model.prob.status]


def read_lp(model: LPModel) -> tuple[dict[str, float], dict[str, float]]:
    """Return ({terminal: workers}, {terminal: equipment}).  Call only if Optimal."""
    workers = {t: float(v.value() or 0.0) for t, v in model.workers.items()}
    equipment = {t: float(v.value() or 0.0) for t, v in model.equipment.items()}
    return workers, equipment
