"""Endpoint tests for Part 2 (M7).

The contract these lock down: the batch and its value scores are visible before
solving, a solve always answers 200 with a status, Part 1's allocation can be
handed in so the two-stage model is real, and Part 2 still works standalone.
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


def batch(dataset_id: str, **overrides) -> dict:
    response = client.post(
        "/api/ip/batch", json={"dataset_id": dataset_id, **overrides}
    )
    assert response.status_code == 200, response.text
    return response.json()


def solve(dataset_id: str, **overrides) -> dict:
    response = client.post(
        "/api/ip/solve", json={"dataset_id": dataset_id, **overrides}
    )
    assert response.status_code == 200, response.text
    return response.json()


def lp_allocation(dataset_id: str) -> dict[str, float]:
    body = client.post("/api/lp/solve", json={"dataset_id": dataset_id}).json()
    assert body["status"] == "Optimal"
    return {r["terminal"]: r["optimized_workforce"] for r in body["allocation"]}


# --- /batch -------------------------------------------------------------------


def test_batch_returns_scored_shipments(dataset_id: str) -> None:
    body = batch(dataset_id, size=40)

    assert len(body["shipments"]) == 40
    assert body["totals"]["n_shipments"] == 40
    assert body["caveat"] == config.MODEL_WORLD_CAVEAT
    assert "λ_w" in body["value_formula"]

    for row in body["shipments"]:
        assert row["value"] > 0
        assert row["volume"] > 0
        assert row["worker_minutes"] > 0
        assert row["equipment_minutes"] > 0
        assert 0.0 <= row["urgency_uplift"] <= config.URGENCY_UPLIFT_CAP + 1e-9
        assert row["value"] == pytest.approx(
            row["priority_weight"] * (1 + row["urgency_uplift"])
        )


def test_batch_reports_its_capacity_defaults(dataset_id: str) -> None:
    body = batch(dataset_id, size=50, capacity_fraction=0.6)
    caps = body["capacities"]

    assert caps["fraction"] == 0.6
    assert caps["worker_minutes_source"] == "batch_fraction"
    assert caps["volume"] == pytest.approx(body["totals"]["total_volume"] * 0.6)
    assert caps["equipment_minutes"] == pytest.approx(
        body["totals"]["total_equipment_minutes"] * 0.6
    )
    assert set(caps["worker_minutes"]) <= set(config.TERMINALS)


def test_batch_priority_ordering_survives_any_lambda(dataset_id: str) -> None:
    body = batch(dataset_id, size=200, lambda_waiting=1.0, lambda_queue=1.0)
    by_class: dict[str, list[float]] = {}
    for row in body["shipments"]:
        by_class.setdefault(row["priority"], []).append(row["value"])

    for higher, lower in (("Critical", "High"), ("High", "Medium"),
                          ("Medium", "Low")):
        if higher in by_class and lower in by_class:
            assert min(by_class[higher]) > max(by_class[lower])


def test_out_of_range_lambda_is_rejected(dataset_id: str) -> None:
    response = client.post("/api/ip/batch", json={
        "dataset_id": dataset_id, "lambda_waiting": 3.0})
    assert response.status_code == 422


def test_an_uncapped_urgency_uplift_cannot_be_requested(dataset_id: str) -> None:
    """The priority-inversion bug must not be reachable from the wire."""
    response = client.post("/api/ip/batch", json={
        "dataset_id": dataset_id, "urgency_cap": 1.5})
    assert response.status_code == 422


def test_narrow_priority_weights_are_flagged(dataset_id: str) -> None:
    body = batch(dataset_id, size=60, priority_weights={
        "Critical": 2.0, "High": 1.8, "Medium": 1.5, "Low": 1.0})
    assert any("lexicographic" in w for w in body["warnings"])


def test_batch_filters_narrow_the_pool(dataset_id: str) -> None:
    body = batch(dataset_id, size=40, filters={"terminals": ["T2"]})
    assert {r["terminal"] for r in body["shipments"]} == {"T2"}
    assert set(body["totals"]["terminal_mix"]) == {"T2"}


def test_unknown_dataset_is_404() -> None:
    assert client.post(
        "/api/ip/batch", json={"dataset_id": "nope"}
    ).status_code == 404


def test_empty_batch_is_422(dataset_id: str) -> None:
    response = client.post("/api/ip/batch", json={
        "dataset_id": dataset_id, "filters": {"terminals": ["T9"]}})
    assert response.status_code == 422
    assert "No shipments" in str(response.json()["detail"])


def test_oversized_batch_is_rejected(dataset_id: str) -> None:
    response = client.post("/api/ip/batch", json={
        "dataset_id": dataset_id, "size": config.MAX_BATCH_SIZE + 1})
    assert response.status_code == 422


# --- /solve -------------------------------------------------------------------


def test_solve_returns_a_full_result(dataset_id: str) -> None:
    body = solve(dataset_id, size=50)

    assert body["status"] == "Optimal"
    assert len(body["shipments"]) == 50
    assert body["comparison"] is not None
    assert body["caveat"] == config.MODEL_WORLD_CAVEAT
    assert "no shadow prices" in body["duals_note"]

    accepted = [r for r in body["shipments"] if r["accepted"]]
    assert 0 < len(accepted) < 50
    assert body["comparison"]["optimized"]["n_accepted"] == len(accepted)


def test_solve_respects_every_capacity(dataset_id: str) -> None:
    body = solve(dataset_id, size=50)
    for use in body["comparison"]["optimized"]["capacity_use"]:
        assert use["used"] <= use["available"] + 1e-6
        assert 0.0 <= use["utilization"] <= 1.0 + 1e-9


def test_optimum_beats_fcfs_on_the_same_value_function(dataset_id: str) -> None:
    comparison = solve(dataset_id, size=60)["comparison"]
    assert comparison["optimized"]["total_value"] >= (
        comparison["baseline"]["total_value"] - 1e-6
    )
    assert comparison["value_delta"] >= -1e-6
    # The interesting number: the two disagree about which shipments to take.
    assert comparison["set_difference"] > 0.0


def test_round_trip_batch_then_solve_agree(dataset_id: str) -> None:
    """The same seed must produce the same batch in both endpoints."""
    preview = batch(dataset_id, size=45, seed=7)
    solved = solve(dataset_id, size=45, seed=7)

    assert [r["record_id"] for r in preview["shipments"]] == [
        r["record_id"] for r in solved["shipments"]
    ]
    assert solved["capacities"]["volume"] == pytest.approx(
        preview["capacities"]["volume"]
    )


def test_binding_capacities_are_reported(dataset_id: str) -> None:
    body = solve(dataset_id, size=50, capacity_fraction=0.4)
    assert body["binding_capacities"]
    keys = {u["key"] for u in body["comparison"]["optimized"]["capacity_use"]}
    assert set(body["binding_capacities"]) <= keys


# --- The two-stage coupling ---------------------------------------------------


def test_standalone_solve_works_and_says_so(dataset_id: str) -> None:
    """Part 2 must be testable without Part 1 (SCOPE.md M7)."""
    body = solve(dataset_id, size=40)
    assert body["status"] == "Optimal"
    assert body["two_stage"] is False
    assert body["capacities"]["worker_minutes_source"] == "batch_fraction"
    assert any("self-referential" in w for w in body["warnings"])


def test_part_one_allocation_feeds_the_worker_budget(dataset_id: str) -> None:
    allocation = lp_allocation(dataset_id)
    body = solve(dataset_id, size=50, lp_workforce=allocation)

    assert body["status"] == "Optimal"
    assert body["two_stage"] is True
    caps = body["capacities"]
    assert caps["worker_minutes_source"] == "lp_allocation"

    for terminal, budget in caps["worker_minutes"].items():
        assert budget == pytest.approx(
            allocation[terminal]
            * config.PLANNING_HORIZON_HOURS
            * config.MINUTES_PER_HOUR
        )
    assert not any("self-referential" in w for w in body["warnings"])


def test_a_starved_terminal_in_part_one_shuts_it_out_in_part_two(
    dataset_id: str,
) -> None:
    starved = {t: (0.0 if t == "T1" else 40.0) for t in config.TERMINALS}
    body = solve(dataset_id, size=60, lp_workforce=starved)

    assert body["status"] == "Optimal"
    accepted = [r for r in body["shipments"] if r["accepted"]]
    assert accepted
    assert not any(r["terminal"] == "T1" for r in accepted)
    assert any("no workers" in w for w in body["warnings"])


# --- Policy toggles -----------------------------------------------------------


def test_force_critical_pins_every_critical_shipment(dataset_id: str) -> None:
    body = solve(dataset_id, size=50, capacity_fraction=0.9, force_critical=True)
    assert body["status"] == "Optimal"

    critical = [r for r in body["shipments"] if r["priority"] == "Critical"]
    assert critical
    assert all(r["accepted"] for r in critical)


def test_hazardous_cap_is_respected(dataset_id: str) -> None:
    body = solve(dataset_id, size=60, max_hazardous=2)
    assert body["status"] == "Optimal"
    accepted = [r for r in body["shipments"] if r["accepted"]]
    assert sum(1 for r in accepted if r["cargo_type"] == "Hazardous") <= 2


def test_perishable_floor_is_respected(dataset_id: str) -> None:
    body = solve(dataset_id, size=60, min_perishable=3)
    assert body["status"] == "Optimal"
    accepted = [r for r in body["shipments"] if r["accepted"]]
    assert sum(1 for r in accepted if r["cargo_type"] == "Perishable") >= 3


# --- Infeasibility is a 200 ---------------------------------------------------


def test_forced_critical_infeasibility_is_a_200_with_advice(
    dataset_id: str,
) -> None:
    """Never a 500: an unsatisfiable policy is a result, not a crash."""
    response = client.post("/api/ip/solve", json={
        "dataset_id": dataset_id, "size": 60,
        "capacity_fraction": 0.05, "force_critical": True,
    })
    assert response.status_code == 200
    body = response.json()

    assert body["status"] == "Infeasible"
    assert "Critical" in body["message"]
    assert body["suggestions"]
    assert body["shipments"] == []
    assert body["comparison"] is None


def test_impossible_perishable_floor_is_a_200_with_advice(
    dataset_id: str,
) -> None:
    response = client.post("/api/ip/solve", json={
        "dataset_id": dataset_id, "size": 30, "min_perishable": 500,
    })
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "Infeasible"
    assert "Perishable" in body["message"]
    assert body["suggestions"]


def test_a_starved_part_one_allocation_never_500s(dataset_id: str) -> None:
    response = client.post("/api/ip/solve", json={
        "dataset_id": dataset_id, "size": 40,
        "lp_workforce": {t: 0.0 for t in config.TERMINALS},
        "force_critical": True,
    })
    assert response.status_code == 200
    body = response.json()
    assert body["status"] in {"Optimal", "Infeasible"}
    if body["status"] == "Infeasible":
        assert body["suggestions"]


def test_solve_is_fast_enough_to_stay_synchronous(dataset_id: str) -> None:
    assert solve(dataset_id, size=200)["solve_seconds"] < 2.0


# --- Both baselines reach the response ---------------------------------------


def test_solve_reports_the_greedy_baseline_alongside_fcfs(
    dataset_id: str,
) -> None:
    """The response has to carry the harder comparison, not just the easy one."""
    body = solve(dataset_id)
    block = body["comparison"]

    assert block["greedy"] is not None
    assert block["greedy_rule"] in block["greedy_candidates"]
    assert block["greedy_value_delta"] is not None
    assert block["greedy_set_difference"] is not None

    # Optimal is an upper bound on both baselines.
    optimum = block["optimized"]["total_value"]
    assert optimum >= block["greedy"]["total_value"] - 1e-6
    assert optimum >= block["baseline"]["total_value"] - 1e-6

    # And greedy is the harder of the two, so the gap over it must be smaller.
    assert block["greedy_value_percent_delta"] < block["value_percent_delta"]


def test_the_note_quotes_both_gaps_and_names_the_honest_one(
    dataset_id: str,
) -> None:
    """A note claiming a small edge while returning a large one is the defect
    this guards: the figure quoted must be the one actually measured."""
    block = solve(dataset_id)["comparison"]
    note = next(n for n in block["notes"] if "greedy" in n and "%" in n)

    assert f"{block['value_percent_delta']:+.1f}%" in note
    assert f"{block['greedy_value_percent_delta']:+.1f}%" in note
    assert "honest" in note
