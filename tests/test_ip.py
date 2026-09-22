"""Tests for Part 2 — the IP shipment-selection model (M6).

The invariants that matter: the optimum must never lose to FCFS under identical
capacities and the identical value function; the worker-minute constraint must
actually be per-terminal and actually be fed by Part 1's `w_t*`; the policy
toggles must bite; and a forced-Critical run that cannot fit must be caught
before CBC turns it into an unexplained "Infeasible".
"""

from __future__ import annotations

from dataclasses import replace

import pandas as pd
import pytest

from backend.core import baseline as baseline_mod
from backend.core import config, data_loader, preprocessing
from backend.models import ip_shipment_selection as ip
from backend.models import lp_resource_allocation as lp


@pytest.fixture(scope="module")
def df() -> pd.DataFrame:
    return data_loader.clean(data_loader.load_bundled())


@pytest.fixture(scope="module")
def batch(df: pd.DataFrame) -> pd.DataFrame:
    return preprocessing.build_batch(df, size=50, seed=11)


def make_problem(
    batch: pd.DataFrame,
    fraction: float = config.DEFAULT_CAPACITY_FRACTION,
    lp_workforce: dict[str, float] | None = None,
    policy: ip.PolicyOptions | None = None,
) -> ip.SelectionProblem:
    return ip.problem_from_batch(
        preprocessing.batch_items(batch),
        preprocessing.default_capacities(
            batch, fraction=fraction, lp_workforce=lp_workforce
        ),
        policy=policy,
    )


@pytest.fixture(scope="module")
def problem(batch: pd.DataFrame) -> ip.SelectionProblem:
    return make_problem(batch)


# --- Solving ----------------------------------------------------------------


def test_solves_to_optimal_on_a_fifty_shipment_batch(
    problem: ip.SelectionProblem,
) -> None:
    result = ip.solve_selection(problem)
    assert result.status == "Optimal"
    assert result.solution is not None
    assert result.solve_seconds < 5.0
    assert len(problem.items) == 50


def test_the_decision_is_binary_and_covers_the_batch(
    problem: ip.SelectionProblem,
) -> None:
    solution = ip.solve_selection(problem).solution
    assert solution is not None
    assert solution.n_accepted + solution.n_rejected == len(problem.items)
    assert set(solution.accepted) & set(solution.rejected) == set()
    # Binding, but feasible: neither everything nor nothing.
    assert 0 < solution.n_accepted < len(problem.items)


def test_solution_respects_every_capacity(problem: ip.SelectionProblem) -> None:
    solution = ip.solve_selection(problem).solution
    assert solution is not None
    assert solution.feasible
    assert solution.violations == []

    assert solution.volume_used <= problem.capacities.volume + 1e-6
    assert solution.equipment_minutes_used <= (
        problem.capacities.equipment_minutes + 1e-6
    )
    for terminal, used in solution.worker_minutes_used.items():
        assert used <= problem.worker_budget(terminal) + 1e-6


def test_a_capacity_actually_binds(problem: ip.SelectionProblem) -> None:
    """A knapsack nothing constrains is not a knapsack."""
    solution = ip.solve_selection(problem).solution
    assert solution is not None
    assert any(u.binding for u in solution.capacity_use)


def test_looser_capacity_never_lowers_the_optimum(batch: pd.DataFrame) -> None:
    """Relaxing a constraint cannot make a maximisation worse."""
    values = []
    for fraction in (0.3, 0.5, 0.7, 0.9):
        solution = ip.solve_selection(make_problem(batch, fraction)).solution
        assert solution is not None
        values.append(solution.total_value)
    assert all(b >= a - 1e-6 for a, b in zip(values, values[1:]))


# --- The honest-comparison invariant ----------------------------------------


def test_ip_never_loses_to_fcfs(problem: ip.SelectionProblem) -> None:
    """Identical capacities, identical value function, one scoring path."""
    optimal = ip.solve_selection(problem).solution
    fcfs = baseline_mod.fcfs_baseline(problem).evaluation
    assert optimal is not None
    assert optimal.total_value >= fcfs.total_value - 1e-6


@pytest.mark.parametrize("fraction", [0.3, 0.45, 0.6, 0.75])
def test_ip_beats_fcfs_across_capacity_settings(
    batch: pd.DataFrame, fraction: float
) -> None:
    problem = make_problem(batch, fraction)
    optimal = ip.solve_selection(problem).solution
    fcfs = baseline_mod.fcfs_baseline(problem).evaluation
    assert optimal is not None
    assert optimal.total_value >= fcfs.total_value - 1e-6
    # And the optimiser is choosing, not just reproducing the queue.
    assert set(optimal.accepted) != set(fcfs.accepted)


