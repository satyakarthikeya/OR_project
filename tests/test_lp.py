"""Tests for Part 1 — the LP allocation model (M3).

The tests that matter most are the invariants: the baseline must be feasible,
the optimum must never be worse than the baseline under the same objective, and
the congestion multiplier must actually differentiate the terminals. If any of
those break, every number the report quotes becomes meaningless.
"""

from __future__ import annotations

from dataclasses import replace

import pandas as pd
import pytest

from backend.core import baseline as baseline_mod
from backend.core import comparison, config, data_loader, preprocessing
from backend.core.preprocessing import LPParameters, ScenarioFilters
from backend.models import lp_resource_allocation as lp

OBJECTIVES = ("max_throughput", "min_cost")


@pytest.fixture(scope="module")
def df() -> pd.DataFrame:
    return data_loader.clean(data_loader.load_bundled())


@pytest.fixture(scope="module")
def params(df: pd.DataFrame) -> LPParameters:
    return preprocessing.estimate_lp_params(df)


# --- Solving ----------------------------------------------------------------


@pytest.mark.parametrize("objective", OBJECTIVES)
def test_solves_to_optimal(params: LPParameters, objective: str) -> None:
    result = lp.solve_allocation(
        lp.problem_from_parameters(params, objective=objective)
    )
    assert result.status == "Optimal"
    assert result.solution is not None
    assert result.solve_seconds < 5.0


@pytest.mark.parametrize("objective", OBJECTIVES)
def test_solution_respects_every_constraint(
    params: LPParameters, objective: str
) -> None:
    problem = lp.problem_from_parameters(params, objective=objective)
    result = lp.solve_allocation(problem)
    solution = result.solution
    assert solution is not None
    assert solution.feasible_against(problem)

    for t in problem.terminals:
        lo, hi = problem.workforce_bounds[t]
        assert lo - 1e-6 <= solution.workforce[t] <= hi + 1e-6
        lo, hi = problem.equipment_bounds[t]
        assert lo - 1e-6 <= solution.equipment[t] <= hi + 1e-6
        assert solution.throughput[t] <= problem.capacity[t] + 1e-6

    assert solution.total_workforce <= problem.workforce_total + 1e-6
    assert solution.total_equipment <= problem.equipment_total + 1e-6


# --- The honest-comparison invariants ---------------------------------------


@pytest.mark.parametrize("objective", OBJECTIVES)
def test_baseline_is_feasible(params: LPParameters, objective: str) -> None:
    """If the observed allocation were infeasible, no comparison would be valid."""
    problem = lp.problem_from_parameters(params, objective=objective)
    result = baseline_mod.observed_allocation_baseline(problem, params)
    assert result.feasible
    assert result.notes == []


@pytest.mark.parametrize("objective", OBJECTIVES)
def test_optimum_is_never_worse_than_baseline(
    params: LPParameters, objective: str
) -> None:
    problem = lp.problem_from_parameters(params, objective=objective)
    optimized = lp.solve_allocation(problem).solution
    base = baseline_mod.observed_allocation_baseline(problem, params).evaluation
    assert optimized is not None

    if objective == "max_throughput":
        assert optimized.objective_value >= base.objective_value - 1e-6
    else:
        assert optimized.objective_value <= base.objective_value + 1e-6


def test_baseline_and_optimum_are_scored_by_one_function(
    params: LPParameters,
) -> None:
    """Re-scoring the solver's own allocation must reproduce its objective."""
    problem = lp.problem_from_parameters(params, objective="max_throughput")
    result = lp.solve_allocation(problem)
    assert result.solution is not None

    rescored = lp.evaluate_allocation(
        problem, result.solution.workforce, result.solution.equipment
    )
    assert rescored.objective_value == pytest.approx(
        result.solution.objective_value, rel=1e-9
    )


