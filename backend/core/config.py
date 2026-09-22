"""Column names, category vocabularies, and every tunable constant.

No other module may hard-code a magic number. If a value could reasonably be
argued with, it belongs here so it can be cited in the report and swept in
sensitivity analysis.
"""

from __future__ import annotations

from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[2]
BUNDLED_DATASET = PROJECT_ROOT / "air_cargo_resource_allocation_dataset.csv"

# --- Column names -----------------------------------------------------------

COL_RECORD_ID = "Record_ID"
COL_TIMESTAMP = "Timestamp"
COL_FLIGHT_ID = "Flight_ID"
COL_CARGO_VOLUME = "Cargo_Volume"
COL_CARGO_TYPE = "Cargo_Type"
COL_PRIORITY = "Shipment_Priority"
COL_DIRECTION = "Arrival_Departure"
COL_TERMINAL = "Terminal_ID"
COL_GATE = "Gate_Assigned"
COL_HANDLING_TIME = "Handling_Time"
COL_WAITING_TIME = "Waiting_Time"
COL_WORKFORCE = "Workforce_Assigned"
COL_EQUIPMENT = "Equipment_Used"
COL_EQUIPMENT_TYPE = "Equipment_Type"
COL_FACILITY_UTIL = "Facility_Utilization"
COL_STORAGE_OCC = "Storage_Occupancy"
COL_QUEUE_LENGTH = "Queue_Length"
COL_FLIGHT_DELAY = "Flight_Delay"
COL_PEAK_HOUR = "Peak_Hour_Indicator"
COL_WEATHER = "Weather_Condition"
COL_OPERATIONAL_COST = "Operational_Cost"
COL_ENERGY = "Energy_Consumption"
COL_THROUGHPUT = "Throughput_Rate"
COL_BOTTLENECK = "Bottleneck_Flag"
COL_DEMAND_FORECAST = "Demand_Forecast"
COL_REAL_TIME_LOAD = "Real_Time_Load"
COL_ALLOCATION_STRATEGY = "Allocation_Strategy"
COL_EFFICIENCY_CLASS = "Allocation_Efficiency_Class"

REQUIRED_COLUMNS: tuple[str, ...] = (
    COL_RECORD_ID, COL_TIMESTAMP, COL_FLIGHT_ID, COL_CARGO_VOLUME, COL_CARGO_TYPE,
    COL_PRIORITY, COL_DIRECTION, COL_TERMINAL, COL_GATE, COL_HANDLING_TIME,
    COL_WAITING_TIME, COL_WORKFORCE, COL_EQUIPMENT, COL_EQUIPMENT_TYPE,
    COL_FACILITY_UTIL, COL_STORAGE_OCC, COL_QUEUE_LENGTH, COL_FLIGHT_DELAY,
    COL_PEAK_HOUR, COL_WEATHER, COL_OPERATIONAL_COST, COL_ENERGY, COL_THROUGHPUT,
    COL_BOTTLENECK, COL_DEMAND_FORECAST, COL_REAL_TIME_LOAD,
    COL_ALLOCATION_STRATEGY, COL_EFFICIENCY_CLASS,
)

NUMERIC_COLUMNS: tuple[str, ...] = (
    COL_CARGO_VOLUME, COL_HANDLING_TIME, COL_WAITING_TIME, COL_WORKFORCE,
    COL_EQUIPMENT, COL_FACILITY_UTIL, COL_STORAGE_OCC, COL_QUEUE_LENGTH,
    COL_FLIGHT_DELAY, COL_OPERATIONAL_COST, COL_ENERGY, COL_THROUGHPUT,
    COL_DEMAND_FORECAST, COL_REAL_TIME_LOAD,
)

CATEGORICAL_COLUMNS: tuple[str, ...] = (
    COL_CARGO_TYPE, COL_PRIORITY, COL_DIRECTION, COL_TERMINAL,
    COL_EQUIPMENT_TYPE, COL_WEATHER, COL_ALLOCATION_STRATEGY, COL_EFFICIENCY_CLASS,
)

# --- Category vocabularies --------------------------------------------------

TERMINALS: tuple[str, ...] = ("T1", "T2", "T3", "T4")
CARGO_TYPES: tuple[str, ...] = ("General", "Express", "Perishable", "Hazardous")
PRIORITIES: tuple[str, ...] = ("Low", "Medium", "High", "Critical")
DIRECTIONS: tuple[str, ...] = ("Arrival", "Departure")
EQUIPMENT_TYPES: tuple[str, ...] = ("Crane", "Loader", "Forklift", "Conveyor")
WEATHER_CONDITIONS: tuple[str, ...] = ("Clear", "Rain", "Fog", "Storm")

EXPECTED_CATEGORIES: dict[str, tuple[str, ...]] = {
    COL_TERMINAL: TERMINALS,
    COL_CARGO_TYPE: CARGO_TYPES,
    COL_PRIORITY: PRIORITIES,
    COL_DIRECTION: DIRECTIONS,
    COL_EQUIPMENT_TYPE: EQUIPMENT_TYPES,
    COL_WEATHER: WEATHER_CONDITIONS,
}

# --- Planning horizon -------------------------------------------------------

#: Hours in one planning window. This is what makes a demand *level* (tons
#: arriving in the window) comparable with a throughput *rate* (tons/hour), and
#: it sets the worker-minute budget Part 2 draws on (MODEL.md section 1).
PLANNING_HORIZON_HOURS = 8.0

