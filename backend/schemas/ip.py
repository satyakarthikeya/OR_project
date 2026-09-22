"""Part 2 API contract.

These models are the single source of truth for the IP endpoints: the frontend
follows them, not the other way round (AGENT.md). Change a field here and the
frontend changes in the same commit.

Two validation rules here are load-bearing rather than cosmetic:

* `lambda_waiting` and `lambda_queue` are clamped to [0, 1]. They set the
  *balance* between the two urgency signals; the size of the uplift is fixed by
  `U` and is not the client's to widen.
* the urgency uplift can never be asked for above `config.URGENCY_UPLIFT_CAP`,
  which sits below the tightest adjacent priority ratio. Above it the value
  function stops enforcing the priority ordering it is built around
  (MODEL.md section 4.3).
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

from backend.core import config
from backend.schemas.common import ScenarioFiltersIn, SolveStatus


# --- Requests ----------------------------------------------------------------


class IPBatchIn(BaseModel):
    """Everything that defines the item set and its value scores."""

    dataset_id: str
    filters: ScenarioFiltersIn | None = None
    size: int = Field(
        default=config.DEFAULT_BATCH_SIZE, ge=1, le=config.MAX_BATCH_SIZE,
        description="How many shipments to draw into the batch.",
    )
    priority_weights: dict[str, float] | None = Field(
        default=None,
        description=(
            "Priority weights p_i, overriding the defaults "
            "(Critical 10, High 5, Medium 2, Low 1). Priority is lexicographic "
            "and urgency is only a tiebreaker, so keep adjacent ratios above "
            f"{1 + config.URGENCY_UPLIFT_CAP:g}."
        ),
    )
    lambda_waiting: float = Field(
        default=config.LAMBDA_WAITING,
        ge=config.LAMBDA_MIN, le=config.LAMBDA_MAX,
        description="Weight on normalised waiting time within the batch.",
    )
    lambda_queue: float = Field(
        default=config.LAMBDA_QUEUE,
        ge=config.LAMBDA_MIN, le=config.LAMBDA_MAX,
        description="Weight on normalised queue length within the batch.",
    )
    urgency_cap: float = Field(
        default=config.URGENCY_UPLIFT_CAP,
        ge=0.0, le=config.URGENCY_UPLIFT_CAP,
        description=(
            "U — the maximum urgency uplift, so the value multiplier spans "
            f"[1, 1+U]. Capped at {config.URGENCY_UPLIFT_CAP:g} because the "
            "tightest adjacent priority ratio is 2."
        ),
    )
    capacity_fraction: float = Field(
        default=config.DEFAULT_CAPACITY_FRACTION, ge=0.05, le=1.0,
        description=(
            "f — volume and equipment-minute capacities as a fraction of the "
            "batch totals. It does not touch the worker-minute budget, which "
            "comes from Part 1."
        ),
    )
    seed: int = Field(
        default=42, ge=0,
        description="Sampling seed, so a batch preview and its solve match.",
    )


class IPSolveIn(IPBatchIn):
    force_critical: bool = Field(
        default=False,
        description="Pin every Critical shipment into the processed set.",
    )
    max_hazardous: int | None = Field(
        default=None, ge=0,
        description="Optional cap on the number of Hazardous shipments.",
    )
    min_perishable: int | None = Field(
        default=None, ge=0,
        description="Optional floor on the number of Perishable shipments.",
    )
    lp_workforce: dict[str, float] | None = Field(
        default=None,
        description=(
            "Part 1's solved allocation w_t*, keyed by terminal. Supplying it "
            "makes constraint (2)'s right-hand side w_t* x H x 60 and turns the "
            "two models into one two-stage model. Omit it to solve Part 2 "
            "standalone, in which case the batch's own consumption stands in "
            "and the response says so."
        ),
    )


# --- Batch preview -----------------------------------------------------------


class ShipmentOut(BaseModel):
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


class CapacityDefaultsOut(BaseModel):
    volume: float
    equipment_minutes: float
    worker_minutes: dict[str, float]
    worker_minutes_source: Literal["lp_allocation", "batch_fraction"]
    fraction: float


class BatchTotalsOut(BaseModel):
    n_shipments: int
    total_value: float
    total_volume: float
    total_worker_minutes: float
    total_equipment_minutes: float
    priority_mix: dict[str, int]
    cargo_mix: dict[str, int]
    terminal_mix: dict[str, int]


class IPBatchOut(BaseModel):
    dataset_id: str
    shipments: list[ShipmentOut]
    totals: BatchTotalsOut
    capacities: CapacityDefaultsOut
    value_formula: str
    note: str
    warnings: list[str] = Field(default_factory=list)
    caveat: str = config.MODEL_WORLD_CAVEAT


# --- Solve response ----------------------------------------------------------


class SelectionRow(ShipmentOut):
    accepted: bool
    fcfs_accepted: bool
    #: "both", "ip_only", "fcfs_only" or "neither" — where the two disagree is
    #: the whole point of running the optimiser.
    status: Literal["both", "ip_only", "fcfs_only", "neither"]


class CapacityUseOut(BaseModel):
    key: str
    label: str
    terminal: str | None
    used: float
    available: float
    unit: str
    utilization: float
    binding: bool


class SelectionSummaryOut(BaseModel):
    label: str
    total_value: float
    n_accepted: int
    n_rejected: int
    priority_mix: dict[str, int]
    cargo_mix: dict[str, int]
    volume_used: float
    equipment_minutes_used: float
    worker_minutes_used: dict[str, float]
    capacity_use: list[CapacityUseOut]


class IPComparisonOut(BaseModel):
    optimized: SelectionSummaryOut
    baseline: SelectionSummaryOut
    #: The best of several value-density greedy rules. FCFS says what the
    #: dispatcher does today; this says what an obvious sensible rule would
    #: get, which is the harder and more honest comparison.
    greedy: SelectionSummaryOut | None = None
    value_delta: float
    value_percent_delta: float | None
    #: Same two numbers against the greedy baseline rather than FCFS.
    greedy_value_delta: float | None = None
    greedy_value_percent_delta: float | None = None
    #: Which greedy rule won, and what every rule tried scored — so "best
    #: greedy" is auditable rather than asserted.
    greedy_rule: str | None = None
    greedy_candidates: dict[str, float] = Field(default_factory=dict)
    accepted_delta: int
    #: Share of the two accepted sets that differs. Against FCFS.
    set_difference: float
    #: Share of the accepted sets that differs against the greedy baseline.
    greedy_set_difference: float | None = None
    notes: list[str] = Field(default_factory=list)


class IPSolveOut(BaseModel):
    """An infeasible model is a 200 with `status: Infeasible`, never a 5xx."""

    dataset_id: str
    status: SolveStatus
    message: str
    suggestions: list[str] = Field(default_factory=list)
    objective_label: str
    solve_seconds: float
    shipments: list[SelectionRow] = Field(default_factory=list)
    comparison: IPComparisonOut | None = None
    capacities: CapacityDefaultsOut | None = None
    binding_capacities: list[str] = Field(default_factory=list)
    two_stage: bool = False
    duals_note: str = (
        "An integer program has no shadow prices: its value function is a "
        "non-convex step function and LP-relaxation duals are not valid "
        "marginal values across the integrality gap. Sensitivity for Part 2 "
        "means re-solving at a different capacity."
    )
    warnings: list[str] = Field(default_factory=list)
    caveat: str = config.MODEL_WORLD_CAVEAT
