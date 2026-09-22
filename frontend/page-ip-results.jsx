/**
 * Part 2 — the results half of the IP page: outcome, IP-versus-FCFS
 * comparison, capacity utilisation and the accepted/rejected table.
 *
 * Split from page-ip.jsx to keep each file inside the few-hundred-line budget
 * that in-browser Babel compilation is comfortable with (AGENT.md). Loaded
 * before page-ip.jsx, which composes these.
 */
(function () {
  const {
    cx, fmt, Card, SectionLabel, Button, Badge, Callout, SolveStatus, StatTile,
    DataTable, Delta, Chart, KeyValueList, UtilizationBar,
    useTheme, chartTheme,
  } = window.UI;

  const PRIORITIES = ['Critical', 'High', 'Medium', 'Low'];

  /** Where the optimiser and the queue disagree — the interesting rows. */
  const ROW_STATUS = {
    both: { label: 'both', tone: 'neutral', stripe: null },
    ip_only: { label: 'IP only', tone: 'accent', stripe: 'accent' },
    fcfs_only: { label: 'FCFS only', tone: 'danger', stripe: 'neg' },
    neither: { label: 'neither', tone: 'neutral', stripe: null },
  };

  /* ---------------------------------------------------------------- results */

  function IPResultsSection({ result, stale, onResolve, busy }) {
    if (result.status !== 'Optimal') {
      return (
        <Card title="Result">
          <SolveStatus status={result.status} message={result.message}
            suggestions={result.suggestions} />
        </Card>
      );
    }

    const c = result.comparison;
    const ip = c.optimized;
    const fcfs = c.baseline;
    const greedy = c.greedy || null;

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
          actions={result.two_stage
            ? <Badge tone="accent">Two-stage · fed by Part 1</Badge>
            : <Badge tone="warn">Standalone</Badge>}>
          <SolveStatus status={result.status} message={result.message}
            seconds={result.solve_seconds} />

          <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatTile label="Value — FCFS" value={fmt.num(fcfs.total_value, 1)}
              hint={`${fcfs.n_accepted} shipments accepted`} />
            <StatTile label="Value — optimised"
              value={fmt.num(ip.total_value, 1)}
              tone={c.value_delta > 0 ? 'good' : 'neutral'}
              hint={`${ip.n_accepted} shipments accepted`} />
            {/* The gap over FCFS is large and flattering; the gap over a
                value-density greedy rule is the one worth defending, so it
                gets the tile and FCFS moves to the hint. */}
            <StatTile label="Value gained"
              value={c.greedy_value_delta === null || c.greedy_value_delta === undefined
                ? fmt.signed(c.value_delta, 1)
                : fmt.signed(c.greedy_value_delta, 1)}
              hint={c.greedy_value_percent_delta === null
                || c.greedy_value_percent_delta === undefined
                ? 'against the best greedy rule'
                : `${fmt.percent(c.greedy_value_percent_delta)} over best greedy`
                  + (c.value_percent_delta === null ? ''
                    : ` · ${fmt.percent(c.value_percent_delta)} over FCFS`)} />
            <StatTile label="Different set"
              value={fmt.ratio(c.greedy_set_difference === null
                || c.greedy_set_difference === undefined
                ? c.set_difference : c.greedy_set_difference)}
              hint="of the greedy and optimal sets disagree" />
          </div>

          <div className="mt-6 border border-rule">
            <DataTable
              compact
              rowKey={(r) => r.key}
              rows={comparisonRows(ip, fcfs, greedy)}
              columns={[
                { key: 'label', header: 'Metric', className: 'text-ink' },
                { key: 'baseline', header: 'FCFS', align: 'right',
                  render: (r) => fmt.num(r.baseline, r.digits) },
                ...(greedy ? [{
                  key: 'greedy', header: 'Best greedy', align: 'right',
                  render: (r) => fmt.num(r.greedy, r.digits),
                }] : []),
                { key: 'optimized', header: 'Optimised', align: 'right',
                  render: (r) => fmt.num(r.optimized, r.digits) },
                { key: 'delta',
                  header: greedy ? 'vs greedy' : 'Change', align: 'right',
                  render: (r) => (
                    <Delta value={r.optimized - (greedy ? r.greedy : r.baseline)}
                      better={r.better} digits={r.digits} />
                  ) },
              ]}
            />
          </div>

          {c.notes.length > 0 && (
            <div className="mt-4 space-y-3">
              {c.notes.map((note, i) => (
                <Callout key={i} tone="neutral" icon="info">{note}</Callout>
              ))}
            </div>
          )}

          <p className="mt-4 text-xs leading-relaxed text-muted">
            {result.duals_note}
          </p>
        </Card>

        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
          <Card title="Priority mix of the processed set"
            subtitle="Value is priority-weighted, so the optimiser should lean Critical.">
            <PriorityMixChart ip={ip} fcfs={fcfs} />
          </Card>

          <Card title="Capacity utilisation"
            subtitle="Which of the three dimensions actually limits the window.">
            <div className="space-y-5">
              {ip.capacity_use.map((u) => (
                <UtilizationBar key={u.key} label={u.label} unit={u.unit}
                  digits={0} used={u.used} available={u.available} />
              ))}
            </div>
            <div className="mt-6 border-t border-rule pt-5">
              <SectionLabel>Binding</SectionLabel>
              {result.binding_capacities.length === 0 ? (
                <p className="mt-2 text-[13px] leading-relaxed text-muted">
                  Nothing binds — the whole batch fits. Lower the capacity
                  fraction to make the selection a real decision.
                </p>
              ) : (
                <ul className="mt-3 space-y-2">
                  {ip.capacity_use.filter((u) => u.binding).map((u) => (
                    <li key={u.key}
                      className="border-l-2 border-accent-fill pl-3 text-[13px] leading-relaxed text-body">
                      <span className="font-mono text-xs text-ink">{u.label}</span>
                      {' — '}no rejected shipment fits in the
                      {' '}<span className="num">{fmt.num(u.available - u.used, 0)}</span>
                      {' '}{u.unit} left.
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </Card>
        </div>

        <ShipmentsCard result={result} />
      </div>
    );
  }

  function comparisonRows(ip, fcfs, greedy) {
    const g = greedy || fcfs;
    return [
      { key: 'total_value', label: 'Priority-weighted value', digits: 2,
        better: 'up', baseline: fcfs.total_value, greedy: g.total_value,
        optimized: ip.total_value },
      { key: 'n_accepted', label: 'Shipments processed', digits: 0,
        better: 'up', baseline: fcfs.n_accepted, greedy: g.n_accepted,
        optimized: ip.n_accepted },
      ...PRIORITIES.map((p) => ({
        key: `mix_${p}`, label: `${p} processed`, digits: 0, better: 'up',
        baseline: fcfs.priority_mix[p] || 0,
        greedy: g.priority_mix[p] || 0,
        optimized: ip.priority_mix[p] || 0,
      })),
      { key: 'volume_used', label: 'Volume used', digits: 1, better: 'neutral',
        baseline: fcfs.volume_used, greedy: g.volume_used,
        optimized: ip.volume_used },
      { key: 'equipment_minutes_used', label: 'Equipment-minutes used',
        digits: 0, better: 'neutral',
        baseline: fcfs.equipment_minutes_used,
        greedy: g.equipment_minutes_used,
        optimized: ip.equipment_minutes_used },
    ];
  }

  /* ----------------------------------------------------------------- charts */

  function PriorityMixChart({ ip, fcfs }) {
    const t = chartTheme(useTheme());

    return (
      <div className="space-y-2">
        <Chart
          height={280}
          ariaLabel="Shipments processed by priority class, FCFS versus optimised"
          data={[
            { type: 'bar', name: 'FCFS', x: PRIORITIES,
              y: PRIORITIES.map((p) => fcfs.priority_mix[p] || 0),
              marker: { color: t.muted }, offsetgroup: 1,
              hovertemplate: '%{x}: %{y} shipments<extra>FCFS</extra>' },
            { type: 'bar', name: 'Optimised', x: PRIORITIES,
              y: PRIORITIES.map((p) => ip.priority_mix[p] || 0),
              marker: { color: t.accent }, offsetgroup: 2,
              hovertemplate: '%{x}: %{y} shipments<extra>Optimised</extra>' },
          ]}
          layout={{
            barmode: 'group', bargap: 0.4,
            yaxis: { title: { text: 'shipments', font: { size: 11 } },
                     rangemode: 'tozero' },
            margin: { l: 8, r: 8, t: 8, b: 8 },
          }}
        />
        <p className="text-xs leading-relaxed text-muted">
          Both bars are drawn from the same batch under the same capacities.
          The optimiser has no rule telling it to prefer Critical cargo — it
          leans that way because the value function prices it higher.
        </p>
      </div>
    );
  }

  /* -------------------------------------------------------------- shipments */

  function ShipmentsCard({ result }) {
    const [filter, setFilter] = React.useState('all');

    const rows = result.shipments.filter((r) => {
      if (filter === 'accepted') return r.accepted;
      if (filter === 'rejected') return !r.accepted;
      if (filter === 'disagree') return r.status === 'ip_only'
        || r.status === 'fcfs_only';
      return true;
    });

    const counts = {
      all: result.shipments.length,
      accepted: result.shipments.filter((r) => r.accepted).length,
      rejected: result.shipments.filter((r) => !r.accepted).length,
      disagree: result.shipments.filter(
        (r) => r.status === 'ip_only' || r.status === 'fcfs_only').length,
    };

    return (
      <Card
        title="Shipment decisions"
        subtitle="Every candidate, what the optimiser chose, and where it parts company with the queue."
        bodyClass="p-0"
        actions={
          <div className="flex flex-wrap gap-1">
            {['all', 'accepted', 'rejected', 'disagree'].map((key) => (
              <button
                key={key}
                onClick={() => setFilter(key)}
                className={cx(
                  'border px-2 py-1 font-mono text-[10px] uppercase tracking-wider transition-colors',
                  filter === key
                    ? 'border-accent-fill bg-accent-fill text-accent-ink'
                    : 'border-rule-firm text-muted hover:bg-sunken hover:text-ink'
                )}
              >
                {key} <span className="num">{counts[key]}</span>
              </button>
            ))}
          </div>
        }
      >
        <DataTable
          compact
          rowKey={(r) => r.record_id}
          rows={rows}
          emptyMessage="No shipments match this filter"
          rowStripe={(r) => ROW_STATUS[r.status].stripe}
          headerClass="normal-case tracking-normal"
          columns={[
            { key: 'record_id', header: 'Record',
              className: 'font-mono text-xs text-ink' },
            { key: 'terminal', header: 'Terminal',
              className: 'font-mono text-xs text-body' },
            { key: 'priority', header: 'Priority',
              render: (r) => (
                <Badge tone={r.priority === 'Critical' ? 'danger'
                  : r.priority === 'High' ? 'warn' : 'neutral'}>
                  {r.priority}
                </Badge>
              ) },
            { key: 'cargo_type', header: 'Cargo' },
            { key: 'value', header: 'value v', align: 'right',
              render: (r) => (
                <span className={r.accepted ? 'font-medium text-ink' : ''}>
                  {fmt.num(r.value, 2)}
                </span>
              ) },
            { key: 'urgency_uplift', header: 'urgency', align: 'right',
              render: (r) => `+${fmt.ratio(r.urgency_uplift)}` },
            { key: 'volume', header: 'volume', align: 'right',
              render: (r) => fmt.num(r.volume, 1) },
            { key: 'worker_minutes', header: 'worker-min', align: 'right',
              render: (r) => fmt.num(r.worker_minutes, 0) },
            { key: 'equipment_minutes', header: 'machine-min', align: 'right',
              render: (r) => fmt.num(r.equipment_minutes, 0) },
            { key: 'accepted', header: 'Decision',
              render: (r) => (
                <span className={cx(
                  'font-mono text-[11px] uppercase tracking-wider',
                  r.accepted ? 'text-pos' : 'text-faint')}>
                  {r.accepted ? 'process' : 'hold'}
                </span>
              ) },
            { key: 'status', header: 'vs FCFS',
              render: (r) => (
                <Badge tone={ROW_STATUS[r.status].tone}>
                  {ROW_STATUS[r.status].label}
                </Badge>
              ) },
          ]}
        />
        <div className="border-t border-rule px-5 py-4">
          <p className="text-xs leading-relaxed text-muted">
            An amber stripe marks a shipment the optimiser processes and the
            queue does not; a brick stripe marks one the queue takes and the
            optimiser holds back. Those rows are where the optimisation
            actually happened.
          </p>
        </div>
      </Card>
    );
  }


  window.IPResults = { IPResultsSection };
})();
