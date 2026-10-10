"""Schemas for dataset upload and descriptive statistics."""

from __future__ import annotations

from pydantic import BaseModel, Field


class DatasetOut(BaseModel):
    dataset_id: str
    name: str
    n_rows: int
    n_columns: int
    uploaded_at: str
    warnings: list[str] = Field(default_factory=list)


class NumericStat(BaseModel):
    column: str
    min: float
    max: float
    mean: float
    std: float
    median: float


class CategoryCount(BaseModel):
    column: str
    counts: dict[str, int]


class TerminalStat(BaseModel):
    terminal: str
    n_records: int
    mean_workforce: float
    mean_equipment: float
    mean_throughput: float
    mean_cost: float
    mean_demand_forecast: float
    mean_facility_util: float
    bottleneck_rate: float
    throughput_capacity: float


class DatasetSummaryOut(BaseModel):
    dataset_id: str
    n_rows: int
    kpis: dict[str, float]
    numeric_stats: list[NumericStat]
    categorical_counts: list[CategoryCount]
    terminal_stats: list[TerminalStat]
    correlation: dict[str, dict[str, float]]
    correlation_note: str
