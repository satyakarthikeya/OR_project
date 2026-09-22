"""Scenario filtering, terminal aggregation, and model parameter estimation.

This is the intellectual core of the project. The dataset is synthetic and its
columns are mutually uncorrelated (AGENT.md), so nothing here is fitted. Every
coefficient is derived in closed form from group means plus assumptions that are
named, defaulted in `config`, and exposed to the UI.
"""

from __future__ import annotations

from collections import OrderedDict
from dataclasses import dataclass, field
from typing import Any

import numpy as np
import pandas as pd

from backend.core import config


# --- Scenario selection -----------------------------------------------------


@dataclass
class ScenarioFilters:
    terminals: list[str] | None = None
    cargo_types: list[str] | None = None
    priorities: list[str] | None = None
    directions: list[str] | None = None
    weather: list[str] | None = None
    peak_hour: int | None = None
    date_from: str | None = None
    date_to: str | None = None

    def as_key(self) -> tuple:
        return (
            tuple(self.terminals or ()), tuple(self.cargo_types or ()),
            tuple(self.priorities or ()), tuple(self.directions or ()),
            tuple(self.weather or ()), self.peak_hour,
            self.date_from, self.date_to,
        )


def apply_filters(df: pd.DataFrame, filters: ScenarioFilters | None) -> pd.DataFrame:
    if filters is None:
        return df

    out = df
    for column, values in (
        (config.COL_TERMINAL, filters.terminals),
        (config.COL_CARGO_TYPE, filters.cargo_types),
        (config.COL_PRIORITY, filters.priorities),
        (config.COL_DIRECTION, filters.directions),
        (config.COL_WEATHER, filters.weather),
    ):
        if values:
            out = out[out[column].isin(values)]

    if filters.peak_hour is not None:
        out = out[out[config.COL_PEAK_HOUR] == filters.peak_hour]
    if filters.date_from:
        out = out[out[config.COL_TIMESTAMP] >= pd.Timestamp(filters.date_from)]
    if filters.date_to:
        out = out[out[config.COL_TIMESTAMP] <= pd.Timestamp(filters.date_to)]

    return out


# --- Terminal aggregation ---------------------------------------------------


def _daily_demand_levels(df: pd.DataFrame) -> pd.Series:
    """Tons of forecast cargo arriving at each terminal, per calendar day.

    `Demand_Forecast` is a per-shipment tonnage, so a *sum* is the workload and
    a mean is not: a terminal handling 1,301 shipments and one handling 1,200
    come out identical under a mean, and how busy a terminal is never reaches
    the model (MODEL.md section 3.4).
    """
    day = (
        df["date"] if "date" in df.columns
        else df[config.COL_TIMESTAMP].dt.date
    )
    return df.groupby([df[config.COL_TERMINAL], day])[
        config.COL_DEMAND_FORECAST
    ].sum()


def terminal_summary(df: pd.DataFrame) -> pd.DataFrame:
    """Per-terminal aggregates: the raw material for every LP parameter."""
    grouped = df.groupby(config.COL_TERMINAL)
    daily = _daily_demand_levels(df).groupby(level=0)

    summary = pd.DataFrame({
        "n_records": grouped.size(),
        "n_days": daily.size(),
        "demand_tons_mean_day": daily.mean(),
        "demand_tons_peak_day": daily.quantile(config.DEMAND_DAY_PERCENTILE),
        "mean_workforce": grouped[config.COL_WORKFORCE].mean(),
        "mean_equipment": grouped[config.COL_EQUIPMENT].mean(),
        "mean_throughput": grouped[config.COL_THROUGHPUT].mean(),
        "mean_cost": grouped[config.COL_OPERATIONAL_COST].mean(),
        "mean_demand_forecast": grouped[config.COL_DEMAND_FORECAST].mean(),
        "mean_facility_util": grouped[config.COL_FACILITY_UTIL].mean(),
        "mean_storage_occupancy": grouped[config.COL_STORAGE_OCC].mean(),
        "bottleneck_rate": grouped[config.COL_BOTTLENECK].mean(),
        "workforce_min": grouped[config.COL_WORKFORCE].quantile(
            config.BOUND_LOW_PERCENTILE),
        "workforce_max": grouped[config.COL_WORKFORCE].quantile(
            config.BOUND_HIGH_PERCENTILE),
        "equipment_min": grouped[config.COL_EQUIPMENT].quantile(
            config.BOUND_LOW_PERCENTILE),
        "equipment_max": grouped[config.COL_EQUIPMENT].quantile(
            config.BOUND_HIGH_PERCENTILE),
        "throughput_capacity": grouped[config.COL_THROUGHPUT].quantile(
            config.CAPACITY_PERCENTILE),
    })

    summary.index.name = "terminal"
    return summary.sort_index()


