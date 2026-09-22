"""Tests for the data layer.

The calibration identity tests are the important ones: they guard the closed-form
parameter derivation that everything in Part 1 rests on.
"""

from __future__ import annotations

import math

import pandas as pd
import pytest

from backend.core import config, data_loader, preprocessing
from backend.core.preprocessing import ScenarioFilters


@pytest.fixture(scope="module")
def df() -> pd.DataFrame:
    raw = data_loader.load_bundled()
    assert data_loader.validate(raw).ok
    return data_loader.clean(raw)


# --- Loading and cleaning ---------------------------------------------------


def test_dataset_loads_and_cleans(df: pd.DataFrame) -> None:
    assert len(df) == 5000
    assert set(config.REQUIRED_COLUMNS).issubset(df.columns)
    assert df[list(config.REQUIRED_COLUMNS)].isna().sum().sum() == 0
    assert {"date", "hour", "priority_weight", "worker_minutes"}.issubset(df.columns)


def test_validation_rejects_missing_columns(df: pd.DataFrame) -> None:
    report = data_loader.validate(df.drop(columns=[config.COL_THROUGHPUT]))
    assert not report.ok
    assert config.COL_THROUGHPUT in report.errors[0]


def test_denominators_are_floored(df: pd.DataFrame) -> None:
    assert df[config.COL_WORKFORCE].min() >= config.MIN_WORKFORCE
    assert df[config.COL_EQUIPMENT].min() >= config.MIN_EQUIPMENT


# --- Terminal aggregation ---------------------------------------------------


def test_terminal_summary_covers_all_terminals(df: pd.DataFrame) -> None:
    summary = preprocessing.terminal_summary(df)
    assert list(summary.index) == list(config.TERMINALS)
    assert (summary["n_records"] > config.MIN_ROWS_PER_TERMINAL).all()
    assert (summary["workforce_max"] > summary["workforce_min"]).all()
    assert (summary["throughput_capacity"] >= summary["mean_throughput"]).all()


# --- LP parameter estimation ------------------------------------------------


def test_all_parameters_finite_and_positive(df: pd.DataFrame) -> None:
    params = preprocessing.estimate_lp_params(df)
    for name in ("alpha", "beta", "cost_worker", "cost_equipment", "capacity"):
        values = getattr(params, name)
        assert set(values) == set(params.terminals)
        for terminal, value in values.items():
            assert math.isfinite(value), f"{name}[{terminal}] is not finite"
            assert value > 0, f"{name}[{terminal}] is not positive"


def test_uncongested_parameters_reproduce_each_terminal_mean(df: pd.DataFrame) -> None:
    """Per-terminal calibration identity: alpha_t*w_t + beta_t*e_t == T_t."""
    params = preprocessing.estimate_lp_params(df, apply_congestion=False)
    summary = preprocessing.terminal_summary(df)

    for t in params.terminals:
        modelled = (
            params.alpha[t] * params.baseline_workforce[t]
            + params.beta[t] * params.baseline_equipment[t]
        )
        assert modelled == pytest.approx(summary.loc[t, "mean_throughput"], rel=1e-9)


def test_congestion_preserves_system_throughput(df: pd.DataFrame) -> None:
    """Congestion redistributes productivity without inventing or destroying it."""
    plain = preprocessing.estimate_lp_params(df, apply_congestion=False)
    congested = preprocessing.estimate_lp_params(df, apply_congestion=True)

    assert congested.baseline_throughput() == pytest.approx(
        plain.baseline_throughput(), rel=1e-9
    )


def test_congestion_differentiates_terminals(df: pd.DataFrame) -> None:
    """Without this the LP would be indifferent between terminals (SCOPE.md 3)."""
    congested = preprocessing.estimate_lp_params(df, apply_congestion=True)
    gammas = list(congested.congestion.values())
    assert max(gammas) - min(gammas) > 1e-6

    ratios = [
        congested.alpha[t] / congested.alpha_uncongested[t]
        for t in congested.terminals
    ]
    assert max(ratios) / min(ratios) > 1.01


