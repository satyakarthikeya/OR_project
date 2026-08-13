"""Part 1 — Linear program for workforce and equipment allocation.

Pure optimisation layer: it accepts an `AllocationProblem` of plain numbers and
returns a structured result. It never reads the CSV, never imports FastAPI and
never touches the dataset store (AGENT.md, "Layering rules").

Formulation (SCOPE.md section 3), for terminals ``t``:

    decision   w_t >= 0   workers at terminal t
               e_t >= 0   equipment units at terminal t
               s_t >= 0   unmet demand at terminal t (soft-constraint slack)

    max        sum_t (alpha_t w_t + beta_t e_t) - M sum_t s_t          [throughput]
    min        sum_t (cw_t w_t + ce_t e_t)      + M sum_t s_t          [cost]

    s.t.       sum_t w_t <= W_total                              (worker pool)
               sum_t e_t <= E_total                              (equipment pool)
               wmin_t <= w_t <= wmax_t, emin_t <= e_t <= emax_t   (terminal bounds)
               alpha_t w_t + beta_t e_t + s_t >= D_t              (demand, soft)
               alpha_t w_t + beta_t e_t <= Cap_t                  (physical ceiling)
               sum_t (cw_t w_t + ce_t e_t) <= B                   (budget, optional)

The demand constraint is soft on purpose: a scenario whose demand cannot be met
must report *how much* is unmet, not collapse to an Infeasible status.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Literal

import pulp

from backend.core import config

if TYPE_CHECKING:  # import for typing only — keeps this module free of pandas
    from backend.core.preprocessing import LPParameters

Objective = Literal["max_throughput", "min_cost"]

OBJECTIVE_LABELS: dict[str, str] = {
    "max_throughput": "Maximise throughput",
    "min_cost": "Minimise operational cost subject to demand",
}


# --- Problem definition ------------------------------------------------------


@dataclass(frozen=True)
class AllocationProblem:
    """Every number the LP needs, and nothing else."""

    terminals: list[str]
    alpha: dict[str, float]
    beta: dict[str, float]
    cost_worker: dict[str, float]
    cost_equipment: dict[str, float]
    demand: dict[str, float]
    capacity: dict[str, float]
    workforce_bounds: dict[str, tuple[float, float]]
    equipment_bounds: dict[str, tuple[float, float]]
    workforce_total: float
    equipment_total: float
    objective: Objective = "max_throughput"
    budget: float | None = None
    penalty_factor: float = config.UNMET_DEMAND_PENALTY_FACTOR

    @property
    def unmet_penalty(self) -> float:
        """Penalty per unit of unmet demand, scaled to the active objective.

        The penalty has to dominate whatever the objective would gain by leaving
        demand unmet, but must stay finite so the solver keeps well-conditioned.
        Scaling it to the largest coefficient *of the active objective* achieves
        both, and keeps the number meaningful when the objective switches
        between throughput units and currency.
        """
        if self.objective == "max_throughput":
            scale = max(
                [*self.alpha.values(), *self.beta.values(), config.EPSILON]
            )
        else:
            scale = max(
                [*self.cost_worker.values(), *self.cost_equipment.values(),
                 config.EPSILON]
            )
        return self.penalty_factor * scale

    def throughput_at(
        self, workforce: dict[str, float], equipment: dict[str, float]
    ) -> dict[str, float]:
        return {
            t: self.alpha[t] * workforce[t] + self.beta[t] * equipment[t]
            for t in self.terminals
        }

    def cost_at(
        self, workforce: dict[str, float], equipment: dict[str, float]
    ) -> dict[str, float]:
        return {
            t: self.cost_worker[t] * workforce[t]
            + self.cost_equipment[t] * equipment[t]
            for t in self.terminals
        }


def problem_from_parameters(
    params: "LPParameters",
    objective: Objective = "max_throughput",
    workforce_total: float | None = None,
    equipment_total: float | None = None,
    budget: float | None = None,
    penalty_factor: float = config.UNMET_DEMAND_PENALTY_FACTOR,
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
        equipment_bounds=dict(params.equipment_bounds),
        workforce_total=(
            params.workforce_total if workforce_total is None else workforce_total
        ),
        equipment_total=(
            params.equipment_total if equipment_total is None else equipment_total
        ),
        objective=objective,
        budget=budget,
        penalty_factor=penalty_factor,
    )


# --- Results -----------------------------------------------------------------


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
        tol = 1e-6
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
    throughput = problem.throughput_at(workforce, equipment)
    cost = problem.cost_at(workforce, equipment)
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


# --- Pre-solve checks --------------------------------------------------------


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

    for t in problem.terminals:
        floor = (
            problem.alpha[t] * problem.workforce_bounds[t][0]
            + problem.beta[t] * problem.equipment_bounds[t][0]
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

    return errors, suggestions


# --- Solve -------------------------------------------------------------------


def _dual_of(constraint: pulp.LpConstraint) -> float:
    value = constraint.pi
    return 0.0 if value is None else float(value)


def solve_allocation(
    problem: AllocationProblem, time_limit: int | None = None
) -> AllocationResult:
    """Build and solve the LP. Infeasibility is a result, never an exception."""
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

    sense = (
        pulp.LpMaximize if problem.objective == "max_throughput" else pulp.LpMinimize
    )
    model = pulp.LpProblem("air_cargo_resource_allocation", sense)

    w = {
        t: pulp.LpVariable(
            f"workers_{t}",
            lowBound=problem.workforce_bounds[t][0],
            upBound=problem.workforce_bounds[t][1],
        )
        for t in problem.terminals
    }
    e = {
        t: pulp.LpVariable(
            f"equipment_{t}",
            lowBound=problem.equipment_bounds[t][0],
            upBound=problem.equipment_bounds[t][1],
        )
        for t in problem.terminals
    }
    s = {
        t: pulp.LpVariable(f"unmet_{t}", lowBound=0)
        for t in problem.terminals
    }

    throughput = {
        t: problem.alpha[t] * w[t] + problem.beta[t] * e[t]
        for t in problem.terminals
    }
    cost = {
        t: problem.cost_worker[t] * w[t] + problem.cost_equipment[t] * e[t]
        for t in problem.terminals
    }
    penalty = problem.unmet_penalty * pulp.lpSum(s.values())

    if problem.objective == "max_throughput":
        model += pulp.lpSum(throughput.values()) - penalty, "objective"
    else:
        model += pulp.lpSum(cost.values()) + penalty, "objective"

    tracked: list[tuple[str, str, str | None, str, float]] = []

    model += pulp.lpSum(w.values()) <= problem.workforce_total, "worker_pool"
    tracked.append(("worker_pool", "resource_pool", None, "<=",
                    problem.workforce_total))

    model += pulp.lpSum(e.values()) <= problem.equipment_total, "equipment_pool"
    tracked.append(("equipment_pool", "resource_pool", None, "<=",
                    problem.equipment_total))

    for t in problem.terminals:
        model += throughput[t] + s[t] >= problem.demand[t], f"demand_{t}"
        tracked.append((f"demand_{t}", "demand", t, ">=", problem.demand[t]))

        model += throughput[t] <= problem.capacity[t], f"capacity_{t}"
        tracked.append((f"capacity_{t}", "capacity", t, "<=", problem.capacity[t]))

    if problem.budget is not None:
        model += pulp.lpSum(cost.values()) <= problem.budget, "budget"
        tracked.append(("budget", "budget", None, "<=", problem.budget))

    solver = pulp.PULP_CBC_CMD(msg=False, timeLimit=time_limit)
    start = time.perf_counter()
    model.solve(solver)
    elapsed = time.perf_counter() - start

    status = pulp.LpStatus[model.status]
    if status != "Optimal":
        return AllocationResult(
            status=status,
            objective=problem.objective,
            objective_label=label,
            message=(
                f"The solver returned '{status}'. The soft demand constraints "
                "make plain demand shortfalls impossible to hit, so this points "
                "at the resource pools, the bounds or the budget."
            ),
            suggestions=[
                "Raise the worker or equipment pool",
                "Remove the budget cap, or raise it",
                "Widen the scenario filters so per-terminal bounds relax",
            ],
            solve_seconds=elapsed,
        )

    # Never read variable values before checking the status above.
    workforce = {t: float(w[t].value() or 0.0) for t in problem.terminals}
    equipment = {t: float(e[t].value() or 0.0) for t in problem.terminals}
    evaluation = evaluate_allocation(problem, workforce, equipment)

    duals = _collect_duals(model, tracked, problem, evaluation)

    return AllocationResult(
        status="Optimal",
        objective=problem.objective,
        objective_label=label,
        message=f"Solved to optimality: {label.lower()}.",
        solution=evaluation,
        duals=duals,
        solve_seconds=elapsed,
    )


def _collect_duals(
    model: pulp.LpProblem,
    tracked: list[tuple[str, str, str | None, str, float]],
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

        lhs = _lhs_value(name, kind, terminal, evaluation)
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
    if kind == "budget":
        return (
            f"Binding. The budget cap is fully spent — it, not the resource "
            f"pools, is what limits this plan. One more unit of budget is worth "
            f"{magnitude}."
        )
    return f"Binding. Marginal value {magnitude}."
