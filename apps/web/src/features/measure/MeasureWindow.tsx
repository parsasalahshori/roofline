import 'maplibre-gl/dist/maplibre-gl.css';
import { Banner, Button, Checkbox, EmptyState, Field } from '@roofline/ui';
import { instantEstimate, type ProposalView, type Ring } from '@roofline/shared';
import { Map as MapLibreMap } from 'maplibre-gl';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router';
import { ApiError } from '../../api/client.ts';
import { useMe } from '../../api/hooks.ts';
import { paidReports } from '../../copy/billing.ts';
import { liftMeasureSteps } from '../../copy/liftMeasure.ts';
import { measure } from '../../copy/measure.ts';
import { makeFailureMessage, useBuildProposal, useSendProposal } from '../estimator/api.ts';
import type { MapEnv } from '../../shell/map/types.ts';
import type { NewCustomerInput } from '../estimator/types.ts';
import { useExactReport, useMeasurement, useMeasurementPreview, usePatchMeasurement } from './api.ts';
import { CustomerStep, customerReady } from './CustomerStep.tsx';
import { EstimateChoice, type PriceChoice } from './EstimateChoice.tsx';
import { readHandoff } from './handoff.ts';
import styles from './MeasureWindow.module.css';
import { measureStyle, useImageryDate, usesFreeAerial } from './lift/aerial.ts';
import { PropertyStrip } from './lift/PropertyStrip.tsx';
import { ProposalPanel } from './lift/ProposalPanel.tsx';
import { RequestsList } from './lift/RequestsList.tsx';
import { useRequestRows } from './lift/requests.ts';
import { addRoofLayers, readRoof } from './lift/roofModel.ts';
import { RoofView } from './lift/RoofView.tsx';
import { useRoofScan } from './lift/scan.ts';
import { MeasureSlotsContext, type RoofSession } from './lift/slots.ts';
import { addStructureLayers } from './lift/structures.ts';
import { createOutlineEditor, type EditResult, type OutlineEditor } from './OutlineEditor.ts';
import type { MeasurementPatch, MeasurementView, OutlineProblem } from './types.ts';

const SAVE_DEBOUNCE_MS = 500;
// The free aerial photos are sharp to zoom 19: the camera starts there and fitting never goes past 19.5
const START_ZOOM = 19;
const MAX_ZOOM = 20;
const FIT_MAX_ZOOM = 19.5;
const PITCHES = [4, 5, 6, 7, 8, 9, 10, 11, 12] as const;
const MAX_OVERHANG_FT = 3;
const DIAGRAM_SIZE = 24;
const RECOMMENDED_TIER = 'better';

/** The only place the two build-time map settings are read. It is called at use time, so tests can stub them. */
function readMapEnv(): MapEnv {
  return { maptilerKey: import.meta.env.VITE_MAPTILER_KEY, tiles: import.meta.env.VITE_MAP_TILES, imagery: import.meta.env.VITE_MAP_IMAGERY };
}

/** Creates the map over the aerial photo, or answers null when it cannot start (no WebGL). */
function createMap(container: HTMLElement, center: [number, number]): MapLibreMap | null {
  try {
    return new MapLibreMap({
      container,
      style: measureStyle(readMapEnv()),
      center,
      zoom: START_ZOOM,
      maxZoom: MAX_ZOOM,
      // The credits for the photo and the outlines are drawn by the roof view itself
      attributionControl: false,
    });
  } catch {
    return null;
  }
}

type FitMap = { fitBounds?: (b: [[number, number], [number, number]], o: Record<string, unknown>) => void; resize?: () => void };

