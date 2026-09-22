"""Part 2 endpoints — IP shipment selection.

Translator only (AGENT.md): validate with Pydantic, ask `preprocessing` for the
batch and its capacities, ask `models.ip_shipment_selection` to solve and
`core.baseline` for FCFS, shape the response. No modelling decisions are taken
here.

`/batch` is split from `/solve` for the same reason `/parameters` is split from
`/solve` in Part 1: the value score behind every shipment can be inspected and
argued with before any optimisation runs.
"""

from __future__ import annotations

import pandas as pd
from fastapi import APIRouter, HTTPException

from backend.core import baseline as baseline_mod
from backend.core import config, preprocessing
from backend.core.preprocessing import ScenarioFilters
from backend.core.store import DatasetNotFound, store
from backend.models import ip_shipment_selection as ip
from backend.schemas.common import ScenarioFiltersIn, SolveStatus
from backend.schemas.ip import (
    BatchTotalsOut,
    CapacityDefaultsOut,
    CapacityUseOut,
    IPBatchIn,
    IPBatchOut,
    IPComparisonOut,
    IPSolveIn,
    IPSolveOut,
    SelectionRow,
    SelectionSummaryOut,
    ShipmentOut,
)

router = APIRouter(prefix="/api/ip", tags=["Part 2 — IP shipment selection"])

VALUE_FORMULA = (
    "v_i = p_i · [ 1 + U · (λ_w·ŵ_i + λ_q·q̂_i) / (λ_w + λ_q) ]"
)

BATCH_NOTE = (
    "Waiting time and queue length are min-max normalised within this batch, "
    "so the same shipment scores differently in a different batch — the "
    "urgency term is relative to the queue it is standing in. The uplift is "
    f"capped at U = {config.URGENCY_UPLIFT_CAP:g}, below the tightest adjacent "
    "priority ratio, so urgency orders shipments within a priority class and "
    "can never lift one class above the class above it. Priority is "
    "lexicographic; urgency is a tiebreaker."
)


# --- Shared plumbing ---------------------------------------------------------


def _filters(payload: ScenarioFiltersIn | None) -> ScenarioFilters | None:
    if payload is None:
        return None
    return ScenarioFilters(**payload.model_dump())


def _batch(payload: IPBatchIn) -> pd.DataFrame:
    """Fetch the dataset and assemble the batch, mapping failures onto 4xx."""
    try:
        record = store.get(payload.dataset_id)
    except DatasetNotFound as exc:
        raise HTTPException(
            status_code=404, detail=f"Unknown dataset_id '{payload.dataset_id}'"
        ) from exc

    try:
        return preprocessing.build_batch(
            record.df,
            filters=_filters(payload.filters),
            size=payload.size,
            priority_weights=payload.priority_weights,
            lambda_waiting=payload.lambda_waiting,
            lambda_queue=payload.lambda_queue,
            urgency_cap=payload.urgency_cap,
            seed=payload.seed,
        )
    except ValueError as exc:
        # An empty batch is a bad request, not a server fault.
        raise HTTPException(status_code=422, detail=str(exc)) from exc


def _capacities(
    payload: IPBatchIn, batch: pd.DataFrame, lp_workforce: dict | None = None
) -> dict:
    return preprocessing.default_capacities(
        batch,
        fraction=payload.capacity_fraction,
        lp_workforce=lp_workforce,
    )


def _capacity_defaults_out(capacities: dict) -> CapacityDefaultsOut:
    return CapacityDefaultsOut(**capacities)


def _shipment_out(item: dict) -> ShipmentOut:
    return ShipmentOut(**item)


def _mix(items: list[dict], key: str) -> dict[str, int]:
    out: dict[str, int] = {}
    for item in items:
        out[item[key]] = out.get(item[key], 0) + 1
    return out


# --- Batch preview -----------------------------------------------------------


@router.post("/batch", response_model=IPBatchOut)
def ip_batch(payload: IPBatchIn) -> IPBatchOut:
    """The candidate set, every value score, and the capacities it implies."""
    batch = _batch(payload)
    items = preprocessing.batch_items(batch)
    capacities = _capacities(payload, batch)

    warnings: list[str] = []
    if payload.priority_weights:
        ordered = [
            payload.priority_weights.get(p, config.PRIORITY_WEIGHTS[p])
            for p in ("Low", "Medium", "High", "Critical")
        ]
        ratios = [
            b / a for a, b in zip(ordered, ordered[1:]) if a > config.EPSILON
        ]
        if ratios and min(ratios) <= 1.0 + payload.urgency_cap:
            warnings.append(
                "These priority weights put two adjacent classes closer "
                f"together than the urgency uplift (1 + U = "
                f"{1 + payload.urgency_cap:g}), so an urgent shipment can "
                "outrank the class above it. Priority is meant to be "
                "lexicographic."
            )

    return IPBatchOut(
        dataset_id=payload.dataset_id,
        shipments=[_shipment_out(i) for i in items],
        totals=BatchTotalsOut(
            n_shipments=len(items),
            total_value=sum(i["value"] for i in items),
            total_volume=sum(i["volume"] for i in items),
            total_worker_minutes=sum(i["worker_minutes"] for i in items),
            total_equipment_minutes=sum(i["equipment_minutes"] for i in items),
            priority_mix=_mix(items, "priority"),
            cargo_mix=_mix(items, "cargo_type"),
            terminal_mix=_mix(items, "terminal"),
        ),
        capacities=_capacity_defaults_out(capacities),
        value_formula=VALUE_FORMULA,
        note=BATCH_NOTE,
        warnings=warnings,
    )


# --- Solve -------------------------------------------------------------------


