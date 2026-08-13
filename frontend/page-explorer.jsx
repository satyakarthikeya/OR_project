/**
 * Home and Data Explorer.
 *
 * The Explorer's job is not decoration: the correlation heatmap is the evidence
 * for the central modelling constraint of this project — nothing in this dataset
 * can be fitted — and it is presented as a finding, with the consequence spelled
 * out next to it.
 */
(function () {
  const { useState, useMemo } = React;
  const {
    cx, fmt, Card, PageHeader, SectionLabel, Button, Badge, Callout, CaveatBanner,
    StatTile, DataTable, Chart, EmptyState, Skeleton, ErrorState, SegmentedControl,
    Icon, KeyValueList, useAsync, useTheme, chartTheme,
  } = window.UI;

  /* ------------------------------------------------------------------ home */

  const PART_CARDS = [
    {
      tag: 'Part 1',
      status: 'ready',
      title: 'Linear programming — workforce & equipment allocation',
      question: 'Given a limited pool of workers and equipment, where should we put them?',
      points: [
        'Continuous decision variables per terminal, solved with CBC',
        'Two objectives: maximise throughput, or minimise cost subject to demand',
        'Soft demand constraints, shadow prices, and a resource-pool sweep',
      ],
      page: 'lp',
    },
    {
      tag: 'Part 2',
      status: 'planned',
      title: 'Integer programming — cargo processing selection',
      question: 'If we cannot process everything now, what goes first?',
      points: [
        '0-1 multi-dimensional knapsack over a batch of shipments',
        'Priority-weighted value with waiting-time and queue urgency terms',
        'Compared against a greedy first-come-first-served baseline',
      ],
      page: 'ip',
    },
  ];

  function HomePage({ dataset, onDataset, onNavigate }) {
    // Re-checked whenever a dataset is registered, so the "datasets in memory"
    // count cannot sit at zero next to a loaded dataset.
    const health = useAsync(
      () => window.api.health(), [dataset && dataset.dataset_id]
    );
    const [busy, setBusy] = useState(null);
    const [error, setError] = useState(null);

    async function loadBundled() {
      setBusy('bundled'); setError(null);
      try {
        onDataset(await window.api.loadBundledDataset());
      } catch (e) { setError(e); } finally { setBusy(null); }
    }

    async function upload(event) {
      const file = event.target.files && event.target.files[0];
      event.target.value = '';
      if (!file) return;
      setBusy('upload'); setError(null);
      try {
        onDataset(await window.api.uploadDataset(file));
      } catch (e) { setError(e); } finally { setBusy(null); }
    }

    return (
      <div>
        <PageHeader
          eyebrow="Operations Research decision support"
          title="Air cargo resource allocation and operational optimisation"
        >
          Two optimisation models over one shared data layer, solved with PuLP/CBC
          and served by FastAPI. Load the dataset to begin — every later screen
          works from the <code className="rounded bg-slate-200 px-1 py-0.5 text-xs dark:bg-slate-800">dataset_id</code> it
          returns.
        </PageHeader>

        <CaveatBanner />

        <div className="grid gap-6 lg:grid-cols-3">
          <Card
            className="lg:col-span-2"
            title="Dataset"
            subtitle="Use the bundled Kaggle extract, or upload a CSV with the same 28 columns."
          >
            {dataset ? (
              <div>
                <div className="flex flex-wrap items-center gap-3">
                  <Badge tone="good">Loaded</Badge>
                  <span className="truncate text-sm font-medium text-slate-900 dark:text-slate-100">
                    {dataset.name}
                  </span>
                </div>
                <div className="mt-5">
                  <KeyValueList
                    columns={2}
                    items={[
                      { label: 'Records', value: fmt.int(dataset.n_rows) },
                      // 28 source columns plus the helper columns `clean()`
                      // derives, so the raw count would look like a mismatch
                      // against the "same 28 columns" line above.
                      { label: 'Columns after cleaning',
                        value: fmt.int(dataset.n_columns) },
                      { label: 'Dataset ID', value: dataset.dataset_id },
                      {
                        label: 'Loaded at',
                        value: new Date(dataset.uploaded_at).toLocaleString(),
                      },
                    ]}
                  />
                </div>
                {dataset.warnings && dataset.warnings.length > 0 && (
                  <Callout tone="warn" className="mt-5" title="Validation warnings">
                    <ul className="list-disc space-y-1 pl-5">
                      {dataset.warnings.map((w, i) => <li key={i}>{w}</li>)}
                    </ul>
                  </Callout>
                )}
                <div className="mt-6 flex flex-wrap gap-3">
                  <Button variant="primary" icon="chart"
                    onClick={() => onNavigate('explorer')}>
                    Explore the data
                  </Button>
                  <Button variant="secondary" icon="sliders"
                    onClick={() => onNavigate('lp')}>
                    Go to Part 1 — LP
                  </Button>
                </div>
              </div>
            ) : (
              <div>
                <div className="flex flex-wrap gap-3">
                  <Button variant="primary" icon="database" busy={busy === 'bundled'}
                    onClick={loadBundled}>
                    Load bundled dataset
                  </Button>
                  <label className={cx(
                    'inline-flex cursor-pointer items-center gap-2 rounded-lg border px-3.5 py-2',
                    'border-slate-300 bg-white text-sm font-medium text-slate-700 transition-colors',
                    'hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900',
                    'dark:text-slate-200 dark:hover:bg-slate-800'
                  )}>
                    {busy === 'upload'
                      ? <Icon name="spinner" className="h-4 w-4 animate-spin" />
                      : <Icon name="upload" />}
                    Upload a CSV
                    <input type="file" accept=".csv" className="sr-only"
                      onChange={upload} disabled={busy !== null} />
                  </label>
                </div>
                <p className="mt-4 text-sm leading-relaxed text-slate-500 dark:text-slate-400">
                  Uploads are validated against the expected schema before they are
                  accepted: missing columns are rejected outright, unexpected
                  categories and duplicate rows come back as warnings. Nothing is
                  written to disk — the frame lives in an in-memory registry for
                  the lifetime of the server process.
                </p>
                {error && <div className="mt-5"><ErrorState error={error} /></div>}
              </div>
            )}
          </Card>

          <Card title="Service" subtitle="Backend and solver availability.">
            {health.loading ? (
              <div className="space-y-3">
                <Skeleton className="h-4 w-2/3" />
                <Skeleton className="h-4 w-1/2" />
              </div>
            ) : health.error ? (
              <ErrorState error={health.error} onRetry={health.run} />
            ) : (
              <dl className="space-y-3.5 text-sm">
                <StatusRow label="API"
                  ok={health.data.status === 'ok'} value={health.data.status} />
                <StatusRow label="Solver" ok={health.data.solver_available}
                  value={health.data.solver_name} />
                <div className="flex items-center justify-between">
                  <dt className="text-slate-600 dark:text-slate-300">Datasets in memory</dt>
                  <dd className="num font-medium">{health.data.datasets_loaded}</dd>
                </div>
                <div className="border-t border-slate-200 pt-3.5 dark:border-slate-800">
                  <a href="/docs" target="_blank" rel="noreferrer"
                    className="inline-flex items-center gap-1.5 text-sm font-medium text-accent-700 hover:underline dark:text-accent-400">
                    Interactive API docs <Icon name="arrow" className="h-3.5 w-3.5" />
                  </a>
                </div>
              </dl>
            )}
          </Card>
        </div>

        <div className="mt-6 grid gap-6 lg:grid-cols-2">
          {PART_CARDS.map((part) => (
            <Card key={part.tag}>
              <div className="flex items-center gap-2">
                <Badge tone={part.status === 'ready' ? 'accent' : 'neutral'}>
                  {part.tag}
                </Badge>
                {part.status === 'planned' && <Badge tone="neutral">Planned</Badge>}
              </div>
              <h3 className="mt-3 text-base font-semibold tracking-tight text-slate-900 dark:text-slate-50">
                {part.title}
              </h3>
              <p className="mt-1.5 text-sm italic leading-relaxed text-slate-500 dark:text-slate-400">
                {part.question}
              </p>
              <ul className="mt-4 space-y-2">
                {part.points.map((point) => (
                  <li key={point} className="flex gap-2.5 text-sm text-slate-600 dark:text-slate-300">
                    <Icon name="check" className="mt-1 h-3.5 w-3.5 shrink-0 text-accent-600 dark:text-accent-400" />
                    <span className="leading-relaxed">{point}</span>
                  </li>
                ))}
              </ul>
              <div className="mt-5">
                <Button
                  variant={part.status === 'ready' ? 'primary' : 'secondary'}
                  disabled={part.status !== 'ready' || !dataset}
                  onClick={() => onNavigate(part.page)}
                >
                  {part.status === 'ready'
                    ? (dataset ? 'Open Part 1' : 'Load a dataset first')
                    : 'Not built yet'}
                </Button>
              </div>
            </Card>
          ))}
        </div>
      </div>
    );
  }

  const StatusRow = ({ label, ok, value }) => (
    <div className="flex items-center justify-between">
      <dt className="text-slate-600 dark:text-slate-300">{label}</dt>
      <dd className="flex items-center gap-2">
        <span className={cx('h-1.5 w-1.5 rounded-full',
          ok ? 'bg-emerald-500' : 'bg-rose-500')} />
        <span className="font-medium">{value}</span>
      </dd>
    </div>
  );

  /* -------------------------------------------------------------- explorer */

  const SHORT_NAMES = {
    Cargo_Volume: 'Volume', Handling_Time: 'Handling', Waiting_Time: 'Waiting',
    Workforce_Assigned: 'Workforce', Equipment_Used: 'Equipment',
    Facility_Utilization: 'Facility util', Storage_Occupancy: 'Storage',
    Queue_Length: 'Queue', Flight_Delay: 'Delay', Operational_Cost: 'Cost',
    Energy_Consumption: 'Energy', Throughput_Rate: 'Throughput',
    Demand_Forecast: 'Demand fc', Real_Time_Load: 'Load',
  };
  const short = (name) => SHORT_NAMES[name] || name.replace(/_/g, ' ');

  function ExplorerPage({ dataset }) {
    const summary = useAsync(
      () => window.api.datasetSummary(dataset.dataset_id), [dataset.dataset_id]
    );

    if (summary.loading) return <ExplorerSkeleton />;
    if (summary.error) {
      return <ErrorState error={summary.error} onRetry={summary.run} />;
    }

    const data = summary.data;
    const kpis = data.kpis;

    return (
      <div>
        <PageHeader eyebrow="Data explorer" title="What the data actually says">
          Descriptive statistics for the loaded scenario, plus the one finding that
          shapes every model in this project: the columns carry no mutual
          information.
        </PageHeader>

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatTile label="Records" value={fmt.int(kpis.n_records)}
            hint={`${fmt.int(kpis.n_terminals)} terminals`} />
          <StatTile label="Mean throughput" value={fmt.num(kpis.mean_throughput, 1)}
            unit="units" hint="Throughput_Rate" />
          <StatTile label="Mean operational cost"
            value={fmt.money(kpis.mean_operational_cost)} unit="per record" />
          <StatTile label="Bottleneck rate" value={fmt.ratio(kpis.bottleneck_rate)}
            hint="Share of records flagged as bottlenecked" />
        </div>

        <div className="mt-6 grid gap-6 lg:grid-cols-5">
          <Card className="lg:col-span-3" title="Per-terminal profile"
            subtitle="The aggregates every LP coefficient is derived from."
            bodyClass="p-0">
            <DataTable
              rowKey={(r) => r.terminal}
              rows={data.terminal_stats}
              columns={[
                { key: 'terminal', header: 'Terminal',
                  className: 'font-medium text-slate-900 dark:text-slate-100' },
                { key: 'n_records', header: 'Records', align: 'right',
                  render: (r) => fmt.int(r.n_records) },
                { key: 'mean_workforce', header: 'Workers', align: 'right',
                  render: (r) => fmt.num(r.mean_workforce, 2) },
                { key: 'mean_equipment', header: 'Equipment', align: 'right',
                  render: (r) => fmt.num(r.mean_equipment, 2) },
                { key: 'mean_throughput', header: 'Throughput', align: 'right',
                  render: (r) => fmt.num(r.mean_throughput, 2) },
                { key: 'mean_cost', header: 'Cost', align: 'right',
                  render: (r) => fmt.money(r.mean_cost) },
                { key: 'mean_demand_forecast', header: 'Demand fc', align: 'right',
                  render: (r) => fmt.num(r.mean_demand_forecast, 1) },
                { key: 'mean_facility_util', header: 'Facility util', align: 'right',
                  render: (r) => fmt.num(r.mean_facility_util, 1) },
                { key: 'bottleneck_rate', header: 'Bottleneck', align: 'right',
                  render: (r) => fmt.ratio(r.bottleneck_rate, 1) },
                { key: 'throughput_capacity', header: 'Cap (p95)', align: 'right',
                  render: (r) => fmt.num(r.throughput_capacity, 1) },
              ]}
            />
            <p className="px-4 pb-4 pt-3 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
              Facility utilisation and bottleneck rate feed the congestion
              multiplier γ; the capacity column is the 95th percentile of observed
              throughput, which becomes each terminal's ceiling in the LP.
            </p>
          </Card>

          <Card className="lg:col-span-2" title="The signals that vary"
            subtitle="Bottleneck rate and facility utilisation are the only per-terminal measures that differ enough to model with.">
            <TerminalSignalChart terminals={data.terminal_stats} />
          </Card>
        </div>

        <div className="mt-6">
          <CorrelationCard data={data} />
        </div>

        <div className="mt-6 grid gap-6 lg:grid-cols-2">
          <CategoryCard counts={data.categorical_counts} />
          <Card title="Numeric ranges"
            subtitle="Every numeric column is uniform across its range — mean and median coincide throughout."
            bodyClass="p-0">
            <DataTable
              compact
              rowKey={(r) => r.column}
              rows={data.numeric_stats}
              columns={[
                { key: 'column', header: 'Column', render: (r) => short(r.column),
                  className: 'font-medium text-slate-900 dark:text-slate-100' },
                { key: 'min', header: 'Min', align: 'right',
                  render: (r) => fmt.num(r.min, 1) },
                { key: 'median', header: 'Median', align: 'right',
                  render: (r) => fmt.num(r.median, 1) },
                { key: 'mean', header: 'Mean', align: 'right',
                  render: (r) => fmt.num(r.mean, 1) },
                { key: 'max', header: 'Max', align: 'right',
                  render: (r) => fmt.num(r.max, 1) },
                { key: 'std', header: 'Std', align: 'right',
                  render: (r) => fmt.num(r.std, 1) },
              ]}
            />
          </Card>
        </div>
      </div>
    );
  }

  function TerminalSignalChart({ terminals }) {
    const theme = useTheme();
    const t = chartTheme(theme);
    const labels = terminals.map((r) => r.terminal);

    const data = [
      {
        type: 'bar', name: 'Bottleneck rate',
        x: labels, y: terminals.map((r) => r.bottleneck_rate * 100),
        marker: { color: t.accent }, hovertemplate: '%{y:.1f}%<extra>Bottleneck</extra>',
      },
      {
        type: 'bar', name: 'Facility utilisation',
        x: labels, y: terminals.map((r) => r.mean_facility_util),
        marker: { color: t.muted }, hovertemplate: '%{y:.1f}%<extra>Utilisation</extra>',
      },
    ];

    return (
      <Chart
        data={data} height={260}
        ariaLabel="Bottleneck rate and facility utilisation per terminal"
        layout={{
          barmode: 'group', bargap: 0.35,
          yaxis: { title: { text: '%', font: { size: 11 } }, rangemode: 'tozero' },
          margin: { l: 8, r: 8, t: 8, b: 8 },
        }}
      />
    );
  }

  function CorrelationCard({ data }) {
    const theme = useTheme();
    const t = chartTheme(theme);
    const [scale, setScale] = useState('full');

    const { z, labels, peak } = useMemo(() => {
      const cols = Object.keys(data.correlation);
      const matrix = cols.map((r) => cols.map((c) => data.correlation[r][c]));
      let max = 0;
      cols.forEach((r, i) => cols.forEach((c, j) => {
        if (i !== j) max = Math.max(max, Math.abs(matrix[i][j]));
      }));
      return { z: matrix, labels: cols.map(short), peak: max };
    }, [data.correlation]);

    // The zoom bound is derived from the data, not from the current mode, so the
    // toggle's label states where zooming would take you rather than where you
    // already are.
    const zoomBound = Math.max(0.01, Math.ceil(peak * 100) / 100);
    const bound = scale === 'full' ? 1 : zoomBound;

    return (
      <Card
        title="Correlation matrix — a finding, not a decoration"
        subtitle="Pearson correlation between every pair of numeric columns."
        actions={
          <SegmentedControl
            value={scale} onChange={setScale}
            options={[
              { value: 'full', label: 'Scale −1…1' },
              { value: 'zoom', label: `Zoom ±${zoomBound.toFixed(2)}` },
            ]}
          />
        }
      >
        <div className="grid gap-6 lg:grid-cols-5">
          <div className="lg:col-span-3">
            <Chart
              height={420}
              ariaLabel="Correlation heatmap of numeric columns"
              data={[{
                type: 'heatmap', z, x: labels, y: labels,
                zmin: -bound, zmax: bound,
                colorscale: [
                  [0, t.dark ? '#7f1d1d' : '#b91c1c'],
                  [0.5, t.dark ? '#0f172a' : '#f8fafc'],
                  [1, t.dark ? '#134e4a' : '#0f766e'],
                ],
                hovertemplate: '%{y} × %{x}<br>r = %{z:.3f}<extra></extra>',
                colorbar: { thickness: 10, len: 0.85, outlinewidth: 0,
                            tickfont: { size: 10 } },
              }]}
              layout={{
                xaxis: { tickangle: -45, tickfont: { size: 10 }, showgrid: false },
                yaxis: { autorange: 'reversed', tickfont: { size: 10 }, showgrid: false },
                margin: { l: 8, r: 8, t: 8, b: 8 },
              }}
            />
          </div>
          <div className="lg:col-span-2">
            <SectionLabel>Reading</SectionLabel>
            <p className="mt-2 text-sm leading-relaxed text-slate-600 dark:text-slate-300">
              {data.correlation_note}
            </p>
            <div className="mt-5 rounded-lg border border-slate-200 bg-slate-50 p-4 dark:border-slate-800 dark:bg-slate-950/50">
              <p className="num text-2xl font-semibold tracking-tight text-slate-900 dark:text-slate-50">
                {fmt.num(peak, 3)}
              </p>
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                strongest off-diagonal |r| across {labels.length} numeric columns
              </p>
            </div>
            <Callout tone="accent" className="mt-5" title="Consequence for the models">
              With no signal to regress on, fitting coefficients would produce
              noise dressed up as a result. Part 1 instead derives every
              coefficient in closed form from group means plus a single named
              assumption, which you can move and re-solve on the LP page.
            </Callout>
            <p className="mt-4 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
              Switch the scale to see the two readings: at −1…1 the matrix is
              uniformly blank, which is the honest picture; zoomed to the observed
              range the structure that appears is sampling noise, not signal.
            </p>
          </div>
        </div>
      </Card>
    );
  }

  function CategoryCard({ counts }) {
    const theme = useTheme();
    const t = chartTheme(theme);
    const [column, setColumn] = useState(counts[0] && counts[0].column);

    const active = counts.find((c) => c.column === column) || counts[0];
    const entries = Object.entries(active.counts).sort((a, b) => b[1] - a[1]);

    return (
      <Card title="Category distributions"
        subtitle="Category balance across the loaded scenario.">
        <div className="mb-4 flex flex-wrap gap-1.5">
          {counts.map((c) => (
            <button key={c.column} onClick={() => setColumn(c.column)}
              className={cx(
                'rounded-md border px-2.5 py-1 text-xs font-medium transition-colors',
                c.column === active.column
                  ? 'border-accent-600 bg-accent-600 text-white'
                  : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300'
              )}>
              {short(c.column)}
            </button>
          ))}
        </div>
        <Chart
          height={Math.max(240, entries.length * 46 + 70)}
          ariaLabel={`Distribution of ${active.column}`}
          data={[{
            type: 'bar', orientation: 'h',
            y: entries.map((e) => e[0]).reverse(),
            x: entries.map((e) => e[1]).reverse(),
            marker: { color: t.accent },
            hovertemplate: '%{y}: %{x} records<extra></extra>',
          }]}
          layout={{
            xaxis: { rangemode: 'tozero' },
            yaxis: { automargin: true },
            margin: { l: 8, r: 16, t: 8, b: 8 },
          }}
        />
      </Card>
    );
  }

  const ExplorerSkeleton = () => (
    <div>
      <Skeleton className="h-7 w-72" />
      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-24 w-full rounded-xl" />)}
      </div>
      <div className="mt-6 grid gap-6 lg:grid-cols-5">
        <Skeleton className="h-64 rounded-xl lg:col-span-3" />
        <Skeleton className="h-64 rounded-xl lg:col-span-2" />
      </div>
      <Skeleton className="mt-6 h-96 w-full rounded-xl" />
    </div>
  );

  window.Pages = Object.assign(window.Pages || {}, {
    HomePage, ExplorerPage, EmptyState,
  });
})();
