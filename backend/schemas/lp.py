"""Part 1 API contract.

These models are the single source of truth for the LP endpoints: the frontend
follows them, not the other way round (AGENT.md). Change a field here and the
frontend changes in the same commit.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

from backend.core import config
from backend.schemas.common import ScenarioFiltersIn, SolveStatus

Objective = Literal["max_throughput", "min_cost"]


# --- Requests ----------------------------------------------------------------


class LPParametersIn(BaseModel):
    """Everything that affects how coefficients are derived, and nothing more."""

    dataset_id: str
    filters: ScenarioFiltersIn | None = None
    labor_share: float = Field(
        default=config.LABOR_SHARE, gt=0.0, lt=1.0,
        description="Share of throughput attributed to workers (theta).",
    )
    cost_labor_share: float = Field(
        default=config.COST_LABOR_SHARE, gt=0.0, lt=1.0,
        description="Share of operational cost attributed to workers.",
    )
    congestion_delta: float = Field(
        default=config.CONGESTION_DELTA, ge=0.0, le=4.0,
        description="Exponent on the facility-utilisation term of gamma.",
    )
    apply_congestion: bool = Field(
        default=True,
        description=(
            "Turn the congestion multiplier off to see the degenerate model the "
            "multiplier exists to prevent."
        ),
    )
    demand_scale: float = Field(
        default=1.0, gt=0.0, le=5.0,
        description="Stress-test multiplier on per-terminal demand.",
    )
    demand_day: Literal["mean", "p95"] = Field(
        default=config.DEMAND_DAY_AGGREGATION,
        description=(
            "Which planning window D_t describes: the average day, or the "
            "95th-percentile busy day where the slack variables switch on."
        ),
    )


class LPSolveIn(LPParametersIn):
    objective: Objective = "max_throughput"
    workforce_pool_factor: float = Field(
        default=1.0, ge=config.POOL_FACTOR_MIN, le=config.POOL_FACTOR_MAX,
        description="Worker pool as a multiple of the observed total.",
    )
    equipment_pool_factor: float = Field(
        default=1.0, ge=config.POOL_FACTOR_MIN, le=config.POOL_FACTOR_MAX,
        description="Equipment pool as a multiple of the observed total.",
    )
    budget_factor: float | None = Field(
        default=None, gt=0.0, le=5.0,
        description=(
            "Optional cost cap, as a multiple of the baseline operational cost. "
            "Omit for no budget constraint."
        ),
    )


class LPSensitivityIn(LPSolveIn):
    factor_min: float = Field(default=config.POOL_FACTOR_MIN, ge=0.1, le=3.0)
    factor_max: float = Field(default=config.POOL_FACTOR_MAX, ge=0.1, le=3.0)
    points: int = Field(
        default=config.SENSITIVITY_POINTS, ge=3, le=config.MAX_SENSITIVITY_POINTS
    )


# --- Parameter response ------------------------------------------------------


class DerivationNote(BaseModel):
    """One coefficient, its formula, and why it is defensible."""

    symbol: str
    name: str
    formula: str
    explanation: str


class LPAssumptionsOut(BaseModel):
    labor_share: float
    cost_labor_share: float
    congestion_delta: float
    congestion_applied: bool
    horizon_hours: float
    demand_day: str
    demand_scale: float
    staffing_ratio: float
    capacity_percentile: float
    bound_percentiles: list[float]
    n_records: int


class TerminalParametersOut(BaseModel):
    terminal: str
    alpha: float
    beta: float
    alpha_uncongested: float
    beta_uncongested: float
    congestion: float
    cost_worker: float
    cost_equipment: float
    demand: float
    demand_tons: float
    capacity: float
    workforce_min: float
    workforce_max: float
    equipment_min: float
    equipment_max: float
    baseline_workforce: float
    baseline_equipment: float
    baseline_throughput: float
    baseline_cost: float


class LPParametersOut(BaseModel):
    dataset_id: str
    n_records: int
    terminals: list[TerminalParametersOut]
    workforce_total: float
    equipment_total: float
    baseline_throughput: float
    baseline_cost: float
    baseline_unmet_demand: float
    unmet_penalty: dict[str, float]
    assumptions: LPAssumptionsOut
    derivation: list[DerivationNote]
    warnings: list[str] = Field(default_factory=list)
    caveat: str = config.MODEL_WORLD_CAVEAT


# --- Solve response ----------------------------------------------------------


class AllocationRow(BaseModel):
    terminal: str
    baseline_workforce: float
    optimized_workforce: float
    delta_workforce: float
    baseline_equipment: float
    optimized_equipment: float
    delta_equipment: float
    baseline_throughput: float
    optimized_throughput: float
    demand: float
    capacity: float
    unmet_demand: float
    baseline_cost: float
    optimized_cost: float


class DualOut(BaseModel):
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


class MetricDeltaOut(BaseModel):
    key: str
    label: str
    unit: str
    baseline: float
    optimized: float
    delta: float
    percent_delta: float | None
    better: str
    improved: bool | None


class ComparisonOut(BaseModel):
    objective: Objective
    headline: MetricDeltaOut
    metrics: list[MetricDeltaOut]
    expanded_resources: bool
    notes: list[str] = Field(default_factory=list)


class ResourceUseOut(BaseModel):
    workforce_available: float
    workforce_used: float
    equipment_available: float
    equipment_used: float
    budget: float | None
    cost_incurred: float


class LPSolveOut(BaseModel):
    """An infeasible model is a 200 with `status: Infeasible`, never a 5xx."""

    dataset_id: str
    status: SolveStatus
    message: str
    suggestions: list[str] = Field(default_factory=list)
    objective: Objective
    objective_label: str
    solve_seconds: float
    allocation: list[AllocationRow] = Field(default_factory=list)
    resources: ResourceUseOut | None = None
    comparison: ComparisonOut | None = None
    duals: list[DualOut] = Field(default_factory=list)
    binding_constraints: list[str] = Field(default_factory=list)
    #: Which solve produced the allocation, and which produced the duals. With
    #: `e_t` integer these are never the same solve (MODEL.md 3.1).
    allocation_source: str = "milp"
    duals_source: str = "relaxation"
    duals_penalty_inflated: bool = False
    duals_note: str = ""
    unmet_penalty: float = 0.0
    expanded_resources: bool = False
    assumptions: LPAssumptionsOut | None = None
    warnings: list[str] = Field(default_factory=list)
    caveat: str = config.MODEL_WORLD_CAVEAT


# --- Sensitivity response ----------------------------------------------------


class SensitivityPoint(BaseModel):
    factor: float
    workforce_total: float
    status: SolveStatus
    objective_value: float | None
    total_throughput: float | None
    total_cost: float | None
    total_unmet_demand: float | None


class LPSensitivityOut(BaseModel):
    dataset_id: str
    objective: Objective
    objective_label: str
    swept: str = "workforce_total"
    baseline_workforce_total: float
    points: list[SensitivityPoint]
    note: str
    warnings: list[str] = Field(default_factory=list)
    caveat: str = config.MODEL_WORLD_CAVEAT
