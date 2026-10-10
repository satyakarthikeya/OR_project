"""Part 1 - runs the allocation model and packages what comes back.

The model itself lives in `or_models/lp_model.py`.  This file decides *how many
times* to solve it and what to do with the answers:

  1. MILP solve (whole machines)    -> the allocation that gets reported
  2. continuous relaxation          -> the shadow prices
  3. relaxation, penalty removed    -> clean shadow prices, only if demand is unmet

Every result says which solve each number came from (MODEL.md sections 3.1, 3.5).
"""

from __future__ import annotations

import math
import time
from typing import TYPE_CHECKING

from airops.core import config
from airops.solving.lp_checks import check_problem
from airops.solving.lp_duals import collect_duals
from airops.solving.lp_results import (
    OBJECTIVE_LABELS,
    AllocationEvaluation,
    AllocationResult,
    ConstraintDual,
    evaluate_allocation,
)
from or_models.inputs import AllocationProblem, Objective
from or_models.lp_model import LPModel, build_lp, read_lp, solve_lp

if TYPE_CHECKING:  # typing only - keeps this module free of pandas
    from airops.core.preprocessing import LPParameters

__all__ = [
    "AllocationProblem", "AllocationEvaluation", "AllocationResult",
    "OBJECTIVE_LABELS", "check_problem", "evaluate_allocation",
    "problem_from_parameters", "solve_allocation",
]


def problem_from_parameters(
    params: "LPParameters",
    objective: Objective = "max_throughput",
    workforce_total: float | None = None,
    equipment_total: float | None = None,
    budget: float | None = None,
    penalty_factor: float = config.UNMET_DEMAND_PENALTY_FACTOR,
    staffing_ratio: float = config.STAFFING_RATIO,
) -> AllocationProblem:
    """Adapt derived parameters into a solvable problem.

    The capacity ceiling is raised to the baseline's own modelled throughput
    where the two collide. `Cap_t` is the 95th percentile of *observed* row-level
    throughput while the baseline is evaluated through the congested production
    function, so on a lopsided scenario slice the ceiling can land below the
    baseline itself. Letting that stand would make the observed allocation
    infeasible and void every baseline-versus-optimised comparison, which the
    honest-comparison invariant (AGENT.md) does not allow.
    """
    capacity = dict(params.capacity)
    for t in params.terminals:
        baseline_throughput = (
            params.alpha[t] * params.baseline_workforce[t]
            + params.beta[t] * params.baseline_equipment[t]
        )
        capacity[t] = max(capacity[t], baseline_throughput)

    return AllocationProblem(
        terminals=list(params.terminals),
        alpha=dict(params.alpha),
        beta=dict(params.beta),
        cost_worker=dict(params.cost_worker),
        cost_equipment=dict(params.cost_equipment),
        demand=dict(params.demand),
        capacity=capacity,
        workforce_bounds=dict(params.workforce_bounds),
        # e_t is integer, so CBC would tighten a fractional bound anyway.
        equipment_bounds={
            t: (float(math.floor(lo)), float(math.ceil(hi)))
            for t, (lo, hi) in params.equipment_bounds.items()
        },
        workforce_total=(
            params.workforce_total if workforce_total is None else workforce_total
        ),
        equipment_total=(
            params.equipment_total if equipment_total is None else equipment_total
        ),
        objective=objective,
        budget=budget,
        penalty_factor=penalty_factor,
        staffing_ratio=staffing_ratio,
    )


def _timed_solve(model: LPModel, time_limit: int | None) -> tuple[str, float]:
    start = time.perf_counter()
    status = solve_lp(model, time_limit)
    return status, time.perf_counter() - start


def _read(model: LPModel, problem: AllocationProblem) -> AllocationEvaluation:
    workforce, equipment = read_lp(model)
    return evaluate_allocation(problem, workforce, equipment)


