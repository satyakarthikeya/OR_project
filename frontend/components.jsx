/**
 * The shared component vocabulary.
 *
 * Built before any page markup, on purpose: page-level ad-hoc styling is what
 * makes a hand-rolled UI look inconsistent (AGENT.md, "Frontend rules").
 *
 * The design is a dispatch desk, not a card dashboard. House rules:
 *   · Panels are ruled sheets — square corners, hairline borders, no shadows.
 *   · Colour comes only from semantic tokens (`bg-panel`, `text-ink`,
 *     `border-rule`, `text-accent`, `text-pos`, `text-neg`). Never a raw
 *     palette value, never a `dark:` colour pair — the tokens carry the theme.
 *   · Signal amber is the accent and is spent only on active state, the primary
 *     action, focus, and the lead chart series. Positive/negative are jade and
 *     brick, kept clear of the accent.
 *   · Every numeral is Plex Mono with tabular figures, via `.num`.
 *   · Structure is information: a left stripe means binding, a hazard edge
 *     means the standing caveat. Decoration that says nothing is omitted.
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
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"
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

  /**
   * A ruled sheet. The header is separated by a hairline that runs the full
   * width, the way a form divides its fields — not by whitespace alone.
   */
  const Card = ({ title, subtitle, actions, children, className, bodyClass,
                  dense, stripe }) => (
    <section className={cx('relative border border-rule bg-panel', className)}>
      {stripe && (
        <span aria-hidden="true"
          className={cx('absolute inset-y-0 left-0 w-[3px]',
            stripe === 'accent' ? 'bg-accent-fill'
              : stripe === 'neg' ? 'bg-neg' : 'bg-pos')} />
      )}
      {(title || actions) && (
        <header className="flex items-start justify-between gap-4 border-b border-rule px-5 py-3.5">
          <div className="min-w-0">
            {title && (
              <h2 className="text-[13px] font-semibold tracking-tight text-ink">
                {title}
              </h2>
            )}
            {subtitle && (
              <p className="mt-1 max-w-prose text-[13px] leading-relaxed text-muted">
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
    <h3 className={cx('field-label', className)}>{children}</h3>
  );

  const PageHeader = ({ eyebrow, title, children, actions }) => (
    <div className="mb-6 border-b border-rule-firm pb-5">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="max-w-2xl">
          {eyebrow && <p className="field-label text-accent">{eyebrow}</p>}
          <h1 className="mt-2 text-[22px] font-semibold leading-tight tracking-tight text-ink"
              style={{ textWrap: 'balance' }}>
            {title}
          </h1>
          {children && (
            <p className="mt-2.5 text-sm leading-relaxed text-body">{children}</p>
          )}
        </div>
        {actions}
      </div>
    </div>
  );

  /* --------------------------------------------------------------- inputs */

  const BUTTON_VARIANTS = {
    primary: 'bg-accent-fill text-accent-ink hover:brightness-95 disabled:opacity-50',
    secondary: 'border border-rule-firm bg-panel text-ink hover:bg-sunken disabled:opacity-50',
    ghost: 'text-muted hover:bg-sunken hover:text-ink disabled:opacity-50',
  };

  const Button = ({ variant = 'secondary', size = 'md', busy, icon, children,
                    className, ...rest }) => (
    <button
      {...rest}
      disabled={rest.disabled || busy}
      className={cx(
        'inline-flex items-center justify-center gap-2 font-medium transition-colors',
        'disabled:cursor-not-allowed',
        size === 'sm' ? 'px-2.5 py-1.5 text-xs' : 'px-4 py-2 text-[13px]',
        BUTTON_VARIANTS[variant], className
      )}
    >
      {busy ? <Spinner /> : icon ? <Icon name={icon} /> : null}
      {children}
    </button>
  );

  const SliderRow = ({ label, hint, value, min, max, step, onChange, format,
                       disabled }) => (
    <div className={cx('py-3.5', disabled && 'opacity-40')}>
      <div className="flex items-baseline justify-between gap-3">
        <label className="text-[13px] font-medium text-ink">{label}</label>
        <span className="num text-[13px] font-medium text-ink">
          {format ? format(value) : value}
        </span>
      </div>
      <input
        type="range" min={min} max={max} step={step} value={value}
        disabled={disabled}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="mt-2.5 h-1 w-full cursor-pointer appearance-none bg-rule-firm accent-accent-fill"
      />
      {hint && (
        <p className="mt-2 text-xs leading-relaxed text-muted">{hint}</p>
      )}
    </div>
  );

  /** Square segmented control — a row of stops on a rule, not a pill group. */
  const SegmentedControl = ({ options, value, onChange, className }) => (
    <div className={cx('inline-flex border border-rule-firm', className)}>
      {options.map((option, index) => (
        <button
          key={String(option.value)}
          onClick={() => onChange(option.value)}
          aria-pressed={value === option.value}
          className={cx(
            'flex-1 whitespace-nowrap px-3 py-1.5 text-xs font-medium transition-colors',
            index > 0 && 'border-l border-rule-firm',
            value === option.value
              ? 'bg-accent-fill text-accent-ink'
              : 'bg-panel text-muted hover:bg-sunken hover:text-ink'
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );

  const Toggle = ({ label, hint, checked, onChange }) => (
    <div className="flex items-start justify-between gap-4 py-3.5">
      <div className="min-w-0">
        <p className="text-[13px] font-medium text-ink">{label}</p>
        {hint && <p className="mt-1.5 text-xs leading-relaxed text-muted">{hint}</p>}
      </div>
      <button
        role="switch" aria-checked={checked} aria-label={label}
        onClick={() => onChange(!checked)}
        className={cx(
          'relative mt-0.5 h-5 w-9 shrink-0 border transition-colors',
          checked
            ? 'border-accent-fill bg-accent-fill'
            : 'border-rule-firm bg-sunken'
        )}
      >
        <span
          className={cx('absolute left-0.5 top-0.5 h-3.5 w-3.5 transition-transform',
            checked ? 'bg-accent-ink' : 'bg-rule-firm')}
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
      <div className="py-3.5">
        <div className="flex items-baseline justify-between gap-3">
          <label className="text-[13px] font-medium text-ink">{label}</label>
          {selected.length > 0 && (
            <button onClick={() => onChange([])}
              className="font-mono text-[10px] uppercase tracking-wider text-muted underline-offset-2 hover:text-ink hover:underline">
              clear
            </button>
          )}
        </div>
        <div className="mt-2.5 flex flex-wrap gap-1">
          {options.map((option) => {
            const active = selected.includes(option);
            return (
              <button
                key={option} onClick={() => toggle(option)} aria-pressed={active}
                className={cx(
                  'border px-2.5 py-1 font-mono text-[11px] transition-colors',
                  active
                    ? 'border-accent-fill bg-accent-fill text-accent-ink'
                    : 'border-rule-firm bg-panel text-body hover:bg-sunken hover:text-ink'
                )}
              >
                {option}
              </button>
            );
          })}
        </div>
        <p className="mt-2 font-mono text-[10px] uppercase tracking-wider text-muted">
          {selected.length === 0 ? (hint || 'all included') : `${selected.length} selected`}
        </p>
      </div>
    );
  };

  /* -------------------------------------------------------------- feedback */

  const TONES = {
    neutral: 'border-rule bg-sunken text-body',
    accent: 'border-accent-fill/50 bg-accent-wash text-ink',
    warn: 'border-accent-fill/50 bg-accent-wash text-ink',
    danger: 'border-neg/40 bg-neg-wash text-ink',
    good: 'border-pos/40 bg-pos-wash text-ink',
  };

  const ICON_TONES = {
    neutral: 'text-muted', accent: 'text-accent', warn: 'text-accent',
    danger: 'text-neg', good: 'text-pos',
  };

  const Callout = ({ tone = 'neutral', icon = 'info', title, children, className }) => (
    <div className={cx('border px-4 py-3', TONES[tone], className)}>
      <div className="flex gap-3">
        <Icon name={icon} className={cx('mt-0.5 h-4 w-4 shrink-0', ICON_TONES[tone])} />
        <div className="min-w-0 text-[13px] leading-relaxed">
          {title && <p className="font-semibold text-ink">{title}</p>}
          <div className={title ? 'mt-1' : ''}>{children}</div>
        </div>
      </div>
    </div>
  );

  const BADGE_TONES = {
    neutral: 'border-rule-firm text-muted',
    accent: 'border-accent-fill bg-accent-fill text-accent-ink',
    good: 'border-pos/50 bg-pos-wash text-pos',
    warn: 'border-accent-fill/60 bg-accent-wash text-accent',
    danger: 'border-neg/50 bg-neg-wash text-neg',
  };

  const Badge = ({ tone = 'neutral', children, className }) => (
    <span className={cx(
      'inline-flex items-center border px-1.5 py-0.5 font-mono text-[10px] font-medium uppercase tracking-wider',
      BADGE_TONES[tone], className
    )}>
      {children}
    </span>
  );

  /**
   * The standing honesty banner (AGENT.md — never remove it).
   * Rendered as apron hazard tape: this is the one notice in the interface that
   * warns about the validity of the work itself, so it gets the one device
   * nothing else uses.
   */
  const CaveatBanner = ({ text }) => (
    <div className="mb-6 flex border border-rule bg-panel">
      <span aria-hidden="true" className="hazard-edge w-2 shrink-0" />
      <div className="flex gap-3 px-4 py-3">
        <Icon name="alert" className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
        <div className="text-[13px] leading-relaxed text-body">
          <p className="field-label text-accent">Model-world results</p>
          <p className="mt-1.5">
            {text || 'The dataset is synthetic and its columns are mutually ' +
              'uncorrelated, so coefficients are derived from stated assumptions ' +
              'rather than fitted. Improvements are gains under those ' +
              'assumptions, not validated operational gains.'}
          </p>
        </div>
      </div>
    </div>
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
      <p className="text-body">{message}</p>
      {suggestions && suggestions.length > 0 && (
        <ul className="mt-2 list-disc space-y-1 pl-5 text-body">
          {suggestions.map((s, i) => <li key={i}>{s}</li>)}
        </ul>
      )}
      {seconds !== undefined && status === 'Optimal' && (
        <p className="num mt-1.5 text-[11px] text-muted">
          CBC · {fmt.num(seconds, 3)} s
        </p>
      )}
    </Callout>
  );

  const Skeleton = ({ className = 'h-4 w-full' }) => (
    <div className={cx('skeleton', className)} />
  );

  const EmptyState = ({ icon = 'database', title, children, action }) => (
    <div className="flex flex-col items-center justify-center px-6 py-14 text-center">
      <div className="border border-rule-firm p-3 text-faint">
        <Icon name={icon} className="h-5 w-5" />
      </div>
      <p className="mt-4 text-[13px] font-semibold text-ink">{title}</p>
      {children && (
        <p className="mt-2 max-w-sm text-[13px] leading-relaxed text-muted">
          {children}
        </p>
      )}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );

  /* ----------------------------------------------------------------- data */

  /** A readout block: field label over a mono figure, ruled like a load sheet. */
  const StatTile = ({ label, value, unit, hint, tone = 'neutral' }) => (
    <div className="border border-rule bg-panel px-4 py-3">
      <p className="field-label truncate">{label}</p>
      <p className="num mt-2 flex items-baseline gap-1.5">
        <span className={cx('text-[26px] font-medium leading-none tracking-tight',
          tone === 'good' ? 'text-pos' : tone === 'danger' ? 'text-neg' : 'text-ink')}>
          {value}
        </span>
        {unit && <span className="text-[11px] text-muted">{unit}</span>}
      </p>
      {hint && (
        <p className="mt-2 truncate border-t border-rule pt-2 text-[11px] text-muted"
           title={hint}>
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
      <span className={cx('num inline-flex items-baseline gap-1.5 font-medium',
        neutral ? 'text-muted' : good ? 'text-pos' : 'text-neg')}>
        {fmt.signed(value, digits)}
        {percent !== null && percent !== undefined && (
          <span className="text-[11px] opacity-80">({fmt.percent(percent)})</span>
        )}
      </span>
    );
  };

  /**
   * Columns: { key, header, align, render(row), className }.
   * `rowStripe(row)` returns 'accent' | 'neg' | 'pos' | null to mark a row's
   * state in form as well as in number.
   */
  const DataTable = ({ columns, rows, rowKey, footer, emptyMessage, compact,
                       headerClass, rowStripe }) => {
    if (!rows || rows.length === 0) {
      return (
        <p className="px-5 py-8 text-center text-[13px] text-muted">
          {emptyMessage || 'No rows'}
        </p>
      );
    }
    const cell = compact ? 'px-3 py-2' : 'px-4 py-2.5';
    return (
      <div className="overflow-x-auto">
        <table className="w-full min-w-full text-[13px]">
          <thead>
            <tr className="border-b border-rule-firm">
              {columns.map((col, index) => (
                <th key={col.key} scope="col"
                  className={cx(
                    cell, 'whitespace-nowrap font-mono text-[10px] font-medium uppercase',
                    'text-muted',
                    col.align === 'right' ? 'text-right' : 'text-left',
                    rowStripe && index === 0 && 'pl-5',
                    // Headers carrying Greek symbols opt out: `uppercase`
                    // silently turns α into Α and γ into Γ.
                    headerClass
                  )}
                  style={{ letterSpacing: '0.09em' }}>
                  {col.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-rule">
            {rows.map((row, index) => {
              const stripe = rowStripe && rowStripe(row);
              return (
                <tr key={rowKey ? rowKey(row) : index}
                  className="relative transition-colors hover:bg-sunken">
                  {columns.map((col, colIndex) => (
                    <td key={col.key}
                      className={cx(
                        cell, 'whitespace-nowrap',
                        col.align === 'right' ? 'num text-right' : 'text-left',
                        rowStripe && colIndex === 0 && 'relative pl-5',
                        col.className || 'text-body'
                      )}>
                      {rowStripe && colIndex === 0 && (
                        <span aria-hidden="true"
                          className={cx('absolute inset-y-0 left-0 w-[3px]',
                            stripe === 'accent' ? 'bg-accent-fill'
                              : stripe === 'neg' ? 'bg-neg'
                              : stripe === 'pos' ? 'bg-pos' : 'bg-transparent')} />
                      )}
                      {col.render ? col.render(row, index) : row[col.key]}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
          {footer && <tfoot className="border-t border-rule-firm">{footer}</tfoot>}
        </table>
      </div>
    );
  };

  /** Label/value pairs for parameter and assumption panels. */
  const KeyValueList = ({ items, columns = 2 }) => (
    <dl className={cx('grid gap-x-8 gap-y-4',
      columns === 3 ? 'sm:grid-cols-3' : columns === 2 ? 'sm:grid-cols-2' : '')}>
      {items.map((item) => (
        <div key={item.label} className="min-w-0">
          <dt className="field-label truncate">{item.label}</dt>
          <dd className="num mt-1 truncate text-[13px] font-medium text-ink"
              title={String(item.value)}>
            {item.value}
          </dd>
        </div>
      ))}
    </dl>
  );

  /** "Used out of available", with the bar turning amber once it binds. */
  const UtilizationBar = ({ label, used, available, unit, digits = 1 }) => {
    const pct = available > 0 ? Math.min(100, (used / available) * 100) : 0;
    const tight = pct > 99.5;
    return (
      <div>
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-[13px] text-body">{label}</span>
          <span className="num text-[13px] font-medium text-ink">
            {fmt.num(used, digits)} / {fmt.num(available, digits)}
            {unit && <span className="ml-1 text-[11px] text-muted">{unit}</span>}
          </span>
        </div>
        <div className="mt-2 h-1.5 w-full bg-sunken ring-1 ring-inset ring-rule">
          <div className={cx('h-full transition-all',
            tight ? 'bg-accent-fill' : 'bg-rule-firm')}
            style={{ width: `${pct}%` }} />
        </div>
        <p className="num mt-1.5 text-[11px] text-muted">
          {fmt.num(pct, 1)}% used{tight ? ' · binding' : ''}
        </p>
      </div>
    );
  };

  /* --------------------------------------------------------------- charts */

  /**
   * Plotly palette and layout defaults, resolved per theme.
   *
   * The only place in the frontend that holds literal colour values: Plotly
   * takes concrete strings and cannot read the CSS variables the rest of the
   * interface is built on. These mirror the tokens in index.html — change one
   * and change the other. The lead series is the accent; comparison series stay
   * neutral, so amber always means "this is the thing being decided".
   */
  function chartTheme(theme) {
    const dark = theme === 'dark';
    return {
      dark,
      font: dark ? '#B2B8BF' : '#474D54',
      grid: dark ? 'rgba(150,156,164,0.14)' : 'rgba(106,112,120,0.14)',
      zero: dark ? 'rgba(150,156,164,0.3)' : 'rgba(106,112,120,0.28)',
      accent: dark ? '#F0AE45' : '#D9902A',
      muted: dark ? '#5A636C' : '#AFB4AC',
      pos: dark ? '#4FB894' : '#1F7A5C',
      neg: dark ? '#F27469' : '#B3261E',
      series: dark
        ? ['#F0AE45', '#5A636C', '#4FB894', '#F27469', '#7FA8C9']
        : ['#D9902A', '#AFB4AC', '#1F7A5C', '#B3261E', '#41688A'],
      hoverBg: dark ? '#171B1F' : '#FFFFFF',
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
        tickfont: { size: 10, family: '"IBM Plex Mono", monospace' },
        automargin: true,
      };
      const merged = {
        margin: { l: 8, r: 8, t: 8, b: 8 },
        paper_bgcolor: 'transparent',
        plot_bgcolor: 'transparent',
        font: { color: t.font, size: 11,
                family: '"IBM Plex Sans", system-ui, sans-serif' },
        colorway: t.series,
        hoverlabel: {
          bgcolor: t.hoverBg, bordercolor: t.grid,
          font: { color: t.font, size: 11,
                  family: '"IBM Plex Mono", monospace' },
        },
        legend: { orientation: 'h', y: -0.2, x: 0, font: { size: 10 } },
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
      <p className="text-body">
        {error && error.message ? error.message : String(error)}
      </p>
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
