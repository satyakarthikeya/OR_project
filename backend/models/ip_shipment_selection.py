"""Part 2 — 0-1 integer program for shipment selection.

Pure optimisation layer, under the same discipline as the LP module: plain
dicts and dataclasses in, a structured result out. It never reads the CSV,
never imports pandas and never imports FastAPI (AGENT.md, "Layering rules";
`tests/test_ip.py` asserts it by scanning this source).

Formulation (MODEL.md section 4), over a batch of shipments ``i``:

    decision   x_i in {0, 1}    process shipment i in this window, or do not

    max        sum_i v_i x_i

    s.t.       sum_i Vol_i x_i                    <= V_cap          (1) volume
               sum_{i in terminal t} wm_i x_i     <= w_t* H 60      (2) worker-minutes
               sum_i em_i x_i                     <= E_cap          (3) equipment-minutes
               x_i in {0, 1}                                        (4)

    optional   x_i = 1 for every Critical shipment                  (force in)
               sum_{i Hazardous} x_i <= max_hazardous               (policy cap)
               sum_{i Perishable} x_i >= min_perishable             (policy floor)

This is a **multi-dimensional** knapsack — one window, three resource
dimensions. With constraint (2) indexed per terminal it is also a *multiple*
knapsack over four bins.

Two things this formulation does deliberately, both of them corrections:

* Constraint (2)'s right-hand side comes from Part 1's solved allocation, so
  the two models draw on one workforce rather than on two parallel fictions.
* Constraint (3) charges machine-*minutes*, not machines. Equipment is
  reusable: a forklift serving shipment A and then B is not consumed twice.

There are no shadow prices here, and none are reported. An integer program's
value function is a non-convex step function and LP-relaxation duals are not
valid marginal values across the integrality gap; sensitivity for Part 2 means
parametric re-solve (MODEL.md section 4.5).
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any, Iterable, Sequence

import pulp

from backend.core import config

OBJECTIVE_LABEL = "Maximise priority-weighted value of the processed set"


# --- Problem definition ------------------------------------------------------


@dataclass(frozen=True)
class ShipmentItem:
    """One candidate shipment, already scored and weighed."""

    record_id: str
    terminal: str
    priority: str
    cargo_type: str
    timestamp: str
    value: float
    priority_weight: float
    urgency_uplift: float
    volume: float
    worker_minutes: float
    equipment_minutes: float

    @classmethod
    def from_dict(cls, raw: dict[str, Any]) -> "ShipmentItem":
        return cls(
            record_id=str(raw["record_id"]),
            terminal=str(raw["terminal"]),
            priority=str(raw["priority"]),
            cargo_type=str(raw["cargo_type"]),
            timestamp=str(raw["timestamp"]),
            value=float(raw["value"]),
            priority_weight=float(raw["priority_weight"]),
            urgency_uplift=float(raw.get("urgency_uplift", 0.0)),
            volume=float(raw["volume"]),
            worker_minutes=float(raw["worker_minutes"]),
            equipment_minutes=float(raw["equipment_minutes"]),
        )


@dataclass(frozen=True)
class Capacities:
    """The three resource dimensions, and where the worker budget came from."""

    volume: float
    equipment_minutes: float
    #: Per terminal. A terminal absent from this mapping is unconstrained.
    worker_minutes: dict[str, float]
    #: "lp_allocation" when fed by Part 1's w_t*, "batch_fraction" standalone.
    worker_minutes_source: str = "batch_fraction"


@dataclass(frozen=True)
class PolicyOptions:
    """The UI's optional policy toggles (MODEL.md section 4.4)."""

    force_critical: bool = False
    max_hazardous: int | None = None
    min_perishable: int | None = None


@dataclass(frozen=True)
class SelectionProblem:
    """Every number the IP needs, and nothing else."""

    items: list[ShipmentItem]
    capacities: Capacities
    policy: PolicyOptions = PolicyOptions()

    @property
    def terminals(self) -> list[str]:
        seen: list[str] = []
        for item in self.items:
            if item.terminal not in seen:
                seen.append(item.terminal)
        return seen

    def worker_budget(self, terminal: str) -> float | None:
        return self.capacities.worker_minutes.get(terminal)


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


# --- Results -----------------------------------------------------------------


