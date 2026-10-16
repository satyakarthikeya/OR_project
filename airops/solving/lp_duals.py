"""Part 1 - shadow prices and their plain-language reading.

The numbers themselves come from the continuous relaxation built by
`or_models.lp_model.build_lp(..., integer_equipment=False)`.
"""

from __future__ import annotations

import pulp

from airops.core import config
from airops.solving.lp_results import AllocationEvaluation, ConstraintDual
from or_models.inputs import AllocationProblem, Objective


def _dual_of(constraint: pulp.LpConstraint) -> float:
    value = constraint.pi
    return 0.0 if value is None else float(value)


def collect_duals(
    model: pulp.LpProblem,
    tracked: list,
    problem: AllocationProblem,
    evaluation: AllocationEvaluation,
) -> list[ConstraintDual]:
    """Shadow prices plus a plain-language reading of each one.

    Slack is recomputed from the evaluated allocation rather than read off the
    solver, because PuLP's sign convention for `constraint.slack` differs by
    sense and is a well-known source of misreadings.
    """
    duals: list[ConstraintDual] = []

    for name, kind, terminal, sense, rhs in tracked:
        constraint = model.constraints.get(name)
        if constraint is None:
            continue

        lhs = _lhs_value(name, kind, terminal, problem, evaluation)
        slack = (rhs - lhs) if sense == "<=" else (lhs - rhs)
        shadow = _dual_of(constraint)
        binding = _is_binding(slack, rhs, shadow)

        duals.append(
            ConstraintDual(
                name=name,
                kind=kind,
                terminal=terminal,
                sense=sense,
                rhs=float(rhs),
                lhs=float(lhs),
                slack=float(slack),
                shadow_price=shadow,
                binding=binding,
                interpretation=_interpret(
                    kind, terminal, binding, shadow, problem.objective
                ),
            )
        )

    duals.sort(key=lambda d: (not d.binding, -abs(d.shadow_price)))
    return duals


def _is_binding(slack: float, rhs: float, shadow_price: float) -> bool:
    """Whether a constraint actually limits the solution.

    Two independent tests, because either alone misreports. A tolerance scaled
    to the constraint's own magnitude handles the fact that CBC lands further
    from a right-hand side of 5,000 than from one of 30; complementary slackness
    then catches anything left, since a constraint with a non-zero dual is
    binding by definition and must never be shown as slack next to its own
    shadow price.
    """
    tolerance = max(config.BINDING_ABS_TOL, config.BINDING_REL_TOL * abs(rhs))
    return abs(slack) <= tolerance or abs(shadow_price) > config.DUAL_ZERO_TOL


def _lhs_value(
    name: str,
    kind: str,
    terminal: str | None,
    problem: AllocationProblem,
    evaluation: AllocationEvaluation,
) -> float:
    if kind == "resource_pool":
        return (
            evaluation.total_workforce
            if name == "worker_pool"
            else evaluation.total_equipment
        )
    if kind == "budget":
        return evaluation.total_cost
    assert terminal is not None
    if kind == "demand":
        return evaluation.throughput[terminal] + evaluation.unmet_demand[terminal]
    if kind == "staffing":
        # w_t - rho e_t >= 0, so the headroom is operators beyond the minimum.
        return (
            evaluation.workforce[terminal]
            - problem.staffing_ratio * evaluation.equipment[terminal]
        )
    return evaluation.throughput[terminal]


def _interpret(
    kind: str,
    terminal: str | None,
    binding: bool,
    shadow: float,
    objective: Objective,
) -> str:
    unit = "throughput units" if objective == "max_throughput" else "cost units"
    where = f" at {terminal}" if terminal else ""

    if not binding:
        return f"Slack — this constraint{where} is not limiting the solution."

    magnitude = f"{abs(shadow):,.3f} {unit}"
    if kind == "resource_pool":
        return (
            f"Binding. One more unit in this pool changes the objective by "
            f"{magnitude} — the pool is the system's bottleneck."
        )
    if kind == "capacity":
        return (
            f"Binding{where}. The terminal is at its physical ceiling; a unit of "
            f"extra capacity is worth {magnitude}."
        )
    if kind == "demand":
        return (
            f"Binding{where}. Demand is met exactly; one more unit of demand "
            f"costs {magnitude}."
        )
    if kind == "staffing":
        return (
            f"Binding{where}. Every equipment unit there is fully crewed at "
            f"the assumed operator ratio; one more worker releases "
            f"{magnitude} through the machines they would run."
        )
    if kind == "budget":
        return (
            f"Binding. The budget cap is fully spent — it, not the resource "
            f"pools, is what limits this plan. One more unit of budget is worth "
            f"{magnitude}."
        )
    return f"Binding. Marginal value {magnitude}."
