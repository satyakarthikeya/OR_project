/* Home: load the dataset (bundled or uploaded), show its facts, explain the app. */
(function () {
  'use strict';
  const { el, fmt, api } = AC;

  const PARTS = [
    { tag: 'Part 1', title: 'Linear programming: workforce & equipment allocation',
      question: 'Given a limited pool of workers and equipment, where should we put them?',
      points: ['Continuous decision variables per terminal, solved with CBC',
               'Two objectives: maximise throughput, or minimise cost subject to demand',
               'Soft demand constraints, shadow prices, and a resource-pool sweep'],
      href: 'lp.html', label: 'Open Part 1' },
    { tag: 'Part 2', title: 'Integer programming: cargo processing selection',
      question: 'If we cannot process everything now, what goes first?',
      points: ['0-1 multi-dimensional knapsack over a batch of shipments',
               'Priority-weighted value with waiting-time and queue urgency terms',
               'Compared against a greedy first-come-first-served baseline'],
      href: 'ip.html', label: 'Open Part 2' },
  ];

  let current = null;
  let busy = null;      // 'bundled' | 'upload' | null
  let problem = null;   // {title, items[]}

  const dsPanel = AC.$('#dataset-panel');
  const servicePanel = AC.$('#service-panel');

  function refreshHeader() {
    const old = AC.$('.site-header');
    if (old) old.remove();
    return AC.shell('home', { needsDataset: false });
  }

  function kv(items) {
    return el('dl', { class: 'kv' }, items.map(([k, v]) => [el('dt', {}, k), el('dd', { class: 'num' }, v)]));
  }

  function errorBox() {
    if (!problem) return '';
    return AC.callout('bad', el('strong', {}, problem.title),
      problem.items.length ? el('ul', {}, problem.items.map((i) => el('li', {}, i))) : '');
  }

  function renderDataset() {
    let body;
    if (current) {
      body = el('div', {},
        el('div', { class: 'row' }, AC.badge('Loaded', 'pos'), el('strong', {}, current.name)),
        el('div', { style: 'margin-top:14px' }, kv([
          ['Records', fmt.int(current.n_rows)],
          ['Columns after cleaning', fmt.int(current.n_columns)],
          ['Dataset ID', current.dataset_id],
          ['Loaded at', new Date(current.uploaded_at).toLocaleString()],
        ])),
        (current.warnings && current.warnings.length)
          ? el('div', { style: 'margin-top:14px' }, AC.callout('warn', el('strong', {}, 'Validation warnings'),
              el('ul', {}, current.warnings.map((w) => el('li', {}, w))))) : '',
        el('div', { class: 'row', style: 'margin-top:14px' },
          el('a', { class: 'btn btn-primary', href: 'explorer.html' }, 'Explore the data'),
          el('a', { class: 'btn', href: 'lp.html' }, 'Go to Part 1: LP'),
          el('a', { class: 'btn', href: 'ip.html' }, 'Go to Part 2: IP'),
          el('button', { class: 'btn', type: 'button', onclick: replaceDataset }, 'Load a different dataset')));
    } else {
      body = el('div', {},
        el('div', { class: 'row' },
          el('button', { class: 'btn btn-primary', type: 'button', disabled: busy !== null, onclick: loadBundled },
            busy === 'bundled' ? AC.spinner('Loading...') : 'Load bundled dataset'),
          el('label', { class: 'btn file-btn' },
            busy === 'upload' ? AC.spinner('Validating...') : 'Upload a CSV',
            el('input', { type: 'file', accept: '.csv', disabled: busy !== null, onchange: upload }))),
        el('p', { class: 'muted', style: 'margin-top:12px' },
          'Uploads are validated against the expected schema before they are accepted: missing columns are rejected outright, ' +
          'unexpected categories and duplicate rows come back as warnings. Nothing is written to disk; the frame lives in an ' +
          'in-memory registry for the lifetime of the server process.'),
        errorBox());
    }
    AC.clear(dsPanel).append(AC.panel('Dataset',
      el('div', {}, el('p', { class: 'muted' }, 'Use the bundled Kaggle extract, or upload a CSV with the same 28 columns.'), body)));
  }

  function renderParts() {
    const host = AC.clear(AC.$('#parts'));
    PARTS.forEach((p) => host.append(AC.panel(p.tag, el('div', {},
      AC.badge(p.tag, 'accent'),
      el('h3', { style: 'margin-top:10px;font-size:15px' }, p.title),
      el('p', { class: 'muted', style: 'font-style:italic;margin-top:4px' }, p.question),
      el('ul', { class: 'ticks' }, p.points.map((t) => el('li', {}, t))),
      el('div', { style: 'margin-top:14px' }, current
        ? el('a', { class: 'btn btn-primary', href: p.href }, p.label)
        : el('button', { class: 'btn', type: 'button', disabled: true }, 'Load a dataset first'))))));
  }

  function renderAll() { renderDataset(); renderParts(); }

  function replaceDataset() {
    current = null; problem = null; AC.dataset.clear();
    renderAll(); refreshHeader();
  }

  async function adopt(record) {
    current = record;
    AC.dataset.set(record);
    renderAll();
    await refreshHeader();
    loadHealth();
  }

  async function loadBundled() {
    busy = 'bundled'; problem = null; renderDataset();
    try {
      const record = await api.loadBundled();
      busy = null; await adopt(record);
    } catch (e) { busy = null; problem = { title: e.message, items: [] }; renderDataset(); }
  }

  async function upload(event) {
    const file = event.target.files && event.target.files[0];
    event.target.value = '';
    if (!file) return;
    busy = 'upload'; problem = null; renderDataset();
    let response;
    try {
      const form = new FormData(); form.append('file', file);
      response = await fetch('/api/datasets', { method: 'POST', body: form });
    } catch (e) {
      busy = null; problem = { title: 'Cannot reach the server. Is it still running?', items: [] };
      renderDataset(); return;
    }
    let payload = null;
    try { payload = await response.json(); } catch (e) { payload = null; }
    busy = null;
    if (response.ok) { await adopt(payload); return; }
    const detail = payload && payload.detail;
    if (response.status === 422 && detail && Array.isArray(detail.errors)) {
      problem = { title: `"${file.name}" failed schema validation and was not loaded:`, items: detail.errors };
    } else if (typeof detail === 'string') {
      problem = { title: detail, items: [] };
    } else if (Array.isArray(detail)) {
      problem = { title: 'The upload was rejected:', items: detail.map((d) => d.msg) };
    } else {
      problem = { title: `Request failed with status ${response.status}`, items: [] };
    }
    renderDataset();
  }

  function statusRow(label, ok, value) {
    return el('div', { class: 'row', style: 'justify-content:space-between;margin-bottom:8px' },
      el('span', {}, label),
      el('span', {}, el('span', { class: `status-dot ${ok ? '' : 'bad'}` }), el('strong', {}, value)));
  }

  async function loadHealth() {
    AC.clear(servicePanel).append(AC.panel('Service', AC.spinner('Checking...')));
    try {
      const h = await api.health();
      AC.clear(servicePanel).append(AC.panel('Service', el('div', {},
        el('p', { class: 'muted' }, 'Backend and solver availability.'),
        statusRow('API', h.status === 'ok', h.status),
        statusRow('Solver', h.solver_available, h.solver_name),
        el('div', { class: 'row', style: 'justify-content:space-between;margin-bottom:8px' },
          el('span', {}, 'Datasets in memory'), el('strong', { class: 'num' }, h.datasets_loaded)),
        el('a', { href: '/docs', target: '_blank', rel: 'noreferrer' }, 'Interactive API docs'))));
    } catch (e) {
      AC.clear(servicePanel).append(AC.panel('Service', AC.callout('bad', e.message, ' ',
        el('button', { class: 'btn', type: 'button', onclick: loadHealth }, 'Retry'))));
    }
  }

  async function init() {
    AC.$('#caveat').append(AC.caveatBanner());
    current = await AC.shell('home', { needsDataset: false });
    renderAll();
    loadHealth();
  }
  init();
})();
