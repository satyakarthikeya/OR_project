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
  const { HomePage, ExplorerPage, LPPage } = window.Pages;

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

  /* ---------------------------------------------------------------- shell */

  function Header({ page, onNavigate, dataset, theme, onToggleTheme }) {
    return (
      <header className={cx(
        'sticky top-0 z-30 border-b border-slate-200 bg-white/85 backdrop-blur',
        'dark:border-slate-800 dark:bg-slate-950/85'
      )}>
        <div className="mx-auto flex h-14 max-w-[1440px] items-center gap-6 px-4 sm:px-6">
          <a href="#/home" className="flex shrink-0 items-center gap-2.5"
             onClick={() => onNavigate('home')}>
            <span className="grid h-7 w-7 place-items-center rounded-lg bg-accent-600 text-white">
              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor" aria-hidden="true">
                <path d="M4 16h3v4H4zM10 10h3v10h-3zM16 4h3v16h-3z" />
              </svg>
            </span>
            <span className="hidden text-sm font-semibold tracking-tight sm:block">
              Air Cargo <span className="text-slate-400 dark:text-slate-500">/ OR</span>
            </span>
          </a>

          <nav className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"
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
                    'relative whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
                    disabled
                      ? 'cursor-not-allowed text-slate-300 dark:text-slate-600'
                      : active
                        ? 'text-slate-900 dark:text-slate-50'
                        : 'text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100'
                  )}
                >
                  {p.label}
                  {active && (
                    <span className="absolute inset-x-3 -bottom-[9px] h-0.5 rounded-full bg-accent-600" />
                  )}
                </button>
              );
            })}
          </nav>

          <div className="flex shrink-0 items-center gap-3">
            {dataset && (
              <span className="hidden items-center gap-2 md:flex">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                <span className="max-w-[180px] truncate text-xs text-slate-500 dark:text-slate-400"
                      title={`${dataset.name} · ${dataset.dataset_id}`}>
                  {dataset.name}
                </span>
              </span>
            )}
            <a href="/docs" target="_blank" rel="noreferrer"
               className="hidden text-xs font-medium text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100 sm:block">
              API docs
            </a>
            <button
              onClick={onToggleTheme}
              aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
              className="rounded-md p-1.5 text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100"
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
      <footer className="mt-16 border-t border-slate-200 py-8 dark:border-slate-800">
        <div className="mx-auto max-w-[1440px] px-4 sm:px-6">
          <p className="text-xs leading-relaxed text-slate-500 dark:text-slate-400">
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

  /** Part 2 is not built yet; say so plainly rather than shipping a dead tab. */
  function IPPlaceholder({ onNavigate }) {
    return (
      <div className="mx-auto max-w-3xl">
        <Card>
          <EmptyState icon="sliders" title="Part 2 — cargo processing selection">
            The 0-1 multi-dimensional knapsack that decides which shipments to
            process under capacity limits is specified in SCOPE.md section 4 and
            its data layer (batch construction, value scores, capacity defaults)
            is already built and tested. The model, endpoints and page are the
            next milestone.
          </EmptyState>
          <div className="flex justify-center pb-6">
            <Button variant="secondary" onClick={() => onNavigate('lp')}>
              Back to Part 1
            </Button>
          </div>
        </Card>
      </div>
    );
  }

  /* ------------------------------------------------------------------ app */

  function App() {
    const [page, setPage] = useState(pageFromHash);
    const [theme, toggleTheme] = useThemeToggle();
    const { dataset, adopt, restoring } = useDataset();

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
          <div className="skeleton h-48 w-full rounded-xl" />
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
      content = <LPPage dataset={dataset} />;
    } else {
      content = <IPPlaceholder onNavigate={navigate} />;
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