def test_baseline_allocation_respects_pool_totals(df: pd.DataFrame) -> None:
    params = preprocessing.estimate_lp_params(df)
    assert sum(params.baseline_workforce.values()) == pytest.approx(
        params.workforce_total
    )
    assert sum(params.baseline_equipment.values()) == pytest.approx(
        params.equipment_total
    )


def test_baseline_is_within_bounds(df: pd.DataFrame) -> None:
    """The observed allocation must be feasible, or every comparison is void."""
    params = preprocessing.estimate_lp_params(df)
    for t in params.terminals:
        low, high = params.workforce_bounds[t]
        assert low <= params.baseline_workforce[t] <= high
        low, high = params.equipment_bounds[t]
        assert low <= params.baseline_equipment[t] <= high


def test_demand_is_a_level_over_the_horizon_not_a_rescaled_mean(
    df: pd.DataFrame,
) -> None:
    """D_t is tons arriving in the window, divided by H (MODEL.md 3.4).

    The formula this replaced took a mean of a per-shipment column and
    multiplied it by mean(Throughput)/mean(Demand). That is not a unit
    conversion — demand is in tons and throughput in tons per hour, a
    difference of dimension, not of scale — and it pinned D_t to T_t by
    construction, so the demand constraint sat nearly tight everywhere and the
    reported shortfall meant nothing.
    """
    params = preprocessing.estimate_lp_params(df)
    horizon = params.assumptions["horizon_hours"]
    assert horizon == config.PLANNING_HORIZON_HOURS
    assert params.assumptions["demand_day"] == "mean"

    daily = df.groupby([config.COL_TERMINAL, "date"])[
        config.COL_DEMAND_FORECAST
    ].sum()

    for t in params.terminals:
        tons = daily.loc[t].mean()
        assert params.demand_tons[t] == pytest.approx(tons)
        assert params.demand[t] == pytest.approx(tons / horizon)

    # The old rescaling pinned D_t to the terminal's own capability. A genuine
    # level does not: an average day leaves real headroom.
    for t in params.terminals:
        capability = (
            params.alpha[t] * params.baseline_workforce[t]
            + params.beta[t] * params.baseline_equipment[t]
        )
        assert params.demand[t] < capability * 0.8


def test_peak_day_demand_switches_the_slack_on(df: pd.DataFrame) -> None:
    """The busy-day slice is where the LP earns its keep (MODEL.md 3.4)."""
    average = preprocessing.estimate_lp_params(df, demand_day="mean")
    peak = preprocessing.estimate_lp_params(df, demand_day="p95")

    for t in average.terminals:
        assert peak.demand[t] > average.demand[t] * 1.5
        capability = (
            peak.alpha[t] * peak.baseline_workforce[t]
            + peak.beta[t] * peak.baseline_equipment[t]
        )
        assert peak.demand[t] > capability


def test_demand_scale_multiplies_the_level(df: pd.DataFrame) -> None:
    base = preprocessing.estimate_lp_params(df)
    stressed = preprocessing.estimate_lp_params(df, demand_scale=2.0)
    for t in base.terminals:
        assert stressed.demand[t] == pytest.approx(base.demand[t] * 2.0)


def test_unknown_demand_day_rejected(df: pd.DataFrame) -> None:
    with pytest.raises(ValueError, match="demand_day"):
        preprocessing.estimate_lp_params(df, demand_day="median")


def test_equipment_bounds_are_whole_machines(df: pd.DataFrame) -> None:
    """e_t is an integer variable, so its bounds must be integers too."""
    params = preprocessing.estimate_lp_params(df)
    for t in params.terminals:
        low, high = params.equipment_bounds[t]
        assert low == int(low) and high == int(high)
        assert low <= params.baseline_equipment[t] <= high


