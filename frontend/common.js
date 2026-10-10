/* Shared helpers for every page.  Plain JavaScript, no framework, no build step.
 *
 * Exposes one global, `AC`:
 *   AC.api      one wrapper per endpoint (the Pydantic schemas are the contract)
 *   AC.el       tiny DOM builder:  AC.el('div', {class: 'x'}, 'text', child)
 *   AC.fmt      number formatting
 *   AC.table    build a data table
 *   AC.plot     draw a Plotly chart that follows the light/dark theme
 *   AC.shell    header, navigation, theme toggle and the model-world caveat
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
  const kpi = (label, value, sub) => el('div', { class: 'kpi' },
    el('div', { class: 'field-label' }, label), el('div', { class: 'value' }, value),
    sub ? el('div', { class: 'sub' }, sub) : '');
  const callout = (kind, ...children) => el('div', { class: `callout ${kind || ''}` }, children);
  const badge = (text, kind) => el('span', { class: `badge ${kind || ''}` }, text);
  const spinner = (text) => el('span', {}, el('span', { class: 'spinner' }), ' ', text || 'Working...');
  const utilBar = (fraction) => el('div', { class: `bar ${fraction >= 0.999 ? 'full' : ''}` },
    el('i', { style: `width:${Math.min(100, Math.max(0, fraction * 100))}%` }));

  /* ---------------------------------------------------------------- theme */

  function theme() {
    return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
  }
  function setTheme(name) {
    document.documentElement.setAttribute('data-theme', name);
    try { localStorage.setItem('acro-theme', name); } catch (e) { /* private mode */ }
    window.dispatchEvent(new Event('themechange'));
  }
  (function initTheme() {   // runs before first paint, so there is no flash
    let stored = null;
    try { stored = localStorage.getItem('acro-theme'); } catch (e) { /* ignore */ }
    const dark = stored ? stored === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  })();

  /** Plotly cannot read CSS variables, so the chart palette is spelled out here. */
  function chartTheme() {
    const dark = theme() === 'dark';
    return {
      font: dark ? '#D0D5DD' : '#344054',
      grid: dark ? 'rgba(152,162,179,0.16)' : 'rgba(102,112,133,0.16)',
      hoverBg: dark ? '#131B2B' : '#FFFFFF',
      series: dark ? ['#5B8DEF', '#667085', '#47CD89', '#F97066', '#FEC84B']
                   : ['#2563EB', '#98A2B3', '#027A48', '#B42318', '#F79009'],
    };
  }

  /** plot(node, traces, layout) - draws now and redraws when the theme flips. */
  function plot(node, data, layout, height) {
    node.style.height = `${height || 320}px`;
    // A chart built before its node is on the page would be sized wrongly, so wait for it.
    let waited = 0;
    const draw = () => {
      if (!node.isConnected && waited++ < 60) { requestAnimationFrame(draw); return; }
      if (!window.Plotly) { node.textContent = 'Chart library failed to load.'; return; }
      const t = chartTheme();
      const axis = { gridcolor: t.grid, zerolinecolor: t.grid, linecolor: t.grid, automargin: true,
                     tickfont: { size: 10, family: 'system-ui, sans-serif' } };
      window.Plotly.react(node, data, {
        margin: { l: 8, r: 8, t: 8, b: 8 }, paper_bgcolor: 'rgba(0,0,0,0)', plot_bgcolor: 'rgba(0,0,0,0)',
        font: { color: t.font, size: 11, family: 'Inter, system-ui, sans-serif' },
        colorway: t.series,
        hoverlabel: { bgcolor: t.hoverBg, bordercolor: t.grid, font: { color: t.font, size: 11 } },
        legend: { orientation: 'h', y: -0.2, x: 0, font: { size: 10 } },
        ...layout, xaxis: { ...axis, ...((layout || {}).xaxis) }, yaxis: { ...axis, ...((layout || {}).yaxis) },
      }, { displayModeBar: false, responsive: true });
    };
    draw();
    // One listener per chart node: redrawing the same node must not stack them.
    if (node._themeDraw) window.removeEventListener('themechange', node._themeDraw);
    node._themeDraw = draw;
    window.addEventListener('themechange', draw);
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
    save(datasetId, workforce, objective) {
      try { sessionStorage.setItem(HANDOFF_KEY, JSON.stringify({ datasetId, workforce, objective })); } catch (e) { /* ignore */ }
    },
    load(datasetId) {
      try {
        const h = JSON.parse(sessionStorage.getItem(HANDOFF_KEY));
        return h && h.datasetId === datasetId ? h : null;
      } catch (e) { return null; }
    },
    clear() { try { sessionStorage.removeItem(HANDOFF_KEY); } catch (e) { /* ignore */ } },
  };

  /* ---------------------------------------------------------------- shell */

  const PAGES = [
    { id: 'home', href: 'index.html', label: 'Home', needsDataset: false },
    { id: 'explorer', href: 'explorer.html', label: 'Data explorer', needsDataset: true },
    { id: 'lp', href: 'lp.html', label: 'Part 1 · LP', needsDataset: true },
    { id: 'ip', href: 'ip.html', label: 'Part 2 · IP', needsDataset: true },
  ];

  /**
   * shell(activeId, {needsDataset}) builds the header, and - for pages that need
   * data - resolves to the verified dataset record, or shows a "load a dataset
   * first" message and resolves to null.
   */
  async function shell(activeId, options) {
    const live = await dataset.verified();
    const nav = el('nav', { class: 'nav', 'aria-label': 'Main' }, PAGES.map((p) => el('a', {
      href: p.href, class: `${p.id === activeId ? 'active' : ''} ${p.needsDataset && !live ? 'disabled' : ''}`,
    }, p.label)));
    const toggle = el('button', { class: 'btn', type: 'button', onclick: () => setTheme(theme() === 'dark' ? 'light' : 'dark') }, 'Theme');
    const status = el('span', { class: 'field-label' }, live ? live.name || live.dataset_id : 'No dataset loaded');
    document.body.prepend(el('header', { class: 'site-header' },
      el('div', { class: 'inner' }, el('a', { class: 'brand', href: 'index.html' }, 'Air Cargo ', el('b', {}, 'Optimiser')),
        nav, el('div', { class: 'header-right' }, status, toggle))));

    const main = $('main');
    if (options && options.needsDataset && !live) {
      main.prepend(callout('warn', 'No dataset is loaded. ', el('a', { href: 'index.html' }, 'Go to Home'), ' and load one first.'));
      return null;
    }
    return live;
  }

  /** The caveat text is served by the API with each result; this is the fallback. */
  const CAVEAT = 'Parameters are assumptions over a synthetic dataset. Every gain shown is a model-world gain, not a validated operational one.';
  const caveatBanner = (text) => el('div', { class: 'caveat', role: 'note' }, el('div', {}, text || CAVEAT));

  window.AC = { api, ApiError, el, $, clear, fmt, table, panel, kpi, callout, badge, spinner, utilBar,
                theme, plot, shell, dataset, handoff, caveatBanner, CAVEAT };
})();