def test_default_run_is_not_flagged_as_expanded(params: LPParameters) -> None:
    problem = lp.problem_from_parameters(params, objective="max_throughput")
    assert not baseline_mod.resources_were_expanded(problem, params)


def test_raised_pool_is_flagged_as_expanded(params: LPParameters) -> None:
    problem = lp.problem_from_parameters(
        params,
        objective="max_throughput",
        workforce_total=params.workforce_total * 1.2,
    )
    assert baseline_mod.resources_were_expanded(problem, params)


# --- Degeneracy ---------------------------------------------------------------


def test_congestion_changes_the_allocation(params: LPParameters, df: pd.DataFrame) -> None:
    """Without congestion the terminals are interchangeable (SCOPE.md section 3)."""
    congested = lp.solve_allocation(
        lp.problem_from_parameters(params, objective="max_throughput")
    ).solution
    plain_params = preprocessing.estimate_lp_params(df, apply_congestion=False)
    plain = lp.solve_allocation(
        lp.problem_from_parameters(plain_params, objective="max_throughput")
    ).solution

    assert congested is not None and plain is not None
    assert any(
        abs(congested.workforce[t] - plain.workforce[t]) > 1e-3
        for t in params.terminals
    )


def test_allocation_differentiates_terminals(params: LPParameters) -> None:
    """The optimum must be a decision, not an artefact of solver scan order."""
    solution = lp.solve_allocation(
        lp.problem_from_parameters(params, objective="max_throughput")
    ).solution
    assert solution is not None

    workforce = list(solution.workforce.values())
    assert max(workforce) - min(workforce) > 1.0


# --- Duals --------------------------------------------------------------------


def test_duals_cover_every_constraint(params: LPParameters) -> None:
    problem = lp.problem_from_parameters(params, objective="max_throughput")
    result = lp.solve_allocation(problem)

    names = {d.name for d in result.duals}
    expected = {"worker_pool", "equipment_pool"} | {
        f"{kind}_{t}"
        for kind in ("demand", "capacity", "staffing")
        for t in problem.terminals
    }
    assert names == expected
    assert all(d.interpretation for d in result.duals)


def test_scarce_resource_has_a_positive_shadow_price(params: LPParameters) -> None:
    """A binding pool in a max problem must be worth something at the margin."""
    problem = lp.problem_from_parameters(params, objective="max_throughput")
    result = lp.solve_allocation(problem)

    pools = [d for d in result.duals if d.kind == "resource_pool" and d.binding]
    assert pools, "expected at least one binding resource pool"
    assert all(d.shadow_price > 0 for d in pools)


def test_slack_is_reported_for_non_binding_constraints(params: LPParameters) -> None:
    problem = lp.problem_from_parameters(params, objective="max_throughput")
    result = lp.solve_allocation(problem)

    for dual in result.duals:
        assert dual.slack >= -1e-6
        if not dual.binding:
            assert dual.slack > 1e-6
            # Complementary slackness: a genuinely slack constraint is free.
            assert abs(dual.shadow_price) <= config.DUAL_ZERO_TOL


def test_a_priced_constraint_is_never_labelled_slack(params: LPParameters) -> None:
    """A large RHS lands further from the solver's answer than a small one.

    A budget of several thousand is met to within a few thousandths, which an
    absolute epsilon reads as slack — while the constraint carries a large
    shadow price. The two together would be a visible contradiction in the UI.
    """
    cheapest = lp.solve_allocation(
        lp.problem_from_parameters(params, objective="min_cost")
    ).solution
    assert cheapest is not None

    # A cap just above the cheapest feasible plan is certain to bind when the
    # objective wants to spend.
    problem = lp.problem_from_parameters(
        params, objective="max_throughput", budget=cheapest.total_cost * 1.05
    )
    result = lp.solve_allocation(problem)

    budget = next(d for d in result.duals if d.name == "budget")
    assert abs(budget.shadow_price) > config.DUAL_ZERO_TOL
    assert budget.binding

    for dual in result.duals:
        if abs(dual.shadow_price) > config.DUAL_ZERO_TOL:
            assert dual.binding, f"{dual.name} is priced but reported as slack"