def test_fcfs_is_feasible_and_ordered_by_arrival(
    problem: ip.SelectionProblem,
) -> None:
    result = baseline_mod.fcfs_baseline(problem)
    assert result.evaluation.feasible
    assert result.evaluation.violations == []

    order = {i.record_id: (i.timestamp, i.record_id) for i in problem.items}
    stamps = [order[r] for r in result.evaluation.accepted]
    assert stamps == sorted(stamps)

    # It stopped because the window filled, and says on which shipment.
    assert result.blocked_on is not None
    assert result.blocked_by in {
        "volume", "equipment_minutes",
        *(f"worker_minutes_{t}" for t in problem.terminals),
    }


def test_both_sides_go_through_one_scoring_function(
    problem: ip.SelectionProblem,
) -> None:
    """Re-scoring the solver's own answer must reproduce its objective."""
    solution = ip.solve_selection(problem).solution
    assert solution is not None
    rescored = ip.evaluate_selection(problem, solution.accepted)
    assert rescored.total_value == pytest.approx(solution.total_value, rel=1e-12)
    assert rescored.volume_used == pytest.approx(solution.volume_used)


def test_the_optimiser_favours_priority(problem: ip.SelectionProblem) -> None:
    """Value is priority-weighted, so Critical should fare best."""
    solution = ip.solve_selection(problem).solution
    assert solution is not None

    by_priority = {p: 0 for p in config.PRIORITIES}
    for item in problem.items:
        by_priority[item.priority] += 1

    def share(priority: str) -> float:
        taken = solution.priority_mix.get(priority, 0)
        return taken / by_priority[priority] if by_priority[priority] else 0.0

    assert share("Critical") >= share("Low")


# --- Constraint (2): Part 2 consumes Part 1 ---------------------------------


def test_worker_minutes_are_indexed_per_terminal(batch: pd.DataFrame) -> None:
    allocation = {t: 10.0 for t in config.TERMINALS}
    problem = make_problem(batch, lp_workforce=allocation)

    keys = {u.key for u in ip.evaluate_selection(problem, []).capacity_use}
    for terminal in problem.terminals:
        assert f"worker_minutes_{terminal}" in keys


def test_worker_budget_is_w_star_times_horizon_times_sixty(
    batch: pd.DataFrame,
) -> None:
    allocation = {t: 7.5 for t in config.TERMINALS}
    problem = make_problem(batch, lp_workforce=allocation)

    expected = 7.5 * config.PLANNING_HORIZON_HOURS * config.MINUTES_PER_HOUR
    for terminal in problem.terminals:
        assert problem.worker_budget(terminal) == pytest.approx(expected)
    assert problem.capacities.worker_minutes_source == "lp_allocation"


def test_starving_one_terminal_in_part_one_shuts_it_out_in_part_two(
    batch: pd.DataFrame,
) -> None:
    """The point of the two-stage model, in one assertion.

    Part 1 could previously staff T1 with 15 workers while Part 2 accepted a T1
    shipment needing 45, and nothing noticed.
    """
    generous = {t: 40.0 for t in config.TERMINALS}
    starved = dict(generous, T1=0.0)

    rich = ip.solve_selection(make_problem(batch, lp_workforce=generous)).solution
    poor = ip.solve_selection(make_problem(batch, lp_workforce=starved)).solution
    assert rich is not None and poor is not None

    ids = {i.record_id: i.terminal for i in make_problem(batch).items}
    assert any(ids[r] == "T1" for r in rich.accepted)
    assert not any(ids[r] == "T1" for r in poor.accepted)
    assert poor.total_value < rich.total_value


def test_a_real_lp_allocation_feeds_the_budget(df: pd.DataFrame) -> None:
    """End to end: solve Part 1, spend w_t* in Part 2."""
    params = preprocessing.estimate_lp_params(df)
    allocation = lp.solve_allocation(
        lp.problem_from_parameters(params, objective="max_throughput")
    )
    assert allocation.solution is not None

    batch = preprocessing.build_batch(df, size=60, seed=3)
    problem = make_problem(batch, lp_workforce=allocation.solution.workforce)

    result = ip.solve_selection(problem)
    assert result.status == "Optimal"
    assert result.solution is not None
    assert not result.warnings or all(
        "self-referential" not in w for w in result.warnings
    )
    for terminal in problem.terminals:
        assert problem.worker_budget(terminal) == pytest.approx(
            allocation.solution.workforce[terminal]
            * config.PLANNING_HORIZON_HOURS
            * config.MINUTES_PER_HOUR
        )


