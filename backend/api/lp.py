"""Part 1 endpoints — LP workforce and equipment allocation.

Translator only (AGENT.md): validate with Pydantic, ask `preprocessing` for
parameters, ask `models.lp_resource_allocation` to solve, shape the response.
No modelling decisions are taken here.

`/parameters` is split from `/solve` deliberately: the UI can show exactly how
every coefficient was derived before any optimisation runs.
"""

from __future__ import annotations

import numpy as np
from fastapi import APIRouter, HTTPException

from backend.core import baseline as baseline_mod
from backend.core import comparison, config, preprocessing
from backend.core.preprocessing import LPParameters, ScenarioFilters
from backend.core.store import DatasetNotFound, store
from backend.models import lp_resource_allocation as lp
from backend.schemas.common import ScenarioFiltersIn, SolveStatus
from backend.schemas.lp import (
    AllocationRow,
    ComparisonOut,
    DerivationNote,
    DualOut,
    LPAssumptionsOut,
    LPParametersIn,
    LPParametersOut,
    LPSensitivityIn,
    LPSensitivityOut,
    LPSolveIn,
    LPSolveOut,
    MetricDeltaOut,
    ResourceUseOut,
    SensitivityPoint,
    TerminalParametersOut,
)

router = APIRouter(prefix="/api/lp", tags=["Part 1 — LP allocation"])


# --- Shared plumbing ---------------------------------------------------------


def _filters(payload: ScenarioFiltersIn | None) -> ScenarioFilters | None:
    if payload is None:
        return None
    return ScenarioFilters(**payload.model_dump())


def _derive(payload: LPParametersIn) -> LPParameters:
    """Fetch the dataset and derive parameters, mapping failures onto 4xx."""
    try:
        record = store.get(payload.dataset_id)
    except DatasetNotFound as exc:
        raise HTTPException(
            status_code=404, detail=f"Unknown dataset_id '{payload.dataset_id}'"
        ) from exc

    try:
        return preprocessing.estimate_lp_params_cached(
            dataset_id=payload.dataset_id,
            df=record.df,
            filters=_filters(payload.filters),
            labor_share=payload.labor_share,
            cost_labor_share=payload.cost_labor_share,
            congestion_delta=payload.congestion_delta,
            apply_congestion=payload.apply_congestion,
            demand_scale=payload.demand_scale,
            demand_day=payload.demand_day,
        )
    except ValueError as exc:
        # An empty scenario slice is a bad request, not a server fault.
        raise HTTPException(status_code=422, detail=str(exc)) from exc


def _build_problem(payload: LPSolveIn, params: LPParameters) -> lp.AllocationProblem:
    budget = (
        params.baseline_cost() * payload.budget_factor
        if payload.budget_factor is not None
        else None
    )
    return lp.problem_from_parameters(
        params,
        objective=payload.objective,
        workforce_total=params.workforce_total * payload.workforce_pool_factor,
        equipment_total=params.equipment_total * payload.equipment_pool_factor,
        budget=budget,
    )


def _assumptions(params: LPParameters) -> LPAssumptionsOut:
    return LPAssumptionsOut(**params.assumptions)


# --- Derived parameters ------------------------------------------------------