def test_shadow_price_predicts_the_gain_from_one_more_worker(
    params: LPParameters,
) -> None:
    """The economic meaning of a dual, checked by re-solving."""
    problem = lp.problem_from_parameters(params, objective="max_throughput")
    result = lp.solve_allocation(problem)
    pool = next(d for d in result.duals if d.name == "worker_pool")
    assert pool.binding

    step = 1.0
    bumped = lp.solve_allocation(
        lp.problem_from_parameters(
            params,
            objective="max_throughput",
            workforce_total=problem.workforce_total + step,
        )
    )
    assert result.solution is not None and bumped.solution is not None

    gain = bumped.solution.objective_value - result.solution.objective_value
    assert gain == pytest.approx(pool.shadow_price * step, rel=0.02)


# --- Soft demand and graceful degradation ------------------------------------


def test_unmet_demand_is_slack_not_infeasibility(params: LPParameters) -> None:
    """Demand nobody could meet must be reported, never returned as Infeasible."""
    hungry = preprocessing.estimate_lp_params(
        data_loader.clean(data_loader.load_bundled()), demand_scale=3.0
    )
    result = lp.solve_allocation(
        lp.problem_from_parameters(hungry, objective="min_cost")
    )
    assert result.status == "Optimal"
    assert result.solution is not None
    assert result.solution.total_unmet_demand > 0


def test_impossible_pool_is_pre_detected_with_suggestions(
    params: LPParameters,
) -> None:
    result = lp.solve_allocation(
        lp.problem_from_parameters(
            params, objective="max_throughput", workforce_total=1.0
        )
    )
    assert result.status == "Infeasible"
    assert result.solution is None
    assert "worker pool" in result.message
    assert result.suggestions


def test_impossible_budget_is_pre_detected(params: LPParameters) -> None:
    result = lp.solve_allocation(
        lp.problem_from_parameters(params, objective="min_cost", budget=1.0)
    )
    assert result.status == "Infeasible"
    assert any("budget" in s.lower() for s in result.suggestions)


def test_generous_budget_still_solves(params: LPParameters) -> None:
    problem = lp.problem_from_parameters(
        params, objective="min_cost", budget=params.baseline_cost() * 2
    )
    result = lp.solve_allocation(problem)
    assert result.status == "Optimal"
    assert result.solution is not None
    assert result.solution.total_cost <= problem.budget + 1e-6


def test_binding_budget_is_respected(params: LPParameters) -> None:
    problem = lp.problem_from_parameters(
        params, objective="max_throughput", budget=params.baseline_cost() * 0.9
    )
    result = lp.solve_allocation(problem)
    assert result.status == "Optimal"
    assert result.solution is not None
    assert result.solution.total_cost <= problem.budget + 1e-6


# --- Objective wiring ---------------------------------------------------------


def test_objectives_produce_different_plans(params: LPParameters) -> None:
    throughput = lp.solve_allocation(
        lp.problem_from_parameters(params, objective="max_throughput")
    ).solution
    cost = lp.solve_allocation(
        lp.problem_from_parameters(params, objective="min_cost")
    ).solution
    assert throughput is not None and cost is not None
    assert throughput.total_throughput >= cost.total_throughput - 1e-6


def test_penalty_scales_with_the_active_objective(params: LPParameters) -> None:
    throughput_problem = lp.problem_from_parameters(
        params, objective="max_throughput"
    )
    cost_problem = lp.problem_from_parameters(params, objective="min_cost")
    assert throughput_problem.unmet_penalty < cost_problem.unmet_penalty
    assert throughput_problem.unmet_penalty > max(params.alpha.values())


