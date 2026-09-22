/**
 * Part 2 — IP shipment selection.
 *
 * Same shape as Part 1: the batch and every value score are fetched and shown
 * *before* anything is optimised, so the coefficients can be inspected and
 * argued with first. Solving happens only on an explicit click.
 *
 * The one structural idea worth pointing at on screen: the worker-minute
 * constraint's right-hand side comes from Part 1's solved allocation, so this
 * page spends what the other page allocated. The "use Part 1" switch makes
 * that visible, and turning it off shows the weaker self-referential form.
 */
(function () {
  const { useState, useEffect, useCallback } = React;
  const {
    cx, fmt, Card, PageHeader, SectionLabel, Button, Badge, Callout,
    CaveatBanner, DataTable, Skeleton, ErrorState, SegmentedControl, SliderRow,
    Toggle, ChipSelect, KeyValueList, Icon,
  } = window.UI;
  const { IPResultsSection } = window.IPResults;

  const PRIORITIES = ['Critical', 'High', 'Medium', 'Low'];

  const DEFAULTS = {
    filters: {
      terminals: [], cargo_types: [], priorities: [], weather: [], peak_hour: null,
    },
    size: 50,
    capacity_fraction: 0.6,
    lambda_waiting: 0.5,
    lambda_queue: 0.5,
    priority_weights: { Critical: 10, High: 5, Medium: 2, Low: 1 },
    force_critical: false,
    hazardous_enabled: false,
    max_hazardous: 5,
    perishable_enabled: false,
    min_perishable: 3,
    use_lp: true,
  };

  /** Debounce slider movement so the batch is rebuilt once, not per pixel. */
  function useDebounced(value, delay) {
    const [debounced, setDebounced] = useState(value);
    useEffect(() => {
      const id = setTimeout(() => setDebounced(value), delay);
      return () => clearTimeout(id);
    }, [value, delay]);
    return debounced;
  }

  function batchPayload(datasetId, c) {
    return {
      dataset_id: datasetId,
      filters: c.filters,
      size: c.size,
      priority_weights: c.priority_weights,
      lambda_waiting: c.lambda_waiting,
      lambda_queue: c.lambda_queue,
      capacity_fraction: c.capacity_fraction,
    };
  }

  function solvePayload(datasetId, c, lpWorkforce) {
    return {
      ...batchPayload(datasetId, c),
      force_critical: c.force_critical,
      max_hazardous: c.hazardous_enabled ? c.max_hazardous : null,
      min_perishable: c.perishable_enabled ? c.min_perishable : null,
      lp_workforce: c.use_lp ? lpWorkforce : null,
    };
  }

  /* ----------------------------------------------------------------- page */

  function IPPage({ dataset, lpRun }) {
    const [controls, setControls] = useState(DEFAULTS);
    const [vocab, setVocab] = useState(null);
    const [fallback, setFallback] = useState({
      workforce: null, loading: true, error: null,
    });

    const [batch, setBatch] = useState({ data: null, error: null, loading: true });
    const [solve, setSolve] = useState({ data: null, error: null, loading: false });
    const [solvedAt, setSolvedAt] = useState(null);

    const debounced = useDebounced(controls, 300);
    const set = (patch) => setControls((c) => ({ ...c, ...patch }));
    const setFilter = (patch) =>
      setControls((c) => ({ ...c, filters: { ...c.filters, ...patch } }));

    // Vocabularies come from the dataset itself, so an upload with different
    // categories still produces usable filters.
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

    // Part 1's allocation is the right-hand side of constraint (2), so it has
    // to be the allocation the *user* solved for: objective and sliders move
    // w_t* by several times over, and a T2 staffed at 48 workers is a very
    // different window from the same T2 at 10. The shell holds that run and
    // hands it down as `lpRun`.
    //
    // Only when Part 1 has not been run at all does this page solve it itself,
    // on defaults, so a user who lands here first still sees a coupled model —
    // and the panel says plainly which of the two it is looking at.
    const needsFallback = !lpRun;

    useEffect(() => {
      if (!needsFallback) return undefined;
      let alive = true;
      setFallback({ workforce: null, loading: true, error: null });
      window.api.lpSolve({ dataset_id: dataset.dataset_id })
        .then((result) => {
          if (!alive) return;
          if (result.status !== 'Optimal') {
            setFallback({ workforce: null, loading: false, error: result.message });
            return;
          }
          const workforce = {};
          result.allocation.forEach((r) => {
            workforce[r.terminal] = r.optimized_workforce;
          });
          setFallback({ workforce, loading: false, error: null });
        })
        .catch((e) => alive && setFallback({
          workforce: null, loading: false, error: e.message,
        }));
      return () => { alive = false; };
    }, [dataset.dataset_id, needsFallback]);

    const lp = lpRun
      ? {
          workforce: lpRun.workforce,
          loading: false,
          error: null,
          source: 'user_run',
          objectiveLabel: lpRun.objective_label,
        }
      : { ...fallback, source: 'defaults', objectiveLabel: null };

    const batchSignature = JSON.stringify(batchPayload(dataset.dataset_id, debounced));
    const solveSignature = JSON.stringify(
      solvePayload(dataset.dataset_id, controls, lp.workforce)
    );

    useEffect(() => {
      let alive = true;
      setBatch((b) => ({ ...b, loading: true, error: null }));
      window.api.ipBatch(JSON.parse(batchSignature))
        .then((data) => alive && setBatch({ data, error: null, loading: false }))
        .catch((error) => alive && setBatch({ data: null, error, loading: false }));
      return () => { alive = false; };
    }, [batchSignature]);

    const stale = solvedAt !== null && solvedAt !== solveSignature;

    const runSolve = useCallback(async () => {
      const payload = solvePayload(dataset.dataset_id, controls, lp.workforce);
      const signature = JSON.stringify(payload);
      setSolve({ data: null, error: null, loading: true });
      try {
        const result = await window.api.ipSolve(payload);
        setSolve({ data: result, error: null, loading: false });
        setSolvedAt(signature);
      } catch (error) {
        setSolve({ data: null, error, loading: false });
      }
    }, [dataset.dataset_id, controls, lp.workforce]);

    return (
      <div>
        <PageHeader
          eyebrow="Part 2 — Integer programming"
          title="Shipment selection under capacity"
          actions={
            <Button variant="primary" icon="play" busy={solve.loading}
              onClick={runSolve} disabled={!batch.data}>
              {solve.loading ? 'Solving…' : 'Solve selection'}
            </Button>
          }
        >
          A 0-1 multi-dimensional knapsack over one planning window: which
          shipments get processed when volume, worker-minutes and
          equipment-minutes all run out. The worker-minute budget is indexed by
          terminal and comes from Part 1, so this page spends the allocation the
          other page chose.
        </PageHeader>

        <CaveatBanner text={batch.data && batch.data.caveat} />

        <div className="grid items-start gap-6 lg:grid-cols-[340px_minmax(0,1fr)]">
          <div className="lg:sticky lg:top-[76px]">
            <ControlPanel
              controls={controls} vocab={vocab} set={set} setFilter={setFilter}
              batch={batch.data} lp={lp}
              onReset={() => setControls(DEFAULTS)}
            />
          </div>

          <div className="min-w-0 space-y-6">
            {batch.error ? (
              <ErrorState error={batch.error} />
            ) : (
              <BatchCard state={batch} lp={lp} useLp={controls.use_lp} />
            )}

            {solve.error && <ErrorState error={solve.error} onRetry={runSolve} />}

            {solve.data && (
              <IPResultsSection result={solve.data} stale={stale}
                onResolve={runSolve} busy={solve.loading} />
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
                    The batch above is already scored. Solving runs CBC once
                    and compares the optimal set against first-come,
                    first-served under identical capacities and the identical
                    value function.
                  </p>
                  <Button variant="primary" icon="play" className="mt-5"
                    onClick={runSolve} disabled={!batch.data}>
                    Solve selection
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

  function ControlPanel({ controls, vocab, set, setFilter, batch, lp, onReset }) {
    const [tab, setTab] = useState('batch');

    return (
      <Card
        title="Batch"
        subtitle="Filters pick the candidate set; weights decide what it is worth."
        actions={<Button variant="ghost" size="sm" onClick={onReset}>Reset</Button>}
        bodyClass="p-0"
      >
        <div className="border-b border-rule px-5 pt-3">
          <SegmentedControl
            className="w-full"
            value={tab} onChange={setTab}
            options={[
              { value: 'batch', label: 'Slice' },
              { value: 'value', label: 'Value' },
              { value: 'capacity', label: 'Capacity' },
              { value: 'policy', label: 'Policy' },
            ]}
          />
        </div>

        <div className="divide-y divide-rule px-5">
          {tab === 'batch' && (
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
                  <ChipSelect label="Priority" options={vocab.priorities}
                    selected={controls.filters.priorities}
                    onChange={(v) => setFilter({ priorities: v })} />
                </React.Fragment>
              )}
              <SliderRow
                label="Batch size" value={controls.size}
                min={10} max={200} step={5}
                format={(v) => `${v} shipments`}
                onChange={(v) => set({ size: v })}
                hint="CBC handles all 5,000 binaries; 30–100 keeps the table readable."
              />
            </React.Fragment>
          )}

          {tab === 'value' && (
            <React.Fragment>
              <div className="py-3">
                <SectionLabel>Priority weights p</SectionLabel>
                <p className="mt-2 text-xs leading-relaxed text-muted">
                  Priority is lexicographic and urgency is only a tiebreaker, so
                  keep adjacent classes more than 1.9× apart — below that an
                  urgent shipment can outrank the class above it.
                </p>
                <div className="mt-3 space-y-3">
                  {PRIORITIES.map((p) => (
                    <SliderRow
                      key={p} label={p} value={controls.priority_weights[p]}
                      min={1} max={20} step={1}
                      format={(v) => fmt.num(v, 0)}
                      onChange={(v) => set({
                        priority_weights: { ...controls.priority_weights, [p]: v },
                      })}
                    />
                  ))}
                </div>
              </div>
              <SliderRow
                label="λ_w — waiting time" value={controls.lambda_waiting}
                min={0} max={1} step={0.1}
                format={(v) => v.toFixed(1)}
                onChange={(v) => set({ lambda_waiting: v })}
                hint="Balance, not size: the uplift is capped at U = 0.9 whatever the λ."
              />
              <SliderRow
                label="λ_q — queue length" value={controls.lambda_queue}
                min={0} max={1} step={0.1}
                format={(v) => v.toFixed(1)}
                onChange={(v) => set({ lambda_queue: v })}
              />
            </React.Fragment>
          )}

          {tab === 'capacity' && (
            <React.Fragment>
              <SliderRow
                label="Capacity fraction f" value={controls.capacity_fraction}
                min={0.1} max={1} step={0.05}
                format={(v) => `${(v * 100).toFixed(0)}%`}
                onChange={(v) => set({ capacity_fraction: v })}
                hint="Volume and equipment-minutes as a share of the batch totals. Lower f binds harder; at 100% everything fits and there is nothing to choose."
              />
              <Toggle
                label="Take worker-minutes from Part 1"
                checked={controls.use_lp}
                onChange={(v) => set({ use_lp: v })}
                hint="On, constraint (2)'s right-hand side is w_t* × H × 60 per terminal. Off, the batch's own consumption stands in — a weaker, self-referential claim."
              />
              <div className="py-3">
                {lp.loading ? (
                  <Skeleton className="h-16 w-full" />
                ) : lp.error ? (
                  <Callout tone="warn" icon="alert">
                    Part 1 did not solve on the default scenario, so the
                    worker-minute budgets fall back to the batch's own
                    consumption.
                  </Callout>
                ) : controls.use_lp ? (
                  <React.Fragment>
                    <SectionLabel>Part 1 allocation w*</SectionLabel>
                    {/* Which Part 1 run this is matters more than the numbers:
                        the same batch under a min-cost allocation and a
                        max-throughput one are different problems. */}
                    {lp.source === 'user_run' ? (
                      <p className="mt-2 text-xs leading-relaxed text-muted">
                        From your Part 1 solve — <em>{lp.objectiveLabel}</em>.
                        Re-solve Part 1 to change these budgets.
                      </p>
                    ) : (
                      <Callout tone="warn" icon="alert">
                        Part 1 has not been solved yet, so these budgets come
                        from a default-scenario run of it. Solve Part 1 with
                        your own objective and sliders, then return — the
                        allocation can differ several-fold.
                      </Callout>
                    )}
                    <div className="mt-3">
                      <KeyValueList columns={2} items={
                        Object.entries(lp.workforce || {}).map(([t, w]) => ({
                          label: t,
                          value: `${fmt.num(w, 1)} → ${fmt.int(w * 8 * 60)} min`,
                        }))
                      } />
                    </div>
                  </React.Fragment>
                ) : (
                  <Callout tone="warn" icon="alert">
                    Standalone mode. Part 2 is solvable on its own, but the
                    worker budget is then derived from the very batch it
                    constrains.
                  </Callout>
                )}
              </div>
            </React.Fragment>
          )}

          {tab === 'policy' && (
            <React.Fragment>
              <Toggle
                label="Force all Critical in" checked={controls.force_critical}
                onChange={(v) => set({ force_critical: v })}
                hint="Pins x_i = 1 for every Critical shipment. If they do not fit on their own the run is caught before CBC sees it, with advice instead of a bare Infeasible."
              />
              <Toggle
                label="Cap Hazardous count" checked={controls.hazardous_enabled}
                onChange={(v) => set({ hazardous_enabled: v })}
              />
              <SliderRow
                label="Max Hazardous" value={controls.max_hazardous}
                min={0} max={30} step={1} disabled={!controls.hazardous_enabled}
                format={(v) => fmt.num(v, 0)}
                onChange={(v) => set({ max_hazardous: v })}
              />
              <Toggle
                label="Require Perishables" checked={controls.perishable_enabled}
                onChange={(v) => set({ perishable_enabled: v })}
              />
              <SliderRow
                label="Min Perishable" value={controls.min_perishable}
                min={0} max={30} step={1} disabled={!controls.perishable_enabled}
                format={(v) => fmt.num(v, 0)}
                onChange={(v) => set({ min_perishable: v })}
              />
            </React.Fragment>
          )}
        </div>
      </Card>
    );
  }

  /* ------------------------------------------------------------ batch card */

  function BatchCard({ state, lp, useLp }) {
    const [showAll, setShowAll] = useState(false);
    const batch = state.data;

    if (!batch) {
      return (
        <Card title="Candidate batch">
          <div className="space-y-3">
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="h-32 w-full" />
          </div>
        </Card>
      );
    }

    const totals = batch.totals;
    const caps = batch.capacities;
    const coupled = useLp && lp.workforce;
    const rows = showAll ? batch.shipments : batch.shipments.slice(0, 10);

    return (
      <Card
        title="Candidate batch"
        subtitle="Every shipment, scored before any optimisation runs."
        actions={
          <div className="flex items-center gap-2">
            {state.loading && <span className="text-xs text-faint">updating…</span>}
            <Button size="sm" variant="ghost" onClick={() => setShowAll((v) => !v)}>
              {showAll ? 'Show first 10' : `Show all ${totals.n_shipments}`}
            </Button>
          </div>
        }
        bodyClass="p-0"
      >
        <div className="border-b border-rule px-5 py-4">
          <KeyValueList
            columns={3}
            items={[
              { label: 'Shipments', value: fmt.int(totals.n_shipments) },
              { label: 'Total value', value: fmt.num(totals.total_value, 1) },
              { label: 'Volume V_cap',
                value: `${fmt.num(caps.volume, 0)} / ${fmt.num(totals.total_volume, 0)}` },
              { label: 'Equipment-minutes E_cap',
                value: `${fmt.num(caps.equipment_minutes, 0)} / ${fmt.num(totals.total_equipment_minutes, 0)}` },
              { label: 'Worker-minutes source',
                value: coupled ? 'Part 1 allocation' : 'batch fraction' },
              { label: 'Capacity fraction f', value: fmt.ratio(caps.fraction) },
            ]}
          />
        </div>

        <div className="border-b border-rule bg-sunken px-5 py-4">
          <SectionLabel>Value function</SectionLabel>
          <code className="mt-2 block overflow-x-auto bg-panel px-3 py-2 font-mono text-xs text-body">
            {batch.value_formula}
          </code>
          <p className="mt-2 text-xs leading-relaxed text-muted">{batch.note}</p>
        </div>

        {batch.warnings.length > 0 && (
          <div className="border-b border-rule px-5 py-4">
            <Callout tone="warn" icon="alert" title="Priority weights">
              <ul className="list-disc space-y-1 pl-5">
                {batch.warnings.map((w, i) => <li key={i}>{w}</li>)}
              </ul>
            </Callout>
          </div>
        )}

        <div className={cx('transition-opacity', state.loading && 'opacity-60')}>
          <DataTable
            compact
            rowKey={(r) => r.record_id}
            rows={rows}
            headerClass="normal-case tracking-normal"
            columns={[
              { key: 'record_id', header: 'Record',
                className: 'font-mono text-xs text-ink' },
              { key: 'timestamp', header: 'Arrived',
                render: (r) => r.timestamp.slice(0, 16) },
              { key: 'terminal', header: 'Terminal',
                className: 'font-mono text-xs' },
              { key: 'priority', header: 'Priority' },
              { key: 'cargo_type', header: 'Cargo' },
              { key: 'priority_weight', header: 'p', align: 'right',
                render: (r) => fmt.num(r.priority_weight, 0) },
              { key: 'urgency_uplift', header: 'urgency U', align: 'right',
                render: (r) => `+${fmt.ratio(r.urgency_uplift)}` },
              { key: 'value', header: 'value v', align: 'right',
                render: (r) => (
                  <span className="font-medium text-ink">{fmt.num(r.value, 2)}</span>
                ) },
              { key: 'volume', header: 'volume', align: 'right',
                render: (r) => fmt.num(r.volume, 1) },
              { key: 'worker_minutes', header: 'worker-min', align: 'right',
                render: (r) => fmt.num(r.worker_minutes, 0) },
              { key: 'equipment_minutes', header: 'machine-min', align: 'right',
                render: (r) => fmt.num(r.equipment_minutes, 0) },
            ]}
          />
        </div>
      </Card>
    );
  }


  window.Pages = Object.assign(window.Pages || {}, { IPPage });
})();
