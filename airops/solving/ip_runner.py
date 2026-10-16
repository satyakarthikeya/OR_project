"""Part 2 - runs the shipment-selection model and packages what comes back.

The model itself lives in `or_models/ip_model.py`.  This file adds the pre-checks,
timing, scoring and warnings around it.  An integer programme has no shadow
prices, so none are produced (MODEL.md section 4.5).
"""

from __future__ import annotations

import time
from typing import Any, Iterable

from airops.core import config
from airops.solving.ip_checks import check_problem
from airops.solving.ip_results import (
    SelectionEvaluation,
    SelectionResult,
    evaluate_selection,
)
from or_models.inputs import (
    Capacities,
    PolicyOptions,
    SelectionProblem,
    ShipmentItem,
)
from or_models.ip_model import build_ip, read_ip, solve_ip

__all__ = [
    "SelectionProblem", "PolicyOptions", "SelectionEvaluation", "SelectionResult",
    "check_problem", "evaluate_selection", "problem_from_batch", "solve_selection",
]


def problem_from_batch(
    items: Iterable[dict[str, Any]],
    capacities: dict[str, Any],
    policy: PolicyOptions | None = None,
) -> SelectionProblem:
    """Adapt a batch produced by `preprocessing.batch_items` into a problem."""
    return SelectionProblem(
        items=[ShipmentItem.from_dict(raw) for raw in items],
        capacities=Capacities(
            volume=float(capacities["volume"]),
            equipment_minutes=float(capacities["equipment_minutes"]),
            worker_minutes={
                str(t): float(v)
                for t, v in dict(capacities["worker_minutes"]).items()
            },
            worker_minutes_source=str(
                capacities.get("worker_minutes_source", "batch_fraction")
            ),
        ),
        policy=policy or PolicyOptions(),
    )


def solve_selection(
    problem: SelectionProblem, time_limit: int | None = None
) -> SelectionResult:
    """Check, build, solve and score.  Infeasibility is a result, never a raise."""
    errors, suggestions = check_problem(problem)
    if errors:
        return SelectionResult(
            status="Infeasible",
            message="; ".join(errors),
            suggestions=suggestions,
        )

    model = build_ip(problem)
    start = time.perf_counter()
    status = solve_ip(model, time_limit)
    elapsed = time.perf_counter() - start

    if status != "Optimal":
        return SelectionResult(
            status=status,
            message=(
                f"The solver returned '{status}'. The policy constraints are "
                "the only ones that can make this batch infeasible; the three "
                "capacities alone always admit the empty selection."
            ),
            suggestions=[
                "Relax or turn off the policy toggles",
                "Raise the capacity fraction f",
                "Raise Part 1's workforce at the terminal that is short",
            ],
            solve_seconds=elapsed,
        )

    # Never read variable values before checking the status above.
    accepted = read_ip(model)
    evaluation = evaluate_selection(problem, accepted)

    return SelectionResult(
        status="Optimal",
        message=(
            f"Solved to optimality: {evaluation.n_accepted} of "
            f"{len(problem.items)} shipments accepted."
        ),
        warnings=_result_warnings(problem, evaluation),
        solution=evaluation,
        solve_seconds=elapsed,
    )


def _result_warnings(
    problem: SelectionProblem, evaluation: SelectionEvaluation
) -> list[str]:
    warnings: list[str] = []

    if problem.capacities.worker_minutes_source != "lp_allocation":
        warnings.append(
            "The worker-minute budgets are a fraction of this batch's own "
            "observed consumption rather than Part 1's solved allocation, so "
            "constraint (2) is self-referential. Solve Part 1 first and pass "
            "its allocation to make the two-stage model whole."
        )

    unconstrained = [
        t for t in problem.terminals if problem.worker_budget(t) is None
    ]
    if unconstrained:
        warnings.append(
            f"No worker-minute budget was supplied for "
            f"{', '.join(sorted(unconstrained))}; those terminals are "
            "unconstrained on labour in this run."
        )

    starved = [
        u.terminal for u in evaluation.capacity_use
        if u.terminal is not None and u.available <= config.EPSILON
    ]
    if starved:
        warnings.append(
            f"Part 1 allocated no workers to {', '.join(sorted(starved))}, so "
            "no shipment there can be processed in this window."
        )

    return warnings
