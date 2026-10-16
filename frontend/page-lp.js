/* Part 1 - LP workforce and equipment allocation.  Plain JavaScript.
 *
 * Derived parameters are fetched and shown BEFORE anything is optimised, so the
 * coefficients can be inspected and argued with first.  Solving happens only on
 * an explicit click.  After a successful solve the per-terminal worker plan is
 * saved with AC.handoff so Part 2 (IP) spends this allocation.
 */
(async function () {
  'use strict';
  const { el, fmt, api, table, panel, kpi, callout, badge, spinner, utilBar, plot, ui } = AC;

  const DEFAULTS = () => ({
    filters: { terminals: [], cargo_types: [], priorities: [], weather: [], peak_hour: null },
    labor_share: 0.6, cost_labor_share: 0.6, congestion_delta: 1.0, apply_congestion: true,
    demand_scale: 1.0, demand_day: 'mean',
    workforce_pool_factor: 1.0, equipment_pool_factor: 1.0, budget_enabled: false, budget_factor: 1.0,
  });
  const C = { accent: AC.colors.lead, muted: AC.colors.other, good: AC.colors.good, bad: AC.colors.bad };
  // Keys that only change the solve, not the derived parameters, so they skip the refetch.
  const SOLVE_ONLY = ['workforce_pool_factor', 'equipment_pool_factor', 'budget_factor', 'budget_enabled'];

  const dataset = await AC.shell('lp', { needsDataset: true });
  const app = document.getElementById('app');
  app.append(AC.pageHead({
    kicker: 'Part 1 · Linear programming',
    title: 'Workforce and equipment allocation',
    lede: 'Decide how many workers and machines each terminal gets, to maximise throughput.',
    about: [
      el('p', {}, 'Pick a planning scenario, inspect the coefficients it produces, then solve. A linear programme ' +
        'moves the observed workers and equipment between terminals to maximise throughput. Demand that cannot be met is ' +
        'carried as a penalised shortfall rather than making the model infeasible.'),
      el('p', {}, "Every parameter is derived in closed form from the scenario's group means. Nothing is fitted. " +
        'The result is scored against the observed allocation with the same objective function and the same resource totals.'),
    ],
  }), AC.caveatBanner());
  if (!dataset) return;

  let c = DEFAULTS();
  let params = null;            // last /api/lp/parameters response
  let paramsLoading = true;
  let paramsError = null;
  let solveResult = null;
  let solvedSig = null;
  let solving = false;
  let paramsSeq = 0;
  let timer = null;
  let vocab = { terminals: [], cargo_types: [], priorities: [], weather: [] };
  let w = {};                   // the live widgets, rebuilt on reset

  /* ------------------------------------------------------------- payloads */

  const paramsPayload = () => ({
    dataset_id: dataset.dataset_id, filters: c.filters, labor_share: c.labor_share,
    cost_labor_share: c.cost_labor_share, congestion_delta: c.congestion_delta,
    apply_congestion: c.apply_congestion, demand_scale: c.demand_scale, demand_day: c.demand_day,
  });
  const solvePayload = () => ({
    ...paramsPayload(),
    workforce_pool_factor: c.workforce_pool_factor, equipment_pool_factor: c.equipment_pool_factor,
    budget_factor: c.budget_enabled ? c.budget_factor : null,
  });

  /* ------------------------------------------------------- change handling */

  /** Any control moved: re-derive parameters (debounced) and flag stale results. */
  function changed(key) {
    renderExpanded();
    renderStale();
    if (SOLVE_ONLY.includes(key)) return;
    paramsLoading = true;
    renderParams();
    clearTimeout(timer);
    timer = setTimeout(loadParams, 250);
  }

  async function loadParams() {
    const seq = ++paramsSeq;
    paramsLoading = true;
    try {
      const data = await api.lpParameters(paramsPayload());
      if (seq !== paramsSeq) return;
      params = data; paramsError = null;
    } catch (e) {
      if (seq !== paramsSeq) return;
      params = null; paramsError = e;
    }
    paramsLoading = false;
    renderParams();
    ['workers', 'equipment', 'budget'].forEach((k) => w[k] && w[k].refresh());
    solveBtn.disabled = !params || solving;
  }

  /* ---------------------------------------------------------- settings panel */

  const pctAbs = (total, digits) => (v) =>
    `${(v * 100).toFixed(0)}%${params ? ` · ${fmt.num(params[total] * v, digits)}` : ''}`;
  const set = (key) => (v) => { c[key] = v; changed(key); };
  const setFilter = (key) => (v) => { c.filters[key] = v; changed('filters'); };

  const recordsNote = el('div', { class: 'hint' }, 'Deriving...');
  const expandedNote = el('div', {});
  const controlsHost = el('div', {}, spinner('Loading categories...'));

  function renderExpanded() {
    expandedNote.replaceChildren(c.workforce_pool_factor > 1 || c.equipment_pool_factor > 1
      ? callout('warn', el('b', {}, 'Expanded resources. '),
        'The pool is above what the terminals used, so part of any gain is bought with extra resources rather than earned by re-allocating.')
      : '');
  }

  function buildControls() {
    w = {
      workers: ui.slider({ label: 'Workers available', min: 0.8, max: 1.2, step: 0.05, value: c.workforce_pool_factor,
        format: pctAbs('workforce_total', 1), onInput: set('workforce_pool_factor'),
        help: 'Relative to the total the terminals were observed to use (W). Above 100% is flagged as an expanded-resources scenario.' }),
      equipment: ui.slider({ label: 'Equipment available', min: 0.8, max: 1.2, step: 0.05, value: c.equipment_pool_factor,
        format: pctAbs('equipment_total', 1), onInput: set('equipment_pool_factor'),
        help: 'Relative to the equipment units the terminals were observed to use (E).' }),
      budget: ui.slider({ label: 'Budget', min: 0.5, max: 2, step: 0.05, value: c.budget_factor,
        format: pctAbs('baseline_cost', 0), onInput: set('budget_factor') }),
      delta: ui.slider({ label: 'Congestion exponent (δ)', min: 0, max: 3, step: 0.25, value: c.congestion_delta,
        format: (v) => v.toFixed(2), onInput: set('congestion_delta'),
        help: 'Raises the weight on facility utilisation, widening the productivity spread between terminals.' }),
    };
    w.budget.setDisabled(!c.budget_enabled);
    w.delta.setDisabled(!c.apply_congestion);

    controlsHost.replaceChildren(
      el('div', { class: 'section-title' }, 'Resources'),
      w.workers, w.equipment,
      ui.group(ui.toggle({ label: 'Cap the budget', checked: c.budget_enabled,
        help: 'Cap total operational cost as a multiple of the baseline cost.',
        onChange: (v) => { c.budget_enabled = v; w.budget.setDisabled(!v); changed('budget_enabled'); } }), w.budget),
      expandedNote,
      AC.fold('Demand & assumptions', [
        ui.segmented({ label: 'Planning window', options: [['mean', 'Average day'], ['p95', 'Busy day (p95)']],
          value: c.demand_day, onChange: set('demand_day'),
          help: 'Demand D_t is the tons arriving at a terminal in one window, divided by the horizon H. On an average day every ' +
            'terminal has roughly 45% headroom; on a busy day demand runs past capability and the unmet-demand slack switches on.' }),
        ui.slider({ label: 'Demand stress', min: 0.5, max: 3, step: 0.1, value: c.demand_scale,
          format: (v) => `${v.toFixed(1)}×`, onInput: set('demand_scale'),
          help: 'Scales every D_t. Above roughly 1.5× the terminals cannot meet demand and the shortfall is reported as slack.' }),
        ui.slider({ label: 'Labour share (θ)', min: 0.05, max: 0.95, step: 0.05, value: c.labor_share,
          format: (v) => v.toFixed(2), onInput: set('labor_share'),
          help: 'Share of throughput attributed to workers. The single free assumption behind the productivities α and β.' }),
        ui.slider({ label: 'Cost labour share (θ_c)', min: 0.05, max: 0.95, step: 0.05, value: c.cost_labor_share,
          format: (v) => v.toFixed(2), onInput: set('cost_labor_share'),
          help: 'Splits observed operational cost between workers and equipment. Cost is reported and used by the budget cap; it is not in the objective.' }),
        ui.group(ui.toggle({ label: 'Congestion multiplier (γ)', checked: c.apply_congestion,
          help: 'Off, the terminals are near-identical and the allocation becomes a solver artefact. This switch exists to demonstrate that.',
          onChange: (v) => { c.apply_congestion = v; w.delta.setDisabled(!v); changed('apply_congestion'); } }), w.delta),
      ], { aside: 'θ, γ, demand' }),
      AC.fold('Filter the data', [
        ui.chips({ label: 'Terminals', options: vocab.terminals, selected: c.filters.terminals,
          onChange: setFilter('terminals'), emptyText: 'None selected = all terminals' }),
        ui.chips({ label: 'Cargo type', options: vocab.cargo_types, selected: c.filters.cargo_types, onChange: setFilter('cargo_types') }),
        ui.chips({ label: 'Weather', options: vocab.weather, selected: c.filters.weather, onChange: setFilter('weather') }),
        ui.chips({ label: 'Priority', options: vocab.priorities, selected: c.filters.priorities, onChange: setFilter('priorities') }),
        ui.segmented({ label: 'Hour of day', options: [[null, 'All hours'], [1, 'Peak'], [0, 'Off-peak']],
          value: c.filters.peak_hour, onChange: setFilter('peak_hour') }),
        recordsNote,
      ], { aside: 'terminals, cargo, weather' }));
    renderExpanded();
  }

  /* -------------------------------------------------------- model inputs */

  const paramsHost = el('div', {});
  let showDerivation = false;
  let paramsOpen = true;       // open until the first solve, then tucked away at the bottom

  function renderParams() {
    if (params) {
      recordsNote.textContent = `${fmt.int(params.n_records)} records in this slice, across ${params.terminals.length} terminal(s).`;
    }
    if (paramsError) {
      paramsHost.replaceChildren(callout('bad', el('b', {}, 'Could not derive parameters. '), paramsError.message));
      return;
    }
    if (!params) {
      paramsHost.replaceChildren(AC.fold('Model inputs', spinner('Deriving parameters...'), { open: true, big: true }));
      return;
    }
    const congestionOn = params.assumptions.congestion_applied;
    const derivBtn = el('button', { class: 'btn', type: 'button', onclick: () => {
      showDerivation = !showDerivation; renderParams();
    } }, showDerivation ? 'Hide derivation' : 'How these were derived');

    const rangeText = (lo, hi) => `${fmt.num(lo, 0)}–${fmt.num(hi, 0)}`;
    const n = (k, d) => (r) => fmt.num(r[k], d);
    const tbl = table({
      columns: [
        { key: 'terminal', label: 'Terminal' },
        { label: 'α per worker', align: 'r', sym: true, render: n('alpha', 3) },
        { label: 'β per unit', align: 'r', sym: true, render: n('beta', 3) },
        { label: 'γ', align: 'r', sym: true,
          render: (r) => el('span', { class: congestionOn ? '' : 'faint' }, fmt.num(r.congestion, 3)) },
        { label: 'cost/worker', align: 'r', sym: true, render: n('cost_worker', 1) },
        { label: 'cost/unit', align: 'r', sym: true, render: n('cost_equipment', 1) },
        { label: 'demand D', align: 'r', sym: true, render: n('demand', 1) },
        { label: 'capacity', align: 'r', sym: true, render: n('capacity', 1) },
        { label: 'w range', align: 'r', sym: true, render: (r) => rangeText(r.workforce_min, r.workforce_max) },
        { label: 'e range', align: 'r', sym: true, render: (r) => rangeText(r.equipment_min, r.equipment_max) },
      ],
      rows: params.terminals,
    });
    tbl.classList.toggle('dim', paramsLoading);

    const kv = (pairs) => el('dl', { class: 'kv kv-3' }, pairs.map(([k, v]) => [el('dt', {}, k), el('dd', { class: 'num' }, v)]));
    const gap = (node) => el('div', { style: 'margin-top:16px' }, node);
    const body = el('div', {},
      el('div', { class: 'row', style: 'justify-content:space-between;margin-bottom:12px' },
        el('span', { class: 'muted' }, "Computed from this scenario's group means, before any optimisation runs."),
        el('span', { class: 'row' }, paramsLoading ? el('span', { class: 'faint' }, 'updating...') : '', derivBtn)),
      congestionOn ? '' : callout('warn', el('b', {}, 'Congestion multiplier is off. '),
        'With γ = 1 the terminals are interchangeable, so the allocation the LP returns is an artefact of solver scan order, not a decision.'),
      params.warnings.length
        ? callout('warn', el('b', {}, 'Scenario warnings'), el('ul', {}, params.warnings.map((x) => el('li', {}, x)))) : '',
      tbl,
      gap(kv([
        ['Worker pool W', fmt.num(params.workforce_total, 1)],
        ['Equipment pool E', fmt.num(params.equipment_total, 1)],
        ['Records in slice', fmt.int(params.n_records)],
        ['Baseline throughput', fmt.num(params.baseline_throughput, 2)],
        ['Baseline cost', fmt.num(params.baseline_cost, 0)],
        ['Baseline unmet demand', fmt.num(params.baseline_unmet_demand, 2)],
        ['Planning horizon H', `${fmt.num(params.assumptions.horizon_hours, 0)} h`],
        ['Unmet-demand penalty M', fmt.num(params.unmet_penalty, 1)],
        ['Capacity percentile', fmt.pct(params.assumptions.capacity_percentile * 100, 0)],
      ])),
      showDerivation ? gap([el('div', { class: 'field-label' }, 'Derivation'),
        params.derivation.map((d) => el('div', { class: 'deriv' },
          el('div', {}, el('b', { class: 'num' }, d.symbol), ' ', d.name),
          el('code', {}, d.formula),
          el('p', { class: 'muted' }, d.explanation)))]) : '');
    paramsHost.replaceChildren(AC.fold('Model inputs', body, { open: paramsOpen, big: true,
      aside: `${params.terminals.length} terminals · ${fmt.int(params.n_records)} records`,
      onToggle: (o) => { paramsOpen = o; } }));
  }

  /* ---------------------------------------------------------------- solve */

  const solveBtn = el('button', { class: 'btn btn-primary btn-block', type: 'button', disabled: true,
    onclick: () => runSolve() }, 'Solve allocation');
  const staleHost = el('div', {});
  const resultsHost = el('div', {});

  function renderStale() {
    const stale = solveResult && solvedSig !== null && solvedSig !== JSON.stringify(solvePayload());
    staleHost.replaceChildren(stale ? callout('warn', el('b', {}, 'Settings changed since this solve. '),
      'The results below use the previous settings. ',
      el('button', { class: 'btn', type: 'button', disabled: solving, onclick: () => runSolve() }, 'Re-solve')) : '');
  }

  function renderEmpty() {
    resultsHost.replaceChildren(el('div', { class: 'empty', style: 'margin-bottom:24px' },
      el('b', {}, 'Ready to solve'), el('p', {},
        'Solving gives a worker and equipment plan for each terminal, and compares it with today\'s allocation. ' +
        'The inputs the model will use are below.')));
  }

  async function runSolve() {
    if (solving || !params) return;
    const payload = solvePayload();
    const sig = JSON.stringify(payload);
    const solvedParams = params;
    solving = true;
    solveBtn.disabled = true;
    solveBtn.replaceChildren(spinner('Solving...'));
    staleHost.replaceChildren();
    resultsHost.replaceChildren(panel('Result', spinner('Running the solver...')));
    paramsOpen = false; paramsHost.style.order = '3'; renderParams();
    let result;
    try {
      result = await api.lpSolve(payload);
    } catch (e) {
      solveResult = null; solvedSig = null; solving = false;
      solveBtn.disabled = !params; solveBtn.textContent = 'Solve allocation';
      resultsHost.replaceChildren(callout('bad', el('b', {}, 'Solve failed. '), e.message,
        ' ', el('button', { class: 'btn', type: 'button', onclick: () => runSolve() }, 'Retry')));
      return;
    }
    solveResult = result; solvedSig = sig; solving = false;
    solveBtn.disabled = !params; solveBtn.textContent = 'Solve allocation';

    // Part 1 -> Part 2: publish w_t* so the IP page spends THIS allocation.
    if (result.status === 'Optimal') {
      const workforce = {};
      result.allocation.forEach((r) => { workforce[r.terminal] = r.optimized_workforce; });
      AC.handoff.save(dataset.dataset_id, workforce);
      AC.markStepDone('lp');
    } else {
      AC.handoff.clear();
      AC.markStepDone('lp', false);
    }

    const sensHost = el('div', {});
    renderResults(result, sensHost, payload, solvedParams);
    renderStale();
    if (result.status === 'Optimal') {
      sensHost.replaceChildren(panel('Sensitivity to the worker pool', spinner('Sweeping the worker pool...')));
      try {
        const sweep = await api.lpSensitivity({ ...payload, points: 9 });
        if (solveResult === result) renderSensitivity(sensHost, sweep, result);
      } catch (e) {
        sensHost.replaceChildren();
      }
    }
  }

  /* -------------------------------------------------------------- results */

  const metricOf = (cmp, key) => cmp.metrics.find((m) => m.key === key) || cmp.headline;
  const warnList = (items) => items.length ? callout('warn', el('ul', {}, items.map((x) => el('li', {}, x)))) : '';

  function deltaCell(value, percent, better, digits) {
    const neutral = better === 'neutral' || Math.abs(value) < 1e-9;
    const good = better === 'up' ? value > 0 : value < 0;
    return el('span', { class: `num ${neutral ? 'muted' : good ? 'pos' : 'neg'}` },
      fmt.signed(value, digits == null ? 2 : digits),
      percent != null ? el('small', {}, ` (${fmt.signed(percent, 1)}%)`) : '');
  }

  /** One plain sentence: throughput and unmet demand, never the objective %. */
  function headlineFor(r, payload) {
    const cmp = r.comparison;
    const thr = metricOf(cmp, 'total_throughput');
    const unmet = metricOf(cmp, 'total_unmet_demand');
    const b = (t) => el('b', {}, t);
    const workers = fmt.num(r.resources.workforce_available, 0);
    const equip = fmt.num(r.resources.equipment_available, 0);
    const samePools = payload.workforce_pool_factor === 1 && payload.equipment_pool_factor === 1;
    // Never say "the same workers" when the pools were scaled: that gain is partly bought.
    const lead = samePools ? ['re-allocating the same ', b(`${workers} workers`)]
      : [`with ${r.expanded_resources ? 'expanded' : 'reduced'} resources (`, b(`${workers} workers`),
        `, ${equip} equipment units), the plan`];
    const move = (m, noun, up, down, digits, unit) => {
      if (Math.abs(m.delta) < 1e-6) return [` keeps ${noun} at `, b(fmt.num(m.optimized, digits)), unit];
      return [` ${m.delta > 0 ? up : down} ${noun} from ${fmt.num(m.baseline, digits)} to `, b(fmt.num(m.optimized, digits)),
        unit, m.percent_delta != null ? ` (${fmt.signed(m.percent_delta, 1)}%)` : ''];
    };
    const unmetPart = unmet.optimized <= 0.001 ? ', with no unmet demand'
      : [', leaving ', b(fmt.num(unmet.optimized, 1)), ` ${unmet.unit} of demand unmet (observed ${fmt.num(unmet.baseline, 1)})`];
    return AC.headline('In the model, ', lead, move(thr, 'throughput', 'lifts', 'lowers', 1, ` ${thr.unit}`), unmetPart, '.');
  }

  function statusLine(r) {
    return el('div', { class: 'row', style: 'margin-bottom:16px' },
      badge('Optimal', 'pos'), el('span', { class: 'muted num' }, `CBC · ${fmt.num(r.solve_seconds, 3)} s`),
      r.expanded_resources ? badge('Expanded resources', 'accent') : badge('Same resource pools'),
      el('span', { class: 'faint' }, `${r.objective_label} · allocation: ${r.allocation_source}`));
  }

  function renderResults(r, sensHost, payload, p) {
    if (r.status !== 'Optimal') {
      resultsHost.replaceChildren(panel('Result', [
        callout(r.status === 'Infeasible' || r.status === 'Unbounded' ? 'bad' : 'warn',
          el('b', {}, `The solver could not find a plan (status: ${r.status}).`), el('p', {}, r.message || ''),
          r.suggestions && r.suggestions.length
            ? [el('div', {}, 'Things to try:'), el('ul', {}, r.suggestions.map((s) => el('li', {}, s)))] : ''),
        warnList(r.warnings || []),
      ]));
      return;
    }
    const cmp = r.comparison;
    const thr = metricOf(cmp, 'total_throughput');
    const cost = metricOf(cmp, 'total_cost');
    const unmet = metricOf(cmp, 'total_unmet_demand');
    const unmetK = kpi('Unmet demand', fmt.num(unmet.optimized, 2), `observed ${fmt.num(unmet.baseline, 2)}`);
    unmetK.querySelector('.value').classList.add(unmet.optimized > 0.001 ? 'neg' : 'pos');
    // Warnings from the parameter step must still be seen once Model inputs is folded away.
    const extra = (p.warnings || []).filter((x) => !(r.warnings || []).includes(x));

    const outcome = panel('Result', [
      headlineFor(r, payload),
      statusLine(r),
      AC.kpis(kpi('Throughput', fmt.num(thr.optimized, 1), `observed ${fmt.num(thr.baseline, 1)}`),
        kpi('Operational cost', fmt.num(cost.optimized, 0), `observed ${fmt.num(cost.baseline, 0)}`), unmetK),
      payload.apply_congestion ? '' : callout('warn', el('b', {}, 'Congestion multiplier is off. '),
        'The terminals are interchangeable in this run, so this allocation is a solver artefact rather than a decision.'),
      cmp.notes.map((x) => callout('warn', x)),
      warnList([...(r.warnings || []), ...extra]),
      AC.fold('Observed vs optimised, every metric', [
        table({
          columns: [
            { key: 'label', label: 'Metric' },
            { label: 'Observed', align: 'r', render: (m) => fmt.num(m.baseline, 2) },
            { label: 'Optimised', align: 'r', render: (m) => fmt.num(m.optimized, 2) },
            { label: 'Change', align: 'r', render: (m) => deltaCell(m.delta, m.percent_delta, m.better) },
          ],
          rows: [cmp.headline, ...cmp.metrics],
        }),
        el('p', { class: 'hint', style: 'margin-top:8px' },
          'Both columns are scored by the same objective function at the same resource totals; the observed allocation ' +
          'is never compared against raw recorded KPIs. The objective row includes the unmet-demand penalty.'),
      ]),
    ]);

    const nextStep = callout('good', el('div', { class: 'row', style: 'justify-content:space-between' },
      el('span', {}, el('b', {}, 'Saved for step 3. '), 'Choosing shipments will use this worker plan instead of the observed one.'),
      el('a', { class: 'btn', href: 'ip.html' }, 'Next: choose shipments →')));

    const allocNode = el('div', { class: 'plot', role: 'img', 'aria-label': 'Observed versus optimised workers and equipment per terminal' });
    const thrNode = el('div', { class: 'plot', role: 'img', 'aria-label': 'Throughput against demand and capacity per terminal' });
    const charts = el('div', { class: 'grid grid-2' },
      panel('Allocation', [allocNode, el('p', { class: 'hint' },
        'Bars are workers (left axis), markers are equipment (right axis). One axis would hide the equipment movement.')]),
      panel('Throughput, demand and capacity', [thrNode, el('p', { class: 'hint' },
        'A bar below its demand marker is unmet demand, carried by a slack variable instead of making the model infeasible.')]));

    const plan = panel('Per-terminal plan', [
      el('p', { class: 'muted' }, 'The allocation to hand to operations, with the change from today.'),
      table({
        columns: [
          { key: 'terminal', label: 'Terminal' },
          { label: 'Workers now', align: 'r', render: (a) => fmt.num(a.baseline_workforce, 1) },
          { label: 'Workers plan', align: 'r', render: (a) => el('b', {}, fmt.num(a.optimized_workforce, 1)) },
          { label: 'Δ', align: 'r', sym: true, render: (a) => deltaCell(a.delta_workforce, null, 'neutral', 1) },
          { label: 'Equip. now', align: 'r', render: (a) => fmt.num(a.baseline_equipment, 1) },
          { label: 'Equip. plan', align: 'r', render: (a) => el('b', {}, fmt.num(a.optimized_equipment, 1)) },
          { label: 'Δ', align: 'r', sym: true, render: (a) => deltaCell(a.delta_equipment, null, 'neutral', 1) },
          { label: 'Throughput', align: 'r', render: (a) => fmt.num(a.optimized_throughput, 1) },
          { label: 'Demand', align: 'r', render: (a) => fmt.num(a.demand, 1) },
          { label: 'Unmet', align: 'r',
            render: (a) => a.unmet_demand > 0.001 ? el('b', { class: 'neg' }, fmt.num(a.unmet_demand, 2)) : el('span', { class: 'faint' }, '—') },
          { label: 'Cost', align: 'r', render: (a) => fmt.num(a.optimized_cost, 0) },
        ],
        rows: r.allocation,
      }),
    ]);

    const inflated = r.duals_penalty_inflated;
    const binding = r.duals.filter((d) => d.binding);
    const slack = r.duals.filter((d) => !d.binding);
    const dualCols = [
      { key: 'name', label: 'Constraint', render: (d) => el('span', { class: 'num' }, d.name) },
      { label: 'State', render: (d) => el('span', { class: `num ${d.binding ? '' : 'faint'}` }, d.binding ? 'binding' : 'slack') },
      { label: 'RHS', align: 'r', render: (d) => el('span', { style: 'white-space:nowrap' }, `${d.sense} ${fmt.num(d.rhs, 1)}`) },
      { label: 'Slack', align: 'r', render: (d) => fmt.num(d.slack, 2) },
      { label: 'Shadow price', align: 'r', render: (d) => el('span', { class: d.binding ? '' : 'faint' }, fmt.num(d.shadow_price, 4)) },
    ];
    const dualsPanel = panel('Binding constraints and shadow prices', [
      el('p', { class: 'muted' }, 'What is limiting the plan, and what one more unit of each resource is worth.'),
      // "What is one more worker worth?" is answered by the dual, so its source sits next to it.
      r.duals_note ? callout(inflated ? 'warn' : '', r.duals_note) : '',
      el('div', { class: 'row', style: 'margin-bottom:12px' },
        el('span', { class: 'field-label' }, 'allocation source'), el('span', { class: 'num' }, r.allocation_source),
        el('span', { class: 'field-label' }, 'duals source'), el('span', { class: 'num' }, r.duals_source)),
      binding.length ? table({ columns: dualCols, rows: binding, rowClass: () => 'stripe-binding' }) : '',
      slack.length ? AC.fold(`${slack.length} slack constraints`, table({ columns: dualCols, rows: slack })) : '',
      binding.length ? [el('div', { class: 'field-label', style: 'margin-top:16px' }, 'Reading the binding constraints'),
        el('ul', { class: 'readings' }, binding.map((d) => el('li', {}, el('span', { class: 'num' }, d.name), ' — ', d.interpretation)))] : '',
    ], inflated ? badge('Penalty-stripped', 'accent') : badge('Relaxation duals'));

    const res = r.resources;
    const useRow = (label, used, avail, digits) => el('div', { class: 'control' },
      el('div', { class: 'top' }, el('span', {}, label),
        el('span', { class: 'num' }, `${fmt.num(used, digits)} / ${fmt.num(avail, digits)}`)),
      utilBar(avail > 0 ? used / avail : 0),
      el('div', { class: 'hint num' },
        `${fmt.num(avail > 0 ? Math.min(100, (used / avail) * 100) : 0, 1)}% used${avail > 0 && used / avail > 0.995 ? ' · binding' : ''}`));
    const resourcePanel = panel('Resource use', [
      useRow('Workers', res.workforce_used, res.workforce_available, 1),
      useRow('Equipment', res.equipment_used, res.equipment_available, 1),
      res.budget !== null ? useRow('Budget', res.cost_incurred, res.budget, 0) : '',
      el('dl', { class: 'kv' },
        el('dt', {}, 'Unmet-demand penalty M'), el('dd', { class: 'num' }, fmt.num(r.unmet_penalty, 2)),
        el('dt', {}, 'Solve time'), el('dd', { class: 'num' }, `${fmt.num(r.solve_seconds, 3)} s`),
        el('dt', {}, 'Binding constraints'), el('dd', { class: 'num' }, r.binding_constraints.length)),
    ]);

    resultsHost.replaceChildren(outcome, nextStep, plan, charts,
      el('div', { class: 'split-wide' }, dualsPanel, resourcePanel), sensHost);

    const labels = r.allocation.map((a) => a.terminal);
    const col = (k) => r.allocation.map((a) => a[k]);
    const bar = (name, k, color, group, unit) => ({ type: 'bar', name, x: labels, y: col(k), marker: { color },
      offsetgroup: group, hovertemplate: `%{x}: %{y:.1f}${unit}<extra>${name}</extra>` });
    const mark = (name, k, marker, extra) => ({ type: 'scatter', mode: 'markers', name, x: labels, y: col(k), marker,
      hovertemplate: `%{x}: %{y:.1f}<extra>${name}</extra>`, ...extra });
    plot(allocNode, [
      bar('Workers — observed', 'baseline_workforce', C.muted, 1, ' workers'),
      bar('Workers — optimised', 'optimized_workforce', C.accent, 2, ' workers'),
      mark('Equipment — observed', 'baseline_equipment', { color: C.muted, size: 9, symbol: 'circle-open', line: { width: 2 } }, { yaxis: 'y2' }),
      mark('Equipment — optimised', 'optimized_equipment', { color: C.accent, size: 9, symbol: 'diamond' }, { yaxis: 'y2' }),
    ], {
      barmode: 'group', bargap: 0.4,
      yaxis: { title: { text: 'workers', font: { size: 11 } }, rangemode: 'tozero' },
      yaxis2: { title: { text: 'equipment', font: { size: 11 } }, overlaying: 'y', side: 'right',
                rangemode: 'tozero', showgrid: false, automargin: true },
    }, 300);
    plot(thrNode, [
      bar('Throughput — observed', 'baseline_throughput', C.muted, 1, ''),
      bar('Throughput — optimised', 'optimized_throughput', C.accent, 2, ''),
      mark('Demand D', 'demand', { color: C.good, size: 11, symbol: 'line-ew-open', line: { width: 3 } }),
      mark('Capacity ceiling', 'capacity', { color: C.bad, size: 11, symbol: 'line-ew-open', line: { width: 3 } }),
    ], {
      barmode: 'group', bargap: 0.4,
      yaxis: { title: { text: 'throughput units', font: { size: 11 } }, rangemode: 'tozero' },
    }, 300);
  }

  function renderSensitivity(host, sweep, r) {
    const title = 'Sensitivity to the worker pool';
    const pts = sweep.points.filter((p) => p.objective_value !== null);
    if (!pts.length) {
      host.replaceChildren(panel(title, callout('warn', 'No feasible points in the sweep. ', sweep.note || '')));
      return;
    }
    const node = el('div', { class: 'plot', role: 'img', 'aria-label': 'Objective value as the worker pool is swept' });
    const first = pts[0];
    const last = pts[pts.length - 1];
    const span = last.workforce_total - first.workforce_total;
    const slope = pts.length < 2 || span === 0 ? 0 : (last.objective_value - first.objective_value) / span;
    const vals = pts.map((p) => p.objective_value);
    const stat = (label, value) => el('div', {}, el('div', { class: 'field-label' }, label), el('div', { class: 'num' }, value));
    host.replaceChildren(panel(title, [
      el('p', { class: 'muted' }, sweep.note), node,
      el('div', { class: 'grid grid-3', style: 'margin-top:12px' },
        stat('Swept', `${fmt.num(first.workforce_total, 1)} → ${fmt.num(last.workforce_total, 1)} workers`),
        stat('Objective range', `${fmt.num(Math.min(...vals), 1)} → ${fmt.num(Math.max(...vals), 1)}`),
        stat('Average slope', `${fmt.num(slope, 3)} per worker`)),
    ]));
    plot(node, [
      { type: 'scatter', mode: 'lines+markers', name: 'Objective', x: pts.map((p) => p.workforce_total), y: vals,
        line: { color: C.accent, width: 2.5 }, marker: { size: 6, color: C.accent },
        hovertemplate: 'pool %{x:.1f} → %{y:.1f}<extra></extra>' },
      { type: 'scatter', mode: 'markers', name: 'Current run', x: [r.resources.workforce_available],
        y: [r.comparison.headline.optimized],
        marker: { size: 12, color: C.good, symbol: 'circle-open', line: { width: 3 } },
        hovertemplate: 'current pool %{x:.1f}<extra></extra>' },
    ], {
      xaxis: { title: { text: 'worker pool W', font: { size: 11 } } },
      yaxis: { title: { text: `objective (${r.comparison.headline.unit})`, font: { size: 11 } } },
    }, 300);
  }

  /* ----------------------------------------------------------------- boot */

  const resetBtn = el('button', { class: 'btn btn-quiet', type: 'button', onclick: () => {
    c = DEFAULTS(); buildControls(); changed('filters');
  } }, 'Reset');
  const wb = AC.workbench({ title: 'Settings', controls: controlsHost, reset: resetBtn,
    actions: [solveBtn, el('div', { class: 'hint' }, 'Goal: maximise throughput. Solves in about a second.')] });
  wb.results.append(staleHost, resultsHost, paramsHost);
  app.append(wb.node);
  renderParams();
  renderEmpty();

  // Category vocabularies come from the dataset itself, so an upload with
  // different categories still produces usable filters.
  const vocabPromise = api.summary(dataset.dataset_id).then((summary) => {
    const of = (column) => {
      const entry = summary.categorical_counts.find((x) => x.column === column);
      return entry ? Object.keys(entry.counts).sort() : [];
    };
    return { terminals: of('Terminal_ID'), cargo_types: of('Cargo_Type'),
             priorities: of('Shipment_Priority'), weather: of('Weather_Condition') };
  }).catch(() => vocab);

  [vocab] = await Promise.all([vocabPromise, loadParams()]);
  buildControls();
  renderParams();
  solveBtn.disabled = !params;
})();
