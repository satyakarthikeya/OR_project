"""Loading and schema validation for the air-cargo dataset.

Uploads are untrusted: validate before anything downstream assumes column names,
dtypes or category vocabularies.
"""

from __future__ import annotations

import io
from dataclasses import dataclass, field
from pathlib import Path

import pandas as pd

from backend.core import config


@dataclass
class ValidationReport:
    ok: bool
    n_rows: int
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    def raise_if_invalid(self) -> None:
        if not self.ok:
            raise ValueError("; ".join(self.errors))


def load_csv(source: str | Path | bytes) -> pd.DataFrame:
    """Read the dataset from a path or from raw uploaded bytes."""
    if isinstance(source, bytes):
        return pd.read_csv(io.BytesIO(source))
    return pd.read_csv(source)


def load_bundled() -> pd.DataFrame:
    if not config.BUNDLED_DATASET.exists():
        raise FileNotFoundError(f"Bundled dataset missing at {config.BUNDLED_DATASET}")
    return load_csv(config.BUNDLED_DATASET)


def validate(df: pd.DataFrame) -> ValidationReport:
    errors: list[str] = []
    warnings: list[str] = []

    missing = [c for c in config.REQUIRED_COLUMNS if c not in df.columns]
    if missing:
        errors.append(f"Missing required columns: {', '.join(missing)}")
        return ValidationReport(ok=False, n_rows=len(df), errors=errors)

    if df.empty:
        errors.append("Dataset contains no rows")
        return ValidationReport(ok=False, n_rows=0, errors=errors)

    for col in config.NUMERIC_COLUMNS:
        coerced = pd.to_numeric(df[col], errors="coerce")
        n_bad = int(coerced.isna().sum() - df[col].isna().sum())
        if n_bad > 0:
            errors.append(f"Column '{col}' has {n_bad} non-numeric values")

    for col, expected in config.EXPECTED_CATEGORIES.items():
        seen = set(df[col].dropna().astype(str).unique())
        unexpected = sorted(seen - set(expected))
        if unexpected:
            warnings.append(
                f"Column '{col}' has unexpected categories: {', '.join(unexpected[:5])}"
            )

    n_null = int(df[list(config.REQUIRED_COLUMNS)].isna().sum().sum())
    if n_null:
        warnings.append(f"{n_null} missing values will be dropped during cleaning")

    n_dup = int(df.duplicated().sum())
    if n_dup:
        warnings.append(f"{n_dup} duplicate rows will be dropped")

    if len(df) < config.MIN_ROWS_PER_TERMINAL * len(config.TERMINALS):
        warnings.append(
            f"Only {len(df)} rows; per-terminal group means may be unstable"
        )

    return ValidationReport(
        ok=not errors, n_rows=len(df), errors=errors, warnings=warnings
    )


def clean(df: pd.DataFrame) -> pd.DataFrame:
    """Normalise dtypes and derive the helper columns the models rely on.

    Assumes `validate` already passed.
    """
    out = df.copy()

    out[config.COL_TIMESTAMP] = pd.to_datetime(
        out[config.COL_TIMESTAMP], errors="coerce"
    )
    for col in config.NUMERIC_COLUMNS:
        out[col] = pd.to_numeric(out[col], errors="coerce")
    for col in config.CATEGORICAL_COLUMNS:
        out[col] = out[col].astype(str).str.strip()

    out = out.drop_duplicates()
    out = out.dropna(subset=list(config.REQUIRED_COLUMNS))

    # Denominator floors: a zero here would produce infinite productivity rates.
    out[config.COL_WORKFORCE] = out[config.COL_WORKFORCE].clip(
        lower=config.MIN_WORKFORCE
    )
    out[config.COL_EQUIPMENT] = out[config.COL_EQUIPMENT].clip(
        lower=config.MIN_EQUIPMENT
    )

    out["date"] = out[config.COL_TIMESTAMP].dt.date
    out["hour"] = out[config.COL_TIMESTAMP].dt.hour
    out["priority_weight"] = (
        out[config.COL_PRIORITY].map(config.PRIORITY_WEIGHTS).astype(float)
    )
    out["worker_minutes"] = (
        out[config.COL_HANDLING_TIME] * out[config.COL_WORKFORCE]
    )

    return out.reset_index(drop=True)


def load_and_clean(source: str | Path | bytes) -> tuple[pd.DataFrame, ValidationReport]:
    raw = load_csv(source)
    report = validate(raw)
    report.raise_if_invalid()
    return clean(raw), report
