"""Plain-number inputs for the two models.

These classes hold *data only*.  Where the numbers come from (the CSV, the
closed-form share method, the UI sliders) is somebody else's job; the models
just receive them.  Every symbol in the comments matches MODEL.md.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

# --- Defaults shared with the application config ---------------------------------

DEFAULT_STAFFING_RATIO = 1.5      # rho: workers needed per equipment unit
DEFAULT_PENALTY_FACTOR = 10.0     # M = 10 x the largest throughput coefficient
FORCED_PRIORITY = "Critical"      # class pinned in by the "force Critical" policy
HAZARDOUS_CARGO_TYPE = "Hazardous"
PERISHABLE_CARGO_TYPE = "Perishable"


# =============================================================================
#  PART 1 - LP inputs
# =============================================================================


@dataclass(frozen=True)
class AllocationProblem:
    """Every number the allocation LP needs, per terminal t."""

    terminals: list[str]                          # T1..T4
    alpha: dict[str, float]                       # tons/h produced per worker
    beta: dict[str, float]                        # tons/h produced per equipment unit
    cost_worker: dict[str, float]                 # cost per worker (reported, budget)
    cost_equipment: dict[str, float]              # cost per equipment unit (reported, budget)
    demand: dict[str, float]                      # D_t, tons/h that must be handled
    capacity: dict[str, float]                    # Cap_t, physical ceiling, tons/h
    workforce_bounds: dict[str, tuple[float, float]]   # (w_min, w_max)
    equipment_bounds: dict[str, tuple[float, float]]   # (e_min, e_max)
    workforce_total: float                        # W, the worker pool
    equipment_total: float                        # E, the equipment pool
    budget: float | None = None                   # B, optional cost cap
    penalty_factor: float = DEFAULT_PENALTY_FACTOR
    staffing_ratio: float = DEFAULT_STAFFING_RATIO     # rho

    @property
    def unmet_penalty(self) -> float:
        """M: the price of one unit of unmet demand.

        It must dominate whatever the objective could gain by leaving demand
        unmet, so it is scaled to the largest throughput coefficient (alpha or
        beta).  It is a "large number", not a real currency amount.
        """
        coefficients = [*self.alpha.values(), *self.beta.values()]
        return self.penalty_factor * max([*coefficients, 1e-9])


# =============================================================================
#  PART 2 - IP inputs
# =============================================================================


@dataclass(frozen=True)
class ShipmentItem:
    """One candidate shipment, already scored."""

    record_id: str
    terminal: str
    priority: str            # Critical / High / Medium / Low
    cargo_type: str          # General / Express / Perishable / Hazardous
    timestamp: str
    value: float             # v_i, the objective coefficient
    priority_weight: float   # p_i
    urgency_uplift: float
    volume: float            # Vol_i
    worker_minutes: float    # handling time x workers
    equipment_minutes: float  # handling time x equipment units

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
    """The three resource limits of the knapsack."""

    volume: float                      # V_cap
    equipment_minutes: float           # E_cap
    worker_minutes: dict[str, float]   # per terminal: w_t* x H x 60 (from Part 1)
    #: "lp_allocation" when fed by Part 1, "batch_fraction" when standalone.
    worker_minutes_source: str = "batch_fraction"


@dataclass(frozen=True)
class PolicyOptions:
    """Optional policy rules the user can switch on."""

    force_critical: bool = False
    max_hazardous: int | None = None
    min_perishable: int | None = None


@dataclass(frozen=True)
class SelectionProblem:
    """Every number the shipment-selection IP needs."""

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