def _derivation_notes(params: LPParameters) -> list[DerivationNote]:
    """The audit trail for the parameters panel."""
    theta = params.assumptions["labor_share"]
    theta_c = params.assumptions["cost_labor_share"]
    horizon = params.assumptions["horizon_hours"]
    demand_day = params.assumptions["demand_day"]
    rho = params.assumptions["staffing_ratio"]
    delta = params.assumptions["congestion_delta"]
    day_label = (
        "the 95th-percentile busy day" if demand_day == "p95"
        else "the average day"
    )

    notes = [
        DerivationNote(
            symbol="α_t",
            name="Throughput per worker",
            formula=f"α_t = θ · T̄_t / w̄_t   (θ = {theta:g})",
            explanation=(
                "Closed-form share method. Together with β_t it reproduces the "
                "terminal's observed mean throughput at its observed mean "
                "inputs exactly, so the baseline is feasible by construction "
                "and needs no separate calibration."
            ),
        ),
        DerivationNote(
            symbol="β_t",
            name="Throughput per equipment unit",
            formula=f"β_t = (1 − θ) · T̄_t / ē_t   (θ = {theta:g})",
            explanation=(
                "The residual share of throughput, attributed to equipment. θ "
                "is the single free assumption in the whole derivation, which "
                "is why it is a slider rather than a constant."
            ),
        ),
        DerivationNote(
            symbol="c^w_t, c^e_t",
            name="Unit costs",
            formula=f"c^w_t = θ_c · C̄_t / w̄_t,  c^e_t = (1 − θ_c) · C̄_t / ē_t"
                    f"   (θ_c = {theta_c:g})",
            explanation=(
                "The same split applied to observed operational cost. Note that "
                "with θ = θ_c the two resources are equally cost-efficient "
                "inside a terminal; separating the two shares is what creates a "
                "genuine substitution trade-off."
            ),
        ),
        DerivationNote(
            symbol="D_t",
            name="Demand — a level over the horizon",
            formula=(
                f"D_t = (Σ_i∈t Demand_Forecast_i over {day_label}) / H"
                f"   (H = {horizon:g} h)"
            ),
            explanation=(
                "Demand_Forecast is a per-shipment tonnage and Throughput_Rate "
                "is tons per hour — a difference of dimension, not of scale. "
                "Summing the forecast over a terminal's window gives the tons "
                "arriving there, a level; only dividing by the horizon H makes "
                "it a rate the production function can be compared against. A "
                "mean would make a busy terminal and a quiet one identical, and "
                "a rescaling factor would keep tons as tons while pinning D_t "
                "to observed capability by construction."
            ),
        ),
        DerivationNote(
            symbol="ρ",
            name="Staffing coupling",
            formula=f"w_t ≥ ρ · e_t   (ρ = {rho:g})",
            explanation=(
                "Every equipment type in the data needs an operator. Without "
                "this the objective is separable in w and e, so inside the "
                "per-terminal box the model pushes equipment to its ceiling "
                "while workers sit on the floor and still books throughput "
                "through β_t e_t, with nobody driving the cranes. A stated "
                "operational assumption: the observed ratio of about 3.6 "
                "workers per machine clears it, so the baseline stays feasible."
            ),
        ),
        DerivationNote(
            symbol="Cap_t",
            name="Physical ceiling",
            formula=(
                f"Cap_t = {config.CAPACITY_PERCENTILE:.0%} percentile of "
                "observed Throughput_Rate_t"
            ),
            explanation=(
                "A percentile rather than the maximum, which is a single noisy "
                "row. Raised to the terminal's own modelled baseline throughput "
                "where the two collide, so the observed allocation can never be "
                "ruled infeasible."
            ),
        ),
        DerivationNote(
            symbol="bounds",
            name="Per-terminal allocation bounds",
            formula=(
                f"[{config.BOUND_LOW_PERCENTILE:.0%}, "
                f"{config.BOUND_HIGH_PERCENTILE:.0%}] percentile of observed "
                "Workforce_Assigned / Equipment_Used"
            ),
            explanation=(
                "Terminals can be neither abandoned nor over-stuffed. These "
                "bounds also keep the LP bounded and stop the optimum from "
                "landing on a degenerate corner."
            ),
        ),
        DerivationNote(
            symbol="W, E",
            name="Resource pools",
            formula="W_total = Σ_t w̄_t,  E_total = Σ_t ē_t",
            explanation=(
                "The resources the terminals were actually observed to use, so "
                "the default run re-allocates rather than adds. The sliders "
                "scale these; a run above 1.0 is flagged as an "
                "expanded-resources scenario."
            ),
        ),
    ]

    if params.assumptions["congestion_applied"]:
        notes.insert(2, DerivationNote(
            symbol="γ_t",
            name="Congestion multiplier",
            formula=(
                "γ_t = (1 − bottleneck_rate_t) · "
                f"(1 − facility_utilisation_t / 100)^{delta:g},  then "
                "α_t, β_t ← k · γ_t · (α_t, β_t) with "
                "k = Σ_t T̄_t / Σ_t γ_t T̄_t"
            ),
            explanation=(
                "The terminals in this dataset are statistically near-identical, "
                "so equal productivities would leave the LP indifferent between "
                "them and the optimum would be an artefact of solver scan order. "
                "Bottleneck rate and facility utilisation are the two "
                "per-terminal signals that genuinely vary. The renormalisation "
                "constant k redistributes productivity between terminals without "
                "changing system throughput, so the baseline total is preserved "
                "exactly. This is a stated modelling assumption, not an "
                "empirical finding."
            ),
        ))
    else:
        notes.insert(2, DerivationNote(
            symbol="γ_t",
            name="Congestion multiplier — disabled",
            formula="γ_t = 1 for every terminal",
            explanation=(
                "With congestion off the terminals are near-identical and the LP "
                "has no reason to prefer any of them; the allocation it returns "
                "is a solver artefact. This mode exists to demonstrate the "
                "degeneracy the multiplier was introduced to remove."
            ),
        ))
    return notes


