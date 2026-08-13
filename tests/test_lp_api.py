"""Endpoint tests for Part 1 (M4).

The contract these lock down: derived parameters are visible before solving, a
solve always answers 200 with a status, and an unsolvable scenario returns
advice instead of a stack trace.
"""

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


def solve(dataset_id: str, **overrides) -> dict:
    body = {"dataset_id": dataset_id, **overrides}
    response = client.post("/api/lp/solve", json=body)
    assert response.status_code == 200, response.text
    return response.json()


# --- /parameters --------------------------------------------------------------


def test_parameters_expose_every_coefficient(dataset_id: str) -> None:
    body = client.post(
        "/api/lp/parameters", json={"dataset_id": dataset_id}
    ).json()

    assert body["n_records"] == 5000
    assert len(body["terminals"]) == 4
    for row in body["terminals"]:
        for key in ("alpha", "beta", "cost_worker", "cost_equipment",
                    "demand", "capacity"):
            assert row[key] > 0
        assert row["workforce_min"] < row["workforce_max"]

    assert body["workforce_total"] > 0
    assert set(body["unmet_penalty"]) == {"max_throughput", "min_cost"}


def test_parameters_carry_their_derivation_and_the_caveat(dataset_id: str) -> None:
    body = client.post(
        "/api/lp/parameters", json={"dataset_id": dataset_id}
    ).json()

    symbols = {note["symbol"] for note in body["derivation"]}
    assert {"α_t", "β_t", "γ_t", "D_t", "Cap_t"} <= symbols
    assert all(note["formula"] and note["explanation"]
               for note in body["derivation"])
    assert body["caveat"] == config.MODEL_WORLD_CAVEAT


def test_parameters_reflect_the_labor_share_slider(dataset_id: str) -> None:
    low = client.post("/api/lp/parameters", json={
        "dataset_id": dataset_id, "labor_share": 0.3}).json()
    high = client.post("/api/lp/parameters", json={
        "dataset_id": dataset_id, "labor_share": 0.8}).json()

    for a, b in zip(low["terminals"], high["terminals"]):
        assert b["alpha"] > a["alpha"]
        assert b["beta"] < a["beta"]


def test_disabling_congestion_is_reported(dataset_id: str) -> None:
    body = client.post("/api/lp/parameters", json={
        "dataset_id": dataset_id, "apply_congestion": False}).json()

    assert body["assumptions"]["congestion_applied"] is False
    assert all(row["congestion"] == 1.0 for row in body["terminals"])
    note = next(n for n in body["derivation"] if n["symbol"] == "γ_t")
    assert "degeneracy" in note["explanation"]


def test_filters_narrow_the_scenario(dataset_id: str) -> None:
    body = client.post("/api/lp/parameters", json={
        "dataset_id": dataset_id,
        "filters": {"terminals": ["T1", "T2"], "peak_hour": 1},
    }).json()

    assert [row["terminal"] for row in body["terminals"]] == ["T1", "T2"]
    assert body["n_records"] < 5000
    assert any("No records for terminal" in w for w in body["warnings"])


def test_unknown_dataset_is_404() -> None:
    assert client.post(
        "/api/lp/parameters", json={"dataset_id": "nope"}
    ).status_code == 404


def test_empty_scenario_is_422(dataset_id: str) -> None:
    response = client.post("/api/lp/parameters", json={
        "dataset_id": dataset_id,
        "filters": {"terminals": ["T1"], "weather": ["Snow"]},
    })
    assert response.status_code == 422
    assert "empty" in str(response.json()["detail"]).lower()


def test_out_of_range_labor_share_is_rejected(dataset_id: str) -> None:
    response = client.post("/api/lp/parameters", json={
        "dataset_id": dataset_id, "labor_share": 1.5})
    assert response.status_code == 422


# --- /solve -------------------------------------------------------------------


@pytest.mark.parametrize("objective", ["max_throughput", "min_cost"])
def test_solve_returns_a_full_result(dataset_id: str, objective: str) -> None:
    body = solve(dataset_id, objective=objective)

    assert body["status"] == "Optimal"
    assert body["objective"] == objective
    assert len(body["allocation"]) == 4
    assert body["duals"]
    assert body["comparison"]["headline"]["label"]
    assert body["caveat"] == config.MODEL_WORLD_CAVEAT

    for row in body["allocation"]:
        assert row["delta_workforce"] == pytest.approx(
            row["optimized_workforce"] - row["baseline_workforce"]
        )
        assert row["optimized_throughput"] <= row["capacity"] + 1e-6


def test_solve_respects_the_resource_pools(dataset_id: str) -> None:
    body = solve(dataset_id)
    resources = body["resources"]
    assert resources["workforce_used"] <= resources["workforce_available"] + 1e-6
    assert resources["equipment_used"] <= resources["equipment_available"] + 1e-6


