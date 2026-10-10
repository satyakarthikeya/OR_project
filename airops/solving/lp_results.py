"""Part 1 - result containers, and the one function that scores an allocation.

Both the optimised allocation and the baseline are scored by `evaluate_allocation`,
so the comparison between them is honest by construction: there is a single
scoring path (AGENT.md, "Honest-comparison invariant").
"""

from __future__ import annotations

from dataclasses import dataclass, field

from airops.core import config
from or_models.inputs import AllocationProblem, Objective

OBJECTIVE_LABELS: dict[str, str] = {
    "max_throughput": "Maximise throughput",
    "min_cost": "Minimise operational cost subject to demand",
}


@dataclass
class ConstraintDual:
    """One constraint's post-solve diagnostics."""

    name: str
    kind: str
    terminal: str | None
    sense: str
    rhs: float
    lhs: float
    slack: float
    shadow_price: float
    binding: bool
    interpretation: str


@dataclass
class AllocationEvaluation:
    """An allocation scored through the model's own objective function.

    Both the optimised and the baseline allocation are scored here, which is how
    the honest-comparison invariant is enforced structurally rather than by
    convention: there is only one scoring path.
    """

    workforce: dict[str, float]
    equipment: dict[str, float]
    throughput: dict[str, float]
    cost: dict[str, float]
    unmet_demand: dict[str, float]
    total_workforce: float
    total_equipment: float
    total_throughput: float
    total_cost: float
    total_unmet_demand: float
    objective_value: float
    penalty_applied: float

    def feasible_against(self, problem: AllocationProblem) -> bool:
        tol = config.BINDING_ABS_TOL
        if self.total_workforce > problem.workforce_total + tol:
            return False
        if self.total_equipment > problem.equipment_total + tol:
            return False
        for t in problem.terminals:
            wlo, whi = problem.workforce_bounds[t]
            elo, ehi = problem.equipment_bounds[t]
            if not wlo - tol <= self.workforce[t] <= whi + tol:
                return False
            if not elo - tol <= self.equipment[t] <= ehi + tol:
                return False
            if self.throughput[t] > problem.capacity[t] + tol:
                return False
            if self.workforce[t] < problem.staffing_ratio * self.equipment[t] - tol:
                return False
        if problem.budget is not None and self.total_cost > problem.budget + tol:
            return False
        return True


@dataclass
class AllocationResult:
    status: str
    objective: Objective
    objective_label: str
    message: str = ""
    suggestions: list[str] = field(default_factory=list)
    solution: AllocationEvaluation | None = None
    duals: list[ConstraintDual] = field(default_factory=list)
    solve_seconds: float = 0.0
    #: Which solve the reported allocation came from. Always the MILP.
    allocation_source: str = "milp"
    #: Which solve the duals came from: "relaxation" when demand was met
    #: everywhere, "relaxation_demand_met" when the penalty had to be stripped
    #: out first, "none" when no usable relaxation was available.
    duals_source: str = "relaxation"
    #: True when the *raw* relaxation left demand unmet, so its duals were
    #: driven by the penalty rate M rather than by marginal throughput.
    duals_penalty_inflated: bool = False
    duals_note: str = ""
    warnings: list[str] = field(default_factory=list)

    @property
    def solved(self) -> bool:
        return self.status == "Optimal" and self.solution is not None


# --- Evaluation --------------------------------------------------------------


def evaluate_allocation(
    problem: AllocationProblem,
    workforce: dict[str, float],
    equipment: dict[str, float],
) -> AllocationEvaluation:
    """Score any allocation with the objective the problem was posed under."""
    throughput = {
        t: problem.alpha[t] * workforce[t] + problem.beta[t] * equipment[t]
        for t in problem.terminals
    }
    cost = {
        t: problem.cost_worker[t] * workforce[t]
        + problem.cost_equipment[t] * equipment[t]
        for t in problem.terminals
    }
    unmet = {
        t: max(0.0, problem.demand[t] - throughput[t]) for t in problem.terminals
    }

    total_throughput = sum(throughput.values())
    total_cost = sum(cost.values())
    total_unmet = sum(unmet.values())
    penalty = problem.unmet_penalty * total_unmet

    if problem.objective == "max_throughput":
        objective_value = total_throughput - penalty
    else:
        objective_value = total_cost + penalty

    return AllocationEvaluation(
        workforce=dict(workforce),
        equipment=dict(equipment),
        throughput=throughput,
        cost=cost,
        unmet_demand=unmet,
        total_workforce=sum(workforce.values()),
        total_equipment=sum(equipment.values()),
        total_throughput=total_throughput,
        total_cost=total_cost,
        total_unmet_demand=total_unmet,
        objective_value=objective_value,
        penalty_applied=penalty,
    )