def test_capacity_floor_keeps_the_baseline_feasible() -> None:
    """A tight scenario slice must not put the ceiling below the baseline."""
    df = data_loader.clean(data_loader.load_bundled())
    slice_ = preprocessing.apply_filters(
        df, ScenarioFilters(terminals=["T1", "T2"], weather=["Storm"])
    )
    tight = preprocessing.estimate_lp_params(slice_)
    problem = lp.problem_from_parameters(tight, objective="max_throughput")

    for t in problem.terminals:
        modelled = (
            tight.alpha[t] * tight.baseline_workforce[t]
            + tight.beta[t] * tight.baseline_equipment[t]
        )
        assert problem.capacity[t] >= modelled - 1e-9


# --- Comparison ---------------------------------------------------------------


def test_comparison_reports_deltas_in_both_directions(params: LPParameters) -> None:
    problem = lp.problem_from_parameters(params, objective="min_cost")
    result = lp.solve_allocation(problem)
    base = baseline_mod.observed_allocation_baseline(problem, params)
    assert result.solution is not None

    block = comparison.compare_allocations(
        base.evaluation, result.solution, "min_cost"
    )
    assert block.headline.better == "down"
    assert block.headline.improved is True

    keys = {m.key for m in block.metrics}
    assert {"total_throughput", "total_cost", "total_unmet_demand"} <= keys
    for metric in block.metrics:
        assert metric.delta == pytest.approx(metric.optimized - metric.baseline)


def test_comparison_flags_penalty_driven_headlines(df: pd.DataFrame) -> None:
    """The busy day is where slack switches on, so that is where this bites."""
    peak = preprocessing.estimate_lp_params(df, demand_day="p95")
    problem = lp.problem_from_parameters(peak, objective="max_throughput")
    result = lp.solve_allocation(problem)
    base = baseline_mod.observed_allocation_baseline(problem, peak)
    assert result.solution is not None

    block = comparison.compare_allocations(
        base.evaluation, result.solution, "max_throughput"
    )
    assert base.evaluation.total_unmet_demand > 0
    assert any("unmet-demand penalty" in n for n in block.notes)


def test_penalty_share_never_exceeds_one_hundred_percent(
    params: LPParameters,
) -> None:
    """A budget cap can move cost and penalty in opposite directions."""
    problem = lp.problem_from_parameters(
        params, objective="min_cost", budget=params.baseline_cost() * 0.5
    )
    result = lp.solve_allocation(problem)
    base = baseline_mod.observed_allocation_baseline(problem, params)
    assert result.solution is not None

    block = comparison.compare_allocations(
        base.evaluation, result.solution, "min_cost"
    )
    note = next((n for n in block.notes if "of the change" in n), None)
    assert note is not None
    percent = int(note.split("%")[0])
    assert 50 <= percent <= 100


def test_infeasible_baseline_names_the_constraint_it_breaks(
    params: LPParameters,
) -> None:
    """A generic 'the pools were probably lowered' note would mislead here."""
    problem = lp.problem_from_parameters(
        params, objective="min_cost", budget=params.baseline_cost() * 0.5
    )
    base = baseline_mod.observed_allocation_baseline(problem, params)

    assert not base.feasible
    assert base.notes
    assert "budget cap" in base.notes[0]
    assert "worker" not in base.notes[0]


def test_comparison_flags_expanded_resources(params: LPParameters) -> None:
    problem = lp.problem_from_parameters(
        params, objective="max_throughput",
        workforce_total=params.workforce_total * 1.2,
    )
    result = lp.solve_allocation(problem)
    base = baseline_mod.observed_allocation_baseline(problem, params)
    assert result.solution is not None

    block = comparison.compare_allocations(
        base.evaluation, result.solution, "max_throughput",
        expanded_resources=True,
    )
    assert block.expanded_resources
    assert any("Expanded-resources" in n for n in block.notes)


# --- Integrality and the staffing coupling -----------------------------------


