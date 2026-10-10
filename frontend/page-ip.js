/* Part 2 - IP shipment selection.  Plain JavaScript, uses the global AC.
 *
 * The batch and every value score are fetched and shown BEFORE anything is
 * optimised.  Solving happens only on an explicit click.  The worker-minute
 * budgets come from Part 1 (AC.handoff) when it has been solved, otherwise
 * Part 2 runs standalone and says so.
 */
(async function () {
  'use strict';
  const { el, fmt, api } = AC;
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

  main.append(
    el('div', { class: 'page-head' },
      el('div', { class: 'field-label' }, 'Part 2 · Integer programming'),
      el('h1', {}, 'Shipment selection under capacity'),
      el('p', {}, 'A 0-1 multi-dimensional knapsack over one planning window: which shipments get processed when ' +
        'volume, worker-minutes and equipment-minutes all run out. The worker-minute budget is indexed by terminal ' +
        'and comes from Part 1, so this page spends the allocation the other page chose.')));
  const caveatHolder = el('div', {}, AC.caveatBanner());
  main.append(caveatHolder);
  if (!dataset) return;

  /* ----------------------------------------------------------------- state */

  let controls = DEFAULTS();
  const handoff = AC.handoff.load(dataset.dataset_id);   // {workforce, objective} or null
  const lpWorkforce = handoff && handoff.workforce && Object.keys(handoff.workforce).length ? handoff.workforce : null;
  let vocab = null;
  let lastBatch = null;
  let solvedSignature = null;
  let batchToken = 0;
  let batchTimer = null;
  let showAllBatch = false;
  let decisionFilter = 'all';
  let lastResult = null;

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
  const batchHost = el('div', {});
  const solveBarHost = el('div', {});
  const resultsHost = el('div', {});
  main.append(el('div', { class: 'split' },
    el('div', { class: 'ip-sticky' }, controlsHost),
    el('div', { style: 'min-width:0' }, batchHost, solveBarHost, resultsHost)));

  /* --------------------------------------------------------- control widgets */

  function slider({ label, min, max, step, value, format, hint, onInput, disabled }) {
    const out = el('span', { class: 'num' }, format(value));
    const input = el('input', { type: 'range', min, max, step, value, 'aria-label': label });
    input.disabled = !!disabled;
    input.addEventListener('input', () => { const v = Number(input.value); out.textContent = format(v); onInput(v); });
    const node = el('div', { class: 'control' },
      el('div', { class: 'top' }, el('span', { class: 'field-label' }, label), out), input,
      hint ? el('div', { class: 'hint' }, hint) : '');
    node.setDisabled = (d) => { input.disabled = d; node.style.opacity = d ? '.5' : ''; };
    node.setDisabled(!!disabled);
    return node;
  }

  function toggle({ label, checked, hint, onChange }) {
    const input = el('input', { type: 'checkbox' });
    input.checked = checked;
    input.addEventListener('change', () => onChange(input.checked));
    return el('label', { class: 'check' }, input,
      el('span', {}, el('b', {}, label), hint ? el('div', { class: 'hint muted' }, hint) : ''));
  }

  function chips(label, options, selected, onChange, hint) {
    const sel = new Set(selected);
    const wrap = el('div', { class: 'chips' });
    options.forEach((o) => {
      const b = el('button', { type: 'button', class: `chip ${sel.has(o) ? 'on' : ''}`, 'aria-pressed': sel.has(o) ? 'true' : 'false' }, o);
      b.addEventListener('click', () => {
        if (sel.has(o)) sel.delete(o); else sel.add(o);
        b.classList.toggle('on', sel.has(o)); b.setAttribute('aria-pressed', sel.has(o) ? 'true' : 'false');
        onChange([...sel]);
      });
      wrap.append(b);
    });
    return el('div', { class: 'control' }, el('div', { class: 'top' }, el('span', { class: 'field-label' }, label)), wrap,
      el('div', { class: 'hint' }, sel.size ? '' : (hint || 'None selected = all included')));
  }

  const section = (title, ...kids) => el('div', { class: 'ip-section' }, el('h3', { class: 'ip-section-title' }, title), kids);

  /** Any control change: mark stale, and rebuild the batch preview once sliders settle. */
  function changed({ batch = true } = {}) {
    renderSolveBar();
    refreshStale();
    if (batch) {
      clearTimeout(batchTimer);
      batchTimer = setTimeout(loadBatch, 300);
    }
  }

  function buildControls() {
    const c = controls;
    AC.clear(controlsHost);
    const vocabNodes = !vocab
      ? el('p', { class: 'muted' }, 'Loading filter options...')
      : [
        chips('Terminals', vocab.terminals, c.filters.terminals, (v) => { c.filters.terminals = v; changed(); }, 'All terminals included'),
        chips('Cargo type', vocab.cargo_types, c.filters.cargo_types, (v) => { c.filters.cargo_types = v; changed(); }),
        chips('Priority', vocab.priorities, c.filters.priorities, (v) => { c.filters.priorities = v; changed(); }),
        chips('Weather', vocab.weather, c.filters.weather, (v) => { c.filters.weather = v; changed(); }),
      ];
    const peak = el('select', { 'aria-label': 'Peak hour' },
      el('option', { value: '' }, 'Any hour'), el('option', { value: '1' }, 'Peak hours only'), el('option', { value: '0' }, 'Off-peak only'));
    peak.value = c.filters.peak_hour == null ? '' : String(c.filters.peak_hour);
    peak.addEventListener('change', () => { c.filters.peak_hour = peak.value === '' ? null : Number(peak.value); changed(); });
    const seed = el('input', { type: 'number', min: 0, step: 1, value: c.seed, 'aria-label': 'Sampling seed' });
    seed.addEventListener('change', () => {
      const v = Math.max(0, Math.floor(Number(seed.value) || 0)); seed.value = v; c.seed = v; changed();
    });

    const hazard = slider({ label: 'Max Hazardous', min: 0, max: 30, step: 1, value: c.max_hazardous, format: (v) => fmt.num(v, 0),
      disabled: !c.hazardous_enabled, onInput: (v) => { c.max_hazardous = v; changed({ batch: false }); } });
    const perish = slider({ label: 'Min Perishable', min: 0, max: 30, step: 1, value: c.min_perishable, format: (v) => fmt.num(v, 0),
      disabled: !c.perishable_enabled, onInput: (v) => { c.min_perishable = v; changed({ batch: false }); } });

    const lpBox = el('div', {});
    const renderLpBox = () => {
      AC.clear(lpBox);
      if (!lpWorkforce) {
        lpBox.append(AC.callout('warn', el('b', {}, 'Running standalone. '),
          'Part 1 has not been solved for this dataset, so the worker-minute budget is derived from the very batch it constrains. ',
          el('a', { href: 'lp.html' }, 'Solve Part 1 first (lp.html)'), ' to couple the two models.'));
        return;
      }
      lpBox.append(toggle({
        label: "Use Part 1's workforce allocation", checked: c.use_lp,
        hint: "On, constraint (2)'s right-hand side is w_t* x H x 60 per terminal. Off, the batch's own consumption stands in - a weaker, self-referential claim.",
        onChange: (v) => { c.use_lp = v; renderLpBox(); changed({ batch: false }); },
      }));
      if (c.use_lp) {
        const label = handoff.objective && (typeof handoff.objective === 'string' ? handoff.objective
          : handoff.objective.label || handoff.objective.objective_label);
        lpBox.append(
          el('div', { class: 'field-label' }, 'Part 1 allocation w*'),
          el('p', { class: 'muted', style: 'font-size:12px;margin-top:4px' },
            'From your Part 1 solve', label ? [' - ', el('em', {}, label)] : '', '. Re-solve Part 1 to change these budgets.'),
          el('dl', { class: 'kv' }, Object.entries(lpWorkforce).map(([t, w]) => [
            el('dt', {}, t), el('dd', { class: 'num' }, `${fmt.num(w, 1)} workers → ${fmt.int(w * SHIFT_MINUTES)} min`)])));
      } else {
        lpBox.append(AC.callout('warn', el('b', {}, 'Standalone mode. '),
          'Part 1 results exist but are switched off; the worker budget is derived from the batch it constrains.'));
      }
    };
    renderLpBox();

    controlsHost.append(AC.panel('Batch', [
      el('p', { class: 'muted', style: 'font-size:12px' }, 'Filters pick the candidate set; weights decide what it is worth.'),
      section('Slice',
        vocabNodes,
        el('div', { class: 'control' }, el('div', { class: 'top' }, el('span', { class: 'field-label' }, 'Peak hour')), peak),
        slider({ label: 'Batch size', min: 10, max: 200, step: 5, value: c.size, format: (v) => `${v} shipments`,
          hint: 'CBC handles all 5,000 binaries; 30-100 keeps the table readable.',
          onInput: (v) => { c.size = v; changed(); } }),
        el('div', { class: 'control' }, el('div', { class: 'top' }, el('span', { class: 'field-label' }, 'Seed')), seed,
          el('div', { class: 'hint' }, 'Sampling seed, so a batch preview and its solve match.'))),
      section('Value',
        el('p', { class: 'muted', style: 'font-size:12px' },
          'Priority is lexicographic and urgency is only a tiebreaker, so keep adjacent classes more than 1.9x apart - below that an urgent shipment can outrank the class above it.'),
        el('div', { class: 'field-label' }, 'Priority weights p'),
        PRIORITIES.map((p) => slider({ label: p, min: 1, max: 20, step: 1, value: c.priority_weights[p], format: (v) => fmt.num(v, 0),
          onInput: (v) => { c.priority_weights[p] = v; changed(); } })),
        slider({ label: 'lambda_w - waiting time', min: 0, max: 1, step: 0.1, value: c.lambda_waiting, format: (v) => v.toFixed(1),
          hint: 'Balance, not size: the uplift is capped at U = 0.9 whatever the lambda.',
          onInput: (v) => { c.lambda_waiting = v; changed(); } }),
        slider({ label: 'lambda_q - queue length', min: 0, max: 1, step: 0.1, value: c.lambda_queue, format: (v) => v.toFixed(1),
          onInput: (v) => { c.lambda_queue = v; changed(); } })),
      section('Capacity',
        slider({ label: 'Capacity fraction f', min: 0.1, max: 1, step: 0.05, value: c.capacity_fraction, format: (v) => `${(v * 100).toFixed(0)}%`,
          hint: 'Volume and equipment-minutes as a share of the batch totals. Lower f binds harder; at 100% everything fits and there is nothing to choose.',
          onInput: (v) => { c.capacity_fraction = v; changed(); } }),
        lpBox),
      section('Policy',
        toggle({ label: 'Force all Critical in', checked: c.force_critical,
          hint: 'Pins x_i = 1 for every Critical shipment. If they do not fit on their own the run is caught before CBC sees it, with advice instead of a bare Infeasible.',
          onChange: (v) => { c.force_critical = v; changed({ batch: false }); } }),
        toggle({ label: 'Cap Hazardous count', checked: c.hazardous_enabled,
          onChange: (v) => { c.hazardous_enabled = v; hazard.setDisabled(!v); changed({ batch: false }); } }),
        hazard,
        toggle({ label: 'Require Perishables', checked: c.perishable_enabled,
          onChange: (v) => { c.perishable_enabled = v; perish.setDisabled(!v); changed({ batch: false }); } }),
        perish),
      el('button', { class: 'btn btn-block', type: 'button', onclick: () => {
        controls = DEFAULTS(); buildControls(); changed();
      } }, 'Reset all controls'),
    ]));
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
    buildControls();
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
    const wrapTitle = 'Candidate batch';
    if (lastBatch && lastBatch.error) {
      batchHost.append(AC.callout('bad', el('b', {}, 'Could not build the batch. '), lastBatch.error.message));
      return;
    }
    if (!lastBatch || !lastBatch.data) {
      batchHost.append(AC.panel(wrapTitle, el('p', { class: 'muted' }, AC.spinner('Scoring shipments...'))));
      return;
    }
    const b = lastBatch.data, t = b.totals, caps = b.capacities;
    const rows = showAllBatch ? b.shipments : b.shipments.slice(0, 10);
    const toggleBtn = el('button', { class: 'btn', type: 'button', onclick: () => { showAllBatch = !showAllBatch; renderBatch(false); } },
      showAllBatch ? 'Show first 10' : `Show all ${t.n_shipments}`);
    const wm = caps.worker_minutes || {};
    const body = [
      el('div', { class: 'grid grid-3', style: 'margin-bottom:12px' }, [
        AC.kpi('Shipments', fmt.int(t.n_shipments)),
        AC.kpi('Total value', fmt.num(t.total_value, 1)),
        AC.kpi('Volume V_cap', `${fmt.num(caps.volume, 0)} / ${fmt.num(t.total_volume, 0)}`),
        AC.kpi('Equipment-min E_cap', `${fmt.num(caps.equipment_minutes, 0)} / ${fmt.num(t.total_equipment_minutes, 0)}`),
        AC.kpi('Worker-minutes source', sourceLabel(caps.worker_minutes_source),
          Object.entries(wm).map(([k, v]) => `${k} ${fmt.int(v)}`).join(' · ')),
        AC.kpi('Capacity fraction f', fmt.pct(caps.fraction * 100, 0)),
      ]),
      el('div', { class: 'callout' },
        el('div', { class: 'field-label' }, 'Value function'),
        el('code', { class: 'num', style: 'display:block;overflow-x:auto;margin:4px 0' }, b.value_formula),
        el('div', { class: 'muted', style: 'font-size:12px' }, b.note)),
      (b.warnings && b.warnings.length) ? AC.callout('warn', el('b', {}, 'Priority weights'),
        el('ul', {}, b.warnings.map((w) => el('li', {}, w)))) : '',
      el('div', { style: loading ? 'opacity:.6' : '' }, AC.table({
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
    ];
    batchHost.append(AC.panel(wrapTitle, body, el('span', { class: 'row' }, loading ? AC.spinner('updating') : '', toggleBtn)));
  }

  const sourceLabel = (s) => s === 'lp_allocation' ? "Part 1's allocation" : 'batch fraction (standalone)';

  /* ----------------------------------------------------------------- solve */

  let solving = false;
  let solveError = null;

  function renderSolveBar() {
    AC.clear(solveBarHost);
    const btn = el('button', { class: 'btn btn-primary', type: 'button', onclick: runSolve },
      solving ? AC.spinner('Solving...') : 'Solve selection');
    btn.disabled = solving || !(lastBatch && lastBatch.data);
    const where = coupled() ? 'Two-stage: worker-minutes come from Part 1.' : 'Standalone: worker-minutes derived from the batch.';
    solveBarHost.append(AC.panel('Solve', [
      el('div', { class: 'row' }, btn, el('span', { class: 'muted', style: 'font-size:12px' },
        'Runs CBC once and compares the optimal set against FCFS and the best greedy rule under identical capacities. ', where)),
      solveError ? AC.callout('bad', el('b', {}, 'Solve failed. '), solveError.message) : '',
    ]));
  }

  const staleHost = el('div', {});
  function refreshStale() {
    AC.clear(staleHost);
    if (solvedSignature && solvedSignature !== JSON.stringify(solvePayload())) {
      staleHost.append(AC.callout('warn', el('b', {}, 'Controls changed since this solve. '),
        'The results below were produced with the previous settings. ',
        el('button', { class: 'btn', type: 'button', onclick: runSolve }, 'Re-solve with current settings')));
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

  function statusBlock(result, withSeconds) {
    const ok = result.status === 'Optimal';
    return el('div', { class: `callout ${ok ? 'good' : 'bad'}` },
      el('div', { class: 'row' }, AC.badge(result.status, ok ? 'pos' : 'neg'),
        el('b', {}, result.message || (ok ? 'Optimal solution found.' : 'No solution.')),
        withSeconds ? el('span', { class: 'muted num' }, `${fmt.num(result.solve_seconds, 2)} s`) : ''),
      (result.suggestions && result.suggestions.length) ? [
        el('div', { class: 'field-label', style: 'margin-top:8px' }, 'Suggestions'),
        el('ul', {}, result.suggestions.map((s) => el('li', {}, s)))] : '');
  }

  function delta(value, better, digits) {
    if (value == null) return '-';
    const cls = better === 'up' ? (value > 1e-9 ? 'pos' : value < -1e-9 ? 'neg' : 'muted') : 'muted';
    return el('span', { class: `num ${cls}` }, fmt.signed(value, digits));
  }

  function renderResults() {
    AC.clear(resultsHost);
    const result = lastResult;
    if (!result) return;
    resultsHost.append(staleHost);
    refreshStale();

    const warnings = (result.warnings && result.warnings.length)
      ? AC.callout('warn', el('b', {}, 'Warnings'), el('ul', {}, result.warnings.map((w) => el('li', {}, w)))) : '';

    if (result.status !== 'Optimal' || !result.comparison) {
      resultsHost.append(AC.panel('Result', [statusBlock(result, true), warnings]));
      return;
    }

    const c = result.comparison, ip = c.optimized, fcfs = c.baseline, greedy = c.greedy || null;
    const hasGreedy = !!greedy;
    const caps = result.capacities;
    const gain = hasGreedy && c.greedy_value_delta != null ? c.greedy_value_delta : c.value_delta;
    const gainHint = (hasGreedy && c.greedy_value_percent_delta != null)
      ? `${fmt.pct(c.greedy_value_percent_delta)} over best greedy` +
        (c.value_percent_delta == null ? '' : ` · ${fmt.pct(c.value_percent_delta)} over FCFS`)
      : `${c.value_percent_delta == null ? '' : fmt.pct(c.value_percent_delta) + ' over FCFS'}`;
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

    // Outcome
    resultsHost.append(AC.panel('Outcome', [
      el('div', { class: 'muted', style: 'margin-bottom:8px' }, result.objective_label),
      statusBlock(result, true),
      warnings,
      el('div', { class: 'grid grid-4', style: 'margin:12px 0' }, [
        AC.kpi('Value - FCFS', fmt.num(fcfs.total_value, 1), `${fcfs.n_accepted} shipments accepted`),
        hasGreedy ? AC.kpi('Value - best greedy', fmt.num(greedy.total_value, 1), `${greedy.n_accepted} accepted` + (c.greedy_rule ? ` · rule: ${c.greedy_rule}` : '')) : '',
        AC.kpi('Value - optimised', fmt.num(ip.total_value, 1), `${ip.n_accepted} shipments accepted`),
        AC.kpi('Value gained', fmt.signed(gain, 1), gainHint),
        AC.kpi('Different set', fmt.pct(setDiff * 100, 0), hasGreedy ? 'of the greedy and optimal sets disagree' : 'of the FCFS and optimal sets disagree'),
        AC.kpi('Accepted vs FCFS', fmt.signed(c.accepted_delta, 0), 'shipments'),
      ]),
      el('p', { class: 'muted', style: 'font-size:12px' },
        hasGreedy ? 'The gap over FCFS flatters; the gap over the best value-density greedy rule is the one to defend, so it leads.'
          : 'No greedy baseline was returned; the comparison is against FCFS only.'),
      AC.table({ columns: cols, rows: metricRows }),
      candidates.length ? el('p', { class: 'muted', style: 'font-size:12px;margin-top:8px' },
        el('b', {}, 'Greedy rules tried: '), candidates.map(([k, v]) => `${k} = ${fmt.num(v, 1)}`).join(' · '),
        c.greedy_rule ? ` (best: ${c.greedy_rule})` : '') : '',
      (c.notes || []).map((n) => AC.callout('', n)),
      el('p', { class: 'muted', style: 'font-size:12px' }, result.duals_note),
    ], result.two_stage ? AC.badge('Two-stage · fed by Part 1', 'accent') : AC.badge('Standalone')));

    // Worker-minute source
    const wmEntries = Object.entries((caps && caps.worker_minutes) || {});
    const lpBased = caps && caps.worker_minutes_source === 'lp_allocation';
    resultsHost.append(AC.panel('Worker-minute budget source', [
      AC.callout(lpBased ? 'good' : 'warn',
        el('b', {}, lpBased ? "Part 1's allocation. " : 'Batch fraction (standalone). '),
        lpBased ? 'Constraint (2) right-hand side is w_t* x H x 60 per terminal, taken from your Part 1 solve.'
          : "Part 1's allocation was not used; the batch's own consumption stands in, which is a weaker, self-referential claim. ",
        lpBased ? '' : el('a', { href: 'lp.html' }, 'Solve Part 1')),
      wmEntries.length ? el('dl', { class: 'kv' }, wmEntries.map(([t, v]) => [el('dt', {}, t), el('dd', { class: 'num' }, `${fmt.int(v)} min`)])) : '',
    ]));

    // Priority mix + capacity utilisation
    const mixNode = el('div', { class: 'plot', role: 'img', 'aria-label': 'Shipments processed by priority class, FCFS versus optimised' });
    const traces = [
      { type: 'bar', name: 'Optimised', x: PRIORITIES, y: PRIORITIES.map((p) => (ip.priority_mix || {})[p] || 0), offsetgroup: 2,
        hovertemplate: '%{x}: %{y} shipments<extra>Optimised</extra>' },
      { type: 'bar', name: 'FCFS', x: PRIORITIES, y: PRIORITIES.map((p) => (fcfs.priority_mix || {})[p] || 0), offsetgroup: 1,
        hovertemplate: '%{x}: %{y} shipments<extra>FCFS</extra>' },
    ];
    if (hasGreedy) traces.push({ type: 'bar', name: 'Best greedy', x: PRIORITIES, y: PRIORITIES.map((p) => (greedy.priority_mix || {})[p] || 0),
      offsetgroup: 3, hovertemplate: '%{x}: %{y} shipments<extra>Best greedy</extra>' });
    const mixPanel = AC.panel('Priority mix of the processed set', [
      el('p', { class: 'muted', style: 'font-size:12px' }, 'Value is priority-weighted, so the optimiser should lean Critical. All bars come from the same batch under the same capacities; the optimiser has no rule preferring Critical cargo - the value function prices it higher.'),
      mixNode]);

    const use = ip.capacity_use || [];
    const bindingKeys = new Set(result.binding_capacities || []);
    const isBinding = (u) => u.binding || bindingKeys.has(u.key);
    const capPanel = AC.panel('Capacity utilisation', [
      el('p', { class: 'muted', style: 'font-size:12px' }, 'Which of the dimensions actually limits the window.'),
      use.map((u) => el('div', { class: 'control' },
        el('div', { class: 'top' },
          el('span', {}, u.label, ' ', isBinding(u) ? AC.badge('binding', 'accent') : ''),
          el('span', { class: 'num' }, `${fmt.num(u.used, 0)} / ${fmt.num(u.available, 0)} ${u.unit} · ${fmt.pct((u.utilization != null ? u.utilization : u.used / (u.available || 1)) * 100, 0)}`)),
        AC.utilBar(u.utilization != null ? u.utilization : u.used / (u.available || 1)))),
      el('div', { class: 'field-label', style: 'margin-top:12px' }, 'Binding'),
      use.some(isBinding)
        ? el('ul', {}, use.filter(isBinding).map((u) => el('li', {}, el('span', { class: 'num' }, u.label),
          ' - no rejected shipment fits in the ', el('span', { class: 'num' }, fmt.num(u.available - u.used, 0)), ` ${u.unit} left.`)))
        : el('p', { class: 'muted' }, 'Nothing binds - the whole batch fits. Lower the capacity fraction to make the selection a real decision.'),
    ]);
    resultsHost.append(el('div', { class: 'grid grid-2' }, mixPanel, capPanel));
    AC.plot(mixNode, traces, { barmode: 'group', bargap: 0.35, yaxis: { title: { text: 'shipments', font: { size: 11 } }, rangemode: 'tozero' } }, 280);

    // Decisions
    const decisionHost = el('div', {});
    const filterHost = el('span', { class: 'row' });
    const shipments = result.shipments || [];
    const isDisagree = (r) => r.status === 'ip_only' || r.status === 'fcfs_only';
    const counts = { all: shipments.length, accepted: shipments.filter((r) => r.accepted).length,
      rejected: shipments.filter((r) => !r.accepted).length, disagree: shipments.filter(isDisagree).length };
    const drawDecisions = () => {
      AC.clear(filterHost); AC.clear(decisionHost);
      ['all', 'accepted', 'rejected', 'disagree'].forEach((k) => filterHost.append(
        el('button', { type: 'button', class: `chip ${decisionFilter === k ? 'on' : ''}`, onclick: () => { decisionFilter = k; drawDecisions(); } },
          `${k} ${counts[k]}`)));
      const rows = shipments.filter((r) => decisionFilter === 'accepted' ? r.accepted : decisionFilter === 'rejected' ? !r.accepted
        : decisionFilter === 'disagree' ? isDisagree(r) : true);
      decisionHost.append(rows.length ? AC.table({
        rows, rowClass: (r) => ROW_STATUS[r.status].stripe,
        columns: [
          { key: 'record_id', label: 'Record' },
          { key: 'terminal', label: 'Terminal' },
          { key: 'priority', label: 'Priority', render: (r) => AC.badge(r.priority, r.priority === 'Critical' ? 'neg' : r.priority === 'High' ? 'accent' : '') },
          { key: 'cargo_type', label: 'Cargo' },
          { key: 'value', label: 'value v', align: 'r', sym: true, render: (r) => r.accepted ? el('b', {}, fmt.num(r.value, 2)) : fmt.num(r.value, 2) },
          { key: 'urgency_uplift', label: 'urgency', align: 'r', render: (r) => `+${fmt.num(r.urgency_uplift, 2)}` },
          { key: 'volume', label: 'volume', align: 'r', render: (r) => fmt.num(r.volume, 1) },
          { key: 'worker_minutes', label: 'worker-min', align: 'r', render: (r) => fmt.num(r.worker_minutes, 0) },
          { key: 'equipment_minutes', label: 'machine-min', align: 'r', render: (r) => fmt.num(r.equipment_minutes, 0) },
          { key: 'accepted', label: 'Decision', render: (r) => el('span', { class: r.accepted ? 'pos' : 'faint' }, r.accepted ? 'PROCESS' : 'HOLD') },
          { key: 'fcfs_accepted', label: 'FCFS', render: (r) => r.fcfs_accepted ? 'takes' : 'holds' },
          { key: 'status', label: 'vs FCFS', render: (r) => AC.badge(ROW_STATUS[r.status].label, ROW_STATUS[r.status].kind) },
        ],
      }) : el('div', { class: 'empty' }, 'No shipments match this filter'));
    };
    drawDecisions();
    resultsHost.append(AC.panel('Shipment decisions', [
      el('p', { class: 'muted', style: 'font-size:12px' },
        'An amber stripe marks a shipment the optimiser processes and the queue does not; a red stripe marks one the queue takes and the optimiser holds back. Those rows are where the optimisation actually happened.'),
      decisionHost], filterHost));
  }

  /* ----------------------------------------------------------------- start */

  buildControls();
  renderSolveBar();
  renderBatch(true);
  resultsHost.append(el('div', { class: 'empty' }, 'No solve yet. The batch above is already scored; press "Solve selection" to run CBC.'));
  loadVocab();
  loadBatch();
})();