def test_standalone_mode_warns_that_it_is_self_referential(
    problem: ip.SelectionProblem,
) -> None:
    """Part 2 must be solvable without Part 1 — and must say that it was."""
    result = ip.solve_selection(problem)
    assert result.status == "Optimal"
    assert problem.capacities.worker_minutes_source == "batch_fraction"
    assert any("self-referential" in w for w in result.warnings)


# --- Constraint (3): machine-minutes, not machines --------------------------


def test_equipment_is_charged_as_minutes(problem: ip.SelectionProblem) -> None:
    for item in problem.items:
        assert item.equipment_minutes > item.volume * 0 + 1  # sanity: positive
    solution = ip.solve_selection(problem).solution
    assert solution is not None
    assert solution.equipment_minutes_used == pytest.approx(
        sum(
            i.equipment_minutes for i in problem.items
            if i.record_id in set(solution.accepted)
        )
    )


# --- Policy constraints -----------------------------------------------------


def test_force_critical_pins_every_critical_shipment(batch: pd.DataFrame) -> None:
    problem = make_problem(
        batch, fraction=0.8, policy=ip.PolicyOptions(force_critical=True)
    )
    result = ip.solve_selection(problem)
    assert result.status == "Optimal"
    assert result.solution is not None

    accepted = set(result.solution.accepted)
    critical = [
        i.record_id for i in problem.items
        if i.priority == config.FORCED_PRIORITY
    ]
    assert critical, "batch has no Critical shipments to force"
    assert all(r in accepted for r in critical)


def test_hazardous_cap_is_respected(batch: pd.DataFrame) -> None:
    unlimited = ip.solve_selection(make_problem(batch)).solution
    assert unlimited is not None
    before = unlimited.cargo_mix.get(config.HAZARDOUS_CARGO_TYPE, 0)
    assert before > 1, "batch accepts too little Hazardous cargo to test the cap"

    capped = ip.solve_selection(
        make_problem(batch, policy=ip.PolicyOptions(max_hazardous=before - 1))
    ).solution
    assert capped is not None
    assert capped.cargo_mix.get(config.HAZARDOUS_CARGO_TYPE, 0) <= before - 1
    # A tightened constraint cannot improve a maximisation.
    assert capped.total_value <= unlimited.total_value + 1e-6


def test_perishable_floor_is_respected(batch: pd.DataFrame) -> None:
    unlimited = ip.solve_selection(make_problem(batch)).solution
    assert unlimited is not None
    before = unlimited.cargo_mix.get(config.PERISHABLE_CARGO_TYPE, 0)

    floored = ip.solve_selection(
        make_problem(batch, policy=ip.PolicyOptions(min_perishable=before + 2))
    ).solution
    assert floored is not None
    assert floored.cargo_mix.get(config.PERISHABLE_CARGO_TYPE, 0) >= before + 2
    assert floored.total_value <= unlimited.total_value + 1e-6


def test_policy_toggles_are_off_by_default(problem: ip.SelectionProblem) -> None:
    assert problem.policy == ip.PolicyOptions()
    assert problem.policy.force_critical is False
    assert problem.policy.max_hazardous is None
    assert problem.policy.min_perishable is None


# --- Pre-solve checks -------------------------------------------------------


def test_forced_critical_infeasibility_is_pre_detected(
    batch: pd.DataFrame,
) -> None:
    """Pinning a whole priority class can exceed a capacity on its own."""
    problem = make_problem(
        batch, fraction=0.05, policy=ip.PolicyOptions(force_critical=True)
    )
    errors, suggestions = ip.check_problem(problem)
    assert errors
    assert any("Critical" in e for e in errors)
    assert suggestions

    result = ip.solve_selection(problem)
    assert result.status == "Infeasible"
    assert result.solution is None
    assert "Critical" in result.message
    assert any("force-Critical" in s for s in result.suggestions)


def test_forced_critical_against_a_thin_part_one_allocation_is_named(
    batch: pd.DataFrame,
) -> None:
    """The most valuable diagnostic: Part 1 under-staffed a terminal."""
    problem = make_problem(
        batch,
        fraction=1.0,
        lp_workforce={t: 0.05 for t in config.TERMINALS},
        policy=ip.PolicyOptions(force_critical=True),
    )
    errors, suggestions = ip.check_problem(problem)
    assert any("worker-minutes" in e for e in errors)
    assert any("Part 1" in s for s in suggestions)


