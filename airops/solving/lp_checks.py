"""Part 1 - structural feasibility checks, run before the solver is called."""

from __future__ import annotations

from airops.core import config
from or_models.inputs import AllocationProblem


def check_problem(problem: AllocationProblem) -> tuple[list[str], list[str]]:
    """Structural feasibility check. Returns (blocking errors, suggestions).

    Catching these before the solver runs turns "Infeasible" into an actionable
    message, which is what the API contract promises.
    """
    errors: list[str] = []
    suggestions: list[str] = []

    if not problem.terminals:
        return (["The scenario contains no terminals"],
                ["Relax the scenario filters so at least one terminal has rows"])

    min_workers = sum(problem.workforce_bounds[t][0] for t in problem.terminals)
    min_equipment = sum(problem.equipment_bounds[t][0] for t in problem.terminals)

    if min_workers > problem.workforce_total + config.EPSILON:
        errors.append(
            f"Minimum staffing across terminals ({min_workers:.1f} workers) "
            f"exceeds the worker pool ({problem.workforce_total:.1f})"
        )
        suggestions.append(
            f"Raise the worker pool to at least {min_workers:.0f}, "
            "or widen the scenario so the per-terminal minimums drop"
        )
    if min_equipment > problem.equipment_total + config.EPSILON:
        errors.append(
            f"Minimum equipment across terminals ({min_equipment:.1f} units) "
            f"exceeds the equipment pool ({problem.equipment_total:.1f})"
        )
        suggestions.append(
            f"Raise the equipment pool to at least {min_equipment:.0f}"
        )

    if problem.budget is not None:
        cheapest = sum(
            problem.cost_worker[t] * problem.workforce_bounds[t][0]
            + problem.cost_equipment[t] * problem.equipment_bounds[t][0]
            for t in problem.terminals
        )
        if cheapest > problem.budget + config.EPSILON:
            errors.append(
                f"The cheapest allocation that respects the minimum staffing "
                f"levels costs {cheapest:,.0f}, above the budget "
                f"{problem.budget:,.0f}"
            )
            suggestions.append(
                f"Raise the budget above {cheapest:,.0f} or remove the budget cap"
            )

    # Constraints (4) and (7) are both hard and they can conflict: if the
    # capacity ceiling sits below the throughput the per-terminal minimums
    # already produce, the box is empty and CBC answers "Infeasible" for a
    # reason the user cannot see (MODEL.md section 3.3). The coupling
    # constraint raises that floor, so it is applied here too.
    rho = problem.staffing_ratio
    for t in problem.terminals:
        w_lo, w_hi = problem.workforce_bounds[t]
        e_lo, e_hi = problem.equipment_bounds[t]

        if rho * e_lo > w_hi + config.EPSILON:
            errors.append(
                f"Terminal {t} must run at least {e_lo:.0f} equipment units, "
                f"which needs {rho * e_lo:.1f} operators at a staffing ratio of "
                f"{rho:g} — above its own worker ceiling of {w_hi:.1f}"
            )
            suggestions.append(
                f"Widen the scenario so {t}'s workforce bounds relax, or lower "
                "the staffing ratio"
            )
            continue

        coupled_floor_workers = max(w_lo, rho * e_lo)
        floor = (
            problem.alpha[t] * coupled_floor_workers
            + problem.beta[t] * e_lo
        )
        if floor > problem.capacity[t] + config.EPSILON:
            errors.append(
                f"Terminal {t} breaches its own capacity ceiling "
                f"({problem.capacity[t]:.1f}) even at minimum staffing "
                f"({floor:.1f})"
            )
            suggestions.append(
                f"Terminal {t}'s capacity percentile is too tight for this "
                "scenario slice; widen the filters or exclude that terminal"
            )

    coupled_minimum = sum(
        max(problem.workforce_bounds[t][0], rho * problem.equipment_bounds[t][0])
        for t in problem.terminals
    )
    if (
        coupled_minimum > problem.workforce_total + config.EPSILON
        and min_workers <= problem.workforce_total + config.EPSILON
    ):
        errors.append(
            f"The minimum equipment across terminals needs {coupled_minimum:.1f} "
            f"operators at a staffing ratio of {rho:g}, above the worker pool "
            f"({problem.workforce_total:.1f})"
        )
        suggestions.append(
            f"Raise the worker pool to at least {coupled_minimum:.0f}, or lower "
            "the equipment minimums by widening the scenario"
        )

    return errors, suggestions