# --- LP parameters ----------------------------------------------------------


@dataclass
class LPParameters:
    terminals: list[str]
    alpha: dict[str, float]
    beta: dict[str, float]
    cost_worker: dict[str, float]
    cost_equipment: dict[str, float]
    demand: dict[str, float]
    #: The level behind `demand`: tons arriving at the terminal in one window,
    #: before division by the horizon. Reported so the rate can be audited.
    demand_tons: dict[str, float]
    capacity: dict[str, float]
    workforce_bounds: dict[str, tuple[float, float]]
    equipment_bounds: dict[str, tuple[float, float]]
    baseline_workforce: dict[str, float]
    baseline_equipment: dict[str, float]
    workforce_total: float
    equipment_total: float
    alpha_uncongested: dict[str, float] = field(default_factory=dict)
    beta_uncongested: dict[str, float] = field(default_factory=dict)
    congestion: dict[str, float] = field(default_factory=dict)
    assumptions: dict[str, Any] = field(default_factory=dict)
    warnings: list[str] = field(default_factory=list)

    def baseline_throughput(self) -> float:
        return sum(
            self.alpha[t] * self.baseline_workforce[t]
            + self.beta[t] * self.baseline_equipment[t]
            for t in self.terminals
        )

    def baseline_cost(self) -> float:
        return sum(
            self.cost_worker[t] * self.baseline_workforce[t]
            + self.cost_equipment[t] * self.baseline_equipment[t]
            for t in self.terminals
        )


def _congestion_multipliers(
    summary: pd.DataFrame, delta: float
) -> dict[str, float]:
    """Productivity discount for congested terminals.

    Terminals in this dataset are statistically near-identical, so uniform
    productivity would leave the LP indifferent between them and the optimum
    would be an artefact of solver scan order. Bottleneck rate and facility
    utilisation are the two per-terminal signals that genuinely vary, so they
    supply the differentiation. This is a stated modelling assumption, not an
    empirical finding (SCOPE.md section 3).
    """
    headroom = (1.0 - summary["mean_facility_util"] / 100.0).clip(lower=0.01)
    gamma = (1.0 - summary["bottleneck_rate"]).clip(lower=0.01) * headroom**delta
    return gamma.to_dict()