@pytest.mark.parametrize("objective", OBJECTIVES)
def test_equipment_is_whole_machines(params: LPParameters, objective: str) -> None:
    """You cannot run 0.43 of a forklift (MODEL.md 3.1)."""
    result = lp.solve_allocation(
        lp.problem_from_parameters(params, objective=objective)
    )
    assert result.solution is not None
    for t in params.terminals:
        units = result.solution.equipment[t]
        assert abs(units - round(units)) < 1e-6, f"{t} got {units} machines"


def test_workers_are_not_forced_to_whole_people(params: LPParameters) -> None:
    """w_t stays continuous: a staffing level over a shift genuinely splits."""
    problem = lp.problem_from_parameters(params, objective="max_throughput")
    assert problem.workforce_bounds  # sanity
    result = lp.solve_allocation(problem)
    assert result.solution is not None
    assert any(
        abs(result.solution.workforce[t] - round(result.solution.workforce[t]))
        > 1e-6
        for t in params.terminals
    )


@pytest.mark.parametrize("objective", OBJECTIVES)
def test_every_machine_has_an_operator(
    params: LPParameters, objective: str
) -> None:
    """Constraint (5). Without it the LP runs the cranes unattended."""
    problem = lp.problem_from_parameters(params, objective=objective)
    result = lp.solve_allocation(problem)
    assert result.solution is not None

    for t in problem.terminals:
        assert result.solution.workforce[t] >= (
            problem.staffing_ratio * result.solution.equipment[t] - 1e-6
        )


def test_observed_baseline_clears_the_staffing_ratio(params: LPParameters) -> None:
    """The answer to 'does your baseline survive the new constraint?'"""
    problem = lp.problem_from_parameters(params, objective="max_throughput")
    for t in problem.terminals:
        ratio = params.baseline_workforce[t] / params.baseline_equipment[t]
        assert ratio > problem.staffing_ratio
    assert baseline_mod.observed_allocation_baseline(problem, params).feasible


def test_staffing_coupling_holds_equipment_back(params: LPParameters) -> None:
    """With the coupling removed the LP would buy machines it cannot crew."""
    coupled = lp.solve_allocation(
        lp.problem_from_parameters(params, objective="max_throughput")
    ).solution
    uncoupled = lp.solve_allocation(
        lp.problem_from_parameters(
            params, objective="max_throughput", staffing_ratio=0.0
        )
    ).solution
    assert coupled is not None and uncoupled is not None
    assert uncoupled.total_equipment >= coupled.total_equipment - 1e-6


def test_capacity_versus_floor_conflict_is_pre_detected(
    params: LPParameters,
) -> None:
    """An empty box must be named, not handed to CBC to report as Infeasible."""
    problem = lp.problem_from_parameters(params, objective="max_throughput")
    squeezed = replace(
        problem, capacity={t: 1.0 for t in problem.terminals}
    )
    errors, suggestions = lp.check_problem(squeezed)
    assert errors
    assert any("capacity ceiling" in e for e in errors)
    assert suggestions

    result = lp.solve_allocation(squeezed)
    assert result.status == "Infeasible"
    assert result.solution is None


def test_unstaffable_equipment_floor_is_pre_detected(
    params: LPParameters,
) -> None:
    """rho * e_min above w_max is an empty box the user cannot see."""
    problem = lp.problem_from_parameters(params, objective="max_throughput")
    unstaffable = replace(
        problem,
        equipment_bounds={t: (40.0, 50.0) for t in problem.terminals},
        equipment_total=200.0,
    )
    errors, suggestions = lp.check_problem(unstaffable)
    assert any("operators" in e for e in errors)
    assert suggestions


# --- Duals: which solve they came from ---------------------------------------


def test_duals_come_from_the_relaxation_and_say_so(params: LPParameters) -> None:
    """e_t is integer, so CBC's own duals are not shadow prices (MODEL.md 3.1)."""
    result = lp.solve_allocation(
        lp.problem_from_parameters(params, objective="max_throughput")
    )
    assert result.allocation_source == "milp"
    assert result.duals_source == "relaxation"
    assert "relaxation" in result.duals_note
    assert result.duals_penalty_inflated is False