/** Frames the roof: centred, about 55% of the photo, with a little more room at the bottom for the card. */
function fitRoof(instance: MapLibreMap, ring: Ring, box: HTMLElement): void {
  if (ring.length < 3) return;
  const w = box.clientWidth;
  const h = box.clientHeight;
  if (w < 50 || h < 50) return;
  const lngs = ring.map((p) => p[0]);
  const lats = ring.map((p) => p[1]);
  try {
    (instance as unknown as FitMap).fitBounds?.(
      [
        [Math.min(...lngs), Math.min(...lats)],
        [Math.max(...lngs), Math.max(...lats)],
      ],
      { padding: { top: Math.round(h * 0.18), bottom: Math.round(h * 0.27), left: Math.round(w * 0.22), right: Math.round(w * 0.22) }, maxZoom: FIT_MAX_ZOOM, duration: 0 },
    );
  } catch {
    // A map too small to fit into keeps its start view.
  }
}

function PitchDiagram({ x }: { x: number }) {
  const top = DIAGRAM_SIZE - (DIAGRAM_SIZE * x) / 12;
  return (
    <>
      <svg
        className={styles.diagram}
        viewBox={`0 0 ${DIAGRAM_SIZE} ${DIAGRAM_SIZE}`}
        width={DIAGRAM_SIZE}
        height={DIAGRAM_SIZE}
        aria-hidden="true"
        focusable="false"
      >
        <polygon points={`0,${DIAGRAM_SIZE} ${DIAGRAM_SIZE},${DIAGRAM_SIZE} ${DIAGRAM_SIZE},${top}`} fill="currentColor" />
      </svg>
      <span className="visually-hidden">{measure.pitchDiagram(x)}</span>
    </>
  );
}

function format(value: number): string {
  return value.toLocaleString();
}