@dataclass
class CapacityUse:
    """One resource dimension after a selection, with its own utilisation."""

    key: str
    label: str
    terminal: str | None
    used: float
    available: float
    unit: str
    binding: bool

    @property
    def utilization(self) -> float:
        if self.available <= config.EPSILON:
            return 0.0
        return self.used / self.available


@dataclass
class SelectionEvaluation:
    """A chosen set scored through the model's own value function.

    Both the IP's answer and the FCFS baseline are scored here, which is how the
    honest-comparison invariant is enforced structurally: there is one scoring
    path, not two (MODEL.md section 5).
    """

    accepted: list[str]
    rejected: list[str]
    total_value: float
    n_accepted: int
    n_rejected: int
    priority_mix: dict[str, int]
    cargo_mix: dict[str, int]
    volume_used: float
    equipment_minutes_used: float
    worker_minutes_used: dict[str, float]
    capacity_use: list[CapacityUse]
    feasible: bool
    violations: list[str] = field(default_factory=list)


@dataclass
class SelectionResult:
    status: str
    objective_label: str = OBJECTIVE_LABEL
    message: str = ""
    suggestions: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    solution: SelectionEvaluation | None = None
    solve_seconds: float = 0.0

    @property
    def solved(self) -> bool:
        return self.status == "Optimal" and self.solution is not None


# --- Evaluation --------------------------------------------------------------


def _counts(items: Sequence[ShipmentItem], attribute: str) -> dict[str, int]:
    out: dict[str, int] = {}
    for item in items:
        key = getattr(item, attribute)
        out[key] = out.get(key, 0) + 1
    return out


def _is_binding(
    used: float, available: float, smallest_rejected: float | None
) -> bool:
    """Whether a capacity is actually keeping shipments out.

    An LP capacity binds when it is exactly full. An integer one almost never
    is: the items are indivisible, so a dimension can sit at 98% and still be
    the reason nothing more was taken. The honest test is therefore whether the
    headroom left is too small for any rejected shipment to fit into — which is
    what "this capacity is what limits the plan" means when the decision is
    0-1. A dimension with nothing left to reject is binding only if it is full.
    """
    tolerance = max(config.BINDING_ABS_TOL, config.BINDING_REL_TOL * abs(available))
    headroom = available - used
    if headroom <= tolerance:
        return True
    if smallest_rejected is None:
        return False
    return headroom + tolerance < smallest_rejected


def evaluate_selection(
    problem: SelectionProblem, accepted_ids: Iterable[str]
) -> SelectionEvaluation:
    """Score any selection against the problem's own value and capacities."""
    chosen = set(accepted_ids)
    taken = [i for i in problem.items if i.record_id in chosen]
    left = [i for i in problem.items if i.record_id not in chosen]

    volume = sum(i.volume for i in taken)
    equipment = sum(i.equipment_minutes for i in taken)
    worker: dict[str, float] = {}
    for item in taken:
        worker[item.terminal] = worker.get(item.terminal, 0.0) + item.worker_minutes

    def smallest(attribute: str, terminal: str | None = None) -> float | None:
        candidates = [
            getattr(i, attribute) for i in left
            if terminal is None or i.terminal == terminal
        ]
        return min(candidates) if candidates else None

    caps = problem.capacities
    use = [
        CapacityUse("volume", "Storage volume", None, volume, caps.volume,
                    "m3", _is_binding(volume, caps.volume, smallest("volume"))),
        CapacityUse("equipment_minutes", "Equipment-minutes", None, equipment,
                    caps.equipment_minutes, "machine-min",
                    _is_binding(equipment, caps.equipment_minutes,
                                smallest("equipment_minutes"))),
    ]
    for terminal in problem.terminals:
        budget = problem.worker_budget(terminal)
        if budget is None:
            continue
        used = worker.get(terminal, 0.0)
        use.append(CapacityUse(
            f"worker_minutes_{terminal}", f"Worker-minutes {terminal}",
            terminal, used, budget, "worker-min",
            _is_binding(used, budget, smallest("worker_minutes", terminal)),
        ))

    violations = [
        f"{u.label} over capacity by {u.used - u.available:,.1f} {u.unit}"
        for u in use
        if u.used > u.available + max(
            config.BINDING_ABS_TOL, config.BINDING_REL_TOL * abs(u.available)
        )
    ]
    violations.extend(_policy_violations(problem, taken))

    return SelectionEvaluation(
        accepted=[i.record_id for i in taken],
        rejected=[i.record_id for i in left],
        total_value=sum(i.value for i in taken),
        n_accepted=len(taken),
        n_rejected=len(left),
        priority_mix=_counts(taken, "priority"),
        cargo_mix=_counts(taken, "cargo_type"),
        volume_used=volume,
        equipment_minutes_used=equipment,
        worker_minutes_used=worker,
        capacity_use=use,
        feasible=not violations,
        violations=violations,
    )