MINUTES_PER_HOUR = 60.0

# --- LP model assumptions ---------------------------------------------------

#: Fraction of throughput attributed to labour; the remainder goes to equipment.
#: This is the single free assumption behind the closed-form parameter method
#: (SCOPE.md section 3) and is exposed in the UI for sensitivity analysis.
LABOR_SHARE = 0.6

#: Same idea for operational cost.
COST_LABOR_SHARE = 0.6

#: Exponent on the facility-utilisation term of the congestion multiplier.
#: Raising it widens the productivity spread between terminals.
CONGESTION_DELTA = 1.0

#: Percentile of observed throughput used as each terminal's physical ceiling.
CAPACITY_PERCENTILE = 0.95

#: Operators required per equipment unit (MODEL.md section 3.3, constraint 5).
#: A stated operational assumption, not a data finding: the observed ratio of
#: about 3.6 workers per machine clears it comfortably, which is what keeps the
#: observed baseline feasible under the coupling constraint.
STAFFING_RATIO = 1.5

#: How the per-day demand levels behind `D_t` are collapsed into one planning
#: window. "mean" is the average day; "p95" is the busy day where the slack
#: variables switch on (MODEL.md section 3.4).
DEMAND_DAY_AGGREGATION = "mean"
DEMAND_DAY_PERCENTILE = 0.95

#: Percentiles of observed resource use used as per-terminal allocation bounds.
BOUND_LOW_PERCENTILE = 0.05
BOUND_HIGH_PERCENTILE = 0.95

#: Penalty per unit of unmet demand. Scaled against the objective at build time
#: so the solver always prefers meeting demand over saving cost.
UNMET_DEMAND_PENALTY_FACTOR = 10.0

#: Terminal slices thinner than this make group means unstable; callers warn.
MIN_ROWS_PER_TERMINAL = 30

#: Tolerances for calling a constraint "binding" after a solve. The tolerance is
#: relative to the constraint's own right-hand side because an absolute epsilon
#: that suits a pool of 30 units is meaningless against a budget of 5,000: CBC
#: lands a few thousandths off a large RHS and the constraint would be reported
#: as slack while carrying a large shadow price.
BINDING_ABS_TOL = 1e-6
BINDING_REL_TOL = 1e-6

#: Below this, a dual is treated as zero. By complementary slackness a non-zero
#: dual means the constraint is binding, which catches whatever the tolerance
#: above misses.
DUAL_ZERO_TOL = 1e-7

# --- IP model assumptions ---------------------------------------------------

PRIORITY_WEIGHTS: dict[str, float] = {
    "Critical": 10.0,
    "High": 5.0,
    "Medium": 2.0,
    "Low": 1.0,
}

#: Urgency weights on normalised waiting time and queue length in the value
#: score. Clamped to [0, 1]: they set the *balance* between the two signals,
#: never the size of the uplift.
LAMBDA_WAITING = 0.5
LAMBDA_QUEUE = 0.5
LAMBDA_MIN = 0.0
LAMBDA_MAX = 1.0

#: Cap on the urgency uplift, so the value multiplier spans [1, 1 + U] for any
#: lambda. It must stay strictly below the tightest adjacent priority ratio
#: (Critical:High = 2), otherwise a maximally-urgent High ties with, or
#: outranks, a non-urgent Critical and the model stops enforcing the priority
#: ordering it is built around (MODEL.md section 4.3). Priority is
#: lexicographic; urgency is a tiebreaker within a class.
URGENCY_UPLIFT_CAP = 0.9

#: Priority classes whose shipments the force-Critical policy toggle pins in.
FORCED_PRIORITY = "Critical"
HAZARDOUS_CARGO_TYPE = "Hazardous"
PERISHABLE_CARGO_TYPE = "Perishable"

#: Capacities default to this fraction of the batch totals, which keeps the
#: knapsack binding but always feasible.
DEFAULT_CAPACITY_FRACTION = 0.6

DEFAULT_BATCH_SIZE = 50
MAX_BATCH_SIZE = 500

# --- Resource pool sweeps ---------------------------------------------------

#: Multiplier range the UI offers on the resource pools, and the range the
#: sensitivity endpoint sweeps by default (SCOPE.md section 3).
POOL_FACTOR_MIN = 0.8
POOL_FACTOR_MAX = 1.2
SENSITIVITY_POINTS = 9
MAX_SENSITIVITY_POINTS = 41

# --- Standing caveat --------------------------------------------------------

#: Repeated verbatim in every optimisation response and rendered as a banner in
#: the UI. The dataset is synthetic, so no result here is an empirical claim.
MODEL_WORLD_CAVEAT = (
    "Model-world result. The dataset is synthetic and its columns are mutually "
    "uncorrelated, so these coefficients are derived from stated assumptions "
    "rather than fitted to observed behaviour. Improvements are gains under "
    "those assumptions, not validated operational gains."
)

# --- Numerical guards -------------------------------------------------------

WINSOR_LOW = 0.05
WINSOR_HIGH = 0.95

#: Denominator floors, so a degenerate slice can never produce an infinite rate.
MIN_WORKFORCE = 1.0
MIN_EQUIPMENT = 1.0

EPSILON = 1e-9