def estimate_lp_params(
    df: pd.DataFrame,
    labor_share: float = config.LABOR_SHARE,
    cost_labor_share: float = config.COST_LABOR_SHARE,
    congestion_delta: float = config.CONGESTION_DELTA,
    apply_congestion: bool = True,
    demand_scale: float = 1.0,
    demand_day: str = config.DEMAND_DAY_AGGREGATION,
    horizon_hours: float = config.PLANNING_HORIZON_HOURS,
) -> LPParameters:
    """Derive every LP coefficient from a scenario slice.

    Uses the closed-form share method: with `alpha_t = theta * T_t / w_t` and
    `beta_t = (1 - theta) * T_t / e_t`, the production function reproduces
    observed mean throughput at observed mean inputs exactly, so the baseline
    allocation is feasible by construction and needs no separate calibration.
    """
    if df.empty:
        raise ValueError("Scenario slice is empty; relax the filters")
    if not 0.0 < labor_share < 1.0:
        raise ValueError("labor_share must lie strictly between 0 and 1")
    if demand_day not in ("mean", "p95"):
        raise ValueError("demand_day must be 'mean' or 'p95'")
    if horizon_hours <= 0:
        raise ValueError("horizon_hours must be positive")

    summary = terminal_summary(df)
    terminals = [str(t) for t in summary.index]
    warnings: list[str] = []

    thin = summary.index[summary["n_records"] < config.MIN_ROWS_PER_TERMINAL]
    if len(thin):
        warnings.append(
            f"Terminals {', '.join(map(str, thin))} have fewer than "
            f"{config.MIN_ROWS_PER_TERMINAL} records; their means are unstable"
        )
    missing = sorted(set(config.TERMINALS) - set(terminals))
    if missing:
        warnings.append(
            f"No records for terminal(s) {', '.join(missing)} in this scenario; "
            "they are excluded from the model"
        )

    w_bar = summary["mean_workforce"].clip(lower=config.MIN_WORKFORCE)
    e_bar = summary["mean_equipment"].clip(lower=config.MIN_EQUIPMENT)
    t_bar = summary["mean_throughput"]
    c_bar = summary["mean_cost"]

    alpha_raw = labor_share * t_bar / w_bar
    beta_raw = (1.0 - labor_share) * t_bar / e_bar

    if apply_congestion:
        gamma = pd.Series(_congestion_multipliers(summary, congestion_delta))
        # Renormalise so the congestion discount redistributes productivity
        # between terminals without changing total baseline throughput.
        scale = t_bar.sum() / max((gamma * t_bar).sum(), config.EPSILON)
        factor = gamma * scale
    else:
        gamma = pd.Series(1.0, index=summary.index)
        factor = gamma

    alpha = alpha_raw * factor
    beta = beta_raw * factor

    cost_worker = cost_labor_share * c_bar / w_bar
    cost_equipment = (1.0 - cost_labor_share) * c_bar / e_bar

    # Demand and throughput differ in *dimension*, not scale: Demand_Forecast is
    # a per-shipment tonnage, Throughput_Rate is tons per hour. Summing the
    # forecast over a terminal's planning window gives a level in tons; only
    # dividing by the horizon H turns it into a comparable rate. A rescaling
    # factor would keep tons as tons (MODEL.md section 3.4).
    tons_column = (
        "demand_tons_peak_day" if demand_day == "p95" else "demand_tons_mean_day"
    )
    demand = summary[tons_column] / horizon_hours * demand_scale

    capacity = summary["throughput_capacity"]
    infeasible_demand = [
        t for t in terminals if demand[t] > capacity[t] + config.EPSILON
    ]
    if infeasible_demand:
        warnings.append(
            f"Demand exceeds physical capacity at {', '.join(infeasible_demand)}; "
            "unmet demand will be reported as slack"
        )

    return LPParameters(
        terminals=terminals,
        alpha=alpha.to_dict(),
        beta=beta.to_dict(),
        cost_worker=cost_worker.to_dict(),
        cost_equipment=cost_equipment.to_dict(),
        demand=demand.to_dict(),
        demand_tons=(summary[tons_column] * demand_scale).to_dict(),
        capacity=capacity.to_dict(),
        workforce_bounds={
            t: (float(summary.loc[t, "workforce_min"]),
                float(summary.loc[t, "workforce_max"]))
            for t in terminals
        },
        # e_t is an integer variable, so a fractional percentile bound is
        # tightened by CBC anyway; doing it here keeps the reported bounds and
        # the solved bounds the same number.
        equipment_bounds={
            t: (float(np.floor(summary.loc[t, "equipment_min"])),
                float(np.ceil(summary.loc[t, "equipment_max"])))
            for t in terminals
        },
        baseline_workforce=w_bar.to_dict(),
        baseline_equipment=e_bar.to_dict(),
        workforce_total=float(w_bar.sum()),
        equipment_total=float(e_bar.sum()),
        alpha_uncongested=alpha_raw.to_dict(),
        beta_uncongested=beta_raw.to_dict(),
        congestion=gamma.to_dict(),
        assumptions={
            "labor_share": labor_share,
            "cost_labor_share": cost_labor_share,
            "congestion_delta": congestion_delta,
            "congestion_applied": apply_congestion,
            "horizon_hours": float(horizon_hours),
            "demand_day": demand_day,
            "demand_scale": demand_scale,
            "staffing_ratio": config.STAFFING_RATIO,
            "capacity_percentile": config.CAPACITY_PERCENTILE,
            "bound_percentiles": [
                config.BOUND_LOW_PERCENTILE, config.BOUND_HIGH_PERCENTILE,
            ],
            "n_records": int(len(df)),
        },
        warnings=warnings,
    )


# --- Parameter cache --------------------------------------------------------

#: Derivation runs a groupby over the whole slice, which is far too much work to
#: repeat on every slider move (AGENT.md). Keyed by dataset plus every input that
#: can change the answer, so a stale hit is impossible. `functools.lru_cache`
#: cannot be used directly: a DataFrame is not hashable.
_PARAM_CACHE: "OrderedDict[tuple, LPParameters]" = OrderedDict()
_PARAM_CACHE_MAX = 128