def test_labor_share_shifts_weight_between_resources(df: pd.DataFrame) -> None:
    low = preprocessing.estimate_lp_params(df, labor_share=0.3)
    high = preprocessing.estimate_lp_params(df, labor_share=0.8)
    for t in low.terminals:
        assert high.alpha[t] > low.alpha[t]
        assert high.beta[t] < low.beta[t]


def test_invalid_labor_share_rejected(df: pd.DataFrame) -> None:
    with pytest.raises(ValueError, match="labor_share"):
        preprocessing.estimate_lp_params(df, labor_share=1.0)


def test_empty_scenario_rejected(df: pd.DataFrame) -> None:
    with pytest.raises(ValueError, match="empty"):
        preprocessing.estimate_lp_params(df.iloc[0:0])


def test_filters_narrow_the_slice(df: pd.DataFrame) -> None:
    filtered = preprocessing.apply_filters(
        df, ScenarioFilters(terminals=["T1"], peak_hour=1)
    )
    assert not filtered.empty
    assert set(filtered[config.COL_TERMINAL].unique()) == {"T1"}
    assert set(filtered[config.COL_PEAK_HOUR].unique()) == {1}


def test_single_terminal_scenario_warns(df: pd.DataFrame) -> None:
    slice_ = preprocessing.apply_filters(df, ScenarioFilters(terminals=["T1"]))
    params = preprocessing.estimate_lp_params(slice_)
    assert params.terminals == ["T1"]
    assert any("No records for terminal" in w for w in params.warnings)


# --- IP batch ---------------------------------------------------------------


def test_build_batch_shape_and_columns(df: pd.DataFrame) -> None:
    batch = preprocessing.build_batch(df, size=50)
    assert len(batch) == 50
    for col in (
        "value", "priority_weight", "weight_volume",
        "weight_worker_minutes", "weight_equipment_minutes",
    ):
        assert col in batch.columns
        assert batch[col].gt(0).all()


def test_equipment_is_charged_as_minutes_not_machines(df: pd.DataFrame) -> None:
    """Equipment is reusable, so a machine cannot be consumed by a shipment.

    Charging a unit per shipment double-counts a forklift that serves A and
    then B, and made E_cap a count of "slots" against a real fleet of about 30
    units — two numbers describing different universes (MODEL.md 4.4).
    """
    batch = preprocessing.build_batch(df, size=50)
    expected = batch[config.COL_HANDLING_TIME] * batch[config.COL_EQUIPMENT]
    pd.testing.assert_series_equal(
        batch["weight_equipment_minutes"], expected, check_names=False
    )
    # Minutes, not machines: the totals are orders of magnitude apart.
    assert batch["weight_equipment_minutes"].sum() > (
        batch[config.COL_EQUIPMENT].sum() * 20
    )


def test_batch_value_respects_priority_ordering(df: pd.DataFrame) -> None:
    """A Critical shipment must never score below a Low one."""
    batch = preprocessing.build_batch(df, size=200)
    by_priority = batch.groupby(config.COL_PRIORITY)["value"].mean()
    assert by_priority["Critical"] > by_priority["High"] > by_priority["Medium"]
    assert by_priority["Medium"] > by_priority["Low"]
    assert batch.loc[batch[config.COL_PRIORITY] == "Critical", "value"].min() > (
        batch.loc[batch[config.COL_PRIORITY] == "Low", "value"].max()
    )


def test_urgency_weights_change_value_but_not_order(df: pd.DataFrame) -> None:
    flat = preprocessing.build_batch(df, size=80, lambda_waiting=0, lambda_queue=0)
    urgent = preprocessing.build_batch(df, size=80, lambda_waiting=1, lambda_queue=1)
    assert (flat["value"] == flat["priority_weight"]).all()
    assert (urgent["value"] >= flat["value"]).all()