def _summary(
    label: str, evaluation: ip.SelectionEvaluation
) -> SelectionSummaryOut:
    return SelectionSummaryOut(
        label=label,
        total_value=evaluation.total_value,
        n_accepted=evaluation.n_accepted,
        n_rejected=evaluation.n_rejected,
        priority_mix=evaluation.priority_mix,
        cargo_mix=evaluation.cargo_mix,
        volume_used=evaluation.volume_used,
        equipment_minutes_used=evaluation.equipment_minutes_used,
        worker_minutes_used=evaluation.worker_minutes_used,
        capacity_use=[
            CapacityUseOut(
                key=u.key, label=u.label, terminal=u.terminal,
                used=u.used, available=u.available, unit=u.unit,
                utilization=u.utilization, binding=u.binding,
            )
            for u in evaluation.capacity_use
        ],
    )


def _row_status(accepted: bool, fcfs: bool) -> str:
    if accepted and fcfs:
        return "both"
    if accepted:
        return "ip_only"
    if fcfs:
        return "fcfs_only"
    return "neither"


@router.post("/solve", response_model=IPSolveOut)
def ip_solve(payload: IPSolveIn) -> IPSolveOut:
    """Solve the selection IP. Infeasible is a 200 with a status and advice."""
    batch = _batch(payload)
    items = preprocessing.batch_items(batch)
    capacities = _capacities(payload, batch, lp_workforce=payload.lp_workforce)

    problem = ip.problem_from_batch(
        items,
        capacities,
        policy=ip.PolicyOptions(
            force_critical=payload.force_critical,
            max_hazardous=payload.max_hazardous,
            min_perishable=payload.min_perishable,
        ),
    )
    result = ip.solve_selection(problem)
    two_stage = capacities["worker_minutes_source"] == "lp_allocation"

    if not result.solved:
        return IPSolveOut(
            dataset_id=payload.dataset_id,
            status=SolveStatus(result.status),
            message=result.message,
            suggestions=result.suggestions,
            objective_label=result.objective_label,
            solve_seconds=result.solve_seconds,
            capacities=_capacity_defaults_out(capacities),
            two_stage=two_stage,
            warnings=list(result.warnings),
        )

    optimized = result.solution
    assert optimized is not None  # guaranteed by result.solved
    fcfs = baseline_mod.fcfs_baseline(problem)

    greedy = baseline_mod.greedy_baseline(problem)

    chosen = set(optimized.accepted)
    queued = set(fcfs.evaluation.accepted)

    def _against(other: ip.SelectionEvaluation) -> tuple[float, float | None, float]:
        theirs = set(other.accepted)
        union = chosen | theirs
        spread = len(chosen ^ theirs) / len(union) if union else 0.0
        gap = optimized.total_value - other.total_value
        pct = (
            gap / abs(other.total_value) * 100.0
            if abs(other.total_value) > config.EPSILON
            else None
        )
        return gap, pct, spread

    delta, percent, difference = _against(fcfs.evaluation)
    greedy_delta, greedy_percent, greedy_difference = _against(greedy.evaluation)

    notes = list(fcfs.notes)
    notes.extend(greedy.notes)
    # Two baselines, two very different gaps, and reporting only one of them
    # would mislead in opposite directions: FCFS flatters the optimiser
    # because arrival order carries no information about value, while the
    # greedy rule is the comparison an examiner will actually press on.
    fcfs_gap = "n/a" if percent is None else f"{percent:+.1f}%"
    greedy_gap = "n/a" if greedy_percent is None else f"{greedy_percent:+.1f}%"
    notes.append(
        f"All three selections are scored by the same value function under the "
        f"same capacities. The optimum beats first-come-first-served by "
        f"{fcfs_gap} and the best greedy rule by {greedy_gap} — the greedy "
        f"figure is the honest measure of what the optimiser buys, since "
        f"arrival order carries no information about value. Alongside it, the "
        f"{greedy_difference:.0%} difference in which shipments were chosen "
        f"and the guaranteed optimum are the rest of the case."
    )
    if not two_stage:
        notes.append(
            "Solved standalone: the worker-minute budgets are a fraction of "
            "this batch's own consumption rather than Part 1's allocation. "
            "Solve Part 1 and re-run to make this a genuine two-stage model."
        )

    return IPSolveOut(
        dataset_id=payload.dataset_id,
        status=SolveStatus.OPTIMAL,
        message=result.message,
        objective_label=result.objective_label,
        solve_seconds=result.solve_seconds,
        shipments=[
            SelectionRow(
                **item,
                accepted=item["record_id"] in chosen,
                fcfs_accepted=item["record_id"] in queued,
                status=_row_status(
                    item["record_id"] in chosen, item["record_id"] in queued
                ),
            )
            for item in items
        ],
        comparison=IPComparisonOut(
            optimized=_summary("Optimised selection", optimized),
            baseline=_summary("FCFS by arrival time", fcfs.evaluation),
            greedy=_summary(
                f"Best greedy ({greedy.rule.replace('_', ' ')})",
                greedy.evaluation,
            ),
            value_delta=delta,
            value_percent_delta=percent,
            greedy_value_delta=greedy_delta,
            greedy_value_percent_delta=greedy_percent,
            greedy_rule=greedy.rule,
            greedy_candidates=greedy.candidates,
            accepted_delta=optimized.n_accepted - fcfs.evaluation.n_accepted,
            set_difference=difference,
            greedy_set_difference=greedy_difference,
            notes=notes,
        ),
        capacities=_capacity_defaults_out(capacities),
        binding_capacities=[u.key for u in optimized.capacity_use if u.binding],
        two_stage=two_stage,
        warnings=list(result.warnings),
    )
