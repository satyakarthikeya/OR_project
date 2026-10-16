/* Data explorer.  The correlation heatmap is the evidence for the central modelling
 * constraint (nothing in this synthetic dataset can be fitted), so it is framed as a finding. */
(function () {
  'use strict';
  const { el, fmt } = AC;

  const SHORT = {
    Cargo_Volume: 'Volume', Handling_Time: 'Handling', Waiting_Time: 'Waiting',
    Workforce_Assigned: 'Workforce', Equipment_Used: 'Equipment',
    Facility_Utilization: 'Facility util', Storage_Occupancy: 'Storage',
    Queue_Length: 'Queue', Flight_Delay: 'Delay', Operational_Cost: 'Cost',
    Energy_Consumption: 'Energy', Throughput_Rate: 'Throughput',
    Demand_Forecast: 'Demand fc', Real_Time_Load: 'Load',
  };
  const short = (name) => SHORT[name] || name.replace(/_/g, ' ');
  const money = (v) => (v == null ? '-' : fmt.num(v, 0));
  const ratio = (v, d = 0) => (v == null ? '-' : `${fmt.num(v * 100, d)}%`);

  const content = AC.$('#content');

  /** Correlation matrix as rows, plus the strongest off-diagonal |r|. */
  function correlation(data) {
    const cols = Object.keys(data.correlation);
    const z = cols.map((r) => cols.map((c) => data.correlation[r][c]));
    let peak = 0;
    z.forEach((row, i) => row.forEach((v, j) => { if (i !== j) peak = Math.max(peak, Math.abs(v)); }));
    return { cols, z, peak };
  }

  /* ------------------------------------------------------------- sections */

  function kpiRow(k) {
    return el('div', { style: 'margin-bottom:48px' }, AC.kpis(
      AC.kpi('Records', fmt.int(k.n_records), `${fmt.int(k.n_terminals)} terminals`),
      AC.kpi('Mean throughput', fmt.num(k.mean_throughput, 1), 'units per record'),
      AC.kpi('Mean operational cost', money(k.mean_operational_cost), 'per record'),
      AC.kpi('Bottleneck rate', ratio(k.bottleneck_rate), 'records flagged as bottlenecked')));
  }

  function terminalTable(rows) {
    const col = (key, label, render) => ({ key, label, align: 'r', render });
    return AC.table({
      rows,
      columns: [
        { key: 'terminal', label: 'Terminal', render: (r) => el('strong', {}, r.terminal) },
        col('n_records', 'Records', (r) => fmt.int(r.n_records)),
        col('mean_workforce', 'Workers', (r) => fmt.num(r.mean_workforce, 2)),
        col('mean_equipment', 'Equipment', (r) => fmt.num(r.mean_equipment, 2)),
        col('mean_throughput', 'Throughput', (r) => fmt.num(r.mean_throughput, 2)),
        col('mean_cost', 'Cost', (r) => money(r.mean_cost)),
        col('mean_demand_forecast', 'Demand fc', (r) => fmt.num(r.mean_demand_forecast, 1)),
        col('mean_facility_util', 'Facility util', (r) => fmt.num(r.mean_facility_util, 1)),
        col('bottleneck_rate', 'Bottleneck', (r) => ratio(r.bottleneck_rate, 1)),
        col('throughput_capacity', 'Cap (p95)', (r) => fmt.num(r.throughput_capacity, 1)),
      ],
    });
  }

  function signalChart(terminals) {
    const node = el('div', { class: 'plot', role: 'img',
      'aria-label': 'Bottleneck rate and facility utilisation per terminal' });
    const labels = terminals.map((r) => r.terminal);
    AC.plot(node, [
      { type: 'bar', name: 'Bottleneck rate', x: labels, y: terminals.map((r) => r.bottleneck_rate * 100),
        marker: { color: AC.colors.lead }, hovertemplate: '%{y:.1f}%<extra>Bottleneck</extra>' },
      { type: 'bar', name: 'Facility utilisation', x: labels, y: terminals.map((r) => r.mean_facility_util),
        marker: { color: AC.colors.other }, hovertemplate: '%{y:.1f}%<extra>Utilisation</extra>' },
    ], { barmode: 'group', bargap: 0.35,
         yaxis: { title: { text: '%', font: { size: 11 } }, rangemode: 'tozero' } }, 260);
    return node;
  }

  function correlationPanel(data, corr) {
    const { cols, z, peak } = corr;
    const labels = cols.map(short);
    // The zoom bound comes from the data, so the toggle says where zooming would take you.
    const zoomBound = Math.max(0.01, Math.ceil(peak * 100) / 100);

    const node = el('div', { class: 'plot', role: 'img', 'aria-label': 'Correlation heatmap of numeric columns' });
    let scale = 'full';

    const draw = () => {
      const bound = scale === 'full' ? 1 : zoomBound;
      AC.plot(node, [{
        type: 'heatmap', z, x: labels, y: labels, zmin: -bound, zmax: bound,
        // Diverging through white, so "no correlation" reads as the blank surface itself.
        colorscale: [[0, AC.colors.bad], [0.5, AC.colors.surface], [1, AC.colors.ink]],
        hovertemplate: '%{y} x %{x}<br>r = %{z:.3f}<extra></extra>',
        colorbar: { thickness: 10, len: 0.85, outlinewidth: 0, tickfont: { size: 10 } },
      }], { xaxis: { tickangle: -45, showgrid: false }, yaxis: { autorange: 'reversed', showgrid: false } }, 420);
    };

    const seg = el('div', { class: 'seg' });
    const options = [['full', 'Scale -1...1'], ['zoom', `Zoom ±${zoomBound.toFixed(2)}`]];
    const paintSeg = () => {
      AC.clear(seg).append(...options.map(([value, label]) => el('button', {
        type: 'button', class: scale === value ? 'on' : '', 'aria-pressed': scale === value ? 'true' : 'false',
        onclick: () => { scale = value; paintSeg(); draw(); },
      }, label)));
    };
    paintSeg();

    const reading = el('div', {},
      el('p', {}, data.correlation_note),
      el('div', { class: 'kpis', style: 'margin:16px 0' }, AC.kpi('Strongest off-diagonal |r|', fmt.num(peak, 3),
        `across ${labels.length} numeric columns`)),
      AC.callout('warn', el('strong', {}, 'Consequence for the models. '),
        'With no signal to regress on, fitted coefficients would be noise. Part 1 derives every coefficient ' +
        'from group means plus one named assumption, which you can move on the LP page.'),
      el('p', { class: 'hint' },
        'At -1...1 the matrix is blank: the honest picture. Zoomed in, the pattern you see is sampling noise.'));

    const panel = AC.panel('Correlation matrix: a finding, not a decoration',
      el('div', { class: 'split-35' }, el('div', { style: 'min-width:0' }, seg, node), reading));
    requestAnimationFrame(draw);
    return panel;
  }

  function categoryPanel(counts) {
    let column = counts[0] && counts[0].column;
    const chips = el('div', { class: 'chips', style: 'margin-bottom:12px' });
    const node = el('div', { class: 'plot' });
    const paint = () => {
      const active = counts.find((c) => c.column === column) || counts[0];
      const entries = Object.entries(active.counts).sort((a, b) => b[1] - a[1]);
      AC.clear(chips).append(...counts.map((c) => el('button', {
        type: 'button', class: `chip ${c.column === active.column ? 'on' : ''}`,
        'aria-pressed': c.column === active.column ? 'true' : 'false',
        onclick: () => { column = c.column; paint(); },
      }, short(c.column))));
      node.setAttribute('aria-label', `Distribution of ${active.column}`);
      // Fixed per-bar height and a wide gap keep two-category columns from turning into slabs.
      AC.plot(node, [{
        type: 'bar', orientation: 'h', marker: { color: AC.colors.ink },
        y: entries.map((e) => e[0]).reverse(), x: entries.map((e) => e[1]).reverse(),
        hovertemplate: '%{y}: %{x} records<extra></extra>',
      }], { showlegend: false, bargap: 0.55, margin: { l: 8, r: 16, t: 8, b: 8 },
            xaxis: { rangemode: 'tozero' }, yaxis: { automargin: true } },
        Math.min(320, entries.length * 34 + 60));
    };
    paint();
    return AC.panel('Category distributions',
      el('div', {}, el('p', { class: 'muted' }, 'How records split across each category.'), chips, node));
  }

  function numericPanel(stats) {
    const col = (key, label) => ({ key, label, align: 'r', render: (r) => fmt.num(r[key], 1) });
    return AC.panel('Numeric ranges', el('div', {},
      el('p', { class: 'muted' }, 'Every column is spread evenly across its range: mean and median match.'),
      AC.table({ rows: stats, columns: [
        { key: 'column', label: 'Column', render: (r) => el('strong', {}, short(r.column)) },
        col('min', 'Min'), col('median', 'Median'), col('mean', 'Mean'), col('max', 'Max'), col('std', 'Std'),
      ] })));
  }

  /* ---------------------------------------------------------------- page */

  async function load(dataset) {
    AC.clear(content).append(el('div', { class: 'empty' }, AC.spinner('Loading summary...')));
    let data;
    try { data = await AC.api.summary(dataset.dataset_id); }
    catch (e) {
      AC.clear(content).append(AC.callout('bad', e.message, ' ',
        el('button', { class: 'btn', type: 'button', onclick: () => load(dataset) }, 'Retry')));
      return;
    }
    const corr = correlation(data);
    AC.clear(content).append(
      AC.headline('The columns carry no mutual information: the strongest correlation between any two is ',
        el('b', {}, `|r| = ${fmt.num(corr.peak, 3)}`),
        ', so every model coefficient is derived, not fitted.'),
      kpiRow(data.kpis),
      // Full width: the ten-column table is clipped when it shares a row with the chart.
      AC.panel('Per-terminal profile', el('div', {},
        el('p', { class: 'muted' }, 'The averages every LP coefficient is derived from.'),
        terminalTable(data.terminal_stats),
        el('p', { class: 'hint', style: 'margin-top:10px' },
          'Utilisation and bottleneck rate set the congestion factor (γ). Cap (p95) is each terminal\'s throughput ceiling.'))),
      AC.panel('The signals that vary', el('div', {},
        el('p', { class: 'muted' }, 'The only per-terminal measures that differ enough to model with.'),
        signalChart(data.terminal_stats))),
      correlationPanel(data, corr),
      el('div', { class: 'grid grid-2' }, categoryPanel(data.categorical_counts), numericPanel(data.numeric_stats)),
      el('div', { class: 'row', style: 'justify-content:flex-end;margin-top:48px' },
        el('a', { class: 'btn btn-primary', href: 'lp.html' }, 'Next: plan staff →')));
  }

  async function init() {
    AC.$('#head').append(
      AC.pageHead({
        kicker: 'Step 1 · Data',
        title: 'What the data actually says',
        lede: 'A quick profile of the loaded data, and the one finding that shapes both models.',
        about: [
          el('p', {}, 'These are descriptive statistics for the loaded scenario. Nothing here is fitted.'),
          el('p', {}, 'The per-terminal averages become the LP\'s coefficients, and the 95th-percentile ' +
            'throughput becomes each terminal\'s capacity. The correlation matrix shows why: the columns ' +
            'do not move together, so there is no relationship to estimate.'),
        ],
      }),
      AC.caveatBanner());
    const dataset = await AC.shell('explorer', { needsDataset: true });
    if (dataset) load(dataset);
  }
  init();
})();