def test_unmet_demand_forces_clean_duals_from_a_second_solve(
    df: pd.DataFrame,
) -> None:
    """With s_t > 0 the raw duals are multiples of M, not marginal throughput."""
    hungry = preprocessing.estimate_lp_params(df, demand_day="p95", demand_scale=2.0)
    problem = lp.problem_from_parameters(hungry, objective="max_throughput")
    result = lp.solve_allocation(problem)

    assert result.status == "Optimal"
    assert result.solution is not None
    assert result.solution.total_unmet_demand > 0

    assert result.duals_penalty_inflated is True
    assert result.duals_source == "relaxation_demand_met"
    assert "penalty" in result.duals_note.lower()

    # The point of the second solve: no dual is a multiple of the penalty rate.
    pool = next(d for d in result.duals if d.name == "worker_pool")
    assert pool.shadow_price < problem.unmet_penalty
    assert pool.shadow_price <= max(hungry.alpha.values()) + 1e-6


# --- Purity -------------------------------------------------------------------


def test_model_module_stays_pure() -> None:
    """Models must not reach for the data layer or the web layer (AGENT.md)."""
    source = (config.PROJECT_ROOT / "backend" / "models" /
              "lp_resource_allocation.py").read_text(encoding="utf-8")
    for forbidden in ("import pandas", "from fastapi", "import fastapi",
                      "from backend.core.store", "read_csv"):
        assert forbidden not in source, f"model imports {forbidden}"


# --- Service-level disclosure on min_cost (MODEL.md section 5) ---------------


def _min_cost_blocks(params: LPParameters):
    problem = lp.problem_from_parameters(params, objective="min_cost")
    result = lp.solve_allocation(problem)
    assert result.solution is not None
    base = baseline_mod.observed_allocation_baseline(problem, params)
    return base.evaluation, result.solution, problem


def test_min_cost_saving_that_cuts_output_is_disclosed(
    params: LPParameters,
) -> None:
    """The headline cost cut must never stand on its own.

    Minimising cost only requires demand to be met, and demand on this data
    sits far below observed capability, so the cheapest plan stops at the
    demand line and cost falls roughly in proportion with throughput. That is
    a correct optimum and a misleading headline, so the comparison has to say
    where the saving came from.
    """
    baseline_eval, optimized, _ = _min_cost_blocks(params)
    block = comparison.compare_allocations(
        baseline=baseline_eval, optimized=optimized, objective="min_cost"
    )

    drop = (
        baseline_eval.total_throughput - optimized.total_throughput
    ) / baseline_eval.total_throughput
    assert drop > comparison.SERVICE_LEVEL_DROP_THRESHOLD, (
        "fixture no longer exercises the case this test guards"
    )
    assert any("fall in throughput" in note for note in block.notes)


def test_no_service_level_note_when_output_holds_up(
    params: LPParameters,
) -> None:
    """The disclosure is targeted, not boilerplate on every min-cost run."""
    baseline_eval, optimized, _ = _min_cost_blocks(params)
    # Same objective, but an "optimised" plan that produces what the baseline
    # produced: nothing was traded away, so nothing needs disclosing.
    block = comparison.compare_allocations(
        baseline=baseline_eval, optimized=baseline_eval, objective="min_cost"
    )
    assert not any("fall in throughput" in note for note in block.notes)


def test_service_level_note_is_confined_to_min_cost(
    params: LPParameters,
) -> None:
    """Maximising throughput cannot buy a saving by producing less."""
    baseline_eval, optimized, _ = _min_cost_blocks(params)
    block = comparison.compare_allocations(
        baseline=baseline_eval, optimized=optimized, objective="max_throughput"
    )
    assert not any("fall in throughput" in note for note in block.notes)
