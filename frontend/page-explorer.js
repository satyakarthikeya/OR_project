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

  /* ------------------------------------------------------------- sections */

  function kpiRow(k) {
    return el('div', { class: 'grid grid-4', style: 'margin-bottom:16px' },
      AC.kpi('Records', fmt.int(k.n_records), `${fmt.int(k.n_terminals)} terminals`),
      AC.kpi('Mean throughput', fmt.num(k.mean_throughput, 1), 'units, Throughput_Rate'),
      AC.kpi('Mean operational cost', money(k.mean_operational_cost), 'per record'),
      AC.kpi('Bottleneck rate', ratio(k.bottleneck_rate), 'Share of records flagged as bottlenecked'));
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
    // Series colours come from the shared palette via Plotly's colorway (set by AC.plot).
    AC.plot(node, [
      { type: 'bar', name: 'Bottleneck rate', x: labels, y: terminals.map((r) => r.bottleneck_rate * 100),
        hovertemplate: '%{y:.1f}%<extra>Bottleneck</extra>' },
      { type: 'bar', name: 'Facility utilisation', x: labels, y: terminals.map((r) => r.mean_facility_util),
        hovertemplate: '%{y:.1f}%<extra>Utilisation</extra>' },
    ], { barmode: 'group', bargap: 0.35,
         yaxis: { title: { text: '%', font: { size: 11 } }, rangemode: 'tozero' } }, 260);
    return node;
  }

  function correlationPanel(data) {
    const cols = Object.keys(data.correlation);
    const z = cols.map((r) => cols.map((c) => data.correlation[r][c]));
    const labels = cols.map(short);
    let peak = 0;
    cols.forEach((r, i) => cols.forEach((c, j) => { if (i !== j) peak = Math.max(peak, Math.abs(z[i][j])); }));
    // The zoom bound comes from the data, so the toggle says where zooming would take you.
    const zoomBound = Math.max(0.01, Math.ceil(peak * 100) / 100);

    const node = el('div', { class: 'plot', role: 'img', 'aria-label': 'Correlation heatmap of numeric columns' });
    let scale = 'full';

    const draw = () => {
      const dark = AC.theme() === 'dark';
      const bound = scale === 'full' ? 1 : zoomBound;
      AC.plot(node, [{
        type: 'heatmap', z, x: labels, y: labels, zmin: -bound, zmax: bound,
        // Diverging through the panel's own ground, so "no correlation" reads as the surface itself.
        colorscale: [[0, dark ? '#F27469' : '#B3261E'], [0.5, dark ? 'rgb(23,27,31)' : 'rgb(252,252,251)'],
                     [1, dark ? '#4FB894' : '#1F7A5C']],
        hovertemplate: '%{y} x %{x}<br>r = %{z:.3f}<extra></extra>',
        colorbar: { thickness: 10, len: 0.85, outlinewidth: 0, tickfont: { size: 10 } },
      }], { xaxis: { tickangle: -45, showgrid: false }, yaxis: { autorange: 'reversed', showgrid: false } }, 420);
    };

    const seg = el('div', { class: 'seg' });
    const options = [['full', 'Scale -1...1'], ['zoom', `Zoom +/-${zoomBound.toFixed(2)}`]];
    const paintSeg = () => {
      AC.clear(seg).append(options.map(([value, label]) => el('button', {
        type: 'button', class: scale === value ? 'on' : '',
        onclick: () => { scale = value; paintSeg(); draw(); },
      }, label)));
    };
    paintSeg();

    const reading = el('div', {},
      el('div', { class: 'field-label' }, 'Reading'),
      el('p', { style: 'margin-top:6px' }, data.correlation_note),
      el('div', { class: 'kpi', style: 'margin:14px 0' },
        el('div', { class: 'value' }, fmt.num(peak, 3)),
        el('div', { class: 'sub' }, `strongest off-diagonal |r| across ${labels.length} numeric columns`)),
      AC.callout('warn', el('strong', {}, 'Consequence for the models. '),
        'With no signal to regress on, fitting coefficients would produce noise dressed up as a result. ' +
        'Part 1 instead derives every coefficient in closed form from group means plus a single named ' +
        'assumption, which you can move and re-solve on the LP page.'),
      el('p', { class: 'muted', style: 'font-size:12px' },
        'Switch the scale to see the two readings: at -1...1 the matrix is uniformly blank, which is the honest ' +
        'picture; zoomed to the observed range the structure that appears is sampling noise, not signal.'));

    const panel = AC.panel('Correlation matrix: a finding, not a decoration',
      el('div', { class: 'split-35' }, node, reading), seg);
    // Panel is in the DOM only after it is returned; draw once the node is attached.
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
      AC.clear(chips).append(counts.map((c) => el('button', {
        type: 'button', class: `chip ${c.column === active.column ? 'on' : ''}`,
        onclick: () => { column = c.column; paint(); },
      }, short(c.column))));
      node.setAttribute('aria-label', `Distribution of ${active.column}`);
      AC.plot(node, [{
        type: 'bar', orientation: 'h',
        y: entries.map((e) => e[0]).reverse(), x: entries.map((e) => e[1]).reverse(),
        hovertemplate: '%{y}: %{x} records<extra></extra>',
      }], { showlegend: false, margin: { l: 8, r: 16, t: 8, b: 8 },
            xaxis: { rangemode: 'tozero' }, yaxis: { automargin: true } },
        Math.max(240, entries.length * 46 + 70));
    };
    paint();
    return AC.panel('Category distributions',
      el('div', {}, el('p', { class: 'muted' }, 'Category balance across the loaded scenario.'), chips, node));
  }

  function numericPanel(stats) {
    const col = (key, label) => ({ key, label, align: 'r', render: (r) => fmt.num(r[key], 1) });
    return AC.panel('Numeric ranges', el('div', {},
      el('p', { class: 'muted' }, 'Every numeric column is uniform across its range: mean and median coincide throughout.'),
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
    AC.clear(content).append(
      kpiRow(data.kpis),
      el('div', { class: 'split-35' },
        AC.panel('Per-terminal profile', el('div', {},
          el('p', { class: 'muted' }, 'The aggregates every LP coefficient is derived from.'),
          terminalTable(data.terminal_stats),
          el('p', { class: 'muted', style: 'font-size:12px;margin-top:10px' },
            'Facility utilisation and bottleneck rate feed the congestion multiplier gamma; the capacity column is the ' +
            '95th percentile of observed throughput, which becomes each terminal\'s ceiling in the LP.'))),
        AC.panel('The signals that vary', el('div', {},
          el('p', { class: 'muted' }, 'Bottleneck rate and facility utilisation are the only per-terminal measures that differ enough to model with.'),
          signalChart(data.terminal_stats)))),
      correlationPanel(data),
      el('div', { class: 'grid grid-2' }, categoryPanel(data.categorical_counts), numericPanel(data.numeric_stats)));
  }

  async function init() {
    AC.$('#caveat').append(AC.caveatBanner());
    const dataset = await AC.shell('explorer', { needsDataset: true });
    if (dataset) load(dataset);
  }
  init();
})();
