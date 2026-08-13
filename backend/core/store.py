"""In-memory dataset registry.

The API is stateless per request, so an uploaded frame is parked here and
referenced by `dataset_id` in every later call. Deliberately not a database:
persistence is out of scope (SCOPE.md section 8).
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone

import pandas as pd

from backend.core import data_loader


class DatasetNotFound(KeyError):
    pass


@dataclass
class DatasetRecord:
    dataset_id: str
    name: str
    df: pd.DataFrame
    uploaded_at: datetime
    warnings: list[str] = field(default_factory=list)


class DatasetStore:
    def __init__(self) -> None:
        self._records: dict[str, DatasetRecord] = {}

    def register(
        self, df: pd.DataFrame, name: str, warnings: list[str] | None = None
    ) -> DatasetRecord:
        dataset_id = uuid.uuid4().hex[:12]
        record = DatasetRecord(
            dataset_id=dataset_id,
            name=name,
            df=df,
            uploaded_at=datetime.now(timezone.utc),
            warnings=warnings or [],
        )
        self._records[dataset_id] = record
        return record

    def get(self, dataset_id: str) -> DatasetRecord:
        try:
            return self._records[dataset_id]
        except KeyError as exc:
            raise DatasetNotFound(dataset_id) from exc

    def list_all(self) -> list[DatasetRecord]:
        return list(self._records.values())

    def load_bundled(self) -> DatasetRecord:
        """Register the bundled CSV, reusing it if already loaded."""
        for record in self._records.values():
            if record.name == config_bundled_name():
                return record
        raw = data_loader.load_bundled()
        report = data_loader.validate(raw)
        report.raise_if_invalid()
        return self.register(
            data_loader.clean(raw), config_bundled_name(), report.warnings
        )


def config_bundled_name() -> str:
    from backend.core import config

    return config.BUNDLED_DATASET.name


store = DatasetStore()
