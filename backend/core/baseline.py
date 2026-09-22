"""Baselines: what the terminals actually did, scored the way the model scores.

The honest-comparison invariant (AGENT.md) says a baseline must be evaluated
with the *same* objective function as the optimised solution — never against raw
observed KPIs. That is enforced here structurally: the baseline allocation is
pushed through `lp_resource_allocation.evaluate_allocation`, the identical
function the solver's own output is scored with.
"""

from __future__ import annotations

from dataclasses import dataclass

from backend.core import config
from backend.core.preprocessing import LPParameters
from backend.models.ip_shipment_selection import (
    SelectionEvaluation,
    SelectionProblem,
    evaluate_selection,
)
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


# --- Part 2: first-come, first-served ---------------------------------------


@dataclass
class FCFSResult:
    """The arrival-order baseline, scored under the IP's own value function."""

    evaluation: SelectionEvaluation
    #: The shipment that stopped the queue, if the window filled before the
    #: batch ran out. Naming it is what makes the baseline auditable.
    blocked_on: str | None
    blocked_by: str | None
    notes: list[str]


def fcfs_baseline(problem: SelectionProblem) -> FCFSResult:
    """Accept shipments in `Timestamp` order until a capacity is exhausted.

    This is the status quo Part 2 is measured against: a dispatcher working the
    queue in arrival order, with no view of what is coming next. It stops at the
    first shipment that will not fit rather than skipping ahead to a smaller
    one — skipping is already an optimisation, and a baseline that optimises is
    not a baseline.

    It is scored through `evaluate_selection`, the same function the IP's own
    answer goes through, against the identical capacities and the identical
    value function. That is the honest-comparison invariant enforced
    structurally rather than by convention (MODEL.md section 5).
    """
    queue = sorted(problem.items, key=lambda i: (i.timestamp, i.record_id))

    caps = problem.capacities
    volume = 0.0
    equipment = 0.0
    worker: dict[str, float] = {}
    accepted: list[str] = []
    blocked_on: str | None = None
    blocked_by: str | None = None

    for item in queue:
        budget = problem.worker_budget(item.terminal)
        used = worker.get(item.terminal, 0.0)

        if volume + item.volume > caps.volume + config.EPSILON:
            blocked_on, blocked_by = item.record_id, "volume"
        elif (
            equipment + item.equipment_minutes
            > caps.equipment_minutes + config.EPSILON
        ):
            blocked_on, blocked_by = item.record_id, "equipment_minutes"
        elif budget is not None and used + item.worker_minutes > budget + config.EPSILON:
            blocked_on = item.record_id
            blocked_by = f"worker_minutes_{item.terminal}"

        if blocked_on is not None:
            break

        accepted.append(item.record_id)
        volume += item.volume
        equipment += item.equipment_minutes
        worker[item.terminal] = used + item.worker_minutes

    notes = [
        "First-come, first-served in Timestamp order, scored through the same "
        "value function and the same capacities as the optimised selection."
    ]
    if blocked_on is not None:
        notes.append(
            f"The queue stopped at shipment {blocked_on}, which did not fit in "
            f"the remaining {blocked_by.replace('_', ' ')}."
        )
    else:
        notes.append(
            "The whole batch fitted, so the capacities are not binding and the "
            "optimiser has nothing to choose between. Lower the capacity "
            "fraction f to make the comparison meaningful."
        )

    return FCFSResult(
        evaluation=evaluate_selection(problem, accepted),
        blocked_on=blocked_on,
        blocked_by=blocked_by,
        notes=notes,
    )


# --- Part 2: the best greedy heuristic --------------------------------------

#: The resource dimensions a value-density ranking can be taken against. There
#: is no single correct denominator in a multi-dimensional knapsack, so each is
#: tried and the best result is kept — otherwise the optimiser is being
#: measured against a straw man of our own choosing.
_DENSITY_KEYS: tuple[str, ...] = ("volume", "worker_minutes", "equipment_minutes")


@dataclass
class GreedyResult:
    """The strongest greedy rule, scored under the IP's own value function."""

    evaluation: SelectionEvaluation
    #: Which density ranking won: "value_per_<dimension>", or "value" when the
    #: unweighted ranking did best.
    rule: str
    #: Every rule tried, with the value it reached. Reported so the claim that
    #: this is the *best* greedy is auditable rather than asserted.
    candidates: dict[str, float]
    notes: list[str]


def _greedy_pass(problem: SelectionProblem, key: str | None) -> list[str]:
    """One greedy sweep: rank by value density, take whatever still fits.

    Unlike FCFS this one *does* skip ahead past a shipment that will not fit,
    which is what makes it a heuristic rather than a queue discipline and what
    makes it a much harder baseline to beat.
    """
    def density(item) -> float:
        if key is None:
            return item.value
        weight = getattr(item, key)
        return item.value / weight if weight > config.EPSILON else float("inf")

    ranked = sorted(
        problem.items, key=lambda i: (-density(i), i.record_id)
    )

    caps = problem.capacities
    volume = 0.0
    equipment = 0.0
    worker: dict[str, float] = {}
    accepted: list[str] = []

    for item in ranked:
        budget = problem.worker_budget(item.terminal)
        used = worker.get(item.terminal, 0.0)

        if volume + item.volume > caps.volume + config.EPSILON:
            continue
        if (
            equipment + item.equipment_minutes
            > caps.equipment_minutes + config.EPSILON
        ):
            continue
        if budget is not None and used + item.worker_minutes > budget + config.EPSILON:
            continue

        accepted.append(item.record_id)
        volume += item.volume
        equipment += item.equipment_minutes
        worker[item.terminal] = used + item.worker_minutes

    return accepted


def greedy_baseline(problem: SelectionProblem) -> GreedyResult:
    """The best of several value-density greedy rules.

    FCFS answers "what does the dispatcher do today?" and is the weaker of the
    two baselines by a wide margin, because arrival order carries no
    information about value. This one answers the harder question an examiner
    actually asks: **what does the optimiser buy over an obvious sensible
    rule?** Ranking by value per unit of a scarce resource is that rule, and on
    a knapsack it is a genuinely strong heuristic.

    Both are reported. Quoting only the gap over FCFS would flatter the
    optimiser; quoting only the gap over greedy would hide the status quo.
    """
    candidates: dict[str, list[str]] = {
        "value": _greedy_pass(problem, None),
    }
    for key in _DENSITY_KEYS:
        candidates[f"value_per_{key}"] = _greedy_pass(problem, key)

    scored = {
        rule: evaluate_selection(problem, accepted)
        for rule, accepted in candidates.items()
    }
    rule = max(scored, key=lambda r: scored[r].total_value)

    return GreedyResult(
        evaluation=scored[rule],
        rule=rule,
        candidates={r: e.total_value for r, e in scored.items()},
        notes=[
            f"Best of {len(scored)} greedy rules ({rule.replace('_', ' ')}), "
            "each ranking the batch by value density and taking whatever still "
            "fits. Unlike FCFS it skips past a shipment that will not fit, "
            "which makes it a far harder baseline than arrival order.",
            "Scored through the same value function and the same capacities as "
            "the optimised selection.",
        ],
    )
