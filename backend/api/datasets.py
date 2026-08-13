"""Dataset upload and descriptive statistics endpoints."""

from __future__ import annotations

import numpy as np
from fastapi import APIRouter, File, HTTPException, UploadFile

from backend.core import config, data_loader, preprocessing
from backend.core.store import DatasetNotFound, store
from backend.schemas.datasets import (
    CategoryCount,
    DatasetOut,
    DatasetSummaryOut,
    NumericStat,
    TerminalStat,
)

router = APIRouter(prefix="/api/datasets", tags=["datasets"])


def _to_out(record) -> DatasetOut:
    return DatasetOut(
        dataset_id=record.dataset_id,
        name=record.name,
        n_rows=len(record.df),
        n_columns=len(record.df.columns),
        uploaded_at=record.uploaded_at.isoformat(),
        warnings=record.warnings,
    )


@router.post("", response_model=DatasetOut)
async def upload_dataset(file: UploadFile = File(...)) -> DatasetOut:
    if not file.filename or not file.filename.lower().endswith(".csv"):
        raise HTTPException(status_code=400, detail="Upload must be a .csv file")

    raw = data_loader.load_csv(await file.read())
    report = data_loader.validate(raw)
    if not report.ok:
        raise HTTPException(status_code=422, detail={"errors": report.errors})

    record = store.register(
        data_loader.clean(raw), file.filename, report.warnings
    )
    return _to_out(record)


@router.post("/bundled", response_model=DatasetOut)
def load_bundled_dataset() -> DatasetOut:
    """Register the CSV shipped with the project, so the UI works with no upload."""
    try:
        return _to_out(store.load_bundled())
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.get("", response_model=list[DatasetOut])
def list_datasets() -> list[DatasetOut]:
    return [_to_out(r) for r in store.list_all()]


@router.get("/{dataset_id}/summary", response_model=DatasetSummaryOut)
def dataset_summary(dataset_id: str) -> DatasetSummaryOut:
    try:
        record = store.get(dataset_id)
    except DatasetNotFound as exc:
        raise HTTPException(
            status_code=404, detail=f"Unknown dataset_id '{dataset_id}'"
        ) from exc

    df = record.df
    numeric = df[list(config.NUMERIC_COLUMNS)]

    numeric_stats = [
        NumericStat(
            column=col,
            min=float(numeric[col].min()),
            max=float(numeric[col].max()),
            mean=float(numeric[col].mean()),
            std=float(numeric[col].std()),
            median=float(numeric[col].median()),
        )
        for col in config.NUMERIC_COLUMNS
    ]

    categorical_counts = [
        CategoryCount(
            column=col,
            counts={str(k): int(v) for k, v in df[col].value_counts().items()},
        )
        for col in config.CATEGORICAL_COLUMNS
    ]

    summary = preprocessing.terminal_summary(df)
    terminal_stats = [
        TerminalStat(
            terminal=str(t),
            n_records=int(row["n_records"]),
            mean_workforce=float(row["mean_workforce"]),
            mean_equipment=float(row["mean_equipment"]),
            mean_throughput=float(row["mean_throughput"]),
            mean_cost=float(row["mean_cost"]),
            mean_demand_forecast=float(row["mean_demand_forecast"]),
            mean_facility_util=float(row["mean_facility_util"]),
            bottleneck_rate=float(row["bottleneck_rate"]),
            throughput_capacity=float(row["throughput_capacity"]),
        )
        for t, row in summary.iterrows()
    ]

    corr = numeric.corr().replace({np.nan: 0.0})
    max_offdiag = float(
        corr.where(~np.eye(len(corr), dtype=bool)).abs().max().max()
    )

    return DatasetSummaryOut(
        dataset_id=dataset_id,
        n_rows=len(df),
        kpis={
            "n_records": float(len(df)),
            "n_terminals": float(df[config.COL_TERMINAL].nunique()),
            "mean_throughput": float(df[config.COL_THROUGHPUT].mean()),
            "mean_operational_cost": float(df[config.COL_OPERATIONAL_COST].mean()),
            "mean_waiting_time": float(df[config.COL_WAITING_TIME].mean()),
            "total_cargo_volume": float(df[config.COL_CARGO_VOLUME].sum()),
            "bottleneck_rate": float(df[config.COL_BOTTLENECK].mean()),
        },
        numeric_stats=numeric_stats,
        categorical_counts=categorical_counts,
        terminal_stats=terminal_stats,
        correlation={
            str(r): {str(c): float(v) for c, v in row.items()}
            for r, row in corr.iterrows()
        },
        correlation_note=(
            f"Strongest off-diagonal correlation is {max_offdiag:.3f}. The dataset "
            "is synthetic and its columns are mutually independent, so model "
            "coefficients are derived from stated assumptions rather than fitted."
        ),
    )
