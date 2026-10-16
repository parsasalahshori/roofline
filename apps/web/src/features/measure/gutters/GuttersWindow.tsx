import 'maplibre-gl/dist/maplibre-gl.css';
import { Banner, Button, Checkbox, EmptyState } from '@roofline/ui';
import {
  DEFAULT_GUTTER_TIERS,
  gutterView,
  MAX_DOWNSPOUTS_PER_RUN,
  type GutterAdjustments,
  type GutterMeasurementView,
  type GutterQuote,
  type GutterRun,
  type GutterSize,
  type LngLat,
} from '@roofline/shared';
import { Map as MapLibreMap } from 'maplibre-gl';
import { useCallback, useEffect, useId, useMemo, useReducer, useRef, useState } from 'react';
import { useParams } from 'react-router';
import { legal } from '../../../copy/legal.ts';
import { liftProposal } from '../../../copy/liftMeasure.ts';
import { measureGutters as copy } from '../../../copy/measureGutters.ts';
import type { MapEnv } from '../../../shell/map/types.ts';
import { useMeasurement } from '../api.ts';
import frame from '../MeasureWindow.module.css';
import { measureStyle, usesFreeAerial } from '../lift/aerial.ts';
import cardStyles from '../lift/MeasureCard.module.css';
import { TierPanel, type TierOption } from '../lift/ProposalPanel.tsx';
import panelStyles from '../lift/ProposalPanel.module.css';
import { wholeDollars } from '../lift/proposalLines.ts';
import { RequestsList } from '../lift/RequestsList.tsx';
import { usableRoof } from '../lift/roofModel.ts';
import roofStyles from '../lift/RoofView.module.css';
import { ScanBar } from '../lift/ScanBar.tsx';
import { ScanCardHead } from '../lift/ScanCardHead.tsx';
import { ScanOverlay } from '../lift/ScanOverlay.tsx';
import { shownShare, stageAt, useScan, type ScanTimer } from '../lift/scan.ts';
import type { MeasurementView } from '../types.ts';
import { MeasureSwitch } from '../windows/MeasureSwitch.tsx';
import { useGutters, usePatchGutters } from './api.ts';
import styles from './GuttersWindow.module.css';

export const SAVE_DEBOUNCE_MS = 500;
const START_ZOOM = 19;
const MAX_ZOOM = 20;
const FIT_MAX_ZOOM = 19.5;
/** The scan draws the runs between these shares of its time, then the downspouts. */
const RUNS_FROM = 0.3;
const RUNS_TO = 0.55;
const SPOUTS_TO = 0.8;
const LABEL_OFFSET_PX = 18;

function readMapEnv(): MapEnv {
  return { maptilerKey: import.meta.env.VITE_MAPTILER_KEY, tiles: import.meta.env.VITE_MAP_TILES, imagery: import.meta.env.VITE_MAP_IMAGERY };
}

function reducedMotion(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

type Loose = {
  on?: (type: string, fn: () => void) => void;
  off?: (type: string, fn: () => void) => void;
  project?: (p: [number, number]) => { x: number; y: number };
  fitBounds?: (b: [[number, number], [number, number]], o: Record<string, unknown>) => void;
  resize?: () => void;
  isStyleLoaded?: () => boolean;
};

function createMap(container: HTMLElement, center: LngLat): MapLibreMap | null {
  try {
    return new MapLibreMap({ container, style: measureStyle(readMapEnv()), center, zoom: START_ZOOM, maxZoom: MAX_ZOOM, attributionControl: false });
  } catch {
    return null;
  }
}

/** Re-renders when the map moves or resizes, so what is drawn in screen space follows the photo. */
function useMapMoves(instance: MapLibreMap | null): void {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const loose = instance as unknown as Loose | null;
    if (!loose?.on) return;
    const on = () => bump();
    loose.on('move', on);
    loose.on('resize', on);
    return () => {
      loose.off?.('move', on);
      loose.off?.('resize', on);
    };
  }, [instance]);
}

