/* Shared helpers for every page.  Plain JavaScript, no framework, no build step.
 *
 * Exposes one global, `AC`:
 *   AC.api      one wrapper per endpoint (the Pydantic schemas are the contract)
 *   AC.el       tiny DOM builder:  AC.el('div', {class: 'x'}, 'text', child)
 *   AC.fmt      number formatting
 *   AC.table    build a data table
 *   AC.plot     draw a Plotly chart; AC.colors is the one place chart colours live
 *   AC.fold     collapsible section;  AC.kpis  a row of headline numbers
 *   AC.ui       control widgets (slider, toggle, segmented, chips, numberInput, group)
 *   AC.workbench  settings panel + results layout;  AC.pageHead, AC.headline
 *   AC.shell    header with the 1-2-3 step guide, and the dataset check
 *   AC.dataset  the loaded dataset id (kept in sessionStorage, re-verified)
 *   AC.handoff  Part 1's solved workforce, passed on to Part 2
 */
(function () {
  'use strict';

  /* ------------------------------------------------------------------ API */

  class ApiError extends Error {
    constructor(message, status) { super(message); this.status = status; }
  }

  function describe(status, payload) {
    const detail = payload && payload.detail;
    if (typeof detail === 'string') return detail;
    if (Array.isArray(detail)) {
      return detail.map((d) => `${(d.loc || []).slice(1).join('.') || 'input'}: ${d.msg}`).join('; ');
    }
    if (detail && detail.errors) return detail.errors.join('; ');
    return `Request failed with status ${status}`;
  }

  async function request(path, options) {
    let response;
    try { response = await fetch(path, options); }
    catch (e) { throw new ApiError('Cannot reach the server. Is it still running?', 0); }
    const text = await response.text();
    let payload = null;
    try { payload = text ? JSON.parse(text) : null; } catch (e) { payload = null; }
    if (!response.ok) throw new ApiError(describe(response.status, payload), response.status);
    return payload;
  }

  const get = (path) => request(path, { method: 'GET' });
  const post = (path, body) => request(path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });

  const api = {
    health: () => get('/api/health'),
    listDatasets: () => get('/api/datasets'),
    loadBundled: () => post('/api/datasets/bundled', {}),
    upload: (file) => { const f = new FormData(); f.append('file', file);
                        return request('/api/datasets', { method: 'POST', body: f }); },
    summary: (id) => get(`/api/datasets/${id}/summary`),
    lpParameters: (b) => post('/api/lp/parameters', b),
    lpSolve: (b) => post('/api/lp/solve', b),
    lpSensitivity: (b) => post('/api/lp/sensitivity', b),
    ipBatch: (b) => post('/api/ip/batch', b),
    ipSolve: (b) => post('/api/ip/solve', b),
  };

  /* ------------------------------------------------------------------ DOM */

  /** el('div', {class:'a', onclick: fn}, 'text', childNode, [more children]) */
  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (value === false || value == null) continue;
      if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
      else if (key === 'html') node.innerHTML = value;
      else node.setAttribute(key, value === true ? '' : value);
    }
    const add = (c) => {
      if (Array.isArray(c)) c.forEach(add);
      else if (c != null && c !== false) node.append(c.nodeType ? c : document.createTextNode(String(c)));
    };
    children.forEach(add);
    return node;
  }

  const $ = (selector, root) => (root || document).querySelector(selector);
  const clear = (node) => { while (node.firstChild) node.removeChild(node.firstChild); return node; };

  /* ----------------------------------------------------------- formatting */

  const fmt = {
    num: (v, d = 2) => (v == null || Number.isNaN(v)) ? '-'
      : Number(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }),
    int: (v) => fmt.num(v, 0),
    pct: (v, d = 1) => (v == null) ? '-' : `${fmt.num(v, d)}%`,
    signed: (v, d = 2) => (v == null) ? '-' : `${v > 0 ? '+' : ''}${fmt.num(v, d)}`,
  };

  /* ---------------------------------------------------------------- table */

  /**
   * table({columns: [{key, label, align:'r', sym:true, render(row)}], rows, rowClass(row)})
   * `sym` marks symbol headers (alpha, beta...) so CSS does not upper-case them.
   */
  function table({ columns, rows, rowClass }) {
    const head = el('tr', {}, columns.map((c) =>
      el('th', { class: `${c.align === 'r' ? 'r' : ''} ${c.sym ? 'sym' : ''}` }, c.label)));
    const body = rows.map((row) => el('tr', { class: rowClass ? rowClass(row) : '' },
      columns.map((c) => el('td', { class: `${c.align === 'r' ? 'r num' : ''}` },
        c.render ? c.render(row) : (row[c.key] == null ? '-' : String(row[c.key]))))));
    return el('div', { class: 'table-wrap' }, el('table', { class: 'data' }, el('thead', {}, head), el('tbody', {}, body)));
  }

  /* --------------------------------------------------------------- panels */

  function panel(title, body, right) {
    return el('section', { class: 'panel' },
      el('div', { class: 'panel-head' }, el('h2', {}, title), right || ''),
      el('div', { class: 'panel-body' }, body));
  }
  /** Collapsible section: fold(title, body, {open, aside, big, onToggle}). */
  function fold(title, body, opts) {
    const o = opts || {};
    const node = el('details', { class: `fold ${o.big ? 'big' : ''}`, open: !!o.open },
      el('summary', {}, title, o.aside ? el('span', { class: 'aside' }, o.aside) : ''),
      el('div', { class: 'fold-body' }, body));
    if (o.onToggle) node.addEventListener('toggle', () => o.onToggle(node.open));
    return node;
  }
  const kpi = (label, value, sub, small) => el('div', { class: 'kpi' },
    el('div', { class: 'field-label' }, label), el('div', { class: `value ${small ? 'sm' : ''}` }, value),
    sub ? el('div', { class: 'sub' }, sub) : '');
  const kpis = (...items) => el('div', { class: 'kpis' }, items);
  const callout = (kind, ...children) => el('div', { class: `callout ${kind || ''}` }, children);
  const badge = (text, kind) => el('span', { class: `badge ${kind || ''}` }, text);
  const spinner = (text) => el('span', {}, el('span', { class: 'spinner' }), ' ', text || 'Working...');
  const utilBar = (fraction) => el('div', { class: `bar ${fraction >= 0.999 ? 'full' : ''}` },
    el('i', { style: `width:${Math.min(100, Math.max(0, fraction * 100))}%` }));

  /* --------------------------------------------------------------- charts */

  /** Plotly cannot read CSS variables, so chart colours are spelled out here, once.
   *  Keep them in step with the tokens in style.css:  accent, ink, pos, neg. */
  const colors = { lead: '#C15F3C', other: '#BDB8AA', ink: '#141413', good: '#15803D', bad: '#B91C1C',
                   grid: '#E9E6DD', text: '#3D3D3A', surface: '#FFFFFF',
                   series: ['#C15F3C', '#BDB8AA', '#15803D', '#B91C1C', '#D97706'] };

  /** plot(node, traces, layout, height) - draws a Plotly chart once it is on the page. */
  function plot(node, data, layout, height) {
    node.style.height = `${height || 320}px`;
    // A chart built before its node is on the page would be sized wrongly, so wait for it.
    let waited = 0;
    const draw = () => {
      if (!node.isConnected && waited++ < 60) { requestAnimationFrame(draw); return; }
      if (!window.Plotly) { node.textContent = 'Chart library failed to load.'; return; }
      const t = colors;
      const axis = { gridcolor: t.grid, zerolinecolor: t.grid, linecolor: t.grid, automargin: true,
                     tickfont: { size: 11, family: 'Inter, system-ui, sans-serif' } };
      window.Plotly.react(node, data, {
        margin: { l: 8, r: 8, t: 8, b: 8 }, paper_bgcolor: 'rgba(0,0,0,0)', plot_bgcolor: 'rgba(0,0,0,0)',
        font: { color: t.text, size: 12, family: 'Inter, system-ui, sans-serif' },
        colorway: t.series,
        hoverlabel: { bgcolor: '#FFFFFF', bordercolor: t.grid, font: { color: t.text, size: 12 } },
        legend: { orientation: 'h', y: -0.2, x: 0, font: { size: 11 } },
        ...layout, xaxis: { ...axis, ...((layout || {}).xaxis) }, yaxis: { ...axis, ...((layout || {}).yaxis) },
      }, { displayModeBar: false, responsive: true });
    };
    draw();
  }

  /* -------------------------------------------------------------- dataset */

  const DATASET_KEY = 'acro-dataset';
  const dataset = {
    get() { try { return JSON.parse(sessionStorage.getItem(DATASET_KEY)); } catch (e) { return null; } },
    set(record) { try { sessionStorage.setItem(DATASET_KEY, JSON.stringify(record)); } catch (e) { /* ignore */ } },
    clear() { try { sessionStorage.removeItem(DATASET_KEY); } catch (e) { /* ignore */ } },
    /** The stored id, checked against the server (a restart invalidates every id). */
    async verified() {
      const stored = dataset.get();
      if (!stored || !stored.dataset_id) return null;
      try {
        const all = await api.listDatasets();
        const live = all.find((d) => d.dataset_id === stored.dataset_id);
        if (live) { dataset.set(live); return live; }
      } catch (e) { /* fall through */ }
      dataset.clear();
      return null;
    },
  };

  /** Part 1 -> Part 2 link: the solved workers per terminal, kept for the IP page. */
  const HANDOFF_KEY = 'acro-lp-handoff';
  const handoff = {
    save(datasetId, workforce) {
      try { sessionStorage.setItem(HANDOFF_KEY, JSON.stringify({ datasetId, workforce })); } catch (e) { /* ignore */ }
    },
    load(datasetId) {
      try {
        const h = JSON.parse(sessionStorage.getItem(HANDOFF_KEY));
        return h && h.datasetId === datasetId ? h : null;
      } catch (e) { return null; }
    },
    clear() { try { sessionStorage.removeItem(HANDOFF_KEY); } catch (e) { /* ignore */ } },
  };

  /* -------------------------------------------------------------- widgets */
  /*
   * Every control widget returns its node, with node.set(value) and
   * node.setDisabled(bool).  `help` is explanatory text hidden behind a "?"
   * button; anything the user must see (warnings) belongs in a callout instead.
   */

  function field(label, value, body, help) {
    const node = el('div', { class: 'control' });
    let helpBtn = '';
    let helpText = '';
    if (help) {
      helpText = el('div', { class: 'help', hidden: true }, help);
      helpBtn = el('button', { type: 'button', class: 'help-btn', 'aria-expanded': 'false',
        'aria-label': `What is ${typeof label === 'string' ? label : 'this'}?`,
        onclick: () => {
          const open = helpText.hidden;
          helpText.hidden = !open;
          helpBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
        } }, '?');
    }
    node.append(el('div', { class: 'top' }, el('span', { class: 'label' }, label, helpBtn), value || ''), helpText, body);
    node.setDisabled = (d) => node.classList.toggle('disabled', !!d);
    return node;
  }

  /** slider({label, help, min, max, step, value, format, onInput}) */
  function slider(o) {
    const out = el('span', { class: 'value num' });
    const input = el('input', { type: 'range', min: o.min, max: o.max, step: o.step, 'aria-label': o.label });
    const node = field(o.label, out, input, o.help);
    node.set = (v) => { input.value = v; out.textContent = o.format ? o.format(Number(v)) : String(v); };
    input.addEventListener('input', () => { const v = Number(input.value); node.set(v); o.onInput(v); });
    const baseDisabled = node.setDisabled;
    node.setDisabled = (d) => { input.disabled = !!d; baseDisabled(d); };
    node.refresh = () => node.set(input.value);   // re-run format when its inputs change
    node.set(o.value);
    return node;
  }

  /** toggle({label, help, checked, onChange}) - a checkbox row. */
  function toggle(o) {
    const input = el('input', { type: 'checkbox' });
    input.checked = !!o.checked;
    input.addEventListener('change', () => o.onChange(input.checked));
    const node = field(el('label', { class: 'check' }, input, el('span', {}, o.label)), '', '', o.help);
    node.classList.add('control-toggle');
    node.set = (v) => { input.checked = !!v; };
    const baseDisabled = node.setDisabled;
    node.setDisabled = (d) => { input.disabled = !!d; baseDisabled(d); };
    return node;
  }

  /** segmented({label, help, options: [[value, text]], value, onChange}) */
  function segmented(o) {
    let current = o.value;
    const buttons = o.options.map(([value, text]) => {
      const b = el('button', { type: 'button', 'aria-pressed': 'false' }, text);
      b.addEventListener('click', () => { node.set(value); o.onChange(value); });
      return [value, b];
    });
    const node = field(o.label, '', el('div', { class: 'seg', role: 'group', 'aria-label': o.label }, buttons.map((p) => p[1])), o.help);
    node.set = (v) => {
      current = v;
      buttons.forEach(([value, b]) => { b.classList.toggle('on', value === current); b.setAttribute('aria-pressed', value === current ? 'true' : 'false'); });
    };
    node.set(current);
    return node;
  }

  /** chips({label, help, options, selected, onChange, emptyText}) - multi-select; none = all. */
  function chips(o) {
    let sel = new Set(o.selected || []);
    const note = el('div', { class: 'hint' });
    const buttons = o.options.map((opt) => {
      const b = el('button', { type: 'button', class: 'chip', 'aria-pressed': 'false' }, opt);
      b.addEventListener('click', () => {
        if (sel.has(opt)) sel.delete(opt); else sel.add(opt);
        node.set([...sel]); o.onChange([...sel]);
      });
      return [opt, b];
    });
    const body = o.options.length
      ? [el('div', { class: 'chips' }, buttons.map((p) => p[1])), note]
      : el('div', { class: 'hint' }, 'No categories found in this dataset.');
    const node = field(o.label, '', body, o.help);
    node.set = (arr) => {
      sel = new Set(arr || []);
      buttons.forEach(([opt, b]) => { b.classList.toggle('on', sel.has(opt)); b.setAttribute('aria-pressed', sel.has(opt) ? 'true' : 'false'); });
      note.textContent = sel.size ? '' : (o.emptyText || 'None selected = all included');
    };
    node.set(o.selected);
    return node;
  }

  /** numberInput({label, help, value, min, step, onChange}) */
  function numberInput(o) {
    const input = el('input', { type: 'number', min: o.min, step: o.step || 1, 'aria-label': o.label });
    input.value = o.value;
    input.addEventListener('change', () => o.onChange(input));
    const node = field(o.label, '', input, o.help);
    node.set = (v) => { input.value = v; };
    return node;
  }

  /** group(...controls) keeps a switch and the control it enables visually together. */
  const group = (...children) => el('div', { class: 'group' }, children);

  /** headline(...parts) - the result in one plain sentence, read before any number. */
  const headline = (...parts) => el('p', { class: 'headline' }, parts);

  /**
   * pageHead({kicker, title, lede, about}) - compact page head.  `about` (longer
   * explanation) sits in a closed fold so it never pushes the work below the fold.
   */
  function pageHead(o) {
    return el('div', { class: 'page-head' },
      o.kicker ? el('div', { class: 'kicker' }, o.kicker) : '',
      el('h1', {}, o.title),
      o.lede ? el('p', {}, o.lede) : '',
      o.about ? fold('How this works', o.about) : '');
  }

  /**
   * workbench({title, controls, actions, reset, results}) - settings panel on the
   * left (sticky, scrolls on its own) with the actions pinned to its foot, results
   * on the right.  Returns {node, results}.
   */
  function workbench(o) {
    const results = o.results || el('div', { class: 'stack' });
    const node = el('div', { class: 'workbench' },
      el('aside', { class: 'settings', 'aria-label': o.title || 'Settings' },
        el('div', { class: 'settings-head' }, el('h2', {}, o.title || 'Settings'), o.reset || ''),
        el('div', { class: 'settings-body' }, o.controls),
        el('div', { class: 'settings-foot' }, o.actions)),
      results);
    return { node, results };
  }

  /* ---------------------------------------------------------------- shell */

  const PAGES = [
    { id: 'explorer', href: 'explorer.html', n: '1', label: 'Data', sub: 'explore', needsDataset: true },
    { id: 'lp', href: 'lp.html', n: '2', label: 'Staff plan', sub: 'Part 1 · LP', needsDataset: true },
    { id: 'ip', href: 'ip.html', n: '3', label: 'Shipments', sub: 'Part 2 · IP', needsDataset: true },
  ];

  /**
   * shell(activeId, {needsDataset}) builds the header, and - for pages that need
   * data - resolves to the verified dataset record, or shows a "load a dataset
   * first" message and resolves to null.  The nav doubles as a 1-2-3 guide: a step
   * shows a tick once it has produced something (data loaded, Part 1 solved).
   */
  async function shell(activeId, options) {
    const live = await dataset.verified();
    const done = { explorer: !!live, lp: !!(live && handoff.load(live.dataset_id)), ip: false };
    const nav = el('nav', { class: 'nav', 'aria-label': 'Steps' }, PAGES.map((p) => el('a', {
      href: p.href, class: `step ${p.id === activeId ? 'active' : ''} ${p.needsDataset && !live ? 'disabled' : ''} ${done[p.id] ? 'done' : ''}`,
      'aria-current': p.id === activeId ? 'page' : false,
    }, el('span', { class: 'n' }, done[p.id] ? '✓' : p.n), el('span', {}, p.label, el('small', {}, p.sub)))));
    const status = el('a', { class: 'dataset-chip', href: 'index.html', title: live ? `Dataset ${live.dataset_id}` : 'Load a dataset' },
      el('span', { class: `status-dot ${live ? '' : 'bad'}` }), live ? `${fmt.int(live.n_rows)} records` : 'No dataset');
    document.body.prepend(el('header', { class: `site-header ${activeId === 'home' ? 'is-home' : ''}` },
      el('div', { class: 'inner' }, el('a', { class: 'brand', href: 'index.html' }, 'Air Cargo Optimiser'), nav, status)));

    const main = $('main');
    if (options && options.needsDataset && !live) {
      main.prepend(callout('warn', 'No dataset is loaded. ', el('a', { href: 'index.html' }, 'Go to Home'), ' and load one first.'));
      return null;
    }
    return live;
  }

  /** markStepDone(id) - tick a step in the header without a reload (e.g. right after Part 1 solves). */
  function markStepDone(id, done) {
    const step = document.querySelector(`.nav .step[href="${(PAGES.find((p) => p.id === id) || {}).href}"]`);
    if (!step) return;
    const p = PAGES.find((x) => x.id === id);
    step.classList.toggle('done', done !== false);
    step.querySelector('.n').textContent = done !== false ? '✓' : p.n;
  }

  /** The caveat text is served by the API with each result; this is the fallback. */
  const CAVEAT = 'Parameters are assumptions over a synthetic dataset. Every gain shown is a model-world gain, not a validated operational one.';
  const caveatBanner = (text) => el('div', { class: 'caveat', role: 'note' }, el('span', {}, text || CAVEAT));

  const ui = { field, slider, toggle, segmented, chips, numberInput, group };

  window.AC = { api, ApiError, el, $, clear, fmt, table, panel, fold, kpi, kpis, callout, badge, spinner, utilBar,
                colors, plot, shell, dataset, handoff, caveatBanner, CAVEAT, ui, headline, pageHead, workbench, markStepDone };
})();