@pytest.mark.parametrize("objective", ["max_throughput", "min_cost"])
def test_optimum_beats_the_baseline_on_its_own_objective(
    dataset_id: str, objective: str
) -> None:
    headline = solve(dataset_id, objective=objective)["comparison"]["headline"]
    if objective == "max_throughput":
        assert headline["optimized"] >= headline["baseline"] - 1e-6
    else:
        assert headline["optimized"] <= headline["baseline"] + 1e-6


def test_default_run_is_not_an_expanded_resources_scenario(dataset_id: str) -> None:
    body = solve(dataset_id)
    assert body["expanded_resources"] is False
    assert not any("Expanded-resources" in n
                   for n in body["comparison"]["notes"])


def test_raised_pool_is_labelled(dataset_id: str) -> None:
    body = solve(dataset_id, workforce_pool_factor=1.2)
    assert body["expanded_resources"] is True
    assert any("Expanded-resources" in n for n in body["comparison"]["notes"])


def test_duals_are_reported_with_an_interpretation(dataset_id: str) -> None:
    body = solve(dataset_id)
    assert body["binding_constraints"]
    for dual in body["duals"]:
        assert dual["interpretation"]
        # Binding must never contradict the shadow price shown beside it.
        if abs(dual["shadow_price"]) > config.DUAL_ZERO_TOL:
            assert dual["binding"]
        if not dual["binding"]:
            assert dual["slack"] > 1e-6
    assert {d["name"] for d in body["duals"]} >= {"worker_pool", "equipment_pool"}


def test_a_starved_pool_returns_advice_not_a_500(dataset_id: str) -> None:
    """A shrunken pool that cannot cover minimum staffing must degrade politely."""
    body = solve(dataset_id, workforce_pool_factor=0.8, demand_scale=5.0)
    assert body["status"] in {"Optimal", "Infeasible"}
    if body["status"] == "Infeasible":
        assert body["suggestions"]


def test_an_impossible_budget_returns_suggestions(dataset_id: str) -> None:
    body = solve(dataset_id, objective="min_cost", budget_factor=0.01)
    assert body["status"] == "Infeasible"
    assert body["allocation"] == []
    assert body["comparison"] is None
    assert any("budget" in s.lower() for s in body["suggestions"])


def test_unmeetable_demand_is_reported_as_slack(dataset_id: str) -> None:
    body = solve(dataset_id, objective="min_cost", demand_scale=3.0)
    assert body["status"] == "Optimal"
    assert sum(row["unmet_demand"] for row in body["allocation"]) > 0


def test_budget_cap_is_respected(dataset_id: str) -> None:
    body = solve(dataset_id, objective="max_throughput", budget_factor=0.9)
    assert body["status"] == "Optimal"
    assert body["resources"]["cost_incurred"] <= body["resources"]["budget"] + 1e-6


def test_solve_is_fast_enough_to_stay_synchronous(dataset_id: str) -> None:
    assert solve(dataset_id)["solve_seconds"] < 2.0


# --- /sensitivity -------------------------------------------------------------


def test_sensitivity_sweeps_the_worker_pool(dataset_id: str) -> None:
    body = client.post("/api/lp/sensitivity", json={
        "dataset_id": dataset_id, "objective": "max_throughput",
        "factor_min": 0.8, "factor_max": 1.2, "points": 9,
    }).json()

    assert len(body["points"]) == 9
    assert body["swept"] == "workforce_total"
    factors = [p["factor"] for p in body["points"]]
    assert factors == sorted(factors)
    assert all(p["status"] == "Optimal" for p in body["points"])


def test_more_workers_never_hurt_the_throughput_objective(dataset_id: str) -> None:
    """Relaxing a constraint cannot make a maximisation worse."""
    body = client.post("/api/lp/sensitivity", json={
        "dataset_id": dataset_id, "objective": "max_throughput", "points": 7,
    }).json()

    values = [p["objective_value"] for p in body["points"]]
    assert all(b >= a - 1e-6 for a, b in zip(values, values[1:]))


def test_more_workers_never_hurt_the_cost_objective(dataset_id: str) -> None:
    body = client.post("/api/lp/sensitivity", json={
        "dataset_id": dataset_id, "objective": "min_cost", "points": 7,
    }).json()

    values = [p["objective_value"] for p in body["points"]]
    assert all(b <= a + 1e-6 for a, b in zip(values, values[1:]))


def test_sensitivity_rejects_an_inverted_range(dataset_id: str) -> None:
    response = client.post("/api/lp/sensitivity", json={
        "dataset_id": dataset_id, "factor_min": 1.2, "factor_max": 0.8,
    })
    assert response.status_code == 422


# --- Caching ------------------------------------------------------------------


def test_repeated_parameter_calls_are_cached(dataset_id: str) -> None:
    from backend.core import preprocessing

    preprocessing.clear_parameter_cache()
    payload = {"dataset_id": dataset_id, "labor_share": 0.55}

    first = client.post("/api/lp/parameters", json=payload).json()
    cache_size = len(preprocessing._PARAM_CACHE)
    second = client.post("/api/lp/parameters", json=payload).json()

    assert first == second
    assert len(preprocessing._PARAM_CACHE) == cache_size == 1
