"""Part 2 - the shipment-selection integer programme.  Modelling only.

Question: when capacity cannot clear everything, which shipments do we process
in this window?  A 0-1 knapsack with several resource limits.

DECISION VARIABLE   (for every shipment i in the batch)
    x_i in {0, 1}       1 = process shipment i now, 0 = leave it for later

OBJECTIVE
    max   sum_i v_i x_i                        total priority value processed

CONSTRAINTS
    (1) sum_i Vol_i x_i                     <= V_cap         storage volume
    (2) sum_{i at terminal t} wm_i x_i      <= w_t* H 60     worker-minutes, per terminal
                                                              (w_t* comes from Part 1)
    (3) sum_i em_i x_i                      <= E_cap         equipment-minutes
    (4) x_i in {0, 1}                                        a shipment is not split

    optional policy rules
    (+) x_i = 1 for every Critical shipment                  "force Critical"
    (+) sum_{i Hazardous}  x_i <= max_hazardous              Hazardous cap
    (+) sum_{i Perishable} x_i >= min_perishable             Perishable floor

wm_i and em_i are handling time x workers / equipment, i.e. *minutes* of a
resource that is shared by every shipment.  An integer programme has no shadow
prices, so none are produced here.
"""

from __future__ import annotations

from typing import NamedTuple

import pulp

from or_models.inputs import (
    FORCED_PRIORITY,
    HAZARDOUS_CARGO_TYPE,
    PERISHABLE_CARGO_TYPE,
    SelectionProblem,
)


class IPModel(NamedTuple):
    prob: pulp.LpProblem
    x: dict[str, pulp.LpVariable]      # record_id -> its 0/1 variable


def build_ip(problem: SelectionProblem) -> IPModel:
    """Write the model down."""
    items, caps, policy = problem.items, problem.capacities, problem.policy
    prob = pulp.LpProblem("air_cargo_shipment_selection", pulp.LpMaximize)

    # ---- Decision variable (4): one binary per shipment ------------------------
    x = {i.record_id: pulp.LpVariable(f"x_{i.record_id}", cat=pulp.LpBinary) for i in items}

    # ---- Objective --------------------------------------------------------------
    prob += pulp.lpSum(i.value * x[i.record_id] for i in items), "objective"

    # ---- Capacity constraints ---------------------------------------------------
    prob += pulp.lpSum(i.volume * x[i.record_id] for i in items) <= caps.volume, "volume"  # (1)

    for t in problem.terminals:                                                   # (2)
        budget = problem.worker_budget(t)
        if budget is not None:
            prob += pulp.lpSum(
                i.worker_minutes * x[i.record_id] for i in items if i.terminal == t
            ) <= budget, f"worker_minutes_{t}"

    prob += pulp.lpSum(
        i.equipment_minutes * x[i.record_id] for i in items
    ) <= caps.equipment_minutes, "equipment_minutes"                              # (3)

    # ---- Optional policy rules --------------------------------------------------
    if policy.force_critical:
        for i in items:
            if i.priority == FORCED_PRIORITY:
                prob += x[i.record_id] == 1, f"force_critical_{i.record_id}"

    if policy.max_hazardous is not None:
        prob += pulp.lpSum(
            x[i.record_id] for i in items if i.cargo_type == HAZARDOUS_CARGO_TYPE
        ) <= policy.max_hazardous, "hazardous_cap"

    if policy.min_perishable is not None:
        prob += pulp.lpSum(
            x[i.record_id] for i in items if i.cargo_type == PERISHABLE_CARGO_TYPE
        ) >= policy.min_perishable, "perishable_floor"

    return IPModel(prob, x)


def solve_ip(model: IPModel, time_limit: int | None = None) -> str:
    """Run CBC and return PuLP's status text."""
    model.prob.solve(pulp.PULP_CBC_CMD(msg=False, timeLimit=time_limit))
    return pulp.LpStatus[model.prob.status]


def read_ip(model: IPModel) -> list[str]:
    """Record ids of the accepted shipments.  Call only if Optimal."""
    return [rid for rid, var in model.x.items() if (var.value() or 0.0) > 0.5]
