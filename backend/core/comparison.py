"""Baseline-versus-optimised deltas.

Deliberately dumb arithmetic over two `AllocationEvaluation` objects that were
already scored by the same objective function. Keeping the comparison this thin
is what makes it trustworthy: there is nowhere for a flattering number to hide.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from backend.core import config
from backend.models.lp_resource_allocation import AllocationEvaluation, Objective


@dataclass
class MetricDelta:
    key: str
    label: str
    unit: str
    baseline: float
    optimized: float
    delta: float
    percent_delta: float | None
    #: "up" when a larger number is better, "down" when smaller is better,
    #: "neutral" when the metric is descriptive rather than a score.
    better: str
    improved: bool | None


@dataclass
class ComparisonBlock:
    objective: Objective
    headline: MetricDelta
    metrics: list[MetricDelta]
    expanded_resources: bool = False
    notes: list[str] = field(default_factory=list)


def _delta(
    key: str,
    label: str,
    unit: str,
    baseline: float,
    optimized: float,
    better: str,
) -> MetricDelta:
    delta = optimized - baseline
    percent = (
        (delta / abs(baseline) * 100.0)
        if abs(baseline) > config.EPSILON
        else None
    )

    if better == "neutral" or abs(delta) <= config.EPSILON:
        improved: bool | None = None if better == "neutral" else False
    else:
        improved = delta > 0 if better == "up" else delta < 0

    return MetricDelta(
        key=key,
        label=label,
        unit=unit,
        baseline=float(baseline),
        optimized=float(optimized),
        delta=float(delta),
        percent_delta=None if percent is None else float(percent),
        better=better,
        improved=improved,
    )


#: Below this share of the objective change, the penalty term is not worth
#: calling out; above it, the headline number would mislead without a caveat.
PENALTY_DOMINANCE_THRESHOLD = 0.5


def _penalty_dominance_note(
    baseline: AllocationEvaluation,
    optimized: AllocationEvaluation,
    headline: MetricDelta,
) -> str | None:
    """Warn when the headline delta is mostly the soft-constraint penalty.

    Meeting previously-unmet demand moves the objective by the penalty rate `M`,
    which is deliberately large. Reporting the resulting percentage without
    saying where it came from would be exactly the inflated improvement claim
    AGENT.md forbids.
    """
    penalty_change = abs(optimized.penalty_applied - baseline.penalty_applied)
    objective_change = abs(headline.delta)
    if objective_change <= config.EPSILON:
        return None
    share = penalty_change / objective_change
    if share < PENALTY_DOMINANCE_THRESHOLD:
        return None

    # The two changes can move in opposite directions, which lets the raw ratio
    # exceed 1. Reporting "103%" would read as an arithmetic slip rather than
    # the intended point, so the share is clamped.
    share = min(share, 1.0)

    return (
        f"{share:.0%} of the change in the objective comes from the "
        f"unmet-demand penalty, not from throughput or cost directly: the "
        f"optimised plan closes a demand shortfall of "
        f"{baseline.total_unmet_demand:.1f} units that the penalty prices at a "
        f"deliberately high rate. Read the throughput and cost rows below for "
        f"the operational change."
    )


def compare_allocations(
    baseline: AllocationEvaluation,
    optimized: AllocationEvaluation,
    objective: Objective,
    expanded_resources: bool = False,
    notes: list[str] | None = None,
) -> ComparisonBlock:
    """Build the metric table the UI renders side by side."""
    headline = _delta(
        key="objective_value",
        label=(
            "Objective — throughput less unmet-demand penalty"
            if objective == "max_throughput"
            else "Objective — cost plus unmet-demand penalty"
        ),
        unit="throughput units" if objective == "max_throughput" else "cost units",
        baseline=baseline.objective_value,
        optimized=optimized.objective_value,
        better="up" if objective == "max_throughput" else "down",
    )

    metrics = [
        _delta("total_throughput", "Total throughput", "units/period",
               baseline.total_throughput, optimized.total_throughput, "up"),
        _delta("total_cost", "Total operational cost", "cost units",
               baseline.total_cost, optimized.total_cost, "down"),
        _delta("total_unmet_demand", "Unmet demand", "units/period",
               baseline.total_unmet_demand, optimized.total_unmet_demand, "down"),
        _delta("penalty_applied", "Unmet-demand penalty in the objective",
               "objective units",
               baseline.penalty_applied, optimized.penalty_applied, "down"),
        _delta("total_workforce", "Workers deployed", "workers",
               baseline.total_workforce, optimized.total_workforce, "neutral"),
        _delta("total_equipment", "Equipment deployed", "units",
               baseline.total_equipment, optimized.total_equipment, "neutral"),
    ]

    all_notes = list(notes or [])
    penalty_note = _penalty_dominance_note(baseline, optimized, headline)
    if penalty_note:
        all_notes.append(penalty_note)
    if expanded_resources:
        all_notes.append(
            "Expanded-resources scenario: this run was solved with a larger "
            "resource pool than the terminals were observed to use, so part of "
            "the gain is bought rather than re-allocated."
        )

    return ComparisonBlock(
        objective=objective,
        headline=headline,
        metrics=metrics,
        expanded_resources=expanded_resources,
        notes=all_notes,
    )
