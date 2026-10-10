"""Part 2 - structural feasibility checks, run before the solver is called."""

from __future__ import annotations

from airops.core import config
from or_models.inputs import SelectionProblem


def check_problem(problem: SelectionProblem) -> tuple[list[str], list[str]]:
    """Structural feasibility check. Returns (blocking errors, suggestions).

    Forced-Critical is the case worth catching here: pinning `x_i = 1` for a
    whole priority class can exceed a capacity on its own, and CBC would then
    answer "Infeasible" for a reason the user cannot see (MODEL.md section 4.4).
    """
    errors: list[str] = []
    suggestions: list[str] = []

    if not problem.items:
        return (["The batch contains no shipments"],
                ["Relax the batch filters, or raise the batch size"])

    caps = problem.capacities
    if caps.volume <= 0 or caps.equipment_minutes <= 0:
        errors.append("A capacity is zero, so nothing can be processed")
        suggestions.append("Raise the capacity fraction f above zero")

    forced = [
        i for i in problem.items if i.priority == config.FORCED_PRIORITY
    ] if problem.policy.force_critical else []

    if forced:
        volume = sum(i.volume for i in forced)
        if volume > caps.volume + config.EPSILON:
            errors.append(
                f"The {len(forced)} Critical shipments need {volume:,.1f} volume "
                f"on their own, above the cap of {caps.volume:,.1f}"
            )
            suggestions.append(
                f"Raise the capacity fraction so volume reaches at least "
                f"{volume:,.0f}, or turn off force-Critical"
            )

        equipment = sum(i.equipment_minutes for i in forced)
        if equipment > caps.equipment_minutes + config.EPSILON:
            errors.append(
                f"The Critical shipments alone need {equipment:,.0f} "
                f"equipment-minutes, above the cap of "
                f"{caps.equipment_minutes:,.0f}"
            )
            suggestions.append(
                "Raise the capacity fraction, or turn off force-Critical"
            )

        by_terminal: dict[str, float] = {}
        for item in forced:
            by_terminal[item.terminal] = (
                by_terminal.get(item.terminal, 0.0) + item.worker_minutes
            )
        for terminal, needed in sorted(by_terminal.items()):
            budget = problem.worker_budget(terminal)
            if budget is None:
                continue
            if needed > budget + config.EPSILON:
                errors.append(
                    f"Critical shipments at {terminal} need {needed:,.0f} "
                    f"worker-minutes against a budget of {budget:,.0f}"
                )
                suggestions.append(
                    f"Part 1 staffs {terminal} too thinly for its Critical "
                    "cargo: raise that terminal's workforce in Part 1, or turn "
                    "off force-Critical"
                )

    policy = problem.policy
    if policy.min_perishable is not None:
        available = sum(
            1 for i in problem.items
            if i.cargo_type == config.PERISHABLE_CARGO_TYPE
        )
        if policy.min_perishable > available:
            errors.append(
                f"The batch holds {available} Perishable shipments, fewer than "
                f"the required minimum of {policy.min_perishable}"
            )
            suggestions.append(
                f"Lower the Perishable minimum to {available} or below, or "
                "widen the batch"
            )

    if policy.max_hazardous is not None and policy.max_hazardous < 0:
        errors.append("The Hazardous cap cannot be negative")
        suggestions.append("Set the Hazardous cap to zero or more")

    if (
        policy.force_critical
        and policy.max_hazardous is not None
    ):
        forced_hazardous = sum(
            1 for i in forced if i.cargo_type == config.HAZARDOUS_CARGO_TYPE
        )
        if forced_hazardous > policy.max_hazardous:
            errors.append(
                f"{forced_hazardous} shipments are both Critical and Hazardous, "
                f"above the Hazardous cap of {policy.max_hazardous}"
            )
            suggestions.append(
                "Raise the Hazardous cap, or turn off force-Critical"
            )

    return errors, suggestions