function Loaded({ m, onProposalReady }: { m: MeasurementView; onProposalReady: (ready: boolean) => void }) {
  const navigate = useNavigate();
  const [lng, lat] = m.center;
  const patch = usePatchMeasurement(m.id);
  const exact = useExactReport(m.id);
  const me = useMe();
  const canOrderReport = (me.data?.role === 'owner' || me.data?.role === 'office') && m.kind !== 'exact';
  const handoff = readHandoff(useLocation().state);
  const build = useBuildProposal();
  const send = useSendProposal();
  const model = readRoof(m);
  const scan = useRoofScan(m, model?.totals.facetCount ?? m.facets);
  const e = m.estimate;
  const preview = useMeasurementPreview(m.id, [e.surfaceSqFt, e.pitchX12, e.edgeFt, e.ridgeFt, e.valleyFt].join(':'));
  const [editing, setEditing] = useState(false);
  const [making, setMaking] = useState(false);
  const [makeFailed, setMakeFailed] = useState<string | null>(null);
  const makingRef = useRef(false);
  const builtRef = useRef<ProposalView | null>(null);
  const [choice, setChoice] = useState<PriceChoice>('free');
  const [customer, setCustomer] = useState<NewCustomerInput>({ name: '', phone: '', askedByText: false });
  // The server also asks for a customer when the home lost its own since this screen loaded
  const [customerAsked, setCustomerAsked] = useState(false);
  const needsCustomer = handoff.jobId === undefined && handoff.customer === undefined && (!m.hasCustomer || customerAsked);

  const [ring, setRing] = useState<Ring>(m.outline?.[0] ?? []);
  const [problem, setProblem] = useState<OutlineProblem | null>(null);
  const [drawMode, setDrawMode] = useState<boolean>(m.drawMode || !m.outline?.[0]?.length);
  const [pitch, setPitch] = useState(m.estimate.pitchX12);
  const [overhangText, setOverhangText] = useState(String(m.overhangFt));
  const [overhang, setOverhang] = useState(m.overhangFt);
  const [included, setIncluded] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(m.structures.map((s) => [s.footprintId, s.included])),
  );

  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<OutlineEditor | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const overhangTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const patchRef = useRef(patch.mutate);
  const patchAsyncRef = useRef(patch.mutateAsync);
  useEffect(() => {
    patchRef.current = patch.mutate;
    patchAsyncRef.current = patch.mutateAsync;
  });
  const pending = useRef<MeasurementPatch>({});
  // Saves go out one after another; flushing with nothing new waits for the ones already on their way
  const inflight = useRef<Promise<void>>(Promise.resolve());
  const flushPending = useRef((): Promise<void> => {
    clearTimeout(saveTimer.current);
    clearTimeout(overhangTimer.current);
    const body = pending.current;
    pending.current = {};
    if (Object.keys(body).length === 0) return inflight.current;
    const saved = inflight.current.then(() => patchAsyncRef.current(body)).then(() => undefined);
    inflight.current = saved.catch(() => undefined);
    return saved;
  }).current;
  const startRef = useRef({ ring: m.outline?.[0] ?? [], drawMode: m.drawMode || !m.outline?.[0]?.length, locked: m.locked, model });
  const [mapFailed, setMapFailed] = useState(false);
  const [mapInstance, setMapInstance] = useState<MapLibreMap | null>(null);
  const [zoom, setZoom] = useState(START_ZOOM);
  const structuresRef = useRef(m.structures);
  useEffect(() => {
    structuresRef.current = m.structures;
  });

  const conflict = patch.error instanceof ApiError && patch.error.status === 409;
  const locked = m.locked || conflict;

  const onEdit = useRef((result: EditResult) => {
    if (result.refused) {
      // The edit was turned down: the outline and what is waiting to be saved stay as they were
      setProblem(result.problem);
      return;
    }
    setRing(result.ring);
    setProblem(result.problem);
    clearTimeout(saveTimer.current);
    if (result.problem !== null) {
      delete pending.current.outline;
      return;
    }
    setDrawMode((current) => (current && result.ring.length >= 3 ? false : current));
    pending.current.outline = [result.ring];
    saveTimer.current = setTimeout(() => {
      void flushPending().catch(() => {});
    }, SAVE_DEBOUNCE_MS);
  });

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const instance = createMap(container, [lng, lat]);
    if (!instance) {
      queueMicrotask(() => setMapFailed(true));
      return;
    }
    instance.on('error', () => setMapFailed(true));
    instance.on('zoom', () => setZoom(instance.getZoom()));
    instance.on('load', () => {
      // The buildings tint and the facets go in first, so the editable outline draws on top of them
      addStructureLayers(instance, structuresRef.current);
      addRoofLayers(instance, startRef.current.model);
      editorRef.current = createOutlineEditor(instance, {
        ring: startRef.current.ring,
        drawMode: startRef.current.drawMode,
        readOnly: startRef.current.locked,
        onChange: (result) => onEdit.current(result),
      });
      fitRoof(instance, startRef.current.ring, container);
      setMapInstance(instance);
    });
    // The proposal column opens beside the roof once it is measured: the photo follows its box
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(() => (instance as unknown as FitMap).resize?.()) : null;
    observer?.observe(container);
    return () => {
      observer?.disconnect();
      clearTimeout(saveTimer.current);
      clearTimeout(overhangTimer.current);
      if (Object.keys(pending.current).length > 0) {
        patchRef.current(pending.current);
        pending.current = {};
      }
      editorRef.current?.destroy();
      editorRef.current = null;
      instance.remove();
    };
  }, [lng, lat]);

  // A save refused as locked turns the outline read-only too
  useEffect(() => {
    startRef.current.locked = locked;
    editorRef.current?.setReadOnly(locked);
  }, [locked]);

  // The photo's date is asked for once the map has started (a map that cannot start shows no photo)
  const captured = useImageryDate(lng, lat, mapInstance !== null && usesFreeAerial(readMapEnv()));
  const done = scan.phase === 'done';
  useEffect(() => {
    onProposalReady(done);
  }, [done, onProposalReady]);

  const estimate = useMemo(
    () =>
      instantEstimate({
        outline: ring.length > 0 ? [ring] : [],
        pitchX12: pitch,
        overhangFt: overhang,
        valleyFt: m.estimate.valleyFt,
      }),
    [ring, pitch, overhang, m.estimate.valleyFt],
  );

  // Price-changing edits go out at once through the same path as the outline, so Send proposal can wait for them
  const save = (body: MeasurementPatch) => {
    Object.assign(pending.current, body);
    void flushPending().catch(() => {});
  };

  const toggleStructure = (id: string, next: boolean) => {
    const map = { ...included, [id]: next };
    setIncluded(map);
    save({ includedStructures: m.structures.filter((s) => map[s.footprintId]).map((s) => s.footprintId) });
  };

  const choosePitch = (x: number) => {
    setPitch(x);
    save({ pitchX12: x });
  };

  const changeOverhang = (text: string) => {
    setOverhangText(text);
    const value = Number.parseFloat(text);
    if (!Number.isFinite(value)) return;
    const clamped = Math.min(MAX_OVERHANG_FT, Math.max(0, value));
    setOverhang(clamped);
    clearTimeout(overhangTimer.current);
    pending.current.overhangFt = clamped;
    overhangTimer.current = setTimeout(() => {
      void flushPending().catch(() => {});
    }, SAVE_DEBOUNCE_MS);
  };

  const makeProposal = async () => {
    if (makingRef.current) return;
    makingRef.current = true;
    setMaking(true);
    setMakeFailed(null);
    try {
      await flushPending();
      const built =
        builtRef.current ??
        (await build.mutateAsync({
          measurementId: m.id,
          ...(handoff.jobId !== undefined && { jobId: handoff.jobId }),
          ...(handoff.customer !== undefined && { customer: handoff.customer }),
          ...(needsCustomer && { customer: { name: customer.name.trim(), phone: customer.phone.trim(), askedByText: customer.askedByText } }),
        }));
      builtRef.current = built;
      const sent = await send.mutateAsync(built.id);
      void navigate(`/approvals/${sent.taskId}`);
    } catch (error) {
      if (error instanceof ApiError && error.status === 400 && error.field === 'customer') setCustomerAsked(true);
      setMakeFailed(makeFailureMessage(error));
    } finally {
      makingRef.current = false;
      setMaking(false);
    }
  };

  const noOutline = drawMode && ring.length < 3;
  const proposalBlocked = making || problem !== null || noOutline || locked || patch.isPending || (needsCustomer && !customerReady(customer));
  const ordering = canOrderReport && (choice === 'exact' || exact.isSuccess);
  const rows: [string, string][] = [
    [measure.area, format(estimate.surfaceSqFt)],
    [measure.squares, format(estimate.squares)],
    [measure.pitch, measure.pitchOption(pitch)],
    [measure.edges, format(estimate.edgeFt)],
    [measure.ridge, format(estimate.ridgeFt)],
    [measure.valley, format(estimate.valleyFt)],
  ];

  const redraw = () => {
    editorRef.current?.setDrawMode(true);
    setDrawMode(true);
    setProblem(null);
  };

  const roof: RoofSession = {
    containerRef,
    map: mapInstance,
    zoom,
    ring,
    drawMode,
    locked,
    conflict,
    problem,
    mapFailed,
    saving: patch.isPending,
    saveFailed: patch.isError && !conflict,
    finishDrawing: () => editorRef.current?.finishDrawing(),
    clearDrawing: () => {
      editorRef.current?.clearDrawing();
      setProblem(null);
    },
    redraw,
  };

  const panelsNode = (
    <>
      {m.structures.length > 0 ? (
        <section className={styles.panel} aria-labelledby="measure-structures">
          <h3 id="measure-structures" className={styles.title}>
            {measure.structuresTitle}
          </h3>
          {m.structures.map((s, i) => (
            <Checkbox
              key={s.footprintId}
              label={measure.structure(i + 1)}
              checked={included[s.footprintId] ?? false}
              disabled={locked}
              onChange={(next) => toggleStructure(s.footprintId, next)}
            />
          ))}
        </section>
      ) : null}

      <section className={styles.panel}>
        <h3 className={styles.title}>{measure.pitchTitle}</h3>
        <div role="group" aria-label={measure.pitchTitle} className={styles.pitches}>
          {PITCHES.map((x) => (
            <Button
              key={x}
              variant="ghost"
              className={styles.pitch}
              aria-pressed={pitch === x}
              data-state={pitch === x ? 'on' : 'off'}
              disabled={locked}
              onClick={() => choosePitch(x)}
            >
              <PitchDiagram x={x} />
              <span>{measure.pitchOption(x)}</span>
            </Button>
          ))}
        </div>
      </section>

      <section className={styles.panel}>
        <Field
          label={measure.overhangTitle}
          type="number"
          inputMode="decimal"
          step={0.5}
          min={0}
          max={MAX_OVERHANG_FT}
          value={overhangText}
          disabled={locked}
          onChange={(event) => changeOverhang(event.target.value)}
        />
      </section>

      <section className={styles.panel} aria-labelledby="measure-numbers">
        <h3 id="measure-numbers" className={styles.title}>
          {measure.numbersTitle}
        </h3>
        <dl className={styles.numbers}>
          {rows.map(([label, value]) => (
            <div key={label} className={styles.row}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      </section>

      {!mapFailed && !locked && !drawMode ? (
        <Button variant="ghost" className={styles.wide} onClick={redraw}>
          {measure.redraw}
        </Button>
      ) : null}
    </>
  );

  const controls = (
    <>
      {canOrderReport ? <EstimateChoice choice={choice} onChoose={setChoice} disabled={exact.isPending || exact.isSuccess} /> : null}
      {needsCustomer && !ordering ? <CustomerStep value={customer} onChange={setCustomer} disabled={making} /> : null}
    </>
  );

  const footer = (
    <div className={styles.actions}>
      {!ordering ? null : exact.isSuccess ? (
        <div className={styles.waiting} role="status">
          <Button variant="ghost" className={styles.wide} href={`/approvals/${exact.data.taskId}`}>
            {measure.waitingForOk}
          </Button>
        </div>
      ) : (
        <Button
          className={styles.send}
          busy={exact.isPending}
          disabled={exact.isPending}
          onClick={() => void flushPending().then(() => exact.mutate(), () => {})}
        >
          {paidReports.exactRequest}
        </Button>
      )}
      {exact.isError ? <Banner tone="danger">{measure.exactFailed}</Banner> : null}
      {ordering ? null : (
        <Button className={styles.send} busy={making} disabled={proposalBlocked} onClick={() => void makeProposal()}>
          <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
            <path d="m22 2-7 20-4-9-9-4Z" />
            <path d="M22 2 11 13" />
          </svg>
          {measure.makeProposal}
        </Button>
      )}
      {makeFailed !== null ? (
        <div role="alert">
          <Banner tone="danger">{makeFailed}</Banner>
        </div>
      ) : null}
    </div>
  );

  const recommended = preview.data?.options?.find((o) => o.tier === RECOMMENDED_TIER) ?? preview.data?.options?.[0];
  const typedName = needsCustomer && customer.name.trim() !== '' ? customer.name : null;
  const customerName = handoff.customer?.name ?? typedName ?? preview.data?.customerName ?? null;

  return (
    <MeasureSlotsContext
      value={{
        roof,
        panels: panelsNode,
        estimate,
        scan,
        model,
        wastePct: recommended?.wastePercent ?? null,
        editing,
        setEditing,
      }}
    >
      <main className={styles.main}>
        <PropertyStrip measurementId={m.id} preview={preview.data} />
        <RoofView measurementId={m.id} captured={captured} />
      </main>
      {done ? (
        <div className={styles.proposal}>
          <ProposalPanel
            preview={preview.data}
            pending={preview.isPending}
            failed={preview.isError}
            customerName={customerName}
            controls={controls}
            footer={footer}
          />
        </div>
      ) : null}
    </MeasureSlotsContext>
  );
}

/** /estimator with no request open: the first request opens (replacing this address), or the right side says what to do. */
function NothingOpen() {
  const navigate = useNavigate();
  const { list, rows } = useRequestRows('');
  const first = rows[0]?.measurementId;
  useEffect(() => {
    if (first !== undefined) void navigate(`/estimator/measure/${encodeURIComponent(first)}`, { replace: true });
  }, [first, navigate]);
  if (list.isPending || first !== undefined) return <p className={styles.loading}>{measure.loading}</p>;
  return (
    <div className={styles.pick}>
      <EmptyState title={measure.pickRequest} />
    </div>
  );
}

type Step = 'requests' | 'roof' | 'proposal';
const STEPS: Step[] = ['requests', 'roof', 'proposal'];

/** The phone's three steps, as the reference numbers them: Requests, Roof, Proposal. */
function Steps({ step, onStep, proposalReady, roofReady }: { step: Step; onStep: (s: Step) => void; proposalReady: boolean; roofReady: boolean }) {
  return (
    <div className={styles.steps} role="tablist" aria-label={liftMeasureSteps.label}>
      {STEPS.map((s, i) => {
        const disabled = (s === 'roof' && !roofReady) || (s === 'proposal' && !proposalReady);
        return (
          <Button
            key={s}
            variant="ghost"
            role="tab"
            aria-selected={step === s}
            data-selected={step === s ? 'true' : undefined}
            disabled={disabled}
            className={styles.step}
            onClick={() => onStep(s)}
          >
            <span className={styles.stepNumber} aria-hidden="true">
              {i + 1}
            </span>
            {liftMeasureSteps[s]}
          </Button>
        );
      })}
    </div>
  );
}

/** The measuring screen: the requests on the left, the roof in the middle, the proposal on the right once measured. */
export function MeasureWindow() {
  const { measurementId = '' } = useParams();
  const query = useMeasurement(measurementId);
  const [step, setStep] = useState<Step>(measurementId === '' ? 'requests' : 'roof');
  const [proposalReady, setProposalReady] = useState(false);
  // Opening another roof shows it (on a phone the requests step gives way to the roof)
  const [shownId, setShownId] = useState(measurementId);
  if (shownId !== measurementId) {
    setShownId(measurementId);
    setStep(measurementId === '' ? 'requests' : 'roof');
    setProposalReady(false);
  }
  const activeStep: Step = step === 'proposal' && !proposalReady ? 'roof' : step;

  return (
    <div className={styles.window} data-step={activeStep} data-proposal={proposalReady ? 'true' : 'false'}>
      <header className={styles.header}>
        <span className={styles.appIcon} aria-hidden="true">
          <svg viewBox="0 0 24 24" width="14" height="14" focusable="false">
            <path
              d="M21.3 15.3a2.4 2.4 0 0 1 0 3.4l-2.6 2.6a2.4 2.4 0 0 1-3.4 0L2.7 8.7a2.41 2.41 0 0 1 0-3.4l2.6-2.6a2.41 2.41 0 0 1 3.4 0ZM14.5 12.5l2-2M11.5 9.5l2-2M8.5 6.5l2-2M17.5 15.5l2-2"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.1"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
        <h2 className={styles.heading}>{measure.title}</h2>
        <span className={styles.subtitle}>{measure.subtitle}</span>
      </header>
      <Steps step={activeStep} onStep={setStep} roofReady={measurementId !== ''} proposalReady={proposalReady} />
      <div className={styles.body}>
        <aside className={styles.list}>
          <RequestsList selectedId={measurementId} onPick={() => setStep('roof')} />
        </aside>
        {measurementId === '' ? (
          <main className={styles.main}>
            <NothingOpen />
          </main>
        ) : query.isError ? (
          <main className={styles.main}>
            <EmptyState title={measure.loadFailed} />
          </main>
        ) : !query.data ? (
          <main className={styles.main}>
            <p className={styles.loading}>{measure.loading}</p>
          </main>
        ) : (
          <Loaded key={query.data.id} m={query.data} onProposalReady={setProposalReady} />
        )}
      </div>
    </div>
  );
}
