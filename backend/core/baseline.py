"""Baselines: what the terminals actually did, scored the way the model scores.

The honest-comparison invariant (AGENT.md) says a baseline must be evaluated
with the *same* objective function as the optimised solution — never against raw
observed KPIs. That is enforced here structurally: the baseline allocation is
pushed through `lp_resource_allocation.evaluate_allocation`, the identical
function the solver's own output is scored with.
"""

from __future__ import annotations

from dataclasses import dataclass

from backend.core.preprocessing import LPParameters
from backend.models.lp_resource_allocation import (
    AllocationEvaluation,
    AllocationProblem,
    evaluate_allocation,
)


@dataclass
class BaselineResult:
    """The observed mean allocation, scored under the active objective."""

    evaluation: AllocationEvaluation
    feasible: bool
    notes: list[str]


def observed_allocation_baseline(
    problem: AllocationProblem, params: LPParameters
) -> BaselineResult:
    """Score the observed per-terminal mean allocation.

    By construction of the closed-form parameter method, this allocation
    reproduces observed mean throughput exactly (in aggregate once congestion is
    applied), so it is the natural "what we do today" reference point.
    """
    workforce = {t: params.baseline_workforce[t] for t in problem.terminals}
    equipment = {t: params.baseline_equipment[t] for t in problem.terminals}

    evaluation = evaluate_allocation(problem, workforce, equipment)
    feasible = evaluation.feasible_against(problem)

    notes: list[str] = []
    if not feasible:
        notes.append(
            "The observed allocation is outside the constraints of this scenario "
            f"({_infeasibility_reason(problem, evaluation)}). The comparison "
            "still uses the same objective function, but it now contrasts an "
            "optimised plan against a reference the constraints rule out, so the "
            "optimised value can legitimately look worse than the baseline."
        )
    return BaselineResult(evaluation=evaluation, feasible=feasible, notes=notes)


def _infeasibility_reason(
    problem: AllocationProblem, evaluation: AllocationEvaluation
) -> str:
    """Name the constraint the observed allocation actually breaks.

    A generic "the pools were probably lowered" message misleads whenever the
    real cause is the budget cap, which is exactly the case a reader is most
    likely to question.
    """
    tol = 1e-6
    reasons: list[str] = []

    if evaluation.total_workforce > problem.workforce_total + tol:
        reasons.append(
            f"it uses {evaluation.total_workforce:.1f} workers against a pool of "
            f"{problem.workforce_total:.1f}"
        )
    if evaluation.total_equipment > problem.equipment_total + tol:
        reasons.append(
            f"it uses {evaluation.total_equipment:.1f} equipment units against a "
            f"pool of {problem.equipment_total:.1f}"
        )
    if problem.budget is not None and evaluation.total_cost > problem.budget + tol:
        reasons.append(
            f"it costs {evaluation.total_cost:,.0f} against a budget cap of "
            f"{problem.budget:,.0f}"
        )
    over_capacity = [
        t for t in problem.terminals
        if evaluation.throughput[t] > problem.capacity[t] + tol
    ]
    if over_capacity:
        reasons.append(
            f"it exceeds the capacity ceiling at {', '.join(over_capacity)}"
        )

    return "; ".join(reasons) if reasons else "it violates a per-terminal bound"


def resources_were_expanded(
    problem: AllocationProblem, params: LPParameters, tolerance: float = 1e-6
) -> bool:
    """True when the user solved with a larger pool than the terminals observed.

    Such runs are flagged in the API response and labelled in the UI: a gain paid
    for with extra resources is not the same claim as a gain from re-allocating
    the resources already in hand.
    """
    return (
        problem.workforce_total > params.workforce_total + tolerance
        or problem.equipment_total > params.equipment_total + tolerance
    )