def _policy_violations(
    problem: SelectionProblem, taken: Sequence[ShipmentItem]
) -> list[str]:
    policy = problem.policy
    out: list[str] = []

    if policy.force_critical:
        missing = sum(
            1 for i in problem.items
            if i.priority == config.FORCED_PRIORITY
            and i.record_id not in {t.record_id for t in taken}
        )
        if missing:
            out.append(f"{missing} Critical shipment(s) left out under force-in")

    if policy.max_hazardous is not None:
        n = sum(1 for i in taken if i.cargo_type == config.HAZARDOUS_CARGO_TYPE)
        if n > policy.max_hazardous:
            out.append(
                f"{n} Hazardous shipments accepted against a cap of "
                f"{policy.max_hazardous}"
            )

    if policy.min_perishable is not None:
        n = sum(1 for i in taken if i.cargo_type == config.PERISHABLE_CARGO_TYPE)
        if n < policy.min_perishable:
            out.append(
                f"only {n} Perishable shipments accepted against a floor of "
                f"{policy.min_perishable}"
            )

    return out


# --- Pre-solve checks --------------------------------------------------------


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


# --- Solve -------------------------------------------------------------------


def solve_selection(
    problem: SelectionProblem, time_limit: int | None = None
) -> SelectionResult:
    """Build and solve the knapsack. Infeasibility is a result, never a raise."""
    errors, suggestions = check_problem(problem)
    if errors:
        return SelectionResult(
            status="Infeasible",
            message="; ".join(errors),
            suggestions=suggestions,
        )

    model = pulp.LpProblem("air_cargo_shipment_selection", pulp.LpMaximize)
    x = {
        item.record_id: pulp.LpVariable(
            f"x_{item.record_id}", cat=pulp.LpBinary
        )
        for item in problem.items
    }

    model += pulp.lpSum(
        item.value * x[item.record_id] for item in problem.items
    ), "objective"

    caps = problem.capacities
    model += pulp.lpSum(
        item.volume * x[item.record_id] for item in problem.items
    ) <= caps.volume, "volume"

    model += pulp.lpSum(
        item.equipment_minutes * x[item.record_id] for item in problem.items
    ) <= caps.equipment_minutes, "equipment_minutes"

    for terminal in problem.terminals:
        budget = problem.worker_budget(terminal)
        if budget is None:
            continue
        model += pulp.lpSum(
            item.worker_minutes * x[item.record_id]
            for item in problem.items
            if item.terminal == terminal
        ) <= budget, f"worker_minutes_{terminal}"

    _add_policy_constraints(model, problem, x)

    solver = pulp.PULP_CBC_CMD(msg=False, timeLimit=time_limit)
    start = time.perf_counter()
    model.solve(solver)
    elapsed = time.perf_counter() - start

    status = pulp.LpStatus[model.status]
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
    accepted = [
        item.record_id for item in problem.items
        if (x[item.record_id].value() or 0.0) > 0.5
    ]
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


def _add_policy_constraints(
    model: pulp.LpProblem,
    problem: SelectionProblem,
    x: dict[str, pulp.LpVariable],
) -> None:
    policy = problem.policy

    if policy.force_critical:
        for item in problem.items:
            if item.priority == config.FORCED_PRIORITY:
                model += x[item.record_id] == 1, f"force_critical_{item.record_id}"

    if policy.max_hazardous is not None:
        model += pulp.lpSum(
            x[i.record_id] for i in problem.items
            if i.cargo_type == config.HAZARDOUS_CARGO_TYPE
        ) <= policy.max_hazardous, "hazardous_cap"

    if policy.min_perishable is not None:
        model += pulp.lpSum(
            x[i.record_id] for i in problem.items
            if i.cargo_type == config.PERISHABLE_CARGO_TYPE
        ) >= policy.min_perishable, "perishable_floor"


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