def estimate_lp_params_cached(
    dataset_id: str,
    df: pd.DataFrame,
    filters: ScenarioFilters | None = None,
    labor_share: float = config.LABOR_SHARE,
    cost_labor_share: float = config.COST_LABOR_SHARE,
    congestion_delta: float = config.CONGESTION_DELTA,
    apply_congestion: bool = True,
    demand_scale: float = 1.0,
    demand_day: str = config.DEMAND_DAY_AGGREGATION,
    horizon_hours: float = config.PLANNING_HORIZON_HOURS,
) -> LPParameters:
    """Cached `estimate_lp_params` over a filtered slice.

    The returned object is shared between callers and must be treated as
    read-only; `problem_from_parameters` copies every dict it touches.
    """
    key = (
        dataset_id,
        (filters or ScenarioFilters()).as_key(),
        labor_share, cost_labor_share, congestion_delta,
        apply_congestion, demand_scale, demand_day, horizon_hours,
    )
    cached = _PARAM_CACHE.get(key)
    if cached is not None:
        _PARAM_CACHE.move_to_end(key)
        return cached

    params = estimate_lp_params(
        apply_filters(df, filters),
        labor_share=labor_share,
        cost_labor_share=cost_labor_share,
        congestion_delta=congestion_delta,
        apply_congestion=apply_congestion,
        demand_scale=demand_scale,
        demand_day=demand_day,
        horizon_hours=horizon_hours,
    )
    _PARAM_CACHE[key] = params
    while len(_PARAM_CACHE) > _PARAM_CACHE_MAX:
        _PARAM_CACHE.popitem(last=False)
    return params


def clear_parameter_cache() -> None:
    _PARAM_CACHE.clear()


# --- IP batch ---------------------------------------------------------------


def _min_max_norm(series: pd.Series) -> pd.Series:
    span = series.max() - series.min()
    if span < config.EPSILON:
        return pd.Series(0.0, index=series.index)
    return (series - series.min()) / span


def build_batch(
    df: pd.DataFrame,
    filters: ScenarioFilters | None = None,
    size: int = config.DEFAULT_BATCH_SIZE,
    priority_weights: dict[str, float] | None = None,
    lambda_waiting: float = config.LAMBDA_WAITING,
    lambda_queue: float = config.LAMBDA_QUEUE,
    urgency_cap: float = config.URGENCY_UPLIFT_CAP,
    seed: int = 42,
) -> pd.DataFrame:
    """Assemble a candidate shipment batch with value scores and resource weights.

    The value score is

        v_i = p_i * [ 1 + U * (lambda_w*wait_i + lambda_q*queue_i)
                          / (lambda_w + lambda_q) ]

    with both urgency terms min-max normalised *within the batch* and both
    lambdas clamped to [0, 1] (MODEL.md section 4.3).

    Normalising by `lambda_w + lambda_q` and capping the uplift at `U` is what
    keeps priority lexicographic. Under the earlier uncapped form the
    multiplier spanned [1, 1 + lambda_w + lambda_q], so at the shipped default
    of 0.5 each a maximally-urgent High scored 5 x 2 = 10.0 against a
    non-urgent Critical's 10 x 1 = 10.0 — an exact tie broken by CBC's
    branching order, and a strict inversion for any larger lambda. `U = 0.9`
    sits below the tightest adjacent priority ratio (Critical:High = 2), so
    urgency can only order shipments *within* a class.
    """
    weights = priority_weights or config.PRIORITY_WEIGHTS
    size = max(1, min(int(size), config.MAX_BATCH_SIZE))
    lambda_waiting = float(np.clip(lambda_waiting, config.LAMBDA_MIN,
                                   config.LAMBDA_MAX))
    lambda_queue = float(np.clip(lambda_queue, config.LAMBDA_MIN,
                                 config.LAMBDA_MAX))
    urgency_cap = float(np.clip(urgency_cap, 0.0, config.URGENCY_UPLIFT_CAP))

    pool = apply_filters(df, filters)
    if pool.empty:
        raise ValueError("No shipments match these filters")

    batch = (
        pool.sample(n=size, random_state=seed) if len(pool) > size else pool.copy()
    ).sort_values(config.COL_TIMESTAMP).reset_index(drop=True)

    base = batch[config.COL_PRIORITY].map(weights).astype(float)
    if base.isna().any():
        unknown = sorted(batch.loc[base.isna(), config.COL_PRIORITY].unique())
        raise ValueError(f"No priority weight configured for: {', '.join(unknown)}")

    lambda_total = lambda_waiting + lambda_queue
    if lambda_total < config.EPSILON:
        uplift = pd.Series(0.0, index=batch.index)
    else:
        uplift = urgency_cap * (
            lambda_waiting * _min_max_norm(batch[config.COL_WAITING_TIME])
            + lambda_queue * _min_max_norm(batch[config.COL_QUEUE_LENGTH])
        ) / lambda_total

    batch["priority_weight"] = base
    batch["urgency_uplift"] = uplift
    batch["value"] = base * (1.0 + uplift)
    batch["weight_volume"] = batch[config.COL_CARGO_VOLUME]
    batch["weight_worker_minutes"] = (
        batch[config.COL_HANDLING_TIME] * batch[config.COL_WORKFORCE]
    )
    # Equipment is reusable, so charging a machine per shipment double-counts a
    # forklift that serves A and then B. Machine-*minutes* genuinely are
    # consumable, stay linear, and mirror the treatment of labour above
    # (MODEL.md section 4.4, constraint 3).
    batch["weight_equipment_minutes"] = (
        batch[config.COL_HANDLING_TIME] * batch[config.COL_EQUIPMENT]
    )

    return batch


