/* Part 2 - IP shipment selection.  Plain JavaScript, uses the global AC.
 *
 * The batch and every value score are fetched and shown BEFORE anything is
 * optimised.  Solving happens only on an explicit click.  The worker-minute
 * budgets come from Part 1 (AC.handoff) when it has been solved, otherwise
 * Part 2 runs standalone and says so.
 */
(async function () {
  'use strict';
  const { el, fmt, api, ui } = AC;
  const PRIORITIES = ['Critical', 'High', 'Medium', 'Low'];
  const SHIFT_MINUTES = 8 * 60;   // H x 60, as the old page displayed it

  const DEFAULTS = () => ({
    filters: { terminals: [], cargo_types: [], priorities: [], weather: [], peak_hour: null },
    size: 50, seed: 42,
    capacity_fraction: 0.6,
    lambda_waiting: 0.5, lambda_queue: 0.5,
    priority_weights: { Critical: 10, High: 5, Medium: 2, Low: 1 },
    force_critical: false,
    hazardous_enabled: false, max_hazardous: 5,
    perishable_enabled: false, min_perishable: 3,
    use_lp: true,
  });

  const main = AC.$('main');
  const dataset = await AC.shell('ip', { needsDataset: true });

  main.append(AC.pageHead({
    kicker: 'Part 2 · Integer programming',
    title: 'Shipment selection under capacity',
    lede: 'When capacity runs out, which shipments should be processed now and which held back?',
    about: [
      el('p', {}, 'A 0-1 multi-dimensional knapsack over one planning window. Each shipment is either processed (x = 1) or held (x = 0), ' +
        'and the selection maximises priority-weighted value while staying inside three budgets: volume, worker-minutes and equipment-minutes.'),
      el('p', {}, 'The worker-minute budget is set per terminal and comes from Part 1: the staff plan decides how many workers each terminal gets, ' +
        'and this page spends those minutes. Without a Part 1 solve the budget is derived from the batch itself, which is a weaker claim.'),
    ],
  }));
  const caveatHolder = el('div', {}, AC.caveatBanner());
  main.append(caveatHolder);
  if (!dataset) return;

  /* ----------------------------------------------------------------- state */

  let controls = DEFAULTS();
  const handoff = AC.handoff.load(dataset.dataset_id);   // {workforce} or null
  const lpWorkforce = handoff && handoff.workforce && Object.keys(handoff.workforce).length ? handoff.workforce : null;
  let vocab = null;
  let lastBatch = null;
  let solvedSignature = null;
  let batchToken = 0;
  let batchTimer = null;
  let showAllBatch = false;
  let decisionFilter = 'all';
  let lastResult = null;
  let showAllDecisions = false;
  let batchOpen = true;          // the preview folds away once there is a result

  const nonEmpty = (a) => (a && a.length ? a : null);
  function batchPayload() {
    const c = controls;
    return {
      dataset_id: dataset.dataset_id,
      filters: {
        terminals: nonEmpty(c.filters.terminals), cargo_types: nonEmpty(c.filters.cargo_types),
        priorities: nonEmpty(c.filters.priorities), weather: nonEmpty(c.filters.weather),
        peak_hour: c.filters.peak_hour,
      },
      size: c.size, seed: c.seed,
      priority_weights: c.priority_weights,
      lambda_waiting: c.lambda_waiting, lambda_queue: c.lambda_queue,
      capacity_fraction: c.capacity_fraction,
    };
  }
  function solvePayload() {
    const c = controls;
    return {
      ...batchPayload(),
      force_critical: c.force_critical,
      max_hazardous: c.hazardous_enabled ? c.max_hazardous : null,
      min_perishable: c.perishable_enabled ? c.min_perishable : null,
      lp_workforce: (c.use_lp && lpWorkforce) ? lpWorkforce : null,
    };
  }
  const coupled = () => !!(controls.use_lp && lpWorkforce);

  /* --------------------------------------------------------------- layout */

  const controlsHost = el('div', {});
  const solveBarHost = el('div', {});
  const staleHost = el('div', {});
  const resultsHost = el('div', {});
  const batchHost = el('div', {});
  const wb = AC.workbench({
    title: 'Settings',
    controls: controlsHost,
    reset: el('button', { class: 'btn btn-quiet', type: 'button', onclick: () => { controls = DEFAULTS(); buildControls(); changed(); } }, 'Reset'),
    actions: solveBarHost,
  });
  wb.results.append(staleHost, resultsHost, batchHost);
  main.append(wb.node);

  /* -------------------------------------------------------------- settings */

  /** Any control change: mark stale, and rebuild the batch preview once sliders settle. */
  function changed({ batch = true } = {}) {
    renderSolveBar();
    refreshStale();
    if (batch) {
      clearTimeout(batchTimer);
      batchTimer = setTimeout(loadBatch, 300);
    }
  }

  const count = (v) => fmt.num(v, 0);
  const vocabHost = el('div', {});
  function renderVocab() {
    const c = controls;
    AC.clear(vocabHost);
    if (!vocab) { vocabHost.append(el('p', { class: 'hint' }, AC.spinner('Loading filter options...'))); return; }
    vocabHost.append(
      ui.chips({ label: 'Terminals', options: vocab.terminals, selected: c.filters.terminals, emptyText: 'All terminals included',
        onChange: (v) => { c.filters.terminals = v; changed(); } }),
      ui.chips({ label: 'Cargo type', options: vocab.cargo_types, selected: c.filters.cargo_types, onChange: (v) => { c.filters.cargo_types = v; changed(); } }),
      ui.chips({ label: 'Priority', options: vocab.priorities, selected: c.filters.priorities, onChange: (v) => { c.filters.priorities = v; changed(); } }),
      ui.chips({ label: 'Weather', options: vocab.weather, selected: c.filters.weather, onChange: (v) => { c.filters.weather = v; changed(); } }));
  }

  function lpBox() {
    const c = controls;
    const box = el('div', {});
    const draw = () => {
      AC.clear(box);
      if (!lpWorkforce) {
        box.append(AC.callout('warn', el('b', {}, 'Running standalone'), ' - ',
          el('a', { href: 'lp.html' }, 'solve step 2 (Staff plan) first'), ' to couple the models.'));
        return;
      }
      box.append(ui.toggle({
        label: "Use Part 1's staff plan", checked: c.use_lp,
        help: "On: each terminal's worker-minute budget (constraint 2) is w_t* x H x 60, from your Part 1 solve. " +
          "Off: the batch's own consumption stands in - a weaker, self-referential claim.",
        onChange: (v) => { c.use_lp = v; draw(); changed({ batch: false }); if (lastBatch) renderBatch(false); },
      }));
      if (c.use_lp) {
        box.append(el('dl', { class: 'kv' }, Object.entries(lpWorkforce).map(([t, w]) => [
          el('dt', {}, t), el('dd', { class: 'num' }, `${fmt.num(w, 1)} workers → ${fmt.int(w * SHIFT_MINUTES)} min`)])),
        el('div', { class: 'hint' }, 'From your Part 1 solve. Re-solve Part 1 to change these.'));
      } else {
        box.append(AC.callout('warn', el('b', {}, 'Running standalone'), " - Part 1's plan is switched off, so the worker budget comes from the batch it constrains."));
      }
    };
    draw();
    return box;
  }

  function buildControls() {
    const c = controls;
    AC.clear(controlsHost);
    const hazard = ui.slider({ label: 'Max hazardous', min: 0, max: 30, step: 1, value: c.max_hazardous, format: count,
      onInput: (v) => { c.max_hazardous = v; changed({ batch: false }); } });
    hazard.setDisabled(!c.hazardous_enabled);
    const perish = ui.slider({ label: 'Min perishable', min: 0, max: 30, step: 1, value: c.min_perishable, format: count,
      onInput: (v) => { c.min_perishable = v; changed({ batch: false }); } });
    perish.setDisabled(!c.perishable_enabled);
    const peak = c.filters.peak_hour == null ? 'any' : String(c.filters.peak_hour);
    renderVocab();

    controlsHost.append(
      el('div', { class: 'section-title' }, 'Capacity'),
      ui.slider({ label: 'Capacity fraction (f)', min: 0.1, max: 1, step: 0.05, value: c.capacity_fraction, format: (v) => `${(v * 100).toFixed(0)}%`,
        help: 'Volume and equipment-minutes as a share of the batch totals. Lower f binds harder; at 100% everything fits and there is nothing to choose.',
        onInput: (v) => { c.capacity_fraction = v; changed(); } }),
      el('div', { class: 'control' }, lpBox()),
      el('div', { class: 'section-title' }, 'Rules'),
      ui.toggle({ label: 'Force all Critical in', checked: c.force_critical,
        help: 'Pins x_i = 1 for every Critical shipment. If they do not fit on their own the run is caught before the solver sees it, with advice instead of a bare "Infeasible".',
        onChange: (v) => { c.force_critical = v; changed({ batch: false }); } }),
      ui.group(ui.toggle({ label: 'Cap Hazardous count', checked: c.hazardous_enabled,
        onChange: (v) => { c.hazardous_enabled = v; hazard.setDisabled(!v); changed({ batch: false }); } }), hazard),
      ui.group(ui.toggle({ label: 'Require Perishables', checked: c.perishable_enabled,
        onChange: (v) => { c.perishable_enabled = v; perish.setDisabled(!v); changed({ batch: false }); } }), perish),
      AC.fold('Value weights', [
        el('p', { class: 'hint', style: 'margin:0 0 12px' },
          'Priority comes first and urgency only breaks ties, so keep each class more than 1.9x the one below it.'),
        PRIORITIES.map((p) => ui.slider({ label: `${p} weight`, min: 1, max: 20, step: 1, value: c.priority_weights[p], format: count,
          onInput: (v) => { c.priority_weights[p] = v; changed(); } })),
        ui.slider({ label: 'Waiting time weight (λ_w)', min: 0, max: 1, step: 0.1, value: c.lambda_waiting, format: (v) => v.toFixed(1),
          help: 'How much of the urgency uplift comes from waiting time. It sets the balance, not the size: the uplift is capped at U = 0.9 whatever the λ.',
          onInput: (v) => { c.lambda_waiting = v; changed(); } }),
        ui.slider({ label: 'Queue length weight (λ_q)', min: 0, max: 1, step: 0.1, value: c.lambda_queue, format: (v) => v.toFixed(1),
          onInput: (v) => { c.lambda_queue = v; changed(); } })]),
      AC.fold('Batch', [
        vocabHost,
        ui.segmented({ label: 'Peak hour', options: [['any', 'Any'], ['1', 'Peak'], ['0', 'Off-peak']], value: peak,
          onChange: (v) => { c.filters.peak_hour = v === 'any' ? null : Number(v); changed(); } }),
        ui.slider({ label: 'Batch size', min: 10, max: 200, step: 5, value: c.size, format: (v) => `${v} shipments`,
          help: 'The solver handles thousands of binaries; 30-100 keeps the tables readable.',
          onInput: (v) => { c.size = v; changed(); } }),
        ui.numberInput({ label: 'Seed', value: c.seed, min: 0, step: 1, help: 'Sampling seed, so a batch preview and its solve use the same shipments.',
          onChange: (input) => { const v = Math.max(0, Math.floor(Number(input.value) || 0)); input.value = v; c.seed = v; changed(); } })]));
  }

  /* ----------------------------------------------------------------- batch */

  async function loadVocab() {
    try {
      const summary = await api.summary(dataset.dataset_id);
      const of = (column) => {
        const entry = (summary.categorical_counts || []).find((e) => e.column === column);
        return entry ? Object.keys(entry.counts).sort() : [];
      };
      vocab = { terminals: of('Terminal_ID'), cargo_types: of('Cargo_Type'), priorities: of('Shipment_Priority'), weather: of('Weather_Condition') };
    } catch (e) {
      vocab = { terminals: [], cargo_types: [], priorities: [], weather: [] };
    }
    renderVocab();
  }

  async function loadBatch() {
    const token = ++batchToken;
    renderBatch(true);
    try {
      const data = await api.ipBatch(batchPayload());
      if (token !== batchToken) return;
      lastBatch = { data, error: null };
      AC.clear(caveatHolder); caveatHolder.append(AC.caveatBanner(data.caveat));
    } catch (e) {
      if (token !== batchToken) return;
      lastBatch = { data: null, error: e };
    }
    renderBatch(false);
    renderSolveBar();
  }

  function renderBatch(loading) {
    AC.clear(batchHost);
    const title = 'Candidate batch';
    if (lastBatch && lastBatch.error) {
      batchHost.append(AC.callout('bad', el('b', {}, 'Could not build the batch. '), lastBatch.error.message));
      return;
    }
    if (!lastBatch || !lastBatch.data) {
      batchHost.append(AC.fold(title, el('p', { class: 'muted' }, AC.spinner('Scoring shipments...')), { open: true, big: true }));
      return;
    }
    const b = lastBatch.data, t = b.totals, caps = b.capacities;
    const rows = showAllBatch ? b.shipments : b.shipments.slice(0, 8);
    // The preview cannot know Part 1's budgets; they are applied when solving.
    const wmKpi = coupled()
      ? AC.kpi('Worker-minutes from', 'Part 1 plan', 'applied when you solve', true)
      : AC.kpi('Worker-minutes from', caps.worker_minutes_source === 'lp_allocation' ? 'Part 1 plan' : 'The batch',
        Object.entries(caps.worker_minutes || {}).map(([k, v]) => `${k} ${fmt.int(v)}`).join(' · '), true);
    const body = [
      AC.kpis(
        AC.kpi('Shipments', fmt.int(t.n_shipments), `total value ${fmt.num(t.total_value, 1)}`),
        AC.kpi('Volume capacity', `${fmt.num(caps.volume, 0)} / ${fmt.num(t.total_volume, 0)}`, `f = ${fmt.pct(caps.fraction * 100, 0)}`, true),
        AC.kpi('Equipment-minutes', `${fmt.num(caps.equipment_minutes, 0)} / ${fmt.num(t.total_equipment_minutes, 0)}`, 'capacity / batch total', true),
        wmKpi),
      AC.fold('How a shipment is scored', [
        el('code', { class: 'num', style: 'display:block;overflow-x:auto;margin:4px 0' }, b.value_formula),
        el('div', { class: 'hint' }, b.note)]),
      el('div', { style: loading ? 'opacity:.6;margin-top:16px' : 'margin-top:16px' }, AC.table({
        rows,
        columns: [
          { key: 'record_id', label: 'Record' },
          { key: 'timestamp', label: 'Arrived', render: (r) => String(r.timestamp).slice(0, 16) },
          { key: 'terminal', label: 'Terminal' },
          { key: 'priority', label: 'Priority' },
          { key: 'cargo_type', label: 'Cargo' },
          { key: 'priority_weight', label: 'p', align: 'r', sym: true, render: (r) => fmt.num(r.priority_weight, 0) },
          { key: 'urgency_uplift', label: 'urgency U', align: 'r', render: (r) => `+${fmt.num(r.urgency_uplift, 2)}` },
          { key: 'value', label: 'value v', align: 'r', sym: true, render: (r) => el('b', {}, fmt.num(r.value, 2)) },
          { key: 'volume', label: 'volume', align: 'r', render: (r) => fmt.num(r.volume, 1) },
          { key: 'worker_minutes', label: 'worker-min', align: 'r', render: (r) => fmt.num(r.worker_minutes, 0) },
          { key: 'equipment_minutes', label: 'machine-min', align: 'r', render: (r) => fmt.num(r.equipment_minutes, 0) },
        ],
      })),
      el('div', { class: 'row', style: 'margin-top:12px' },
        b.shipments.length > 8 ? el('button', { class: 'btn', type: 'button', onclick: () => { showAllBatch = !showAllBatch; renderBatch(false); } },
          showAllBatch ? 'Show first 8' : `Show all ${t.n_shipments}`) : '',
        loading ? AC.spinner('updating') : ''),
    ];
    // Weight warnings sit outside the fold so they stay visible once it closes.
    if (b.warnings && b.warnings.length) {
      batchHost.append(AC.callout('warn', el('b', {}, 'Priority weights'), el('ul', {}, b.warnings.map((w) => el('li', {}, w)))));
    }
    batchHost.append(AC.fold(title, body, { big: true, open: batchOpen, aside: `${t.n_shipments} shipments scored`,
      onToggle: (o) => { batchOpen = o; } }));
  }

  /* ----------------------------------------------------------------- solve */

  let solving = false;
  let solveError = null;

  function renderSolveBar() {
    AC.clear(solveBarHost);
    const btn = el('button', { class: 'btn btn-primary', type: 'button', onclick: runSolve },
      solving ? AC.spinner('Solving...') : 'Solve selection');
    btn.disabled = solving || !(lastBatch && lastBatch.data);
    solveBarHost.append(btn,
      el('div', { class: 'hint' }, coupled() ? "Two-stage: worker-minutes come from Part 1's staff plan."
        : 'Standalone: worker-minutes derived from the batch.'),
      solveError ? AC.callout('bad', el('b', {}, 'Solve failed. '), solveError.message) : '');
  }

  function refreshStale() {
    AC.clear(staleHost);
    if (solvedSignature && solvedSignature !== JSON.stringify(solvePayload())) {
      staleHost.append(AC.callout('warn', el('b', {}, 'Settings changed since this solve. '),
        'The results below use the previous settings. ',
        el('button', { class: 'btn', type: 'button', onclick: runSolve }, 'Re-solve')));
    }
  }

  async function runSolve() {
    if (solving) return;
    const payload = solvePayload();
    solving = true; solveError = null; renderSolveBar();
    resultsHost.style.opacity = lastResult ? '.5' : '';
    try {
      const result = await api.ipSolve(payload);
      lastResult = result; solvedSignature = JSON.stringify(payload);
      batchOpen = false; renderBatch(false);
      renderResults();
    } catch (e) {
      solveError = e;
    }
    solving = false; resultsHost.style.opacity = '';
    renderSolveBar(); refreshStale();
  }

  /* --------------------------------------------------------------- results */

  const ROW_STATUS = {
    both: { label: 'both', kind: '', stripe: '' },
    ip_only: { label: 'IP only', kind: 'accent', stripe: 'stripe-binding' },
    fcfs_only: { label: 'FCFS only', kind: 'neg', stripe: 'stripe-neg' },
    neither: { label: 'neither', kind: '', stripe: '' },
  };

  function delta(value, better, digits) {
    if (value == null) return '-';
    const cls = better === 'up' ? (value > 1e-9 ? 'pos' : value < -1e-9 ? 'neg' : 'muted') : 'muted';
    return el('span', { class: `num ${cls}` }, fmt.signed(value, digits));
  }

  /** One plain sentence; the greedy gap leads because the gap over FCFS flatters. */
  function sentence(c, ip, fcfs, greedy, n) {
    const parts = ['Process ', el('b', {}, `${ip.n_accepted} of the ${n}`), ' shipments: value ', el('b', {}, fmt.num(ip.total_value, 1))];
    const pct = (v) => v == null ? '' : ` (${fmt.signed(v, 1)}%)`;
    if (greedy && c.greedy_value_delta != null) {
      parts.push(', which is ', el('b', {}, fmt.signed(c.greedy_value_delta, 1) + pct(c.greedy_value_percent_delta)),
        ' over the best greedy rule and ', fmt.signed(c.value_delta, 1), ' over first-come-first-served.');
    } else {
      parts.push(', which is ', el('b', {}, fmt.signed(c.value_delta, 1) + pct(c.value_percent_delta)), ' over first-come-first-served.');
    }
    return AC.headline(parts);
  }


  function renderResults() {
    AC.clear(resultsHost);
    const result = lastResult;
    if (!result) return;
    const ok = result.status === 'Optimal';
    const warnings = (result.warnings && result.warnings.length)
      ? AC.callout('warn', el('b', {}, 'Warnings'), el('ul', {}, result.warnings.map((w) => el('li', {}, w)))) : '';
    const modeBadge = result.two_stage ? AC.badge('Two-stage · fed by Part 1', 'accent') : AC.badge('Standalone');

    if (!ok || !result.comparison) {
      resultsHost.append(AC.panel('Result', [
        AC.headline('No selection: the solver returned ', el('b', {}, result.status), '.'),
        AC.callout('bad', result.message || 'No solution.',
          (result.suggestions && result.suggestions.length) ? el('ul', {}, result.suggestions.map((s) => el('li', {}, s))) : ''),
        warnings], modeBadge));
      return;
    }

    const c = result.comparison, ip = c.optimized, fcfs = c.baseline, greedy = c.greedy || null;
    const hasGreedy = !!greedy;
    const caps = result.capacities;
    const n = (result.shipments || []).length || ip.n_accepted;
    const gain = hasGreedy && c.greedy_value_delta != null ? c.greedy_value_delta : c.value_delta;
    const gainPct = hasGreedy && c.greedy_value_delta != null ? c.greedy_value_percent_delta : c.value_percent_delta;
    const setDiff = hasGreedy && c.greedy_set_difference != null ? c.greedy_set_difference : c.set_difference;

    const g = greedy || fcfs;
    const metricRows = [
      { label: 'Priority-weighted value', d: 2, f: fcfs.total_value, g: g.total_value, o: ip.total_value, better: 'up' },
      { label: 'Shipments processed', d: 0, f: fcfs.n_accepted, g: g.n_accepted, o: ip.n_accepted, better: 'up' },
      ...PRIORITIES.map((p) => ({ label: `${p} processed`, d: 0, better: 'up',
        f: (fcfs.priority_mix || {})[p] || 0, g: (g.priority_mix || {})[p] || 0, o: (ip.priority_mix || {})[p] || 0 })),
      { label: 'Volume used', d: 1, f: fcfs.volume_used, g: g.volume_used, o: ip.volume_used, better: 'neutral' },
      { label: 'Equipment-minutes used', d: 0, f: fcfs.equipment_minutes_used, g: g.equipment_minutes_used, o: ip.equipment_minutes_used, better: 'neutral' },
    ];
    const cols = [{ key: 'label', label: 'Metric' },
      { key: 'f', label: 'FCFS', align: 'r', render: (r) => fmt.num(r.f, r.d) }];
    if (hasGreedy) cols.push({ key: 'g', label: 'Best greedy', align: 'r', render: (r) => fmt.num(r.g, r.d) });
    cols.push({ key: 'o', label: 'Optimised', align: 'r', render: (r) => el('b', {}, fmt.num(r.o, r.d)) });
    if (hasGreedy) cols.push({ key: 'dg', label: 'vs greedy', align: 'r', render: (r) => delta(r.o - r.g, r.better, r.d) });
    cols.push({ key: 'df', label: 'vs FCFS', align: 'r', render: (r) => delta(r.o - r.f, r.better, r.d) });
    const candidates = Object.entries(c.greedy_candidates || {});

    resultsHost.append(AC.panel('Result', [
      sentence(c, ip, fcfs, greedy, n),
      el('div', { class: 'row hint', style: 'margin:0 0 16px' }, AC.badge(result.status, 'pos'),
        el('span', {}, result.objective_label || ''), el('span', { class: 'num' }, `${fmt.num(result.solve_seconds, 2)} s`)),
      warnings,
      AC.kpis(
        AC.kpi('Value-optimised', fmt.num(ip.total_value, 1), `${ip.n_accepted} shipments accepted`),
        AC.kpi(hasGreedy ? 'Gain vs best greedy' : 'Gain vs FCFS', fmt.signed(gain, 1), gainPct == null ? '' : `${fmt.signed(gainPct, 1)}%`),
        AC.kpi('FCFS', fmt.num(fcfs.total_value, 1), `${fcfs.n_accepted} accepted`, true),
        hasGreedy ? AC.kpi('Best greedy', fmt.num(greedy.total_value, 1), `${greedy.n_accepted} accepted` + (c.greedy_rule ? ` · ${c.greedy_rule.replace(/_/g, ' ')}` : ''), true) : '',
        AC.kpi('Different set', fmt.pct(setDiff * 100, 0), hasGreedy ? 'vs the greedy set' : 'vs the FCFS set', true)),
      AC.fold('Full comparison', [
        AC.table({ columns: cols, rows: metricRows }),
        candidates.length ? el('p', { class: 'hint', style: 'margin-top:8px' },
          el('b', {}, 'Greedy rules tried: '), candidates.map(([k, v]) => `${k} = ${fmt.num(v, 1)}`).join(' · '),
          c.greedy_rule ? ` (best: ${c.greedy_rule})` : '') : '',
        el('p', { class: 'hint' }, hasGreedy ? 'The gap over FCFS flatters; the gap over the best greedy rule is the one to defend, so it leads.'
          : 'No greedy baseline was returned; the comparison is against FCFS only.')]),
      (c.notes && c.notes.length) ? AC.fold('Notes on this comparison', c.notes.map((x) => el('p', { class: 'hint' }, x))) : '',
      result.duals_note ? el('p', { class: 'hint', style: 'margin-top:12px' }, result.duals_note) : '',
    ], modeBadge));

    // Priority mix + capacity utilisation
    const mixNode = el('div', { class: 'plot', role: 'img', 'aria-label': 'Shipments processed by priority class: optimised, FCFS and best greedy' });
    const mixOf = (s) => PRIORITIES.map((p) => (s.priority_mix || {})[p] || 0);
    const traces = [
      { type: 'bar', name: 'Optimised', x: PRIORITIES, y: mixOf(ip), marker: { color: AC.colors.lead }, hovertemplate: '%{x}: %{y}<extra>Optimised</extra>' },
      { type: 'bar', name: 'FCFS', x: PRIORITIES, y: mixOf(fcfs), marker: { color: AC.colors.other }, hovertemplate: '%{x}: %{y}<extra>FCFS</extra>' },
    ];
    if (hasGreedy) traces.push({ type: 'bar', name: 'Best greedy', x: PRIORITIES, y: mixOf(greedy), marker: { color: AC.colors.ink },
      hovertemplate: '%{x}: %{y}<extra>Best greedy</extra>' });
    const mixPanel = AC.panel('Priority mix', [
      el('p', { class: 'hint', style: 'margin:0 0 8px' }, 'Shipments processed per class. The optimiser has no rule favouring Critical; the value function prices it higher.'),
      mixNode]);

    const use = ip.capacity_use || [];
    const bindingKeys = new Set(result.binding_capacities || []);
    const isBinding = (u) => u.binding || bindingKeys.has(u.key);
    const util = (u) => u.utilization != null ? u.utilization : u.used / (u.available || 1);
    const capPanel = AC.panel('Capacity utilisation', [
      el('p', { class: 'hint', style: 'margin:0 0 12px' }, 'Which budget actually limits the window.'),
      use.map((u) => el('div', { class: 'control' },
        el('div', { class: 'top' },
          el('span', {}, u.label, ' ', isBinding(u) ? AC.badge('binding', 'accent') : ''),
          el('span', { class: 'value num' }, `${fmt.num(u.used, 0)} / ${fmt.num(u.available, 0)} ${u.unit} · ${fmt.pct(util(u) * 100, 0)}`)),
        AC.utilBar(util(u)))),
      el('p', { class: 'hint', style: 'margin:0' }, use.some(isBinding)
        ? 'Binding: no rejected shipment fits in what is left of that budget.'
        : 'Nothing binds - the whole batch fits. Lower the capacity fraction to make the selection a real decision.'),
    ]);
    resultsHost.append(el('div', { class: 'grid grid-2' }, mixPanel, capPanel));
    AC.plot(mixNode, traces, { barmode: 'group', bargap: 0.3, yaxis: { title: { text: 'shipments', font: { size: 11 } }, rangemode: 'tozero' } }, 260);

    resultsHost.append(decisionsPanel(result.shipments || []));

    // Worker-minute source
    const wmEntries = Object.entries((caps && caps.worker_minutes) || {});
    const lpBased = caps && caps.worker_minutes_source === 'lp_allocation';
    resultsHost.append(AC.fold('Worker-minute budget source', [
      AC.callout(lpBased ? 'good' : 'warn',
        el('b', {}, lpBased ? "Part 1's staff plan. " : 'Batch fraction (standalone). '),
        lpBased ? 'Each terminal\'s budget (constraint 2) is w_t* x H x 60, taken from your Part 1 solve.'
          : "Part 1's plan was not used; the batch's own consumption stands in, which is a weaker, self-referential claim. ",
        lpBased ? '' : el('a', { href: 'lp.html' }, 'Solve step 2 (Staff plan)')),
      wmEntries.length ? el('dl', { class: 'kv', style: 'max-width:320px' }, wmEntries.map(([t, v]) => [el('dt', {}, t), el('dd', { class: 'num' }, `${fmt.int(v)} min`)])) : '',
    ], { big: true, aside: lpBased ? 'Part 1' : 'standalone' }));
  }

  function decisionsPanel(shipments) {
    const decisionHost = el('div', {});
    const filterHost = el('div', { class: 'chips', style: 'margin-bottom:12px' });
    const isDisagree = (r) => r.status === 'ip_only' || r.status === 'fcfs_only';
    const tests = { all: () => true, accepted: (r) => r.accepted, rejected: (r) => !r.accepted, disagree: isDisagree };
    const draw = () => {
      AC.clear(filterHost); AC.clear(decisionHost);
      Object.keys(tests).forEach((k) => filterHost.append(
        el('button', { type: 'button', class: `chip ${decisionFilter === k ? 'on' : ''}`, 'aria-pressed': decisionFilter === k ? 'true' : 'false',
          onclick: () => { decisionFilter = k; draw(); } }, `${k} ${shipments.filter(tests[k]).length}`)));
      const matching = shipments.filter(tests[decisionFilter]);
      const rows = showAllDecisions ? matching : matching.slice(0, 12);
      decisionHost.append(rows.length ? AC.table({
        rows, rowClass: (r) => ROW_STATUS[r.status].stripe,
        columns: [
          { key: 'record_id', label: 'Record' },
          { key: 'terminal', label: 'Terminal' },
          { key: 'priority', label: 'Priority', render: (r) => AC.badge(r.priority, r.priority === 'Critical' ? 'neg' : r.priority === 'High' ? 'accent' : '') },
          { key: 'cargo_type', label: 'Cargo' },
          { key: 'value', label: 'value v', align: 'r', sym: true, render: (r) => r.accepted ? el('b', {}, fmt.num(r.value, 2)) : fmt.num(r.value, 2) },
          { key: 'volume', label: 'volume', align: 'r', render: (r) => fmt.num(r.volume, 1) },
          { key: 'worker_minutes', label: 'worker-min', align: 'r', render: (r) => fmt.num(r.worker_minutes, 0) },
          { key: 'equipment_minutes', label: 'machine-min', align: 'r', render: (r) => fmt.num(r.equipment_minutes, 0) },
          { key: 'accepted', label: 'Decision', render: (r) => el('span', { class: r.accepted ? 'pos' : 'faint' }, r.accepted ? 'PROCESS' : 'HOLD') },
          { key: 'status', label: 'vs FCFS', render: (r) => AC.badge(ROW_STATUS[r.status].label, ROW_STATUS[r.status].kind) },
        ],
      }) : el('div', { class: 'empty', style: 'padding:24px 16px;margin-bottom:0' }, 'No shipments match this filter'));
      if (matching.length > 12) decisionHost.append(el('div', { class: 'row', style: 'margin-top:12px' },
        el('button', { class: 'btn', type: 'button', onclick: () => { showAllDecisions = !showAllDecisions; draw(); } },
          showAllDecisions ? 'Show first 12' : `Show all ${matching.length}`)));
    };
    draw();
    return AC.panel('Shipment decisions', [
      filterHost,
      el('p', { class: 'hint', style: 'margin:0 0 8px' },
        'Clay stripe: the optimiser processes it and the queue does not. Red stripe: the queue takes it and the optimiser holds it. Those rows are where the optimisation happened.'),
      decisionHost]);
  }

  /* ----------------------------------------------------------------- start */

  buildControls();
  renderSolveBar();
  renderBatch(true);
  resultsHost.append(el('div', { class: 'empty', style: 'padding:32px 16px;margin-bottom:24px' }, el('b', {}, 'No solve yet'),
    'The candidate batch below is already scored. Press "Solve selection" to choose which shipments to process.'));
  loadVocab();
  loadBatch();
})();
