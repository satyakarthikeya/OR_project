/* Home: a 1-2-3 guide.  Step 1 loads the dataset (bundled or uploaded); steps 2 and 3
 * unlock once it is loaded.  Also shows the caveat and the service status. */
(function () {
  'use strict';
  const { el, fmt, api } = AC;

  let current = null;
  let busy = null;      // 'bundled' | 'upload' | null
  let problem = null;   // {title, items[]}

  const stepsHost = AC.$('#steps');
  const servicePanel = AC.$('#service-panel');

  function refreshHeader() {
    const old = AC.$('.site-header');
    if (old) old.remove();
    return AC.shell('home', { needsDataset: false });
  }

  const STATUS = {
    done: () => AC.badge('Done ✓', 'pos'),
    ready: () => AC.badge('Ready', 'accent'),
    locked: () => AC.badge('Locked', ''),
  };

  /** One numbered step: title + status on the rule, a one-line promise, then the body. */
  function step(n, title, part, status, line, ...body) {
    return AC.panel(`${n} · ${title}`, el('div', {},
      part ? el('div', { class: 'kicker' }, part) : '',
      el('p', { class: 'muted', style: 'margin-bottom:16px' }, line), body), STATUS[status]());
  }

  const locked = () => el('button', { class: 'btn', type: 'button', disabled: true }, 'Load data first');

  function errorBox() {
    if (!problem) return '';
    return el('div', { style: 'margin-top:16px' }, AC.callout('bad', el('strong', {}, problem.title),
      problem.items.length ? el('ul', {}, problem.items.map((i) => el('li', {}, i))) : ''));
  }

  function dataStep() {
    if (!current) {
      return step(1, 'Load & explore the data', '', 'ready',
        'Start with the bundled dataset, or upload a CSV with the same 28 columns.',
        el('div', { class: 'row' },
          el('button', { class: 'btn btn-primary', type: 'button', disabled: busy !== null, onclick: loadBundled },
            busy === 'bundled' ? AC.spinner('Loading...') : 'Load bundled dataset'),
          el('label', { class: 'btn file-btn' },
            busy === 'upload' ? AC.spinner('Validating...') : 'Upload CSV',
            el('input', { type: 'file', accept: '.csv', disabled: busy !== null, onchange: upload }))),
        el('p', { class: 'hint', style: 'margin-top:12px' },
          'Uploads are checked against the schema first. Nothing is written to disk.'),
        errorBox());
    }
    const warnings = current.warnings || [];
    return step(1, 'Load & explore the data', '', 'done',
      'See what the data says before planning anything.',
      el('p', { class: 'num', style: 'margin-bottom:16px' },
        el('strong', {}, fmt.int(current.n_rows)), ' records · ',
        el('strong', {}, fmt.int(current.n_columns)), ' columns · loaded ',
        new Date(current.uploaded_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })),
      warnings.length ? AC.callout('warn', el('strong', {}, 'Validation warnings'),
        el('ul', {}, warnings.map((w) => el('li', {}, w)))) : '',
      el('div', { class: 'row' },
        el('a', { class: 'btn btn-primary', href: 'explorer.html' }, 'Explore the data'),
        el('button', { class: 'btn btn-quiet', type: 'button', onclick: replaceDataset }, 'Load a different dataset')));
  }

  function render() {
    const solved = !!(current && AC.handoff.load(current.dataset_id));
    const lpStatus = !current ? 'locked' : solved ? 'done' : 'ready';
    AC.clear(stepsHost).append(
      dataStep(),
      step(2, 'Plan staff', 'Part 1 · LP', lpStatus,
        'Given limited workers and machines, where should they go?',
        current ? el('a', { class: 'btn', href: 'lp.html' }, 'Open') : locked()),
      step(3, 'Choose shipments', 'Part 2 · IP', current ? 'ready' : 'locked',
        'If not everything fits, what goes first?',
        current ? el('p', { class: 'hint', style: 'margin:-8px 0 16px' }, solved
          ? 'Will use the staff plan you solved in step 2.'
          : 'Uses step 2\'s staff plan once you have solved it.') : '',
        current ? el('a', { class: 'btn', href: 'ip.html' }, 'Open') : locked()));
  }

  function replaceDataset() {
    current = null; problem = null; AC.dataset.clear();
    render(); refreshHeader();
  }

  async function adopt(record) {
    current = record;
    AC.dataset.set(record);
    render();
    await refreshHeader();
    loadHealth();
  }

  async function loadBundled() {
    busy = 'bundled'; problem = null; render();
    try {
      const record = await api.loadBundled();
      busy = null; await adopt(record);
    } catch (e) { busy = null; problem = { title: e.message, items: [] }; render(); }
  }

  async function upload(event) {
    const file = event.target.files && event.target.files[0];
    event.target.value = '';
    if (!file) return;
    busy = 'upload'; problem = null; render();
    let response;
    try {
      const form = new FormData(); form.append('file', file);
      response = await fetch('/api/datasets', { method: 'POST', body: form });
    } catch (e) {
      busy = null; problem = { title: 'Cannot reach the server. Is it still running?', items: [] };
      render(); return;
    }
    let payload = null;
    try { payload = await response.json(); } catch (e) { payload = null; }
    busy = null;
    if (response.ok) { await adopt(payload); return; }
    // A 422 carries the full list of schema errors; show every one, not just the first.
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
    render();
  }

  const dot = (ok) => el('span', { class: `status-dot ${ok ? '' : 'bad'}` });

  async function loadHealth() {
    try {
      const h = await api.health();
      AC.clear(servicePanel).append(el('div', { class: 'status-line' },
        el('span', {}, dot(h.status === 'ok'), 'API ', h.status),
        el('span', {}, dot(h.solver_available), 'Solver ', h.solver_name),
        el('span', {}, `${h.datasets_loaded} dataset(s) in memory`),
        el('a', { href: '/docs', target: '_blank', rel: 'noreferrer' }, 'API docs')));
    } catch (e) {
      AC.clear(servicePanel).append(AC.callout('bad', e.message, ' ',
        el('button', { class: 'btn', type: 'button', onclick: loadHealth }, 'Retry')));
    }
  }

  async function init() {
    AC.$('#caveat').append(AC.caveatBanner());
    current = await AC.shell('home', { needsDataset: false });
    render();
    loadHealth();
  }
  init();
})();