#: The columns `models.ip_shipment_selection` reads, in the plain-dict form the
#: model layer is allowed to see. Keeping the translation here is what lets the
#: model stay free of pandas (AGENT.md, "Layering rules").
def batch_items(batch: pd.DataFrame) -> list[dict[str, Any]]:
    """Convert a batch frame into plain dicts for the pure IP model."""
    return [
        {
            "record_id": str(row[config.COL_RECORD_ID]),
            "terminal": str(row[config.COL_TERMINAL]),
            "priority": str(row[config.COL_PRIORITY]),
            "cargo_type": str(row[config.COL_CARGO_TYPE]),
            "timestamp": str(row[config.COL_TIMESTAMP]),
            "value": float(row["value"]),
            "priority_weight": float(row["priority_weight"]),
            "urgency_uplift": float(row["urgency_uplift"]),
            "volume": float(row["weight_volume"]),
            "worker_minutes": float(row["weight_worker_minutes"]),
            "equipment_minutes": float(row["weight_equipment_minutes"]),
        }
        for _, row in batch.iterrows()
    ]


def default_capacities(
    batch: pd.DataFrame,
    fraction: float = config.DEFAULT_CAPACITY_FRACTION,
    lp_workforce: dict[str, float] | None = None,
    horizon_hours: float = config.PLANNING_HORIZON_HOURS,
) -> dict[str, Any]:
    """Capacities for the knapsack: binding, but always feasible.

    `V_cap` and `E_cap` are a fraction `f` of the batch's own totals, which is
    what keeps the problem interesting without ever making it infeasible.

    The worker-minute budget is different in kind and **does not use `f`**: when
    Part 1's solved allocation `w_t*` is supplied it becomes `w_t* * H * 60`
    per terminal, which is how Part 2 spends what Part 1 allocated (MODEL.md
    section 4.4, constraint 2). Without an LP result the batch's own per-terminal
    consumption stands in, scaled by `f`, so Part 2 stays solvable standalone —
    and the response says which of the two was used, because the self-referential
    form is a weaker claim.
    """
    fraction = float(np.clip(fraction, 0.05, 1.0))
    by_terminal = batch.groupby(config.COL_TERMINAL)["weight_worker_minutes"].sum()

    if lp_workforce:
        worker_minutes = {
            str(t): float(lp_workforce.get(str(t), 0.0))
            * horizon_hours
            * config.MINUTES_PER_HOUR
            for t in by_terminal.index
        }
        source = "lp_allocation"
    else:
        worker_minutes = {
            str(t): float(v) * fraction for t, v in by_terminal.items()
        }
        source = "batch_fraction"

    return {
        "volume": float(batch["weight_volume"].sum() * fraction),
        "equipment_minutes": float(
            batch["weight_equipment_minutes"].sum() * fraction
        ),
        "worker_minutes": worker_minutes,
        "worker_minutes_source": source,
        "fraction": fraction,
    }
