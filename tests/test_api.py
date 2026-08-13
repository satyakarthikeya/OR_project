"""Endpoint tests for the data layer (M2)."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from backend.core import config
from backend.main import app

client = TestClient(app)


@pytest.fixture(scope="module")
def dataset_id() -> str:
    response = client.post("/api/datasets/bundled")
    assert response.status_code == 200
    return response.json()["dataset_id"]


def test_health_reports_solver() -> None:
    body = client.get("/api/health").json()
    assert body["status"] == "ok"
    assert body["solver_available"] is True


def test_bundled_dataset_loads(dataset_id: str) -> None:
    body = client.get("/api/datasets").json()
    assert any(d["dataset_id"] == dataset_id and d["n_rows"] == 5000 for d in body)


def test_upload_rejects_non_csv() -> None:
    response = client.post(
        "/api/datasets",
        files={"file": ("notes.txt", b"hello", "text/plain")},
    )
    assert response.status_code == 400


def test_upload_rejects_missing_columns() -> None:
    response = client.post(
        "/api/datasets",
        files={"file": ("bad.csv", b"a,b\n1,2\n", "text/csv")},
    )
    assert response.status_code == 422
    assert "Missing required columns" in str(response.json()["detail"])


def test_summary_returns_stats(dataset_id: str) -> None:
    body = client.get(f"/api/datasets/{dataset_id}/summary").json()

    assert body["n_rows"] == 5000
    assert body["kpis"]["n_terminals"] == 4
    assert len(body["numeric_stats"]) == len(config.NUMERIC_COLUMNS)
    assert len(body["terminal_stats"]) == 4

    priorities = next(
        c for c in body["categorical_counts"] if c["column"] == config.COL_PRIORITY
    )
    assert set(priorities["counts"]) == set(config.PRIORITIES)


def test_summary_flags_the_synthetic_data_limitation(dataset_id: str) -> None:
    body = client.get(f"/api/datasets/{dataset_id}/summary").json()
    assert "synthetic" in body["correlation_note"]

    corr = body["correlation"]
    off_diagonal = [
        abs(v) for r, row in corr.items() for c, v in row.items() if r != c
    ]
    assert max(off_diagonal) < 0.05


def test_unknown_dataset_id_is_404() -> None:
    assert client.get("/api/datasets/nope/summary").status_code == 404
