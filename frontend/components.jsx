/**
 * The shared component vocabulary.
 *
 * Built before any page markup, on purpose: page-level ad-hoc styling is what
 * makes a hand-rolled UI look inconsistent (AGENT.md, "Frontend rules"). Pages
 * compose from these and never reach for a raw colour or spacing value.
 *
 * House rules encoded here: one accent colour, one neutral scale, rounded-xl
 * surfaces, p-5/p-6 padding, gap-6 grids, two heading sizes, one body size,
 * fixed-width digits on every number.
 */
(function () {
  const { useState, useEffect, useRef, useMemo, useCallback, createContext,
          useContext } = React;

  const cx = (...parts) => parts.filter(Boolean).join(' ');

  /* ---------------------------------------------------------------- theme */

  const ThemeContext = createContext('light');
  const useTheme = () => useContext(ThemeContext);

  /* ------------------------------------------------------------ formatting */

  const nf = (digits) =>
    new Intl.NumberFormat('en-US', {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    });

  const fmt = {
    num(value, digits = 2) {
      if (value === null || value === undefined || Number.isNaN(value)) return '—';
      return nf(digits).format(value);
    },
    int(value) {
      return fmt.num(value, 0);
    },
    money(value) {
      if (value === null || value === undefined) return '—';
      return nf(0).format(value);
    },
    signed(value, digits = 2) {
      if (value === null || value === undefined || Number.isNaN(value)) return '—';
      const sign = value > 0 ? '+' : value < 0 ? '−' : '';
      return sign + nf(digits).format(Math.abs(value));
    },
    percent(value, digits = 1) {
      if (value === null || value === undefined || Number.isNaN(value)) return '—';
      const sign = value > 0 ? '+' : value < 0 ? '−' : '';
      return `${sign}${nf(digits).format(Math.abs(value))}%`;
    },
    ratio(value, digits = 0) {
      if (value === null || value === undefined) return '—';
      return `${nf(digits).format(value * 100)}%`;
    },
  };

  /* --------------------------------------------------------------- icons */

  const Icon = ({ name, className = 'h-4 w-4' }) => {
    const paths = {
      sun: 'M12 3v1.5M12 19.5V21M4.5 12H3m18 0h-1.5M5.6 5.6 4.5 4.5m15 15-1.1-1.1M5.6 18.4 4.5 19.5m15-15-1.1 1.1M15.5 12a3.5 3.5 0 1 1-7 0 3.5 3.5 0 0 1 7 0Z',
      moon: 'M21 12.8A8.5 8.5 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z',
      upload: 'M12 16V4m0 0L8 8m4-4 4 4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2',
      database: 'M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3Zm0 0v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3',
      play: 'M6 4.5v15l13-7.5-13-7.5Z',
      check: 'm4.5 12.5 5 5 10-11',
      alert: 'M12 8.5v5m0 3.5h.01M10.3 3.9 2.6 17.2A2 2 0 0 0 4.3 20h15.4a2 2 0 0 0 1.7-2.8L13.7 3.9a2 2 0 0 0-3.4 0Z',
      info: 'M12 16v-5m0-3.5h.01M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
      chart: 'M4 20h16M7 20v-7m5 7V6m5 14v-10',
      sliders: 'M4 8h10M18 8h2M4 16h4M12 16h8M15 5v6M8 13v6',
      arrow: 'M5 12h14m0 0-5-5m5 5-5 5',
      spinner: 'M12 3a9 9 0 1 0 9 9',
    };
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
           strokeLinecap="round" strokeLinejoin="round" className={className}
           aria-hidden="true">
        <path d={paths[name] || paths.info} />
      </svg>
    );
  };

  const Spinner = ({ className = 'h-4 w-4' }) => (
    <Icon name="spinner" className={cx(className, 'animate-spin')} />
  );

  /* -------------------------------------------------------------- surfaces */

  const Card = ({ title, subtitle, actions, children, className, bodyClass, dense }) => (
    <section className={cx(
      'rounded-xl border border-slate-200 bg-white shadow-card',
      'dark:border-slate-800 dark:bg-slate-900', className
    )}>
      {(title || actions) && (
        <header className={cx(
          'flex items-start justify-between gap-4 border-b border-slate-200 px-5 py-4',
          'dark:border-slate-800'
        )}>
          <div className="min-w-0">
            {title && (
              <h2 className="text-sm font-semibold tracking-tight text-slate-900 dark:text-slate-100">
                {title}
              </h2>
            )}
            {subtitle && (
              <p className="mt-1 text-sm leading-relaxed text-slate-500 dark:text-slate-400">
                {subtitle}
              </p>
            )}
          </div>
          {actions && <div className="shrink-0">{actions}</div>}
        </header>
      )}
      <div className={bodyClass || (dense ? 'p-0' : 'p-5')}>{children}</div>
    </section>
  );

  const SectionLabel = ({ children, className }) => (
    <h3 className={cx(
      'text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-500',
      'dark:text-slate-400', className
    )}>
      {children}
    </h3>
  );

  const PageHeader = ({ eyebrow, title, children, actions }) => (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="max-w-3xl">
        {eyebrow && (
          <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-accent-600 dark:text-accent-400">
            {eyebrow}
          </p>
        )}
        <h1 className="mt-1 text-xl font-semibold tracking-tight text-slate-900 dark:text-slate-50">
          {title}
        </h1>
        {children && (
          <p className="mt-2 text-sm leading-relaxed text-slate-600 dark:text-slate-400">
            {children}
          </p>
        )}
      </div>
      {actions}
    </div>
  );

  /* --------------------------------------------------------------- inputs */

  const BUTTON_VARIANTS = {
    primary: 'bg-accent-600 text-white hover:bg-accent-700 disabled:bg-accent-600/50 dark:bg-accent-600 dark:hover:bg-accent-500',
    secondary: 'border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800',
    ghost: 'text-slate-600 hover:bg-slate-100 disabled:opacity-50 dark:text-slate-300 dark:hover:bg-slate-800',
  };

  const Button = ({ variant = 'secondary', size = 'md', busy, icon, children,
                    className, ...rest }) => (
    <button
      {...rest}
      disabled={rest.disabled || busy}
      className={cx(
        'inline-flex items-center justify-center gap-2 rounded-lg font-medium transition-colors',
        'disabled:cursor-not-allowed',
        size === 'sm' ? 'px-2.5 py-1.5 text-xs' : 'px-3.5 py-2 text-sm',
        BUTTON_VARIANTS[variant], className
      )}
    >
      {busy ? <Spinner /> : icon ? <Icon name={icon} /> : null}
      {children}
    </button>
  );

  const SliderRow = ({ label, hint, value, min, max, step, onChange, format,
                       disabled }) => (
    <div className={cx('py-3', disabled && 'opacity-50')}>
      <div className="flex items-baseline justify-between gap-3">
        <label className="text-sm font-medium text-slate-700 dark:text-slate-200">
          {label}
        </label>
        <span className="num text-sm font-semibold text-slate-900 dark:text-slate-100">
          {format ? format(value) : value}
        </span>
      </div>
      <input
        type="range" min={min} max={max} step={step} value={value}
        disabled={disabled}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className={cx(
          'mt-2 h-1.5 w-full cursor-pointer appearance-none rounded-full',
          'bg-slate-200 accent-accent-600 dark:bg-slate-700'
        )}
      />
      {hint && (
        <p className="mt-1.5 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
          {hint}
        </p>
      )}
    </div>
  );

  const SegmentedControl = ({ options, value, onChange, className }) => (
    <div className={cx(
      'inline-flex rounded-lg border border-slate-200 bg-slate-100 p-0.5',
      'dark:border-slate-800 dark:bg-slate-800/60', className
    )}>
      {options.map((option) => (
        <button
          key={option.value}
          onClick={() => onChange(option.value)}
          aria-pressed={value === option.value}
          className={cx(
            'rounded-[7px] px-3 py-1.5 text-xs font-medium transition-colors',
            value === option.value
              ? 'bg-white text-slate-900 shadow-sm dark:bg-slate-900 dark:text-slate-50'
              : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-200'
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );

  const Toggle = ({ label, hint, checked, onChange }) => (
    <div className="flex items-start justify-between gap-4 py-3">
      <div className="min-w-0">
        <p className="text-sm font-medium text-slate-700 dark:text-slate-200">{label}</p>
        {hint && (
          <p className="mt-1 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
            {hint}
          </p>
        )}
      </div>
      <button
        role="switch" aria-checked={checked} aria-label={label}
        onClick={() => onChange(!checked)}
        className={cx(
          'relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition-colors',
          checked ? 'bg-accent-600' : 'bg-slate-300 dark:bg-slate-700'
        )}
      >
        <span
          className="absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform"
          style={{ transform: checked ? 'translateX(16px)' : 'translateX(0)' }}
        />
      </button>
    </div>
  );

  const ChipSelect = ({ label, options, selected, onChange, hint }) => {
    const toggle = (option) => {
      const next = selected.includes(option)
        ? selected.filter((v) => v !== option)
        : [...selected, option];
      onChange(next);
    };
    return (
      <div className="py-3">
        <div className="flex items-baseline justify-between gap-3">
          <label className="text-sm font-medium text-slate-700 dark:text-slate-200">
            {label}
          </label>
          {selected.length > 0 && (
            <button onClick={() => onChange([])}
              className="text-xs text-slate-500 underline-offset-2 hover:underline dark:text-slate-400">
              clear
            </button>
          )}
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {options.map((option) => {
            const active = selected.includes(option);
            return (
              <button
                key={option} onClick={() => toggle(option)} aria-pressed={active}
                className={cx(
                  'rounded-md border px-2.5 py-1 text-xs font-medium transition-colors',
                  active
                    ? 'border-accent-600 bg-accent-600 text-white'
                    : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300 dark:hover:border-slate-600'
                )}
              >
                {option}
              </button>
            );
          })}
        </div>
        <p className="mt-1.5 text-xs text-slate-500 dark:text-slate-400">
          {selected.length === 0 ? (hint || 'All included') : `${selected.length} selected`}
        </p>
      </div>
    );
  };

  /* -------------------------------------------------------------- feedback */

  const TONES = {
    neutral: 'border-slate-200 bg-slate-50 text-slate-700 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300',
    accent: 'border-accent-200 bg-accent-50 text-accent-900 dark:border-accent-900 dark:bg-accent-950/50 dark:text-accent-100',
    warn: 'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-100',
    danger: 'border-rose-200 bg-rose-50 text-rose-900 dark:border-rose-900/60 dark:bg-rose-950/40 dark:text-rose-100',
    good: 'border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-100',
  };

  const Callout = ({ tone = 'neutral', icon = 'info', title, children, className }) => (
    <div className={cx('rounded-xl border px-4 py-3', TONES[tone], className)}>
      <div className="flex gap-3">
        <Icon name={icon} className="mt-0.5 h-4 w-4 shrink-0 opacity-70" />
        <div className="min-w-0 text-sm leading-relaxed">
          {title && <p className="font-semibold">{title}</p>}
          <div className={title ? 'mt-1 opacity-90' : 'opacity-90'}>{children}</div>
        </div>
      </div>
    </div>
  );

  const BADGE_TONES = {
    neutral: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300',
    accent: 'bg-accent-100 text-accent-800 dark:bg-accent-950 dark:text-accent-300',
    good: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300',
    warn: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
    danger: 'bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-300',
  };

  const Badge = ({ tone = 'neutral', children, className }) => (
    <span className={cx(
      'inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium',
      BADGE_TONES[tone], className
    )}>
      {children}
    </span>
  );

  /** The standing honesty banner. Never remove it — see AGENT.md. */
  const CaveatBanner = ({ text }) => (
    <Callout tone="warn" icon="alert" title="Model-world results" className="mb-6">
      {text || 'The dataset is synthetic and its columns are mutually uncorrelated, ' +
        'so coefficients are derived from stated assumptions rather than fitted. ' +
        'Improvements are gains under those assumptions, not validated operational gains.'}
    </Callout>
  );

  const STATUS_TONE = {
    Optimal: 'good', Infeasible: 'danger', Unbounded: 'danger',
    'Not Solved': 'warn', Undefined: 'warn',
  };

  const SolveStatus = ({ status, message, suggestions, seconds }) => (
    <Callout
      tone={STATUS_TONE[status] || 'neutral'}
      icon={status === 'Optimal' ? 'check' : 'alert'}
      title={status === 'Optimal' ? 'Solved to optimality' : `Solver status: ${status}`}
    >
      <p>{message}</p>
      {suggestions && suggestions.length > 0 && (
        <ul className="mt-2 list-disc space-y-1 pl-5">
          {suggestions.map((s, i) => <li key={i}>{s}</li>)}
        </ul>
      )}
      {seconds !== undefined && status === 'Optimal' && (
        <p className="num mt-1 text-xs opacity-70">
          CBC solved in {fmt.num(seconds, 3)} s
        </p>
      )}
    </Callout>
  );

  const Skeleton = ({ className = 'h-4 w-full' }) => (
    <div className={cx('skeleton', className)} />
  );

  const EmptyState = ({ icon = 'database', title, children, action }) => (
    <div className="flex flex-col items-center justify-center px-6 py-14 text-center">
      <div className="rounded-xl bg-slate-100 p-3 text-slate-400 dark:bg-slate-800 dark:text-slate-500">
        <Icon name={icon} className="h-6 w-6" />
      </div>
      <p className="mt-4 text-sm font-semibold text-slate-900 dark:text-slate-100">
        {title}
      </p>
      {children && (
        <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-slate-500 dark:text-slate-400">
          {children}
        </p>
      )}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );

  /* ----------------------------------------------------------------- data */

  const StatTile = ({ label, value, unit, hint, tone = 'neutral' }) => (
    <div className={cx(
      'rounded-xl border border-slate-200 bg-white px-4 py-3.5 shadow-card',
      'dark:border-slate-800 dark:bg-slate-900'
    )}>
      <p className="truncate text-xs font-medium text-slate-500 dark:text-slate-400">
        {label}
      </p>
      <p className="num mt-1.5 flex items-baseline gap-1.5">
        <span className={cx(
          'text-2xl font-semibold tracking-tight',
          tone === 'good' ? 'text-emerald-600 dark:text-emerald-400'
            : tone === 'danger' ? 'text-rose-600 dark:text-rose-400'
            : 'text-slate-900 dark:text-slate-50'
        )}>
          {value}
        </span>
        {unit && (
          <span className="text-xs font-medium text-slate-500 dark:text-slate-400">
            {unit}
          </span>
        )}
      </p>
      {hint && (
        <p className="mt-1 truncate text-xs text-slate-500 dark:text-slate-400" title={hint}>
          {hint}
        </p>
      )}
    </div>
  );

  /** A delta rendered against what "better" means for that metric. */
  const Delta = ({ value, percent, better = 'up', digits = 2 }) => {
    const neutral = better === 'neutral' || Math.abs(value) < 1e-9;
    const good = better === 'up' ? value > 0 : value < 0;
    return (
      <span className={cx(
        'num inline-flex items-baseline gap-1.5 font-medium',
        neutral ? 'text-slate-500 dark:text-slate-400'
          : good ? 'text-emerald-600 dark:text-emerald-400'
          : 'text-rose-600 dark:text-rose-400'
      )}>
        {fmt.signed(value, digits)}
        {percent !== null && percent !== undefined && (
          <span className="text-xs opacity-70">({fmt.percent(percent)})</span>
        )}
      </span>
    );
  };

  /**
   * Columns: { key, header, align, width, render(row), className, sub }.
   * Numeric columns get fixed-width digits and right alignment by default.
   */
  const DataTable = ({ columns, rows, rowKey, footer, emptyMessage, compact,
                       headerClass }) => {
    if (!rows || rows.length === 0) {
      return (
        <p className="px-5 py-8 text-center text-sm text-slate-500 dark:text-slate-400">
          {emptyMessage || 'No rows'}
        </p>
      );
    }
    const cell = compact ? 'px-3 py-2' : 'px-4 py-2.5';
    return (
      <div className="overflow-x-auto">
        <table className="w-full min-w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200 dark:border-slate-800">
              {columns.map((col) => (
                <th key={col.key} scope="col"
                  className={cx(
                    cell, 'whitespace-nowrap text-[11px] font-semibold uppercase tracking-[0.06em]',
                    'text-slate-500 dark:text-slate-400',
                    col.align === 'right' ? 'text-right' : 'text-left',
                    // Headers carrying Greek symbols must opt out: `uppercase`
                    // silently turns α into Α and γ into Γ.
                    headerClass
                  )}>
                  {col.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800/70">
            {rows.map((row, index) => (
              <tr key={rowKey ? rowKey(row) : index}
                className="transition-colors hover:bg-slate-50 dark:hover:bg-slate-800/40">
                {columns.map((col) => (
                  <td key={col.key}
                    className={cx(
                      cell, 'whitespace-nowrap',
                      col.align === 'right' ? 'num text-right' : 'text-left',
                      col.className || 'text-slate-700 dark:text-slate-300'
                    )}>
                    {col.render ? col.render(row, index) : row[col.key]}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
          {footer && (
            <tfoot className="border-t border-slate-200 dark:border-slate-800">
              {footer}
            </tfoot>
          )}
        </table>
      </div>
    );
  };

  /** Label/value pairs for parameter and assumption panels. */
  const KeyValueList = ({ items, columns = 2 }) => (
    <dl className={cx(
      'grid gap-x-6 gap-y-3',
      columns === 3 ? 'sm:grid-cols-3' : columns === 2 ? 'sm:grid-cols-2' : ''
    )}>
      {items.map((item) => (
        <div key={item.label} className="min-w-0">
          <dt className="text-xs text-slate-500 dark:text-slate-400">{item.label}</dt>
          <dd className="num mt-0.5 truncate text-sm font-medium text-slate-900 dark:text-slate-100"
              title={String(item.value)}>
            {item.value}
          </dd>
        </div>
      ))}
    </dl>
  );

  /** A progress bar for "used out of available". */
  const UtilizationBar = ({ label, used, available, unit, digits = 1 }) => {
    const pct = available > 0 ? Math.min(100, (used / available) * 100) : 0;
    const tight = pct > 99.5;
    return (
      <div>
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-sm text-slate-600 dark:text-slate-300">{label}</span>
          <span className="num text-sm font-medium text-slate-900 dark:text-slate-100">
            {fmt.num(used, digits)} / {fmt.num(available, digits)}
            {unit && <span className="ml-1 text-xs text-slate-500">{unit}</span>}
          </span>
        </div>
        <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
          <div className={cx('h-full rounded-full transition-all',
            tight ? 'bg-accent-600' : 'bg-slate-400 dark:bg-slate-600')}
            style={{ width: `${pct}%` }} />
        </div>
        <p className="num mt-1 text-xs text-slate-500 dark:text-slate-400">
          {fmt.num(pct, 1)}% used{tight ? ' — binding' : ''}
        </p>
      </div>
    );
  };

  /* --------------------------------------------------------------- charts */

  /** Plotly palette and layout defaults, resolved per theme. */
  function chartTheme(theme) {
    const dark = theme === 'dark';
    return {
      dark,
      font: dark ? '#cbd5e1' : '#475569',
      grid: dark ? 'rgba(148,163,184,0.16)' : 'rgba(100,116,139,0.16)',
      zero: dark ? 'rgba(148,163,184,0.35)' : 'rgba(100,116,139,0.3)',
      accent: dark ? '#41bda7' : '#158173',
      muted: dark ? '#64748b' : '#94a3b8',
      series: dark
        ? ['#41bda7', '#94a3b8', '#f0b429', '#f87171', '#818cf8']
        : ['#158173', '#94a3b8', '#d97706', '#e11d48', '#6366f1'],
      hoverBg: dark ? '#1e293b' : '#ffffff',
    };
  }

  /**
   * Thin Plotly wrapper: `Plotly.react` on every change, resize with the
   * container, purge on unmount. Backend endpoints return JSON only — no chart
   * is ever rendered server-side.
   */
  const Chart = ({ data, layout, height = 320, config, ariaLabel }) => {
    const node = useRef(null);
    const theme = useTheme();

    useEffect(() => {
      if (!node.current || !window.Plotly) return;
      const t = chartTheme(theme);
      const axis = {
        gridcolor: t.grid,
        zerolinecolor: t.zero,
        linecolor: t.grid,
        tickfont: { size: 11 },
        automargin: true,
      };
      const merged = {
        margin: { l: 8, r: 8, t: 8, b: 8 },
        paper_bgcolor: 'transparent',
        plot_bgcolor: 'transparent',
        font: { color: t.font, size: 12,
                family: 'Inter, ui-sans-serif, system-ui, sans-serif' },
        colorway: t.series,
        hoverlabel: { bgcolor: t.hoverBg, bordercolor: t.grid,
                      font: { color: t.font, size: 12 } },
        legend: { orientation: 'h', y: -0.18, x: 0, font: { size: 11 } },
        ...layout,
        xaxis: { ...axis, ...(layout && layout.xaxis) },
        yaxis: { ...axis, ...(layout && layout.yaxis) },
      };
      window.Plotly.react(node.current, data, merged, {
        displayModeBar: false, responsive: true, ...config,
      });
    }, [data, layout, config, theme]);

    useEffect(() => {
      const el = node.current;
      return () => { if (el && window.Plotly) window.Plotly.purge(el); };
    }, []);

    return <div ref={node} style={{ height }} role="img" aria-label={ariaLabel} />;
  };

  /* ---------------------------------------------------------------- hooks */

  /** Run an async loader, tracking loading and error state. */
  function useAsync(loader, deps, { immediate = true } = {}) {
    const [state, setState] = useState({ data: null, error: null, loading: immediate });
    const alive = useRef(true);
    useEffect(() => () => { alive.current = false; }, []);

    const run = useCallback(async (...args) => {
      setState((s) => ({ ...s, loading: true, error: null }));
      try {
        const data = await loader(...args);
        if (alive.current) setState({ data, error: null, loading: false });
        return data;
      } catch (error) {
        if (alive.current) setState({ data: null, error, loading: false });
        return null;
      }
    }, deps);

    useEffect(() => { if (immediate) run(); }, [run, immediate]);
    return { ...state, run, reset: () => setState({ data: null, error: null, loading: false }) };
  }

  const ErrorState = ({ error, onRetry }) => (
    <Callout tone="danger" icon="alert" title="Something went wrong">
      <p>{error && error.message ? error.message : String(error)}</p>
      {onRetry && (
        <Button variant="secondary" size="sm" className="mt-3" onClick={onRetry}>
          Try again
        </Button>
      )}
    </Callout>
  );

  window.UI = {
    cx, fmt, chartTheme,
    ThemeContext, useTheme, useAsync,
    Icon, Spinner, Card, SectionLabel, PageHeader, Button, SliderRow,
    SegmentedControl, Toggle, ChipSelect, Callout, Badge, CaveatBanner,
    SolveStatus, Skeleton, EmptyState, StatTile, Delta, DataTable,
    KeyValueList, UtilizationBar, Chart, ErrorState,
  };
})();
