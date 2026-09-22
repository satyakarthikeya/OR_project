/**
 * Application shell: header, tab routing, theme, and the one piece of state
 * every page shares — the loaded dataset.
 *
 * Routing is the URL hash rather than a router library: four pages, no build
 * step, and a refresh keeps you where you were.
 */
(function () {
  const { useState, useEffect, useCallback } = React;
  const { cx, Icon, Button, Badge, Card, EmptyState, ThemeContext } = window.UI;
  const { HomePage, ExplorerPage, LPPage, IPPage } = window.Pages;

  const STORAGE_THEME = 'acro-theme';
  const STORAGE_DATASET = 'acro-dataset';

  const PAGES = [
    { id: 'home', label: 'Home', needsDataset: false },
    { id: 'explorer', label: 'Data explorer', needsDataset: true },
    { id: 'lp', label: 'Part 1 · LP', needsDataset: true },
    { id: 'ip', label: 'Part 2 · IP', needsDataset: true },
  ];

  const pageFromHash = () => {
    const id = (window.location.hash || '').replace(/^#\/?/, '');
    return PAGES.some((p) => p.id === id) ? id : 'home';
  };

  /* --------------------------------------------------------------- theme */

  function useThemeToggle() {
    const [theme, setTheme] = useState(
      () => document.documentElement.classList.contains('dark') ? 'dark' : 'light'
    );
    useEffect(() => {
      document.documentElement.classList.toggle('dark', theme === 'dark');
      localStorage.setItem(STORAGE_THEME, theme);
    }, [theme]);
    return [theme, () => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))];
  }

  /* ------------------------------------------------------------ dataset */

  /**
   * The frame itself lives in the server's in-memory registry, so only the id
   * is cached here — and it is re-verified on load, because a server restart
   * invalidates every id.
   */
  function useDataset() {
    const [dataset, setDataset] = useState(null);
    const [restoring, setRestoring] = useState(true);

    useEffect(() => {
      let alive = true;
      const raw = sessionStorage.getItem(STORAGE_DATASET);
      if (!raw) { setRestoring(false); return; }

      let stored = null;
      try { stored = JSON.parse(raw); } catch (e) { stored = null; }
      if (!stored || !stored.dataset_id) {
        sessionStorage.removeItem(STORAGE_DATASET);
        setRestoring(false);
        return;
      }

      fetch('/api/datasets')
        .then((r) => (r.ok ? r.json() : []))
        .then((all) => {
          if (!alive) return;
          const live = all.find((d) => d.dataset_id === stored.dataset_id);
          if (live) setDataset(live);
          else sessionStorage.removeItem(STORAGE_DATASET);
        })
        .catch(() => sessionStorage.removeItem(STORAGE_DATASET))
        .finally(() => alive && setRestoring(false));

      return () => { alive = false; };
    }, []);

    const adopt = useCallback((record) => {
      setDataset(record);
      if (record) sessionStorage.setItem(STORAGE_DATASET, JSON.stringify(record));
      else sessionStorage.removeItem(STORAGE_DATASET);
    }, []);

    return { dataset, adopt, restoring };
  }

  /* ------------------------------------------------------------- part one */

  /**
   * Part 1's solved allocation, held here because Part 2 spends it.
   *
   * The two models are sequential: constraint (2) of the knapsack takes its
   * right-hand side from `w_t*`. That only means anything if it is the `w_t*`
   * the user actually chose — a different objective or a moved slider gives a
   * materially different allocation, and Part 2 answering from a run nobody
   * saw would make the two-stage coupling a fiction. So the LP page publishes
   * its result here and the IP page reads it.
   */
  function useLPRun(datasetId) {
    const [lpRun, setLpRun] = useState(null);

    // Parameters are derived per dataset, so an allocation from the previous
    // one is meaningless against this one's terminals.
    useEffect(() => { setLpRun(null); }, [datasetId]);

    const publish = useCallback((result, objectiveLabel) => {
      if (!result || result.status !== 'Optimal') return;
      const workforce = {};
      result.allocation.forEach((r) => {
        workforce[r.terminal] = r.optimized_workforce;
      });
      setLpRun({
        workforce,
        objective: result.objective,
        objective_label: objectiveLabel || result.objective_label,
        expanded_resources: result.expanded_resources,
        at: Date.now(),
      });
    }, []);

    return { lpRun, publish };
  }

  /* ---------------------------------------------------------------- shell */

  function Header({ page, onNavigate, dataset, theme, onToggleTheme }) {
    return (
      <header className="sticky top-0 z-30 border-b border-rule-firm bg-panel/95 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-[1440px] items-center gap-5 px-4 sm:px-6">
          <a href="#/home" className="flex shrink-0 items-center gap-2.5"
             onClick={() => onNavigate('home')}>
            {/* Three rising bars — allocation across terminals, the thing the
                whole application decides. */}
            <svg viewBox="0 0 24 24" className="h-5 w-5 text-accent-fill"
                 fill="currentColor" aria-hidden="true">
              <rect x="3" y="14" width="4" height="7" />
              <rect x="10" y="9" width="4" height="12" />
              <rect x="17" y="3" width="4" height="18" />
            </svg>
            <span className="hidden text-[13px] font-semibold uppercase tracking-[0.14em] text-ink sm:block">
              Dispatch Desk
            </span>
          </a>

          <nav className="flex h-full min-w-0 flex-1 items-stretch overflow-x-auto"
               aria-label="Primary">
            {PAGES.map((p) => {
              const disabled = p.needsDataset && !dataset;
              const active = page === p.id;
              return (
                <button
                  key={p.id}
                  onClick={() => !disabled && onNavigate(p.id)}
                  disabled={disabled}
                  aria-current={active ? 'page' : undefined}
                  className={cx(
                    'relative flex items-center whitespace-nowrap px-3.5 font-mono text-[11px]',
                    'uppercase tracking-[0.09em] transition-colors',
                    disabled
                      ? 'cursor-not-allowed text-faint'
                      : active
                        ? 'text-ink'
                        : 'text-muted hover:text-ink'
                  )}
                >
                  {p.label}
                  {/* The active tab is marked on the header's own bottom rule,
                      the way a strip board marks the live position. */}
                  {active && (
                    <span aria-hidden="true"
                      className="absolute inset-x-0 -bottom-px h-0.5 bg-accent-fill" />
                  )}
                </button>
              );
            })}
          </nav>

          <div className="flex shrink-0 items-center gap-3">
            {dataset && (
              // A load tag: mono, ruled, carrying the id every request quotes.
              <span className="hidden items-center gap-2 border border-rule px-2 py-1 md:flex"
                    title={`${dataset.name} · ${dataset.dataset_id}`}>
                <span className="h-1.5 w-1.5 bg-pos" />
                <span className="max-w-[150px] truncate font-mono text-[10px] uppercase tracking-wider text-muted">
                  {dataset.dataset_id}
                </span>
              </span>
            )}
            <a href="/docs" target="_blank" rel="noreferrer"
               className="hidden font-mono text-[11px] uppercase tracking-[0.09em] text-muted hover:text-ink sm:block">
              API
            </a>
            <button
              onClick={onToggleTheme}
              aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
              className="p-1.5 text-muted transition-colors hover:bg-sunken hover:text-ink"
            >
              <Icon name={theme === 'dark' ? 'sun' : 'moon'} className="h-4 w-4" />
            </button>
          </div>
        </div>
      </header>
    );
  }

  function Footer() {
    return (
      <footer className="mt-16 border-t border-rule py-8">
        <div className="mx-auto max-w-[1440px] px-4 sm:px-6">
          <p className="text-xs leading-relaxed text-muted">
            Operations Research course project · FastAPI + PuLP/CBC + React.
            Dataset: Kaggle <em>Air Cargo Resource Allocation Data</em> (CC0), 5,000
            synthetic records. Model formulations and stated assumptions are
            documented in SCOPE.md; every optimisation response carries the same
            caveat shown in the app.
          </p>
        </div>
      </footer>
    );
  }

  /* ------------------------------------------------------------------ app */

  function App() {
    const [page, setPage] = useState(pageFromHash);
    const [theme, toggleTheme] = useThemeToggle();
    const { dataset, adopt, restoring } = useDataset();
    const { lpRun, publish: publishLPRun } = useLPRun(dataset && dataset.dataset_id);

    useEffect(() => {
      const onHashChange = () => setPage(pageFromHash());
      window.addEventListener('hashchange', onHashChange);
      return () => window.removeEventListener('hashchange', onHashChange);
    }, []);

    const navigate = useCallback((id) => {
      window.location.hash = `#/${id}`;
      setPage(id);
      window.scrollTo({ top: 0 });
    }, []);

    // A page that needs a dataset must not render without one, whichever way
    // the user got there — deep link, refresh, or a stale hash.
    const target = PAGES.find((p) => p.id === page) || PAGES[0];
    const blocked = target.needsDataset && !dataset;

    let content;
    if (restoring) {
      content = (
        <div className="space-y-4">
          <div className="skeleton h-8 w-64" />
          <div className="skeleton h-48 w-full" />
        </div>
      );
    } else if (blocked) {
      content = (
        <Card>
          <EmptyState title="No dataset loaded"
            action={<Button variant="primary" onClick={() => navigate('home')}>
              Go to Home
            </Button>}>
            Load the bundled CSV or upload your own from the Home page. Every
            screen works from the dataset id the server returns.
          </EmptyState>
        </Card>
      );
    } else if (page === 'home') {
      content = <HomePage dataset={dataset} onDataset={adopt} onNavigate={navigate} />;
    } else if (page === 'explorer') {
      content = <ExplorerPage dataset={dataset} />;
    } else if (page === 'lp') {
      content = <LPPage dataset={dataset} onSolved={publishLPRun} />;
    } else {
      content = <IPPage dataset={dataset} lpRun={lpRun} />;
    }

    return (
      <ThemeContext.Provider value={theme}>
        <div className="flex min-h-full flex-col">
          <Header page={page} onNavigate={navigate} dataset={dataset}
            theme={theme} onToggleTheme={toggleTheme} />
          <main className="mx-auto w-full max-w-[1440px] flex-1 px-4 py-8 sm:px-6">
            {content}
          </main>
          <Footer />
        </div>
      </ThemeContext.Provider>
    );
  }

  ReactDOM.createRoot(document.getElementById('root')).render(<App />);
})();