function projectOne(instance: MapLibreMap | null, p: LngLat): { x: number; y: number } | null {
  const loose = instance as unknown as Loose | null;
  if (!loose?.project) return null;
  try {
    const q = loose.project(p);
    return Number.isFinite(q.x) && Number.isFinite(q.y) ? { x: q.x, y: q.y } : null;
  } catch {
    return null;
  }
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** The map with the roof's outline framed, the runs, rakes, downspouts and run labels drawn over it. */
function GutterMap({
  m,
  view,
  scan,
  canToggle,
  onToggle,
}: {
  m: MeasurementView;
  view: GutterMeasurementView;
  scan: ScanTimer;
  canToggle: boolean;
  onToggle: (runId: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [instance, setInstance] = useState<MapLibreMap | null>(null);
  const [failed, setFailed] = useState(false);
  const outline = usableRoof(m.roof)?.outline ?? m.outline?.[0] ?? [];
  const startRef = useRef({ center: m.center, outline });

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const map = createMap(container, startRef.current.center);
    if (!map) {
      queueMicrotask(() => setFailed(true));
      return;
    }
    const loose = map as unknown as Loose;
    map.on('error', () => setFailed(true));
    let started = false;
    const setup = () => {
      if (started) return;
      try {
        if (loose.isStyleLoaded?.() === false) return;
      } catch {
        return;
      }
      started = true;
      const ring = startRef.current.outline;
      if (ring.length >= 3) {
        const lngs = ring.map((p) => p[0]);
        const lats = ring.map((p) => p[1]);
        const w = container.clientWidth;
        const h = container.clientHeight;
        try {
          loose.fitBounds?.(
            [
              [Math.min(...lngs), Math.min(...lats)],
              [Math.max(...lngs), Math.max(...lats)],
            ],
            {
              padding: { top: Math.round(h * 0.14), bottom: Math.round(h * 0.38), left: Math.round(w * 0.18), right: Math.round(w * 0.18) },
              maxZoom: FIT_MAX_ZOOM,
              duration: 0,
            },
          );
        } catch {
          // A map too small to fit into keeps its start view.
        }
      }
      setInstance(map);
    };
    map.on('styledata', setup);
    map.on('load', setup);
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(() => loose.resize?.()) : null;
    observer?.observe(container);
    return () => {
      observer?.disconnect();
      map.remove();
    };
  }, []);

  useMapMoves(instance);
  const p = scan.progress;
  const still = reducedMotion();
  const runsShare = scan.phase === 'done' ? 1 : p < RUNS_FROM ? 0 : still ? 1 : clamp01((p - RUNS_FROM) / (RUNS_TO - RUNS_FROM));
  const spoutsShare = scan.phase === 'done' ? 1 : p < RUNS_TO ? 0 : still ? 1 : clamp01((p - RUNS_TO) / (SPOUTS_TO - RUNS_TO));
  const ringPx = outline.map((pt) => projectOne(instance, pt)).filter((q): q is { x: number; y: number } => q !== null);
  const box =
    ringPx.length >= 3
      ? (() => {
          const pad = 22;
          const left = Math.min(...ringPx.map((q) => q.x)) - pad;
          const top = Math.min(...ringPx.map((q) => q.y)) - pad;
          return { left, top, width: Math.max(...ringPx.map((q) => q.x)) + pad - left, height: Math.max(...ringPx.map((q) => q.y)) + pad - top };
        })()
      : null;

  const drawn = view.runs.map((r) => ({ r, a: projectOne(instance, r.coords[0]), b: projectOne(instance, r.coords[1]) }));
  const spouts = view.runs.flatMap((r) => (r.excluded ? [] : r.downspouts.map((d, i) => ({ key: `${r.id}-${i}`, at: projectOne(instance, d.at) }))));
  const shownSpouts = Math.ceil(spouts.length * spoutsShare);

  return (
    <div className={roofStyles.mapBox} data-phase={scan.phase} data-gutter-map="">
      <div ref={containerRef} className={roofStyles.map} role="region" aria-label={copy.mapLabel} />
      <div className={roofStyles.topLeft}>
        <span className={roofStyles.chip} data-tone={scan.phase === 'scanning' ? 'measuring' : undefined}>
          {scan.phase === 'scanning' ? copy.measuringChip : copy.fromRoofChip}
        </span>
      </div>
      {instance !== null ? (
        <svg className={styles.draw} aria-hidden="true" focusable="false" data-gutter-drawing="">
          {runsShare > 0
            ? view.rakes.map((rk, i) => {
                const a = projectOne(instance, rk[0]);
                const b = projectOne(instance, rk[1]);
                return a && b ? <line key={`rake-${i}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} className={styles.rake} data-rake="" /> : null;
              })
            : null}
          {runsShare > 0
            ? drawn.map(({ r, a, b }) =>
                a && b ? (
                  <g key={r.id} data-run={r.id} data-excluded={r.excluded ? 'true' : 'false'}>
                    <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} className={styles.runCasing} />
                    <line
                      x1={a.x}
                      y1={a.y}
                      x2={a.x + (b.x - a.x) * runsShare}
                      y2={a.y + (b.y - a.y) * runsShare}
                      className={r.excluded ? styles.runOut : r.kind === 'low-attachment' ? styles.runPorch : styles.run}
                    />
                    {canToggle ? (
                      <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} className={styles.runHit} onClick={() => onToggle(r.id)} />
                    ) : null}
                  </g>
                ) : null,
              )
            : null}
          {spouts.slice(0, shownSpouts).map((s) => (s.at ? <circle key={s.key} cx={s.at.x} cy={s.at.y} r={6} className={styles.spout} data-downspout="" /> : null))}
        </svg>
      ) : null}
      {instance !== null && spoutsShare > 0
        ? drawn.map(({ r, a, b }) => {
            if (!a || !b) return null;
            const dx = b.x - a.x;
            const dy = b.y - a.y;
            const l = Math.hypot(dx, dy) || 1;
            // Outward (the roof is on the run's left in map terms; on screen y points down, so the right-hand normal)
            const nx = -dy / l;
            const ny = dx / l;
            const x = (a.x + b.x) / 2 - nx * LABEL_OFFSET_PX;
            const y = (a.y + b.y) / 2 - ny * LABEL_OFFSET_PX;
            const side = copy.side[r.side];
            return (
              <Button
                key={r.id}
                variant="ghost"
                className={styles.runLabel}
                style={{ left: x, top: y }}
                aria-pressed={!r.excluded}
                aria-label={copy.runButton(side, r.lengthFt, r.excluded)}
                data-run-label={r.id}
                data-excluded={r.excluded ? 'true' : 'false'}
                data-kind={r.kind}
                disabled={!canToggle}
                onClick={() => onToggle(r.id)}
              >
                {copy.runLength(r.lengthFt)}
              </Button>
            );
          })
        : null}
      {scan.phase === 'scanning' && box !== null ? (
        <ScanOverlay box={box} sweeping={p < RUNS_TO} points={p < RUNS_FROM ? ringPx.slice(0, Math.max(1, Math.ceil((ringPx.length * p) / RUNS_FROM))) : []} />
      ) : null}
      {runsShare > 0 ? (
        <ul className={styles.legend} aria-label={copy.legendLabel}>
          <li>
            <span className={styles.legendDash} data-legend="gutter" aria-hidden="true" />
            {copy.legendGutter}
          </li>
          {view.runs.some((r) => r.excluded) ? (
            <li>
              <span className={styles.legendDash} data-legend="out" aria-hidden="true" />
              {copy.legendLeftOut}
            </li>
          ) : null}
          {view.rakes.length > 0 ? (
            <li>
              <span className={styles.legendDash} data-legend="rake" aria-hidden="true" />
              {copy.legendRake}
            </li>
          ) : null}
          <li>
            <span className={styles.legendDot} aria-hidden="true" />
            {copy.legendDownspout}
          </li>
        </ul>
      ) : null}
      <p className={roofStyles.credits}>
        <span>{usesFreeAerial(readMapEnv()) ? legal.imageryAttribution : legal.maptilerImageryAttribution}</span>
      </p>
      {failed ? <span className={styles.mapFailed} data-map-failed="" /> : null}
    </div>
  );
}

function RunRow({
  run,
  index,
  onToggle,
  onDownspouts,
}: {
  run: GutterRun;
  index: number;
  onToggle: () => void;
  onDownspouts: (n: number) => void;
}) {
  const name = copy.runName(index + 1, copy.side[run.side], run.kind === 'low-attachment');
  const n = run.downspouts.length;
  return (
    <li className={styles.runRow} data-run-row={run.id}>
      <Checkbox label={name} description={copy.runDetail(run.lengthFt, run.designSqFt)} checked={!run.excluded} onChange={onToggle} />
      <div className={styles.stepper} role="group" aria-label={copy.downspoutsFor(name)}>
        <Button variant="ghost" className={styles.stepButton} aria-label={copy.fewer(name)} disabled={run.excluded || n <= 0} onClick={() => onDownspouts(n - 1)}>
          {copy.minus}
        </Button>
        <output className={styles.stepValue} data-changed={run.downspoutsSet ? 'true' : undefined} aria-live="polite">
          {run.excluded ? 0 : n}
        </output>
        <Button
          variant="ghost"
          className={styles.stepButton}
          aria-label={copy.more(name)}
          disabled={run.excluded || n >= MAX_DOWNSPOUTS_PER_RUN}
          onClick={() => onDownspouts(n + 1)}
        >
          {copy.plus}
        </Button>
      </div>
    </li>
  );
}

function GuttersCard({
  view,
  scan,
  editing,
  onEdit,
  onToggle,
  onDownspouts,
  onSize,
  saveFailed,
}: {
  view: GutterMeasurementView;
  scan: ScanTimer;
  editing: boolean;
  onEdit: (next: boolean) => void;
  onToggle: (runId: string) => void;
  onDownspouts: (runId: string, n: number) => void;
  onSize: (size: GutterSize | null) => void;
  saveFailed: boolean;
}) {
  const adjustId = useId();
  const scanning = scan.phase === 'scanning';
  const share = scanning ? shownShare(scan.progress) : 1;
  const title = scanning ? copy.stage[stageAt(scan.progress)] : copy.measuredBy;
  const t = view.totals;
  const open = editing && !scanning;
  const corners = t.insideCorners + t.outsideCorners;
  const placed = !scanning || scan.progress >= RUNS_TO;
  return (
    <section className={`${cardStyles.card} ${styles.card}`} aria-label={copy.cardLabel} data-gutters-card="" data-phase={scan.phase} data-editing={open ? 'true' : 'false'}>
      <ScanCardHead title={title} scanning={scanning} elapsedMs={scan.elapsedMs} onRemeasure={scan.restart} />
      <div className={cardStyles.scroll}>
        {open ? null : (
          <>
            <div className={cardStyles.big}>
              <span className={cardStyles.label}>{copy.gutterLabel}</span>
              <span className={cardStyles.squaresRow}>
                <span className={cardStyles.squares} data-stat="gutter-ft">
                  {Math.round(t.gutterFt * share).toLocaleString('en-US')}
                </span>
                <span className={cardStyles.unit}>{copy.gutterUnit}</span>
              </span>
              <span className={cardStyles.sqft}>{copy.runsLine(Math.round(t.runs * share), Math.round(corners * share))}</span>
            </div>
            <dl className={cardStyles.grid}>
              <div className={cardStyles.cell}>
                <dt>{copy.downspoutsCell}</dt>
                <dd data-stat="downspouts">{placed ? copy.downspoutsValue(t.downspouts, t.downspoutFt) : copy.minus}</dd>
              </div>
              <div className={cardStyles.cell}>
                <dt>{copy.cornersCell}</dt>
                <dd data-stat="corners">{copy.cornersValue(Math.round(t.insideCorners * share), Math.round(t.outsideCorners * share))}</dd>
              </div>
              <div className={cardStyles.cell}>
                <dt>{copy.sizeCell}</dt>
                <dd data-stat="size">{placed ? copy.sizeValue(view.size.chosen, view.size.downspout) : copy.minus}</dd>
              </div>
              <div className={cardStyles.cell}>
                <dt>{copy.heightCell}</dt>
                <dd data-stat="eave" title={copy.heightSource[view.eave.source]}>
                  {copy.heightValue(view.eave.heightFt, view.eave.floors)}
                </dd>
              </div>
            </dl>
            {!scanning ? (
              <div className={styles.facts}>
                <p className={styles.reason} data-size-reason="">
                  <strong>{copy.reasonLabel}</strong> {view.size.reason}
                </p>
                <p className={styles.small}>{copy.heightSource[view.eave.source]}</p>
                <p className={styles.small}>{copy.rainNote(view.design.rainfallInPerHr)}</p>
                {view.runs.some((r) => r.kind === 'low-attachment') ? <p className={styles.small}>{copy.porchNote}</p> : null}
                {view.runs.length === 0 ? <Banner tone="info">{copy.noRuns}</Banner> : null}
              </div>
            ) : null}
          </>
        )}
        {saveFailed ? <Banner tone="danger">{copy.saveFailed}</Banner> : null}
        {open ? (
          <div id={adjustId} className={cardStyles.adjust}>
            <section className={styles.panel} aria-labelledby={`${adjustId}-runs`}>
              <h3 id={`${adjustId}-runs`} className={styles.panelTitle}>
                {copy.runsTitle}
              </h3>
              <p className={styles.small}>{copy.runsHint}</p>
              <ul className={styles.runList}>
                {view.runs.map((r, i) => (
                  <RunRow key={r.id} run={r} index={i} onToggle={() => onToggle(r.id)} onDownspouts={(n) => onDownspouts(r.id, n)} />
                ))}
              </ul>
            </section>
            <section className={styles.panel}>
              <h3 className={styles.panelTitle}>{copy.sizeTitle}</h3>
              <div role="group" aria-label={copy.sizeTitle} className={styles.sizes}>
                {(
                  [
                    [null, copy.sizeAuto(view.size.recommended)],
                    ['5in', copy.size5],
                    ['6in', copy.size6],
                  ] as const
                ).map(([value, label]) => (
                  <Button
                    key={label}
                    variant="ghost"
                    className={styles.size}
                    aria-pressed={view.adjustments.size === value}
                    data-state={view.adjustments.size === value ? 'on' : 'off'}
                    onClick={() => onSize(value)}
                  >
                    {label}
                  </Button>
                ))}
              </div>
            </section>
            <Button variant="ghost" className={cardStyles.done} onClick={() => onEdit(false)}>
              {copy.done}
            </Button>
          </div>
        ) : null}
      </div>
      {!scanning ? (
        <div className={cardStyles.foot}>
          <Button variant="ghost" className={cardStyles.footButton} aria-expanded={open} aria-controls={open ? adjustId : undefined} onClick={() => onEdit(!editing)}>
            {copy.adjust}
            <svg className={cardStyles.chevron} viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false">
              <path d="m4 6 4 4 4-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </Button>
          <span className={cardStyles.kind} data-kind="estimate">
            {copy.estimateTag}
          </span>
        </div>
      ) : null}
    </section>
  );
}

function quoteOptions(quotes: GutterQuote[]): TierOption[] {
  return quotes.map((q) => ({
    tier: q.tier,
    name: q.name,
    note: q.belowRecommended ? `${q.description}. ${copy.belowRecommended}` : q.description,
    totalCents: q.totalCents,
    monthlyCents: null,
    groups: [
      {
        title: copy.quoteGroup(liftProposal.tier[q.tier]),
        lines: q.lines.map((l) => ({
          key: l.kind,
          name: copy.quoteLineName[l.kind],
          quantity: copy.quoteLineQty(l.quantity, l.unit, wholeDollars(l.unitCents)),
          cents: l.amountCents,
        })),
      },
    ],
    finance: null,
  }));
}

/** The gutters of one roof measurement: the map and card in the middle, the quote on the right once measured. */
function Loaded({ m, server, onQuoteReady }: { m: MeasurementView; server: GutterMeasurementView; onQuoteReady: (ready: boolean) => void }) {
  const scan = useScan(`gutters:${m.id}`, true);
  const done = scan.phase === 'done';
  useEffect(() => onQuoteReady(done), [done, onQuoteReady]);
  const patch = usePatchGutters(m.id);
  const [adj, setAdj] = useState<GutterAdjustments>(server.adjustments);
  const [editing, setEditing] = useState(false);

  // Saves: 500 ms after the last change, one PATCH carries the whole set of adjustments
  const pending = useRef<GutterAdjustments | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const mutateRef = useRef(patch.mutate);
  useEffect(() => {
    mutateRef.current = patch.mutate;
  });
  const flush = useCallback(() => {
    clearTimeout(timer.current);
    if (pending.current !== null) {
      mutateRef.current(pending.current);
      pending.current = null;
    }
  }, []);
  useEffect(() => flush, [flush]);
  const change = (next: GutterAdjustments) => {
    setAdj(next);
    pending.current = next;
    clearTimeout(timer.current);
    timer.current = setTimeout(flush, SAVE_DEBOUNCE_MS);
  };

  // The numbers follow each change at once: the same pure rules the server uses, on the roof already loaded
  const roof = usableRoof(m.roof);
  const view = useMemo(
    () => (roof === null ? server : gutterView(m.id, roof, server.eave, adj, server.quotes === null ? null : DEFAULT_GUTTER_TIERS)),
    [m.id, roof, server, adj],
  );
  const toggle = (runId: string) => {
    const out = new Set(adj.excludedRunIds);
    if (out.has(runId)) out.delete(runId);
    else out.add(runId);
    change({ ...adj, excludedRunIds: view.runs.filter((r) => out.has(r.id)).map((r) => r.id) });
  };
  const setDownspouts = (runId: string, n: number) => change({ ...adj, downspouts: { ...adj.downspouts, [runId]: Math.max(0, Math.min(MAX_DOWNSPOUTS_PER_RUN, n)) } });
  const setSize = (size: GutterSize | null) => change({ ...adj, size });

  const t = view.totals;
  return (
    <>
      <main className={frame.main}>
        <div className={styles.stage}>
          <GutterMap m={m} view={view} scan={scan} canToggle={done} onToggle={toggle} />
          <div className={styles.overlay}>
            <div className={styles.overlaySpacer} />
            {scan.phase === 'idle' ? null : (
              <GuttersCard
                view={view}
                scan={scan}
                editing={editing}
                onEdit={setEditing}
                onToggle={toggle}
                onDownspouts={setDownspouts}
                onSize={setSize}
                saveFailed={patch.isError}
              />
            )}
          </div>
          {scan.phase === 'idle' ? <ScanBar scan={scan} introName={copy.scanIntroName} introRest={copy.scanIntroRest} button={copy.scanButton} /> : null}
        </div>
      </main>
      {done ? (
        <div className={frame.proposal}>
          <TierPanel
            title={copy.quoteTitle}
            subline={
              <>
                <p className={panelStyles.squares}>{copy.quoteLine(t.gutterFt, t.downspouts)}</p>
                <p className={styles.small}>{copy.accessories(t.endCaps, t.hangers, t.outlets, t.elbows)}</p>
              </>
            }
            options={view.quotes === null ? [] : quoteOptions(view.quotes)}
            pending={false}
            emptyNote={view.quotes === null ? copy.noMoney : copy.noQuote}
            footer={
              <div className={frame.actions}>
                <Button className={frame.send} disabled aria-describedby={`gutter-send-${m.id}`}>
                  {copy.send}
                </Button>
                <p id={`gutter-send-${m.id}`} className={frame.hint}>
                  {copy.sendNext}
                </p>
              </div>
            }
          />
        </div>
      ) : null}
    </>
  );
}

type Step = 'requests' | 'gutters' | 'quote';
const STEPS: Step[] = ['requests', 'gutters', 'quote'];

/** Measure gutters: /estimator/measure/:measurementId/gutters, the roof measurement's eaves as gutter runs. */
export function GuttersWindow() {
  const { measurementId = '' } = useParams();
  const measurement = useMeasurement(measurementId);
  const gutters = useGutters(measurementId);
  const [step, setStep] = useState<Step>('gutters');
  const [quoteReady, setQuoteReady] = useState(false);
  const active: Step = step === 'quote' && !quoteReady ? 'gutters' : step;
  const dataStep = active === 'requests' ? 'requests' : active === 'gutters' ? 'roof' : 'proposal';
  const m = measurement.data;
  const g = gutters.data;
  const roofHref = `/estimator/measure/${encodeURIComponent(measurementId)}`;

  return (
    <div className={frame.window} data-step={dataStep} data-proposal={quoteReady ? 'true' : 'false'} data-measure-gutters="">
      <header className={frame.header}>
        <span className={frame.appIcon} aria-hidden="true">
          <svg viewBox="0 0 24 24" width="14" height="14" focusable="false">
            <path d="M3 7h18l-2 4H5zM17 11v9" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
        <h2 className={frame.heading}>{copy.title}</h2>
        <MeasureSwitch
          current="gutters"
          roofHref={roofHref}
          windowsHref={m !== undefined ? `/estimator/windows?property=${encodeURIComponent(m.propertyId)}` : '/estimator/windows'}
          guttersHref={`${roofHref}/gutters`}
        />
        <span className={frame.subtitle}>{copy.subtitle}</span>
      </header>
      <div className={frame.steps} role="tablist" aria-label={copy.steps.label}>
        {STEPS.map((s, i) => (
          <Button
            key={s}
            variant="ghost"
            role="tab"
            aria-selected={active === s}
            data-selected={active === s ? 'true' : undefined}
            disabled={s === 'quote' && !quoteReady}
            className={frame.step}
            onClick={() => setStep(s)}
          >
            <span className={frame.stepNumber} aria-hidden="true">
              {i + 1}
            </span>
            {copy.steps[s]}
          </Button>
        ))}
      </div>
      <div className={frame.body}>
        <aside className={frame.list}>
          <RequestsList selectedId={measurementId} />
        </aside>
        {m !== undefined && g !== undefined ? (
          usableRoof(m.roof) === null && g.runs.length === 0 ? (
            <main className={frame.main}>
              <div className={frame.pick}>
                <EmptyState title={copy.noRoof} />
              </div>
            </main>
          ) : (
            <Loaded key={m.id} m={m} server={g} onQuoteReady={setQuoteReady} />
          )
        ) : measurement.isError || gutters.isError ? (
          <main className={frame.main}>
            <EmptyState title={copy.loadFailed} />
          </main>
        ) : (
          <main className={frame.main}>
            <p className={frame.loading}>{copy.loading}</p>
          </main>
        )}
      </div>
    </div>
  );
}
