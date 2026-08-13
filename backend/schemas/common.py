"""Response pieces shared by both optimisation models."""

from __future__ import annotations

from enum import Enum

from pydantic import BaseModel, Field


class SolveStatus(str, Enum):
    OPTIMAL = "Optimal"
    NOT_SOLVED = "Not Solved"
    INFEASIBLE = "Infeasible"
    UNBOUNDED = "Unbounded"
    UNDEFINED = "Undefined"


class SolveOutcome(BaseModel):
    """Solver outcome. An infeasible model is a result, not an HTTP error."""

    status: SolveStatus
    message: str = ""
    suggestions: list[str] = Field(default_factory=list)


class ScenarioFiltersIn(BaseModel):
    terminals: list[str] | None = None
    cargo_types: list[str] | None = None
    priorities: list[str] | None = None
    directions: list[str] | None = None
    weather: list[str] | None = None
    peak_hour: int | None = Field(default=None, ge=0, le=1)
    date_from: str | None = None
    date_to: str | None = None


class HealthOut(BaseModel):
    status: str
    solver_available: bool
    solver_name: str
    datasets_loaded: int