def test_impossible_perishable_floor_is_pre_detected(
    batch: pd.DataFrame,
) -> None:
    problem = make_problem(
        batch, policy=ip.PolicyOptions(min_perishable=len(batch) + 10)
    )
    result = ip.solve_selection(problem)
    assert result.status == "Infeasible"
    assert "Perishable" in result.message
    assert result.suggestions


def test_an_empty_batch_is_pre_detected(problem: ip.SelectionProblem) -> None:
    empty = replace(problem, items=[])
    result = ip.solve_selection(empty)
    assert result.status == "Infeasible"
    assert "no shipments" in result.message.lower()


def test_forced_critical_fits_at_a_generous_capacity(batch: pd.DataFrame) -> None:
    """The pre-check must not fire on a run that genuinely works."""
    problem = make_problem(
        batch, fraction=1.0, policy=ip.PolicyOptions(force_critical=True)
    )
    errors, _ = ip.check_problem(problem)
    assert errors == []
    assert ip.solve_selection(problem).status == "Optimal"


# --- No shadow prices -------------------------------------------------------


def test_the_ip_reports_no_duals(problem: ip.SelectionProblem) -> None:
    """An integer program's value function is a non-convex step function, so
    LP-relaxation duals are not valid marginal values (MODEL.md 4.5)."""
    result = ip.solve_selection(problem)
    assert not hasattr(result, "duals")
    assert result.solution is not None
    assert not hasattr(result.solution, "shadow_prices")


# --- Purity -------------------------------------------------------------------


def test_model_module_stays_pure() -> None:
    """Models must not reach for the data layer or the web layer (AGENT.md)."""
    source = (config.PROJECT_ROOT / "backend" / "models" /
              "ip_shipment_selection.py").read_text(encoding="utf-8")
    for forbidden in ("import pandas", "from fastapi", "import fastapi",
                      "from backend.core.store", "read_csv", "import numpy"):
        assert forbidden not in source, f"model imports {forbidden}"


# --- The greedy baseline (MODEL.md section 5) --------------------------------


def test_greedy_baseline_is_feasible_and_scored_one_way(
    problem: ip.SelectionProblem,
) -> None:
    """It goes through `evaluate_selection`, like the IP and like FCFS."""
    greedy = baseline_mod.greedy_baseline(problem)
    assert greedy.evaluation.feasible
    assert greedy.evaluation.violations == []
    # Re-scoring the same accepted set must reproduce the same value, which is
    # only true if there is one scoring path.
    rescored = ip.evaluate_selection(problem, greedy.evaluation.accepted)
    assert rescored.total_value == pytest.approx(greedy.evaluation.total_value)


def test_greedy_reports_every_rule_it_tried(problem: ip.SelectionProblem) -> None:
    """'Best greedy' has to be auditable, not asserted."""
    greedy = baseline_mod.greedy_baseline(problem)
    assert len(greedy.candidates) == len(baseline_mod._DENSITY_KEYS) + 1
    assert greedy.rule in greedy.candidates
    assert greedy.candidates[greedy.rule] == pytest.approx(
        max(greedy.candidates.values())
    )


def test_ip_never_loses_to_greedy(problem: ip.SelectionProblem) -> None:
    """The optimum is an upper bound on any heuristic over the same problem."""
    result = ip.solve_selection(problem)
    assert result.solution is not None
    greedy = baseline_mod.greedy_baseline(problem)
    assert result.solution.total_value >= greedy.evaluation.total_value - 1e-6


def test_greedy_is_a_harder_baseline_than_fcfs(
    problem: ip.SelectionProblem,
) -> None:
    """The point of adding it.

    FCFS stops dead at the first shipment that will not fit and knows nothing
    about value, so beating it proves very little. Ranking by value density
    and skipping ahead is the baseline worth quoting, and the gap over it is
    the honest measure of what the optimiser buys.
    """
    greedy = baseline_mod.greedy_baseline(problem)
    fcfs = baseline_mod.fcfs_baseline(problem)
    assert greedy.evaluation.total_value > fcfs.evaluation.total_value

    result = ip.solve_selection(problem)
    assert result.solution is not None
    optimum = result.solution.total_value
    gap_over_greedy = optimum / greedy.evaluation.total_value - 1.0
    gap_over_fcfs = optimum / fcfs.evaluation.total_value - 1.0
    assert gap_over_greedy < gap_over_fcfs