def solve_allocation(
    problem: AllocationProblem, time_limit: int | None = None
) -> AllocationResult:
    """Solve the allocation. Infeasibility is a result, never an exception.

    The reported allocation always comes from the MILP. The duals always come
    from a continuous relaxation, and when that relaxation leaves demand unmet
    they come from a *second* relaxation with the unreachable demand
    constraints removed — because with `s_t > 0` the pool duals are driven by
    `M * alpha_t` rather than by marginal throughput, and the demand dual pins
    to exactly `M`. At `M = 10x` the largest coefficient, quoting those
    unqualified overstates the value of a worker by an order of magnitude
    (MODEL.md section 3.5).
    """
    label = OBJECTIVE_LABELS[problem.objective]

    errors, suggestions = check_problem(problem)
    if errors:
        return AllocationResult(
            status="Infeasible",
            objective=problem.objective,
            objective_label=label,
            message="; ".join(errors),
            suggestions=suggestions,
        )

    milp = build_lp(problem, integer_equipment=True)
    status, elapsed = _timed_solve(milp, time_limit)

    if status != "Optimal":
        return AllocationResult(
            status=status,
            objective=problem.objective,
            objective_label=label,
            message=(
                f"The solver returned '{status}'. The soft demand constraints "
                "make plain demand shortfalls impossible to hit, so this points "
                "at the resource pools, the bounds, the staffing coupling or "
                "the budget."
            ),
            suggestions=[
                "Raise the worker or equipment pool",
                "Remove the budget cap, or raise it",
                "Widen the scenario filters so per-terminal bounds relax",
            ],
            solve_seconds=elapsed,
        )

    # Never read variable values before checking the status above.
    evaluation = _read(milp, problem)
    duals, duals_source, inflated, note, extra = _duals_from_relaxation(
        problem, time_limit
    )

    return AllocationResult(
        status="Optimal",
        objective=problem.objective,
        objective_label=label,
        message=f"Solved to optimality: {label.lower()}.",
        solution=evaluation,
        duals=duals,
        solve_seconds=elapsed + extra,
        allocation_source="milp",
        duals_source=duals_source,
        duals_penalty_inflated=inflated,
        duals_note=note,
    )


_MILP_DUAL_NOTE = (
    "Equipment is an integer variable, so the allocation above is a MILP "
    "solution and CBC's constraint duals at the incumbent node are not shadow "
    "prices. The shadow prices below are read from the continuous relaxation "
    "of the same problem"
)


def _duals_from_relaxation(
    problem: AllocationProblem, time_limit: int | None
) -> tuple[list[ConstraintDual], str, bool, str, float]:
    """Shadow prices, taken from a relaxation with the penalty stripped out."""
    relaxed = build_lp(problem, integer_equipment=False)
    status, elapsed = _timed_solve(relaxed, time_limit)
    if status != "Optimal":
        return ([], "none", False,
                "The continuous relaxation did not solve, so no shadow prices "
                "are available for this scenario.", elapsed)

    evaluation = _read(relaxed, problem)
    unmet = {
        t for t in problem.terminals
        if evaluation.unmet_demand[t] > config.BINDING_ABS_TOL
    }

    if not unmet:
        return (
            collect_duals(relaxed.prob, relaxed.labels, problem, evaluation),
            "relaxation", False,
            f"{_MILP_DUAL_NOTE}, in which demand is met at every terminal, so "
            "no dual is inflated by the unmet-demand penalty.",
            elapsed,
        )

    # Demand is unreachable somewhere, so every dual in this solve is a
    # multiple of M. Drop the unreachable demand constraints — which removes
    # the penalty from the objective entirely — and re-read.
    clean = build_lp(problem, integer_equipment=False, drop_demand_for=unmet)
    clean_status, clean_elapsed = _timed_solve(clean, time_limit)
    elapsed += clean_elapsed

    shortfall = ", ".join(sorted(unmet))
    if clean_status != "Optimal":
        return (
            collect_duals(relaxed.prob, relaxed.labels, problem, evaluation),
            "relaxation", True,
            f"{_MILP_DUAL_NOTE}. Demand cannot be met at {shortfall}, so these "
            "duals are driven by the unmet-demand penalty rate M rather than by "
            "marginal throughput and must not be quoted as the value of a "
            "worker. A penalty-free re-solve was attempted and did not succeed.",
            elapsed,
        )

    clean_evaluation = _read(clean, problem)
    return (
        collect_duals(clean.prob, clean.labels, problem, clean_evaluation),
        "relaxation_demand_met", True,
        f"{_MILP_DUAL_NOTE}. Demand cannot be met at {shortfall}, which would "
        "have pinned every dual to a multiple of the penalty rate M, so those "
        "demand constraints were dropped and the relaxation re-solved without "
        "any penalty term. The prices below are marginal throughput; the "
        f"shortfall at {shortfall} is reported in the allocation table.",
        elapsed,
    )
