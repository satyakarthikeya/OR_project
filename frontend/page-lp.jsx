/**
 * Part 1 — LP workforce and equipment allocation.
 *
 * The page follows the shape of the API on purpose: derived parameters are
 * fetched and shown *before* anything is optimised, so the coefficients can be
 * inspected and argued with first. Solving happens only on an explicit click.
 */
(function () {
  const { useState, useEffect, useCallback } = React;
  const {
    cx, fmt, Card, PageHeader, SectionLabel, Button, Callout, CaveatBanner,
    DataTable, Skeleton, ErrorState, SegmentedControl, SliderRow, Toggle,
    ChipSelect, KeyValueList, Icon,
  } = window.UI;
  const { ResultsSection } = window.LPResults;

  const OBJECTIVES = [
    { value: 'max_throughput', label: 'Max throughput' },
    { value: 'min_cost', label: 'Min cost' },
  ];

  const PEAK_OPTIONS = [
    { value: null, label: 'All hours' },
    { value: 1, label: 'Peak' },
    { value: 0, label: 'Off-peak' },
  ];

  const DEFAULTS = {
    filters: {
      terminals: [], cargo_types: [], priorities: [], weather: [], peak_hour: null,
    },
    labor_share: 0.6,
    cost_labor_share: 0.6,
    congestion_delta: 1.0,
    apply_congestion: true,
    demand_scale: 1.0,
    objective: 'max_throughput',
    workforce_pool_factor: 1.0,
    equipment_pool_factor: 1.0,
    budget_enabled: false,
    budget_factor: 1.0,
  };

  /** Debounce slider movement so parameters are re-derived once, not per pixel. */
  function useDebounced(value, delay) {
    const [debounced, setDebounced] = useState(value);
    useEffect(() => {
      const id = setTimeout(() => setDebounced(value), delay);
      return () => clearTimeout(id);
    }, [value, delay]);
    return debounced;
  }

  function parametersPayload(datasetId, c) {
    return {
      dataset_id: datasetId,
      filters: c.filters,
      labor_share: c.labor_share,
      cost_labor_share: c.cost_labor_share,
      congestion_delta: c.congestion_delta,
      apply_congestion: c.apply_congestion,
      demand_scale: c.demand_scale,
    };
  }

  function solvePayload(datasetId, c) {
    return {
      ...parametersPayload(datasetId, c),
      objective: c.objective,
      workforce_pool_factor: c.workforce_pool_factor,
      equipment_pool_factor: c.equipment_pool_factor,
      budget_factor: c.budget_enabled ? c.budget_factor : null,
    };
  }

  /* ----------------------------------------------------------------- page */

  function LPPage({ dataset }) {
    const [controls, setControls] = useState(DEFAULTS);
    const [vocab, setVocab] = useState(null);

    const [params, setParams] = useState({ data: null, error: null, loading: true });
    const [solve, setSolve] = useState({ data: null, error: null, loading: false });
    const [sensitivity, setSensitivity] = useState({ data: null, loading: false });
    const [solvedAt, setSolvedAt] = useState(null);

    const debounced = useDebounced(controls, 250);
    const set = (patch) => setControls((c) => ({ ...c, ...patch }));
    const setFilter = (patch) =>
      setControls((c) => ({ ...c, filters: { ...c.filters, ...patch } }));

    // Category vocabularies come from the dataset itself rather than being
    // duplicated in the frontend, so an upload with different categories still
    // produces usable filters.
    useEffect(() => {
      let alive = true;
      window.api.datasetSummary(dataset.dataset_id).then((summary) => {
        if (!alive) return;
        const of = (column) => {
          const entry = summary.categorical_counts.find((c) => c.column === column);
          return entry ? Object.keys(entry.counts).sort() : [];
        };
        setVocab({
          terminals: of('Terminal_ID'),
          cargo_types: of('Cargo_Type'),
          priorities: of('Shipment_Priority'),
          weather: of('Weather_Condition'),
        });
      }).catch(() => setVocab({
        terminals: [], cargo_types: [], priorities: [], weather: [],
      }));
      return () => { alive = false; };
    }, [dataset.dataset_id]);

    const paramsSignature = JSON.stringify(parametersPayload(dataset.dataset_id, debounced));
    const solveSignature = JSON.stringify(solvePayload(dataset.dataset_id, controls));

    useEffect(() => {
      let alive = true;
      setParams((p) => ({ ...p, loading: true, error: null }));
      window.api.lpParameters(JSON.parse(paramsSignature))
        .then((data) => alive && setParams({ data, error: null, loading: false }))
        .catch((error) => alive && setParams({ data: null, error, loading: false }));
      return () => { alive = false; };
    }, [paramsSignature]);

    const stale = solvedAt !== null && solvedAt !== solveSignature;

    const runSolve = useCallback(async () => {
      const payload = solvePayload(dataset.dataset_id, controls);
      const signature = JSON.stringify(payload);
      setSolve({ data: null, error: null, loading: true });
      setSensitivity({ data: null, loading: true });
      try {
        const result = await window.api.lpSolve(payload);
        setSolve({ data: result, error: null, loading: false });
        setSolvedAt(signature);
        if (result.status === 'Optimal') {
          try {
            const sweep = await window.api.lpSensitivity({ ...payload, points: 9 });
            setSensitivity({ data: sweep, loading: false });
          } catch (e) {
            setSensitivity({ data: null, loading: false });
          }
        } else {
          setSensitivity({ data: null, loading: false });
        }
      } catch (error) {
        setSolve({ data: null, error, loading: false });
        setSensitivity({ data: null, loading: false });
      }
    }, [dataset.dataset_id, controls]);

    return (
      <div>
        <PageHeader
          eyebrow="Part 1 — Linear programming"
          title="Workforce and equipment allocation"
          actions={
            <Button variant="primary" icon="play" busy={solve.loading}
              onClick={runSolve} disabled={!params.data}>
              {solve.loading ? 'Solving…' : 'Solve allocation'}
            </Button>
          }
        >
          Choose a planning scenario, inspect the coefficients it produces, then
          solve. Every parameter below is derived in closed form from that
          scenario's group means — nothing is fitted.
        </PageHeader>

        <CaveatBanner text={params.data && params.data.caveat} />

        <div className="grid items-start gap-6 lg:grid-cols-[340px_minmax(0,1fr)]">
          <div className="lg:sticky lg:top-[76px]">
            <ControlPanel
              controls={controls} vocab={vocab} set={set} setFilter={setFilter}
              params={params.data}
              onReset={() => setControls(DEFAULTS)}
            />
          </div>

          <div className="min-w-0 space-y-6">
            {params.error ? (
              <ErrorState error={params.error} />
            ) : (
              <ParametersCard state={params} controls={controls} />
            )}

            {solve.error && <ErrorState error={solve.error} onRetry={runSolve} />}

            {solve.data && (
              <ResultsSection
                result={solve.data} stale={stale} sensitivity={sensitivity}
                onResolve={runSolve} busy={solve.loading}
              />
            )}

            {!solve.data && !solve.error && !solve.loading && (
              <Card>
                <div className="flex flex-col items-center px-6 py-10 text-center">
                  <div className="border border-rule-firm p-3 text-faint">
                    <Icon name="play" className="h-6 w-6" />
                  </div>
                  <p className="mt-4 text-sm font-semibold text-ink">
                    No solve yet
                  </p>
                  <p className="mt-1.5 max-w-md text-sm leading-relaxed text-muted">
                    The parameters above are already derived for this scenario.
                    Solving runs CBC once and compares the result against the
                    observed allocation under the same objective function.
                  </p>
                  <Button variant="primary" icon="play" className="mt-5"
                    onClick={runSolve} disabled={!params.data}>
                    Solve allocation
                  </Button>
                </div>
              </Card>
            )}
          </div>
        </div>
      </div>
    );
  }

  /* -------------------------------------------------------------- controls */

  function ControlPanel({ controls, vocab, set, setFilter, params, onReset }) {
    const [tab, setTab] = useState('scenario');

    return (
      <Card
        title="Scenario"
        subtitle="Filters define the planning slice; assumptions define the coefficients."
        actions={
          <Button variant="ghost" size="sm" onClick={onReset}>Reset</Button>
        }
        bodyClass="p-0"
      >
        <div className="border-b border-rule px-5 pt-3">
          <SegmentedControl
            className="w-full"
            value={tab} onChange={setTab}
            options={[
              { value: 'scenario', label: 'Slice' },
              { value: 'assumptions', label: 'Assumptions' },
              { value: 'resources', label: 'Resources' },
            ]}
          />
        </div>

        <div className="divide-y divide-rule px-5">
          {tab === 'scenario' && (
            <React.Fragment>
              {!vocab ? (
                <div className="space-y-3 py-4">
                  <Skeleton className="h-4 w-1/2" />
                  <Skeleton className="h-8 w-full" />
                </div>
              ) : (
                <React.Fragment>
                  <ChipSelect label="Terminals" options={vocab.terminals}
                    selected={controls.filters.terminals}
                    onChange={(v) => setFilter({ terminals: v })}
                    hint="All four terminals included" />
                  <ChipSelect label="Cargo type" options={vocab.cargo_types}
                    selected={controls.filters.cargo_types}
                    onChange={(v) => setFilter({ cargo_types: v })} />
                  <ChipSelect label="Weather" options={vocab.weather}
                    selected={controls.filters.weather}
                    onChange={(v) => setFilter({ weather: v })} />
                  <ChipSelect label="Priority" options={vocab.priorities}
                    selected={controls.filters.priorities}
                    onChange={(v) => setFilter({ priorities: v })} />
                </React.Fragment>
              )}
              <div className="py-3">
                <label className="text-sm font-medium text-ink">
                  Hour of day
                </label>
                <div className="mt-2">
                  <SegmentedControl
                    value={controls.filters.peak_hour}
                    onChange={(v) => setFilter({ peak_hour: v })}
                    options={PEAK_OPTIONS}
                  />
                </div>
              </div>
              <div className="py-3">
                <p className="text-xs leading-relaxed text-muted">
                  {params
                    ? `${fmt.int(params.n_records)} records in this slice, across ${params.terminals.length} terminal(s).`
                    : 'Deriving…'}
                </p>
              </div>
            </React.Fragment>
          )}

          {tab === 'assumptions' && (
            <React.Fragment>
              <SliderRow
                label="Labour share θ" value={controls.labor_share}
                min={0.05} max={0.95} step={0.05}
                format={(v) => v.toFixed(2)}
                onChange={(v) => set({ labor_share: v })}
                hint="Share of throughput attributed to workers. The single free assumption behind α and β."
              />
              <SliderRow
                label="Cost labour share θ_c" value={controls.cost_labor_share}
                min={0.05} max={0.95} step={0.05}
                format={(v) => v.toFixed(2)}
                onChange={(v) => set({ cost_labor_share: v })}
                hint="With θ_c = θ the two resources are equally cost-efficient inside a terminal; separate them to create a substitution trade-off."
              />
              <Toggle
                label="Congestion multiplier γ" checked={controls.apply_congestion}
                onChange={(v) => set({ apply_congestion: v })}
                hint="Off, the terminals are near-identical and the allocation becomes a solver artefact. This switch exists to demonstrate that."
              />
              <SliderRow
                label="Congestion exponent δ" value={controls.congestion_delta}
                min={0} max={3} step={0.25}
                disabled={!controls.apply_congestion}
                format={(v) => v.toFixed(2)}
                onChange={(v) => set({ congestion_delta: v })}
                hint="Raises the weight on facility utilisation, widening the productivity spread between terminals."
              />
              <SliderRow
                label="Demand stress ×" value={controls.demand_scale}
                min={0.5} max={3} step={0.1}
                format={(v) => `${v.toFixed(1)}×`}
                onChange={(v) => set({ demand_scale: v })}
                hint="Scales every D_t. Above roughly 1.5× the terminals cannot meet demand and the shortfall is reported as slack."
              />
            </React.Fragment>
          )}

          {tab === 'resources' && (
            <React.Fragment>
              <div className="py-3">
                <label className="text-sm font-medium text-ink">
                  Objective
                </label>
                <div className="mt-2">
                  <SegmentedControl
                    className="w-full" value={controls.objective}
                    onChange={(v) => set({ objective: v })} options={OBJECTIVES}
                  />
                </div>
              </div>
              <SliderRow
                label="Worker pool" value={controls.workforce_pool_factor}
                min={0.8} max={1.2} step={0.05}
                format={(v) => `${(v * 100).toFixed(0)}%${
                  params ? ` · ${fmt.num(params.workforce_total * v, 1)}` : ''}`}
                onChange={(v) => set({ workforce_pool_factor: v })}
                hint="Relative to the total the terminals were observed to use. Above 100% is flagged as an expanded-resources scenario."
              />
              <SliderRow
                label="Equipment pool" value={controls.equipment_pool_factor}
                min={0.8} max={1.2} step={0.05}
                format={(v) => `${(v * 100).toFixed(0)}%${
                  params ? ` · ${fmt.num(params.equipment_total * v, 1)}` : ''}`}
                onChange={(v) => set({ equipment_pool_factor: v })}
              />
              <Toggle
                label="Budget cap" checked={controls.budget_enabled}
                onChange={(v) => set({ budget_enabled: v })}
                hint="Cap total operational cost as a multiple of the baseline cost."
              />
              <SliderRow
                label="Budget" value={controls.budget_factor}
                min={0.5} max={2} step={0.05}
                disabled={!controls.budget_enabled}
                format={(v) => `${(v * 100).toFixed(0)}%${
                  params ? ` · ${fmt.money(params.baseline_cost * v)}` : ''}`}
                onChange={(v) => set({ budget_factor: v })}
              />
              {(controls.workforce_pool_factor > 1 ||
                controls.equipment_pool_factor > 1) && (
                <div className="py-3">
                  <Callout tone="warn" icon="alert">
                    Expanded-resources scenario: part of any gain is bought with
                    extra resources rather than earned by re-allocating.
                  </Callout>
                </div>
              )}
            </React.Fragment>
          )}
        </div>
      </Card>
    );
  }

  /* ------------------------------------------------------------ parameters */

  function ParametersCard({ state, controls }) {
    const [showDerivation, setShowDerivation] = useState(false);
    const params = state.data;

    if (!params) {
      return (
        <Card title="Derived parameters">
          <div className="space-y-3">
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="h-32 w-full" />
          </div>
        </Card>
      );
    }

    const congestionOn = params.assumptions.congestion_applied;

    return (
      <Card
        title="Derived parameters"
        subtitle="Computed from this scenario's group means, before any optimisation runs."
        actions={
          <div className="flex items-center gap-2">
            {state.loading && (
              <span className="text-xs text-faint">updating…</span>
            )}
            <Button size="sm" variant="ghost"
              onClick={() => setShowDerivation((v) => !v)}>
              {showDerivation ? 'Hide derivation' : 'How these were derived'}
            </Button>
          </div>
        }
        bodyClass="p-0"
      >
        <div className={cx('transition-opacity', state.loading && 'opacity-60')}>
          <DataTable
            compact
            rowKey={(r) => r.terminal}
            rows={params.terminals}
            // These headers are mathematical symbols, so the usual uppercase
            // header treatment is switched off for the whole table.
            headerClass="normal-case tracking-normal"
            columns={[
              { key: 'terminal', header: 'Terminal',
                className: 'font-medium text-ink' },
              { key: 'alpha', header: 'α per worker', align: 'right',
                render: (r) => fmt.num(r.alpha, 3) },
              { key: 'beta', header: 'β per unit', align: 'right',
                render: (r) => fmt.num(r.beta, 3) },
              { key: 'congestion', header: 'γ', align: 'right',
                render: (r) => (
                  <span className={congestionOn ? '' : 'text-faint'}>
                    {fmt.num(r.congestion, 3)}
                  </span>
                ) },
              { key: 'cost_worker', header: 'cost/worker', align: 'right',
                render: (r) => fmt.num(r.cost_worker, 1) },
              { key: 'cost_equipment', header: 'cost/unit', align: 'right',
                render: (r) => fmt.num(r.cost_equipment, 1) },
              { key: 'demand', header: 'demand D', align: 'right',
                render: (r) => fmt.num(r.demand, 1) },
              { key: 'capacity', header: 'capacity', align: 'right',
                render: (r) => fmt.num(r.capacity, 1) },
              { key: 'workforce', header: 'w range', align: 'right',
                render: (r) => `${fmt.num(r.workforce_min, 0)}–${fmt.num(r.workforce_max, 0)}` },
              { key: 'equipment', header: 'e range', align: 'right',
                render: (r) => `${fmt.num(r.equipment_min, 0)}–${fmt.num(r.equipment_max, 0)}` },
            ]}
          />
        </div>

        <div className="border-t border-rule px-5 py-4">
          <KeyValueList
            columns={3}
            items={[
              { label: 'Worker pool W', value: fmt.num(params.workforce_total, 1) },
              { label: 'Equipment pool E', value: fmt.num(params.equipment_total, 1) },
              { label: 'Records in slice', value: fmt.int(params.n_records) },
              { label: 'Baseline throughput',
                value: fmt.num(params.baseline_throughput, 2) },
              { label: 'Baseline cost', value: fmt.money(params.baseline_cost) },
              { label: 'Baseline unmet demand',
                value: fmt.num(params.baseline_unmet_demand, 2) },
              { label: 'Demand unit scale',
                value: fmt.num(params.assumptions.demand_unit_scale, 4) },
              { label: 'Unmet-demand penalty M',
                value: fmt.num(params.unmet_penalty[controls.objective], 1) },
              { label: 'Capacity percentile',
                value: fmt.ratio(params.assumptions.capacity_percentile) },
            ]}
          />
        </div>

        {!congestionOn && (
          <div className="px-5 pb-4">
            <Callout tone="warn" icon="alert" title="Congestion multiplier is off">
              With γ = 1 the terminals are statistically interchangeable, so the
              LP has no reason to prefer any of them and the allocation it
              returns is an artefact of solver scan order rather than a decision.
            </Callout>
          </div>
        )}

        {params.warnings.length > 0 && (
          <div className="px-5 pb-4">
            <Callout tone="warn" icon="alert" title="Scenario warnings">
              <ul className="list-disc space-y-1 pl-5">
                {params.warnings.map((w, i) => <li key={i}>{w}</li>)}
              </ul>
            </Callout>
          </div>
        )}

        {showDerivation && (
          <div className="border-t border-rule px-5 py-5">
            <SectionLabel>Derivation</SectionLabel>
            <dl className="mt-3 space-y-4">
              {params.derivation.map((note) => (
                <div key={note.symbol}
                  className="border-l-2 border-accent-fill bg-sunken py-3 pl-4 pr-4">
                  <dt className="flex flex-wrap items-baseline gap-2">
                    <span className="font-mono text-sm font-semibold text-accent">
                      {note.symbol}
                    </span>
                    <span className="text-sm font-medium text-ink">
                      {note.name}
                    </span>
                  </dt>
                  <dd className="mt-2">
                    <code className="block overflow-x-auto rounded bg-panel px-3 py-2 font-mono text-xs text-body">
                      {note.formula}
                    </code>
                    <p className="mt-2 text-sm leading-relaxed text-muted">
                      {note.explanation}
                    </p>
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        )}
      </Card>
    );
  }


  window.Pages = Object.assign(window.Pages || {}, { LPPage });
})();