def test_urgency_uplift_is_capped_below_the_tightest_priority_ratio(
    df: pd.DataFrame,
) -> None:
    """The priority-inversion bug, pinned down (MODEL.md 4.3).

    Under the old form `1 + lambda_w*w + lambda_q*q` the multiplier spanned
    [1, 1+lw+lq], so a maximally-urgent High scored 5 x 2 = 10.0 against a
    non-urgent Critical's 10 x 1 = 10.0 — an exact tie broken by CBC's
    branching order, and a strict inversion above lambda = 0.5.
    """
    for lw, lq in ((0.5, 0.5), (1.0, 1.0), (1.0, 0.0), (0.2, 0.9)):
        batch = preprocessing.build_batch(
            df, size=300, lambda_waiting=lw, lambda_queue=lq
        )
        multiplier = batch["value"] / batch["priority_weight"]
        assert multiplier.min() >= 1.0 - 1e-9
        assert multiplier.max() <= 1.0 + config.URGENCY_UPLIFT_CAP + 1e-9

        # Strict class separation: the cheapest Critical still beats the
        # dearest High, all the way down the ladder.
        by_class = {
            p: batch.loc[batch[config.COL_PRIORITY] == p, "value"]
            for p in config.PRIORITIES
        }
        for higher, lower in (
            ("Critical", "High"), ("High", "Medium"), ("Medium", "Low")
        ):
            assert by_class[higher].min() > by_class[lower].max()


def test_lambdas_are_clamped(df: pd.DataFrame) -> None:
    """Nothing upstream may widen the uplift by pushing lambda past 1."""
    sane = preprocessing.build_batch(df, size=60, lambda_waiting=1, lambda_queue=1)
    wild = preprocessing.build_batch(
        df, size=60, lambda_waiting=50, lambda_queue=-3
    )
    clamped = preprocessing.build_batch(
        df, size=60, lambda_waiting=1, lambda_queue=0
    )
    assert (wild["value"] == clamped["value"]).all()
    assert wild["value"].max() <= sane["priority_weight"].max() * (
        1.0 + config.URGENCY_UPLIFT_CAP
    ) + 1e-9


def test_batch_is_deterministic_for_a_seed(df: pd.DataFrame) -> None:
    a = preprocessing.build_batch(df, size=40, seed=7)
    b = preprocessing.build_batch(df, size=40, seed=7)
    pd.testing.assert_series_equal(a[config.COL_RECORD_ID], b[config.COL_RECORD_ID])


def test_default_capacities_bind_but_stay_feasible(df: pd.DataFrame) -> None:
    batch = preprocessing.build_batch(df, size=60)
    caps = preprocessing.default_capacities(batch, fraction=0.6)

    assert caps["volume"] == pytest.approx(batch["weight_volume"].sum() * 0.6)
    assert caps["equipment_minutes"] == pytest.approx(
        batch["weight_equipment_minutes"].sum() * 0.6
    )
    # Binding: not everything fits. Feasible: the largest single item does.
    assert caps["volume"] < batch["weight_volume"].sum()
    assert caps["volume"] > batch["weight_volume"].max()


def test_worker_minutes_come_from_part_one_when_offered(df: pd.DataFrame) -> None:
    """Constraint (2)'s RHS is w_t* H 60, and does not use the fraction f."""
    batch = preprocessing.build_batch(df, size=80)

    standalone = preprocessing.default_capacities(batch, fraction=0.6)
    assert standalone["worker_minutes_source"] == "batch_fraction"

    allocation = {t: 12.0 for t in config.TERMINALS}
    coupled = preprocessing.default_capacities(
        batch, fraction=0.6, lp_workforce=allocation
    )
    assert coupled["worker_minutes_source"] == "lp_allocation"
    expected = 12.0 * config.PLANNING_HORIZON_HOURS * config.MINUTES_PER_HOUR
    for terminal, budget in coupled["worker_minutes"].items():
        assert budget == pytest.approx(expected)
    # f scales volume and equipment, never the labour budget.
    assert coupled["volume"] == standalone["volume"]


def test_batch_rejects_empty_filter_result(df: pd.DataFrame) -> None:
    with pytest.raises(ValueError, match="No shipments"):
        preprocessing.build_batch(
            df, filters=ScenarioFilters(terminals=["T9"]), size=10
        )
