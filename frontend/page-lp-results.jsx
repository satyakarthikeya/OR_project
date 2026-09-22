/**
 * Part 1 — the results half of the LP page: outcome, comparison, per-terminal
 * plan, duals and the sensitivity sweep.
 *
 * Split from page-lp.jsx purely to keep each file inside the few-hundred-line
 * budget that in-browser Babel compilation is comfortable with (AGENT.md).
 * Loaded before page-lp.jsx, which composes these.
 */
(function () {
  const {
    fmt, Card, SectionLabel, Button, Badge, Callout, SolveStatus, StatTile,
    DataTable, Delta, Chart, Skeleton, KeyValueList, UtilizationBar,
    useTheme, chartTheme,
  } = window.UI;
  /* ---------------------------------------------------------------- results */

  function ResultsSection({ result, stale, sensitivity, onResolve, busy }) {
    if (result.status !== 'Optimal') {
      return (
        <Card title="Result">
          <SolveStatus status={result.status} message={result.message}
            suggestions={result.suggestions} />
        </Card>
      );
    }

    const comparison = result.comparison;
    const headline = comparison.headline;

    return (
      <div className="space-y-6">
        {stale && (
          <Callout tone="warn" icon="alert" title="Controls changed since this solve">
            The results below were produced with the previous settings.
            <Button size="sm" variant="secondary" className="mt-3" busy={busy}
              onClick={onResolve}>
              Re-solve with current settings
            </Button>
          </Callout>
        )}

        <Card title="Outcome" subtitle={result.objective_label}
          actions={result.expanded_resources
            ? <Badge tone="warn">Expanded resources</Badge>
            : <Badge tone="neutral">Same resource pools</Badge>}>
          <SolveStatus status={result.status} message={result.message}
            seconds={result.solve_seconds} />

          <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatTile
              label="Objective — baseline" value={fmt.num(headline.baseline, 1)}
              hint={headline.unit} />
            <StatTile
              label="Objective — optimised" value={fmt.num(headline.optimized, 1)}
              tone={headline.improved ? 'good' : 'neutral'} hint={headline.unit} />
            <StatTile
              label="Total throughput"
              value={fmt.num(metric(comparison, 'total_throughput').optimized, 1)}
              hint={`baseline ${fmt.num(metric(comparison, 'total_throughput').baseline, 1)}`} />
            <StatTile
              label="Unmet demand"
              value={fmt.num(metric(comparison, 'total_unmet_demand').optimized, 2)}
              tone={metric(comparison, 'total_unmet_demand').optimized > 0.001
                ? 'danger' : 'good'}
              hint={`baseline ${fmt.num(metric(comparison, 'total_unmet_demand').baseline, 2)}`} />
          </div>

          <div className="mt-6 border border-rule">
            <DataTable
              compact
              rowKey={(r) => r.key}
              rows={[headline, ...comparison.metrics]}
              columns={[
                { key: 'label', header: 'Metric',
                  className: 'text-ink' },
                { key: 'baseline', header: 'Observed', align: 'right',
                  render: (r) => fmt.num(r.baseline, 2) },
                { key: 'optimized', header: 'Optimised', align: 'right',
                  render: (r) => fmt.num(r.optimized, 2) },
                { key: 'delta', header: 'Change', align: 'right',
                  render: (r) => (
                    <Delta value={r.delta} percent={r.percent_delta}
                      better={r.better} />
                  ) },
              ]}
            />
          </div>

          {comparison.notes.length > 0 && (
            <div className="mt-4 space-y-3">
              {comparison.notes.map((note, i) => (
                <Callout key={i} tone="warn" icon="info">{note}</Callout>
              ))}
            </div>
          )}

          <p className="mt-4 text-xs leading-relaxed text-muted">
            Both columns are scored by the same objective function at the same
            resource totals — the observed allocation is never compared against
            raw recorded KPIs.
          </p>
        </Card>

        <div className="grid gap-6 lg:grid-cols-2">
          <Card title="Allocation" subtitle="Observed mean versus optimised, per terminal.">
            <AllocationChart rows={result.allocation} />
          </Card>
          <Card title="Throughput against demand and capacity"
            subtitle="Where each terminal lands between its demand floor and its physical ceiling.">
            <ThroughputChart rows={result.allocation} />
          </Card>
        </div>

        <Card title="Per-terminal plan" bodyClass="p-0"
          subtitle="The allocation to hand to operations, with the change from today.">
          <DataTable
            compact
            rowKey={(r) => r.terminal}
            rows={result.allocation}
            columns={[
              { key: 'terminal', header: 'Terminal',
                className: 'font-medium text-ink' },
              { key: 'baseline_workforce', header: 'Workers now', align: 'right',
                render: (r) => fmt.num(r.baseline_workforce, 1) },
              { key: 'optimized_workforce', header: 'Workers plan', align: 'right',
                render: (r) => (
                  <span className="font-medium text-ink">
                    {fmt.num(r.optimized_workforce, 1)}
                  </span>
                ) },
              { key: 'delta_workforce', header: 'Δ', align: 'right',
                render: (r) => <Delta value={r.delta_workforce} better="neutral" digits={1} /> },
              { key: 'baseline_equipment', header: 'Equip. now', align: 'right',
                render: (r) => fmt.num(r.baseline_equipment, 1) },
              { key: 'optimized_equipment', header: 'Equip. plan', align: 'right',
                render: (r) => (
                  <span className="font-medium text-ink">
                    {fmt.num(r.optimized_equipment, 1)}
                  </span>
                ) },
              { key: 'delta_equipment', header: 'Δ', align: 'right',
                render: (r) => <Delta value={r.delta_equipment} better="neutral" digits={1} /> },
              { key: 'optimized_throughput', header: 'Throughput', align: 'right',
                render: (r) => fmt.num(r.optimized_throughput, 1) },
              { key: 'demand', header: 'Demand', align: 'right',
                render: (r) => fmt.num(r.demand, 1) },
              { key: 'unmet_demand', header: 'Unmet', align: 'right',
                render: (r) => r.unmet_demand > 0.001
                  ? <span className="font-medium text-neg">
                      {fmt.num(r.unmet_demand, 2)}
                    </span>
                  : <span className="text-faint">—</span> },
              { key: 'optimized_cost', header: 'Cost', align: 'right',
                render: (r) => fmt.money(r.optimized_cost) },
            ]}
          />
        </Card>

        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
          <Card title="Binding constraints and shadow prices"
            subtitle="What is actually limiting the plan, and what a unit of relief is worth."
            actions={result.duals_penalty_inflated
              ? <Badge tone="warn">Penalty-stripped</Badge>
              : <Badge tone="neutral">Relaxation duals</Badge>}
            bodyClass="p-0">
            {/* The single most important caveat in the project: the headline
                research question is "what is one more worker worth?", and the
                dual is the answer, so where it came from has to be on screen
                next to it rather than in a footnote. */}
            <div className="border-b border-rule px-5 py-4">
              <Callout tone={result.duals_penalty_inflated ? 'warn' : 'neutral'}
                icon="info">
                {result.duals_note}
              </Callout>
            </div>
            <DataTable
              compact
              rowKey={(r) => r.name}
              rows={result.duals}
              // A binding constraint is what limits the plan, so it reads as an
              // amber edge before any number is parsed.
              rowStripe={(r) => (r.binding ? 'accent' : null)}
              columns={[
                { key: 'name', header: 'Constraint',
                  className: 'font-mono text-xs text-ink' },
                { key: 'binding', header: 'State',
                  render: (r) => (
                    <span className={r.binding
                      ? 'font-mono text-[11px] uppercase tracking-wider text-accent'
                      : 'font-mono text-[11px] uppercase tracking-wider text-faint'}>
                      {r.binding ? 'binding' : 'slack'}
                    </span>
                  ) },
                { key: 'rhs', header: 'RHS', align: 'right',
                  render: (r) => `${r.sense} ${fmt.num(r.rhs, 1)}` },
                { key: 'slack', header: 'Slack', align: 'right',
                  render: (r) => fmt.num(r.slack, 2) },
                { key: 'shadow_price', header: 'Shadow price', align: 'right',
                  render: (r) => (
                    <span className={r.binding ? 'font-medium text-ink' : 'text-faint'}>
                      {fmt.num(r.shadow_price, 4)}
                    </span>
                  ) },
              ]}
            />
            <div className="border-t border-rule-firm px-5 py-4">
              <SectionLabel>Reading the binding constraints</SectionLabel>
              <ul className="mt-3 space-y-2.5">
                {result.duals.filter((d) => d.binding).map((d) => (
                  <li key={d.name}
                    className="border-l-2 border-accent-fill pl-3 text-[13px] leading-relaxed text-body">
                    <span className="font-mono text-xs text-ink">{d.name}</span>
                    {' — '}{d.interpretation}
                  </li>
                ))}
              </ul>
            </div>
          </Card>

          <Card title="Resource use">
            <div className="space-y-5">
              <UtilizationBar label="Workers"
                used={result.resources.workforce_used}
                available={result.resources.workforce_available} />
              <UtilizationBar label="Equipment"
                used={result.resources.equipment_used}
                available={result.resources.equipment_available} />
              {result.resources.budget !== null && (
                <UtilizationBar label="Budget" digits={0}
                  used={result.resources.cost_incurred}
                  available={result.resources.budget} />
              )}
            </div>
            <div className="mt-6 border-t border-rule pt-5">
              <KeyValueList columns={1} items={[
                { label: 'Unmet-demand penalty M',
                  value: fmt.num(result.unmet_penalty, 2) },
                { label: 'Solve time',
                  value: `${fmt.num(result.solve_seconds, 3)} s` },
                { label: 'Binding constraints',
                  value: result.binding_constraints.length },
              ]} />
            </div>
          </Card>
        </div>

        <SensitivityCard state={sensitivity} result={result} />
      </div>
    );
  }

  const metric = (comparison, key) =>
    comparison.metrics.find((m) => m.key === key) || comparison.headline;

  /* ----------------------------------------------------------------- charts */

  function AllocationChart({ rows }) {
    const t = chartTheme(useTheme());
    const labels = rows.map((r) => r.terminal);

    return (
      <div className="space-y-2">
        <Chart
          height={280}
          ariaLabel="Baseline versus optimised workers and equipment per terminal"
          data={[
            { type: 'bar', name: 'Workers — observed', x: labels,
              y: rows.map((r) => r.baseline_workforce),
              marker: { color: t.muted }, offsetgroup: 1,
              hovertemplate: '%{x}: %{y:.1f} workers<extra>Observed</extra>' },
            { type: 'bar', name: 'Workers — optimised', x: labels,
              y: rows.map((r) => r.optimized_workforce),
              marker: { color: t.accent }, offsetgroup: 2,
              hovertemplate: '%{x}: %{y:.1f} workers<extra>Optimised</extra>' },
            { type: 'scatter', mode: 'markers', name: 'Equipment — observed',
              x: labels, y: rows.map((r) => r.baseline_equipment), yaxis: 'y2',
              marker: { color: t.muted, size: 9, symbol: 'circle-open', line: { width: 2 } },
              hovertemplate: '%{x}: %{y:.1f} units<extra>Observed</extra>' },
            { type: 'scatter', mode: 'markers', name: 'Equipment — optimised',
              x: labels, y: rows.map((r) => r.optimized_equipment), yaxis: 'y2',
              marker: { color: t.accent, size: 9, symbol: 'diamond' },
              hovertemplate: '%{x}: %{y:.1f} units<extra>Optimised</extra>' },
          ]}
          layout={{
            barmode: 'group', bargap: 0.4,
            yaxis: { title: { text: 'workers', font: { size: 11 } }, rangemode: 'tozero' },
            yaxis2: {
              title: { text: 'equipment', font: { size: 11 } },
              overlaying: 'y', side: 'right', rangemode: 'tozero',
              showgrid: false, tickfont: { size: 11 }, automargin: true,
            },
            margin: { l: 8, r: 8, t: 8, b: 8 },
          }}
        />
        <p className="text-xs leading-relaxed text-muted">
          Bars are workers (left axis); markers are equipment units (right axis).
          The two resources live on different scales, so plotting them on one axis
          would hide the equipment movement entirely.
        </p>
      </div>
    );
  }

  function ThroughputChart({ rows }) {
    const t = chartTheme(useTheme());
    const labels = rows.map((r) => r.terminal);

    return (
      <div className="space-y-2">
        <Chart
          height={280}
          ariaLabel="Throughput against demand and capacity per terminal"
          data={[
            { type: 'bar', name: 'Throughput — observed', x: labels,
              y: rows.map((r) => r.baseline_throughput),
              marker: { color: t.muted }, offsetgroup: 1,
              hovertemplate: '%{x}: %{y:.1f}<extra>Observed</extra>' },
            { type: 'bar', name: 'Throughput — optimised', x: labels,
              y: rows.map((r) => r.optimized_throughput),
              marker: { color: t.accent }, offsetgroup: 2,
              hovertemplate: '%{x}: %{y:.1f}<extra>Optimised</extra>' },
            { type: 'scatter', mode: 'markers', name: 'Demand D', x: labels,
              y: rows.map((r) => r.demand),
              marker: { color: t.series[2], size: 11, symbol: 'line-ew-open',
                        line: { width: 3 } },
              hovertemplate: '%{x}: %{y:.1f}<extra>Demand</extra>' },
            { type: 'scatter', mode: 'markers', name: 'Capacity ceiling', x: labels,
              y: rows.map((r) => r.capacity),
              marker: { color: t.series[3], size: 11, symbol: 'line-ew-open',
                        line: { width: 3 } },
              hovertemplate: '%{x}: %{y:.1f}<extra>Capacity</extra>' },
          ]}
          layout={{
            barmode: 'group', bargap: 0.4,
            yaxis: { title: { text: 'throughput units', font: { size: 11 } },
                     rangemode: 'tozero' },
            margin: { l: 8, r: 8, t: 8, b: 8 },
          }}
        />
        <p className="text-xs leading-relaxed text-muted">
          A bar below its demand marker is unmet demand, carried by the soft
          constraint's slack variable rather than making the model infeasible.
        </p>
      </div>
    );
  }

  function SensitivityCard({ state, result }) {
    const t = chartTheme(useTheme());

    if (state.loading) {
      return (
        <Card title="Sensitivity — objective against the worker pool">
          <Skeleton className="h-64 w-full" />
        </Card>
      );
    }
    if (!state.data) return null;

    const points = state.data.points.filter((p) => p.objective_value !== null);
    const current = result.resources.workforce_available;

    return (
      <Card
        title="Sensitivity — objective against the worker pool"
        subtitle={state.data.note}
      >
        <Chart
          height={300}
          ariaLabel="Objective value as the worker pool is swept"
          data={[
            { type: 'scatter', mode: 'lines+markers', name: 'Objective',
              x: points.map((p) => p.workforce_total),
              y: points.map((p) => p.objective_value),
              line: { color: t.accent, width: 2.5 },
              marker: { size: 6, color: t.accent },
              hovertemplate: 'pool %{x:.1f} → %{y:.1f}<extra></extra>' },
            { type: 'scatter', mode: 'markers', name: 'Current run',
              x: [current],
              y: [result.comparison.headline.optimized],
              marker: { size: 12, color: t.series[2], symbol: 'circle-open',
                        line: { width: 3 } },
              hovertemplate: 'current pool %{x:.1f}<extra></extra>' },
          ]}
          layout={{
            xaxis: { title: { text: 'worker pool W', font: { size: 11 } } },
            yaxis: { title: { text: result.comparison.headline.unit,
                              font: { size: 11 } } },
            margin: { l: 8, r: 8, t: 8, b: 8 },
          }}
        />
        <div className="mt-4 grid gap-4 sm:grid-cols-3">
          <div>
            <SectionLabel>Swept</SectionLabel>
            <p className="num mt-1.5 text-[13px] text-ink">
              {fmt.num(points[0].workforce_total, 1)} →{' '}
              {fmt.num(points[points.length - 1].workforce_total, 1)} workers
            </p>
          </div>
          <div>
            <SectionLabel>Objective range</SectionLabel>
            <p className="num mt-1.5 text-[13px] text-ink">
              {fmt.num(Math.min(...points.map((p) => p.objective_value)), 1)} →{' '}
              {fmt.num(Math.max(...points.map((p) => p.objective_value)), 1)}
            </p>
          </div>
          <div>
            <SectionLabel>Average slope</SectionLabel>
            <p className="num mt-1.5 text-[13px] text-ink">
              {fmt.num(slope(points), 3)} per worker
            </p>
          </div>
        </div>
      </Card>
    );
  }

  function slope(points) {
    if (points.length < 2) return 0;
    const first = points[0];
    const last = points[points.length - 1];
    const span = last.workforce_total - first.workforce_total;
    return span === 0 ? 0 : (last.objective_value - first.objective_value) / span;
  }


  window.LPResults = { ResultsSection };
})();