def _terminal_rows(params: LPParameters) -> list[TerminalParametersOut]:
    rows = []
    for t in params.terminals:
        w, e = params.baseline_workforce[t], params.baseline_equipment[t]
        rows.append(TerminalParametersOut(
            terminal=t,
            alpha=params.alpha[t],
            beta=params.beta[t],
            alpha_uncongested=params.alpha_uncongested.get(t, params.alpha[t]),
            beta_uncongested=params.beta_uncongested.get(t, params.beta[t]),
            congestion=params.congestion.get(t, 1.0),
            cost_worker=params.cost_worker[t],
            cost_equipment=params.cost_equipment[t],
            demand=params.demand[t],
            demand_tons=params.demand_tons[t],
            capacity=params.capacity[t],
            workforce_min=params.workforce_bounds[t][0],
            workforce_max=params.workforce_bounds[t][1],
            equipment_min=params.equipment_bounds[t][0],
            equipment_max=params.equipment_bounds[t][1],
            baseline_workforce=w,
            baseline_equipment=e,
            baseline_throughput=params.alpha[t] * w + params.beta[t] * e,
            baseline_cost=params.cost_worker[t] * w + params.cost_equipment[t] * e,
        ))
    return rows


@router.post("/parameters", response_model=LPParametersOut)
def lp_parameters(payload: LPParametersIn) -> LPParametersOut:
    """Every derived coefficient, with the formula that produced it."""
    params = _derive(payload)
    problem = lp.problem_from_parameters(params)
    base = baseline_mod.observed_allocation_baseline(problem, params)

    penalties = {
        objective: lp.problem_from_parameters(
            params, objective=objective
        ).unmet_penalty
        for objective in ("max_throughput", "min_cost")
    }

    return LPParametersOut(
        dataset_id=payload.dataset_id,
        n_records=int(params.assumptions["n_records"]),
        terminals=_terminal_rows(params),
        workforce_total=params.workforce_total,
        equipment_total=params.equipment_total,
        baseline_throughput=params.baseline_throughput(),
        baseline_cost=params.baseline_cost(),
        baseline_unmet_demand=base.evaluation.total_unmet_demand,
        unmet_penalty=penalties,
        assumptions=_assumptions(params),
        derivation=_derivation_notes(params),
        warnings=list(params.warnings),
    )


# --- Solve -------------------------------------------------------------------


def _allocation_rows(
    problem: lp.AllocationProblem,
    base: lp.AllocationEvaluation,
    optimized: lp.AllocationEvaluation,
) -> list[AllocationRow]:
    return [
        AllocationRow(
            terminal=t,
            baseline_workforce=base.workforce[t],
            optimized_workforce=optimized.workforce[t],
            delta_workforce=optimized.workforce[t] - base.workforce[t],
            baseline_equipment=base.equipment[t],
            optimized_equipment=optimized.equipment[t],
            delta_equipment=optimized.equipment[t] - base.equipment[t],
            baseline_throughput=base.throughput[t],
            optimized_throughput=optimized.throughput[t],
            demand=problem.demand[t],
            capacity=problem.capacity[t],
            unmet_demand=optimized.unmet_demand[t],
            baseline_cost=base.cost[t],
            optimized_cost=optimized.cost[t],
        )
        for t in problem.terminals
    ]


def _comparison_out(block: comparison.ComparisonBlock) -> ComparisonOut:
    def metric(m: comparison.MetricDelta) -> MetricDeltaOut:
        return MetricDeltaOut(**vars(m))

    return ComparisonOut(
        objective=block.objective,
        headline=metric(block.headline),
        metrics=[metric(m) for m in block.metrics],
        expanded_resources=block.expanded_resources,
        notes=block.notes,
    )


