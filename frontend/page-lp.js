/* Part 1 - LP workforce and equipment allocation.  Plain JavaScript.
 *
 * Derived parameters are fetched and shown BEFORE anything is optimised, so the
 * coefficients can be inspected and argued with first.  Solving happens only on
 * an explicit click.  After a successful solve the per-terminal worker plan is
 * saved with AC.handoff so Part 2 (IP) spends this allocation.
 */
(async function () {
  'use strict';
  const { el, fmt, api, table, panel, kpi, callout, badge, spinner, utilBar, plot } = AC;

  const DEFAULTS = () => ({
    filters: { terminals: [], cargo_types: [], priorities: [], weather: [], peak_hour: null },
    labor_share: 0.6, cost_labor_share: 0.6, congestion_delta: 1.0, apply_congestion: true,
    demand_scale: 1.0, demand_day: 'mean', objective: 'max_throughput',
    workforce_pool_factor: 1.0, equipment_pool_factor: 1.0, budget_enabled: false, budget_factor: 1.0,
  });
  const OBJECTIVES = [['max_throughput', 'Max throughput'], ['min_cost', 'Min cost']];
  const DEMAND_DAYS = [['mean', 'Average day'], ['p95', 'Busy day (p95)']];
  const PEAK = [[null, 'All hours'], [1, 'Peak'], [0, 'Off-peak']];
  // Mid-tone colours that read on both the light and the dark theme.
  const C = { accent: '#E9A32E', muted: '#7D848C', good: '#1F9A73', bad: '#D4453B' };

  const dataset = await AC.shell('lp', { needsDataset: true });
  if (!dataset) return;
  const app = document.getElementById('app');
  document.getElementById('caveat').append(AC.caveatBanner());

  let c = DEFAULTS();
  let params = null;            // last /api/lp/parameters response
  let paramsLoading = true;
  let paramsError = null;
  let solveResult = null;
  let solvedSig = null;
  let solving = false;
  let paramsSeq = 0;
  let timer = null;
  const syncers = [];           // functions that refresh control labels / disabled states

  /* ------------------------------------------------------------- payloads */

  const paramsPayload = () => ({
    dataset_id: dataset.dataset_id, filters: c.filters, labor_share: c.labor_share,
    cost_labor_share: c.cost_labor_share, congestion_delta: c.congestion_delta,
    apply_congestion: c.apply_congestion, demand_scale: c.demand_scale, demand_day: c.demand_day,
  });
  const solvePayload = () => ({
    ...paramsPayload(), objective: c.objective,
    workforce_pool_factor: c.workforce_pool_factor, equipment_pool_factor: c.equipment_pool_factor,
    budget_factor: c.budget_enabled ? c.budget_factor : null,
  });

  /* ------------------------------------------------------------- widgets */

  function slider({ label, key, min, max, step, format, hint, enabledWhen }) {
    const valueEl = el('span', { class: 'num' });
    const input = el('input', { type: 'range', min, max, step, value: c[key], 'aria-label': label });
    const refresh = () => {
      input.value = c[key];
      valueEl.textContent = format(c[key]);
      input.disabled = enabledWhen ? !enabledWhen() : false;
    };
    input.addEventListener('input', () => { c[key] = parseFloat(input.value); refresh(); changed(key); });
    syncers.push(refresh);
    return el('div', { class: 'control' },
      el('div', { class: 'top' }, el('label', {}, label), valueEl), input,
      hint ? el('div', { class: 'hint' }, hint) : '');
  }

  function toggle({ label, key, hint }) {
    const input = el('input', { type: 'checkbox' });
    input.addEventListener('change', () => { c[key] = input.checked; syncAll(); changed(key); });
    syncers.push(() => { input.checked = c[key]; });
    return el('div', { class: 'control' },
      el('label', { class: 'check' }, input, el('span', {}, label)),
      hint ? el('div', { class: 'hint' }, hint) : '');
  }

  /** Segmented control over c[key] (or c.filters[key] when `holder` is given). */
  function segmented({ label, options, get, set }) {
    const buttons = options.map(([value, text]) => {
      const b = el('button', { type: 'button' }, text);
      b.addEventListener('click', () => { set(value); syncAll(); });
      return [value, b];
    });
    syncers.push(() => buttons.forEach(([v, b]) => b.classList.toggle('on', v === get())));
    return el('div', { class: 'control' },
      el('div', { class: 'top' }, el('label', {}, label)),
      el('div', { class: 'seg' }, buttons.map((p) => p[1])));
  }

  function chipSelect(label, filterKey, options, hint) {
    const wrap = el('div', { class: 'chips' });
    const chips = options.map((opt) => {
      const chip = el('button', { type: 'button', class: 'chip' }, opt);
      chip.addEventListener('click', () => {
        const cur = c.filters[filterKey];
        c.filters[filterKey] = cur.includes(opt) ? cur.filter((x) => x !== opt) : [...cur, opt];
        syncAll(); changed('filters');
      });
      wrap.append(chip);
      return [opt, chip];
    });
    syncers.push(() => chips.forEach(([opt, chip]) =>
      chip.classList.toggle('on', c.filters[filterKey].includes(opt))));
    return el('div', { class: 'control' },
      el('div', { class: 'top' }, el('label', {}, label)),
      options.length ? wrap : el('div', { class: 'hint' }, 'No categories found in this dataset.'),
      hint ? el('div', { class: 'hint' }, hint) : '');
  }

  const syncAll = () => syncers.forEach((f) => f());

  /* ------------------------------------------------------- change handling */

  /** Any control moved: refresh labels, re-derive parameters (debounced), flag stale results. */
  function changed(key) {
    syncAll();
    renderStale();
    if (key === 'objective' || key === 'workforce_pool_factor' || key === 'equipment_pool_factor'
        || key === 'budget_factor' || key === 'budget_enabled') {
      renderParams();          // these only change how cached numbers are displayed
      return;
    }
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
    syncAll();
    solveBtn.disabled = !params || solving;
  }

  /* ---------------------------------------------------------- control panel */

  const recordsNote = el('div', { class: 'hint' }, 'Deriving...');
  const resetBtn = el('button', { class: 'btn', type: 'button', onclick: () => {
    c = DEFAULTS(); syncAll(); changed('filters');
  } }, 'Reset');

  const controlsBody = el('div', {});
  const controlsPanel = panel('Scenario', controlsBody, resetBtn);

  function buildControls(vocab) {
    controlsBody.replaceChildren(
      el('div', { class: 'field-label', style: 'margin-bottom:8px' }, 'Slice'),
      chipSelect('Terminals', 'terminals', vocab.terminals, 'None selected = all terminals'),
      chipSelect('Cargo type', 'cargo_types', vocab.cargo_types),
      chipSelect('Weather', 'weather', vocab.weather),
      chipSelect('Priority', 'priorities', vocab.priorities),
      segmented({ label: 'Hour of day', options: PEAK,
                  get: () => c.filters.peak_hour,
                  set: (v) => { c.filters.peak_hour = v; changed('filters'); } }),
      recordsNote,

      el('div', { class: 'field-label', style: 'margin:16px 0 8px' }, 'Assumptions'),
      slider({ label: 'Labour share θ', key: 'labor_share', min: 0.05, max: 0.95, step: 0.05,
               format: (v) => v.toFixed(2),
               hint: 'Share of throughput attributed to workers. The single free assumption behind α and β.' }),
      slider({ label: 'Cost labour share θ_c', key: 'cost_labor_share', min: 0.05, max: 0.95, step: 0.05,
               format: (v) => v.toFixed(2),
               hint: 'With θ_c = θ the two resources are equally cost-efficient inside a terminal; separate them to create a substitution trade-off.' }),
      toggle({ label: 'Congestion multiplier γ', key: 'apply_congestion',
               hint: 'Off, the terminals are near-identical and the allocation becomes a solver artefact. This switch exists to demonstrate that.' }),
      slider({ label: 'Congestion exponent δ', key: 'congestion_delta', min: 0, max: 3, step: 0.25,
               format: (v) => v.toFixed(2), enabledWhen: () => c.apply_congestion,
               hint: 'Raises the weight on facility utilisation, widening the productivity spread between terminals.' }),
      segmented({ label: 'Planning window', options: DEMAND_DAYS,
                  get: () => c.demand_day, set: (v) => { c.demand_day = v; changed('demand_day'); } }),
      el('div', { class: 'hint', style: 'margin:-8px 0 14px' },
        'D_t is the tons arriving at a terminal in one window, divided by H - a level made into a rate, never a rescaled mean. ' +
        'On an average day every terminal carries roughly 45% headroom; on a busy day demand runs past capability and the slack ' +
        'variables switch on. That is where the LP earns its keep.'),
      slider({ label: 'Demand stress ×', key: 'demand_scale', min: 0.5, max: 3, step: 0.1,
               format: (v) => `${v.toFixed(1)}×`,
               hint: 'Scales every D_t. Above roughly 1.5× the terminals cannot meet demand and the shortfall is reported as slack.' }),

      el('div', { class: 'field-label', style: 'margin:16px 0 8px' }, 'Resources'),
      segmented({ label: 'Objective', options: OBJECTIVES,
                  get: () => c.objective, set: (v) => { c.objective = v; changed('objective'); } }),
      slider({ label: 'Worker pool', key: 'workforce_pool_factor', min: 0.8, max: 1.2, step: 0.05,
               format: (v) => `${(v * 100).toFixed(0)}%${params ? ` · ${fmt.num(params.workforce_total * v, 1)}` : ''}`,
               hint: 'Relative to the total the terminals were observed to use. Above 100% is flagged as an expanded-resources scenario.' }),
      slider({ label: 'Equipment pool', key: 'equipment_pool_factor', min: 0.8, max: 1.2, step: 0.05,
               format: (v) => `${(v * 100).toFixed(0)}%${params ? ` · ${fmt.num(params.equipment_total * v, 1)}` : ''}` }),
      toggle({ label: 'Budget cap', key: 'budget_enabled',
               hint: 'Cap total operational cost as a multiple of the baseline cost.' }),
      slider({ label: 'Budget', key: 'budget_factor', min: 0.5, max: 2, step: 0.05,
               format: (v) => `${(v * 100).toFixed(0)}%${params ? ` · ${fmt.num(params.baseline_cost * v, 0)}` : ''}`,
               enabledWhen: () => c.budget_enabled }),
      expandedNote);
    syncAll();
  }

  const expandedNote = el('div', {});
  syncers.push(() => {
    expandedNote.replaceChildren(
      (c.workforce_pool_factor > 1 || c.equipment_pool_factor > 1)
        ? callout('warn', 'Expanded-resources scenario: part of any gain is bought with extra resources rather than earned by re-allocating.')
        : '');
  });

  /* -------------------------------------------------------- derived params */

  const paramsHost = el('div', {});
  let showDerivation = false;

  function renderParams() {
    if (params) {
      recordsNote.textContent =
        `${fmt.int(params.n_records)} records in this slice, across ${params.terminals.length} terminal(s).`;
    }
    if (paramsError) {
      paramsHost.replaceChildren(callout('bad', el('b', {}, 'Could not derive parameters. '), paramsError.message));
      return;
    }
    if (!params) {
      paramsHost.replaceChildren(panel('Derived parameters', spinner('Deriving parameters...')));
      return;
    }
    const congestionOn = params.assumptions.congestion_applied;
    const derivBtn = el('button', { class: 'btn', type: 'button', onclick: () => {
      showDerivation = !showDerivation; renderParams();
    } }, showDerivation ? 'Hide derivation' : 'How these were derived');
    const right = el('div', { class: 'row' }, paramsLoading ? el('span', { class: 'faint' }, 'updating...') : '', derivBtn);

    const rangeText = (lo, hi) => `${fmt.num(lo, 0)}–${fmt.num(hi, 0)}`;
    const tbl = table({
      columns: [
        { key: 'terminal', label: 'Terminal' },
        { label: 'α per worker', align: 'r', sym: true, render: (r) => fmt.num(r.alpha, 3) },
        { label: 'β per unit', align: 'r', sym: true, render: (r) => fmt.num(r.beta, 3) },
        { label: 'γ', align: 'r', sym: true,
          render: (r) => el('span', { class: congestionOn ? '' : 'faint' }, fmt.num(r.congestion, 3)) },
        { label: 'cost/worker', align: 'r', sym: true, render: (r) => fmt.num(r.cost_worker, 1) },
        { label: 'cost/unit', align: 'r', sym: true, render: (r) => fmt.num(r.cost_equipment, 1) },
        { label: 'demand D', align: 'r', sym: true, render: (r) => fmt.num(r.demand, 1) },
        { label: 'capacity', align: 'r', sym: true, render: (r) => fmt.num(r.capacity, 1) },
        { label: 'w range', align: 'r', sym: true, render: (r) => rangeText(r.workforce_min, r.workforce_max) },
        { label: 'e range', align: 'r', sym: true, render: (r) => rangeText(r.equipment_min, r.equipment_max) },
      ],
      rows: params.terminals,
    });
    tbl.classList.toggle('dim', paramsLoading);

    const kv = (pairs) => el('dl', { class: 'kv kv-3' }, pairs.map(([k, v]) => [el('dt', {}, k), el('dd', { class: 'num' }, v)]));
    const penalty = params.unmet_penalty[c.objective];
    const body = el('div', {},
      el('p', { class: 'muted' }, "Computed from this scenario's group means, before any optimisation runs."),
      tbl,
      el('div', { style: 'margin-top:14px' }, kv([
        ['Worker pool W', fmt.num(params.workforce_total, 1)],
        ['Equipment pool E', fmt.num(params.equipment_total, 1)],
        ['Records in slice', fmt.int(params.n_records)],
        ['Baseline throughput', fmt.num(params.baseline_throughput, 2)],
        ['Baseline cost', fmt.num(params.baseline_cost, 0)],
        ['Baseline unmet demand', fmt.num(params.baseline_unmet_demand, 2)],
        ['Planning horizon H', `${fmt.num(params.assumptions.horizon_hours, 0)} h`],
        ['Unmet-demand penalty M', fmt.num(penalty, 1)],
        ['Capacity percentile', fmt.pct(params.assumptions.capacity_percentile * 100, 0)],
      ])),
      congestionOn ? '' : el('div', { style: 'margin-top:14px' },
        callout('warn', el('b', {}, 'Congestion multiplier is off. '),
          'With γ = 1 the terminals are statistically interchangeable, so the LP has no reason to prefer any of them ' +
          'and the allocation it returns is an artefact of solver scan order rather than a decision.')),
      params.warnings.length ? el('div', { style: 'margin-top:14px' },
        callout('warn', el('b', {}, 'Scenario warnings'), el('ul', {}, params.warnings.map((w) => el('li', {}, w))))) : '',
      showDerivation ? el('div', { style: 'margin-top:14px' },
        el('div', { class: 'field-label' }, 'Derivation'),
        params.derivation.map((n) => el('div', { class: 'deriv' },
          el('div', {}, el('b', { class: 'num' }, n.symbol), ' ', n.name),
          el('code', {}, n.formula),
          el('p', { class: 'muted' }, n.explanation)))) : '');
    paramsHost.replaceChildren(panel('Derived parameters', body, right));
  }

  /* ---------------------------------------------------------------- solve */

  const solveBtn = el('button', { class: 'btn btn-primary btn-block', type: 'button', disabled: true,
    onclick: () => runSolve() }, 'Solve allocation');
  const staleHost = el('div', {});
  const resultsHost = el('div', {});

  function renderStale() {
    const stale = solveResult && solvedSig !== null && solvedSig !== JSON.stringify(solvePayload());
    staleHost.replaceChildren(stale ? callout('warn', el('b', {}, 'Controls changed since this solve. '),
      'The results below were produced with the previous settings. ',
      el('button', { class: 'btn', type: 'button', disabled: solving, onclick: () => runSolve() },
        'Re-solve with current settings')) : '');
  }

  function renderEmpty() {
    resultsHost.replaceChildren(el('div', { class: 'empty' },
      el('b', {}, 'No solve yet'), el('p', {},
        'The parameters above are already derived for this scenario. Solving runs CBC once and compares the ' +
        'result against the observed allocation under the same objective function.')));
  }

  async function runSolve() {
    if (solving || !params) return;
    const payload = solvePayload();
    const sig = JSON.stringify(payload);
    solving = true;
    solveBtn.disabled = true;
    solveBtn.replaceChildren(spinner('Solving...'));
    staleHost.replaceChildren();
    resultsHost.replaceChildren(panel('Result', spinner('Running the solver...')));
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
      AC.handoff.save(dataset.dataset_id, workforce, result.objective);
    } else {
      AC.handoff.clear();
    }

    const sensHost = el('div', {});
    renderResults(result, sensHost);
    renderStale();
    if (result.status === 'Optimal') {
      sensHost.replaceChildren(panel('Sensitivity - objective against the worker pool', spinner('Sweeping the worker pool...')));
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

  function deltaCell(value, percent, better, digits) {
    const neutral = better === 'neutral' || Math.abs(value) < 1e-9;
    const good = better === 'up' ? value > 0 : value < 0;
    return el('span', { class: `num ${neutral ? 'muted' : good ? 'pos' : 'neg'}` },
      fmt.signed(value, digits == null ? 2 : digits),
      percent != null ? el('small', {}, ` (${fmt.signed(percent, 1)}%)`) : '');
  }

  function solveStatusBox(r) {
    const ok = r.status === 'Optimal';
    return callout(ok ? 'good' : (r.status === 'Infeasible' || r.status === 'Unbounded') ? 'bad' : 'warn',
      el('b', {}, ok ? 'Solved to optimality' : `Solver status: ${r.status}`),
      el('p', {}, r.message || ''),
      r.suggestions && r.suggestions.length
        ? el('ul', {}, r.suggestions.map((s) => el('li', {}, s))) : '',
      ok ? el('div', { class: 'num muted' }, `CBC · ${fmt.num(r.solve_seconds, 3)} s`) : '');
  }

  function renderResults(r, sensHost) {
    if (r.status !== 'Optimal') {
      resultsHost.replaceChildren(panel('Result', [
        solveStatusBox(r),
        r.warnings && r.warnings.length ? callout('warn', el('ul', {}, r.warnings.map((w) => el('li', {}, w)))) : '',
      ]));
      return;
    }
    const cmp = r.comparison;
    const h = cmp.headline;
    const thr = metricOf(cmp, 'total_throughput');
    const unmet = metricOf(cmp, 'total_unmet_demand');
    const unmetK = kpi('Unmet demand', fmt.num(unmet.optimized, 2), `baseline ${fmt.num(unmet.baseline, 2)}`);
    unmetK.querySelector('.value').classList.add(unmet.optimized > 0.001 ? 'neg' : 'pos');
    const optK = kpi('Objective — optimised', fmt.num(h.optimized, 1), h.unit);
    if (h.improved) optK.querySelector('.value').classList.add('pos');

    const handoffNote = callout('good', el('b', {}, 'Allocation saved for Part 2. '),
      'These worker numbers are now available in ', el('a', { href: 'ip.html' }, 'Part 2 · IP'),
      ' - shipment selection will spend this plan instead of the observed one.');

    const outcome = panel('Outcome', [
      solveStatusBox(r),
      el('div', { class: 'row', style: 'margin-bottom:12px' },
        el('span', { class: 'muted' }, r.objective_label), ' ',
        r.expanded_resources ? badge('Expanded resources', 'accent') : badge('Same resource pools'),
        ' ', el('span', { class: 'faint' }, `allocation: ${r.allocation_source}`)),
      el('div', { class: 'grid grid-4' },
        kpi('Objective — baseline', fmt.num(h.baseline, 1), h.unit), optK,
        kpi('Total throughput', fmt.num(thr.optimized, 1), `baseline ${fmt.num(thr.baseline, 1)}`), unmetK),
      el('div', { style: 'margin-top:14px' }, table({
        columns: [
          { key: 'label', label: 'Metric' },
          { label: 'Observed', align: 'r', render: (m) => fmt.num(m.baseline, 2) },
          { label: 'Optimised', align: 'r', render: (m) => fmt.num(m.optimized, 2) },
          { label: 'Change', align: 'r', render: (m) => deltaCell(m.delta, m.percent_delta, m.better) },
        ],
        rows: [h, ...cmp.metrics],
      })),
      cmp.notes.map((n) => callout('warn', n)),
      r.warnings && r.warnings.length ? callout('warn', el('ul', {}, r.warnings.map((w) => el('li', {}, w)))) : '',
      el('p', { class: 'muted', style: 'margin-top:10px' },
        'Both columns are scored by the same objective function at the same resource totals - the observed allocation ' +
        'is never compared against raw recorded KPIs.'),
    ]);

    const allocNode = el('div', { class: 'plot', role: 'img',
      'aria-label': 'Baseline versus optimised workers and equipment per terminal' });
    const thrNode = el('div', { class: 'plot', role: 'img',
      'aria-label': 'Throughput against demand and capacity per terminal' });
    const charts = el('div', { class: 'grid grid-2' },
      panel('Allocation', [el('p', { class: 'muted' }, 'Observed mean versus optimised, per terminal.'), allocNode,
        el('p', { class: 'hint muted' }, 'Bars are workers (left axis); markers are equipment units (right axis). The two resources ' +
          'live on different scales, so plotting them on one axis would hide the equipment movement entirely.')]),
      panel('Throughput against demand and capacity', [
        el('p', { class: 'muted' }, 'Where each terminal lands between its demand floor and its physical ceiling.'), thrNode,
        el('p', { class: 'hint muted' }, "A bar below its demand marker is unmet demand, carried by the soft constraint's slack variable " +
          'rather than making the model infeasible.')]));

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
    const dualsPanel = panel('Binding constraints and shadow prices', [
      el('p', { class: 'muted' }, 'What is actually limiting the plan, and what a unit of relief is worth.'),
      // The headline research question is "what is one more worker worth?" and the dual is the
      // answer, so where it came from is on screen next to it rather than in a footnote.
      callout(inflated ? 'warn' : '', r.duals_note || ''),
      el('div', { class: 'row', style: 'margin-bottom:10px' },
        el('span', { class: 'field-label' }, 'allocation source'), el('span', { class: 'num' }, r.allocation_source),
        el('span', { class: 'field-label' }, 'duals source'), el('span', { class: 'num' }, r.duals_source)),
      table({
        columns: [
          { key: 'name', label: 'Constraint', render: (d) => el('span', { class: 'num' }, d.name) },
          { label: 'State', render: (d) => el('span', { class: `num ${d.binding ? '' : 'faint'}` }, d.binding ? 'binding' : 'slack') },
          { label: 'RHS', align: 'r', render: (d) => `${d.sense} ${fmt.num(d.rhs, 1)}` },
          { label: 'Slack', align: 'r', render: (d) => fmt.num(d.slack, 2) },
          { label: 'Shadow price', align: 'r',
            render: (d) => el('span', { class: d.binding ? '' : 'faint' }, fmt.num(d.shadow_price, 4)) },
        ],
        rows: r.duals,
        rowClass: (d) => (d.binding ? 'stripe-binding' : ''),
      }),
      el('div', { class: 'field-label', style: 'margin-top:14px' }, 'Reading the binding constraints'),
      el('ul', { class: 'readings' }, r.duals.filter((d) => d.binding).map((d) =>
        el('li', {}, el('span', { class: 'num' }, d.name), ' — ', d.interpretation))),
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

    resultsHost.replaceChildren(outcome, handoffNote, charts, plan,
      el('div', { class: 'split-wide' }, dualsPanel, resourcePanel), sensHost);

    // Charts need to be in the document before Plotly measures them.
    const labels = r.allocation.map((a) => a.terminal);
    const col = (k) => r.allocation.map((a) => a[k]);
    plot(allocNode, [
      { type: 'bar', name: 'Workers — observed', x: labels, y: col('baseline_workforce'),
        marker: { color: C.muted }, offsetgroup: 1, hovertemplate: '%{x}: %{y:.1f} workers<extra>Observed</extra>' },
      { type: 'bar', name: 'Workers — optimised', x: labels, y: col('optimized_workforce'),
        marker: { color: C.accent }, offsetgroup: 2, hovertemplate: '%{x}: %{y:.1f} workers<extra>Optimised</extra>' },
      { type: 'scatter', mode: 'markers', name: 'Equipment — observed', x: labels, y: col('baseline_equipment'), yaxis: 'y2',
        marker: { color: C.muted, size: 9, symbol: 'circle-open', line: { width: 2 } },
        hovertemplate: '%{x}: %{y:.1f} units<extra>Observed</extra>' },
      { type: 'scatter', mode: 'markers', name: 'Equipment — optimised', x: labels, y: col('optimized_equipment'), yaxis: 'y2',
        marker: { color: C.accent, size: 9, symbol: 'diamond' },
        hovertemplate: '%{x}: %{y:.1f} units<extra>Optimised</extra>' },
    ], {
      barmode: 'group', bargap: 0.4,
      yaxis: { title: { text: 'workers', font: { size: 11 } }, rangemode: 'tozero' },
      yaxis2: { title: { text: 'equipment', font: { size: 11 } }, overlaying: 'y', side: 'right',
                rangemode: 'tozero', showgrid: false, automargin: true },
    }, 300);

    plot(thrNode, [
      { type: 'bar', name: 'Throughput — observed', x: labels, y: col('baseline_throughput'),
        marker: { color: C.muted }, offsetgroup: 1, hovertemplate: '%{x}: %{y:.1f}<extra>Observed</extra>' },
      { type: 'bar', name: 'Throughput — optimised', x: labels, y: col('optimized_throughput'),
        marker: { color: C.accent }, offsetgroup: 2, hovertemplate: '%{x}: %{y:.1f}<extra>Optimised</extra>' },
      { type: 'scatter', mode: 'markers', name: 'Demand D', x: labels, y: col('demand'),
        marker: { color: C.good, size: 11, symbol: 'line-ew-open', line: { width: 3 } },
        hovertemplate: '%{x}: %{y:.1f}<extra>Demand</extra>' },
      { type: 'scatter', mode: 'markers', name: 'Capacity ceiling', x: labels, y: col('capacity'),
        marker: { color: C.bad, size: 11, symbol: 'line-ew-open', line: { width: 3 } },
        hovertemplate: '%{x}: %{y:.1f}<extra>Capacity</extra>' },
    ], {
      barmode: 'group', bargap: 0.4,
      yaxis: { title: { text: 'throughput units', font: { size: 11 } }, rangemode: 'tozero' },
    }, 300);
  }

  function renderSensitivity(host, sweep, r) {
    const pts = sweep.points.filter((p) => p.objective_value !== null);
    if (!pts.length) {
      host.replaceChildren(panel('Sensitivity - objective against the worker pool',
        callout('warn', 'No feasible points in the sweep. ', sweep.note || '')));
      return;
    }
    const node = el('div', { class: 'plot', role: 'img', 'aria-label': 'Objective value as the worker pool is swept' });
    const first = pts[0];
    const last = pts[pts.length - 1];
    const span = last.workforce_total - first.workforce_total;
    const slope = pts.length < 2 || span === 0 ? 0 : (last.objective_value - first.objective_value) / span;
    const vals = pts.map((p) => p.objective_value);
    const stat = (label, value) => el('div', {}, el('div', { class: 'field-label' }, label), el('div', { class: 'num' }, value));
    host.replaceChildren(panel('Sensitivity - objective against the worker pool', [
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
      yaxis: { title: { text: r.comparison.headline.unit, font: { size: 11 } } },
    }, 300);
  }

  /* ----------------------------------------------------------------- boot */

  app.append(el('div', { class: 'split' },
    el('div', { class: 'sticky-col' }, controlsPanel, solveBtn),
    el('div', { style: 'min-width:0' }, paramsHost, staleHost, resultsHost)));
  controlsBody.append(spinner('Loading categories...'));
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
  }).catch(() => ({ terminals: [], cargo_types: [], priorities: [], weather: [] }));

  const [vocab] = await Promise.all([vocabPromise, loadParams()]);
  buildControls(vocab);
  solveBtn.disabled = !params;
})();
