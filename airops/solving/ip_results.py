"""Part 2 - result containers, and the one function that scores a selection.

The optimiser's answer and every baseline are scored by `evaluate_selection`, so
comparing them is honest by construction (MODEL.md section 5).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Iterable, Sequence

from airops.core import config
from or_models.inputs import SelectionProblem, ShipmentItem

OBJECTIVE_LABEL = "Maximise priority-weighted value of the processed set"


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