@router.post("/solve", response_model=LPSolveOut)
def lp_solve(payload: LPSolveIn) -> LPSolveOut:
    """Solve the allocation LP. Infeasible is a 200 with a status and advice."""
    params = _derive(payload)
    problem = _build_problem(payload, params)
    result = lp.solve_allocation(problem)

    if not result.solved:
        return LPSolveOut(
            dataset_id=payload.dataset_id,
            status=SolveStatus(result.status),
            message=result.message,
            suggestions=result.suggestions,
            objective=payload.objective,
            objective_label=result.objective_label,
            solve_seconds=result.solve_seconds,
            unmet_penalty=problem.unmet_penalty,
            assumptions=_assumptions(params),
            warnings=list(params.warnings),
        )

    optimized = result.solution
    assert optimized is not None  # guaranteed by result.solved
    base = baseline_mod.observed_allocation_baseline(problem, params)
    expanded = baseline_mod.resources_were_expanded(problem, params)

    block = comparison.compare_allocations(
        baseline=base.evaluation,
        optimized=optimized,
        objective=payload.objective,
        expanded_resources=expanded,
        notes=base.notes,
    )

    return LPSolveOut(
        dataset_id=payload.dataset_id,
        status=SolveStatus.OPTIMAL,
        message=result.message,
        objective=payload.objective,
        objective_label=result.objective_label,
        solve_seconds=result.solve_seconds,
        allocation=_allocation_rows(problem, base.evaluation, optimized),
        resources=ResourceUseOut(
            workforce_available=problem.workforce_total,
            workforce_used=optimized.total_workforce,
            equipment_available=problem.equipment_total,
            equipment_used=optimized.total_equipment,
            budget=problem.budget,
            cost_incurred=optimized.total_cost,
        ),
        comparison=_comparison_out(block),
        duals=[DualOut(**vars(d)) for d in result.duals],
        binding_constraints=[d.name for d in result.duals if d.binding],
        allocation_source=result.allocation_source,
        duals_source=result.duals_source,
        duals_penalty_inflated=result.duals_penalty_inflated,
        duals_note=result.duals_note,
        unmet_penalty=problem.unmet_penalty,
        expanded_resources=expanded,
        assumptions=_assumptions(params),
        warnings=list(params.warnings) + list(result.warnings),
    )


# --- Sensitivity -------------------------------------------------------------


@router.post("/sensitivity", response_model=LPSensitivityOut)
def lp_sensitivity(payload: LPSensitivityIn) -> LPSensitivityOut:
    """Sweep the worker pool and re-solve at each point.

    This is the empirical companion to the worker-pool shadow price: the dual
    predicts the slope locally, the sweep shows where that slope breaks.
    """
    if payload.factor_max <= payload.factor_min:
        raise HTTPException(
            status_code=422, detail="factor_max must be greater than factor_min"
        )

    params = _derive(payload)
    base_problem = _build_problem(payload, params)
    factors = np.linspace(payload.factor_min, payload.factor_max, payload.points)

    points: list[SensitivityPoint] = []
    for factor in factors:
        workforce_total = params.workforce_total * float(factor)
        problem = lp.problem_from_parameters(
            params,
            objective=payload.objective,
            workforce_total=workforce_total,
            equipment_total=base_problem.equipment_total,
            budget=base_problem.budget,
        )
        result = lp.solve_allocation(problem)
        solution = result.solution

        points.append(SensitivityPoint(
            factor=float(factor),
            workforce_total=workforce_total,
            status=SolveStatus(result.status),
            objective_value=None if solution is None else solution.objective_value,
            total_throughput=(
                None if solution is None else solution.total_throughput
            ),
            total_cost=None if solution is None else solution.total_cost,
            total_unmet_demand=(
                None if solution is None else solution.total_unmet_demand
            ),
        ))

    return LPSensitivityOut(
        dataset_id=payload.dataset_id,
        objective=payload.objective,
        objective_label=lp.OBJECTIVE_LABELS[payload.objective],
        baseline_workforce_total=params.workforce_total,
        points=points,
        note=(
            "Each point is a full re-solve with the worker pool scaled by the "
            "given factor; every other parameter is held fixed. Kinks in the "
            "curve are where the binding constraint changes — past that point "
            "the worker-pool shadow price no longer applies."
        ),
        warnings=list(params.warnings),
    )
