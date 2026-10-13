import 'maplibre-gl/dist/maplibre-gl.css';
import { Banner, Button, Checkbox, EmptyState, Field } from '@roofline/ui';
import { instantEstimate, type ProposalView, type Ring } from '@roofline/shared';
import { Map as MapLibreMap } from 'maplibre-gl';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router';
import { ApiError } from '../../api/client.ts';
import { useMe } from '../../api/hooks.ts';
import { measure } from '../../copy/measure.ts';
import { makeFailureMessage, useBuildProposal, useSendProposal } from '../estimator/api.ts';
import { mapStyle, satelliteAvailable } from '../../shell/map/mapStyle.ts';
import type { MapEnv } from '../../shell/map/types.ts';
import type { NewCustomerInput } from '../estimator/types.ts';
import { useExactReport, useMeasurement, usePatchMeasurement } from './api.ts';
import { CustomerStep, customerReady } from './CustomerStep.tsx';
import { EstimateChoice, type PriceChoice } from './EstimateChoice.tsx';
import { readHandoff } from './handoff.ts';
import styles from './MeasureWindow.module.css';
import { PropertyStrip } from './lift/PropertyStrip.tsx';
import { RequestsList } from './lift/RequestsList.tsx';
import { RoofView } from './lift/RoofView.tsx';
import { MeasureSlotsContext, type RoofSession } from './lift/slots.ts';
import { addStructureLayers } from './lift/structures.ts';
import { StatsPanel } from './lift/StatsPanel.tsx';
import { createOutlineEditor, type EditResult, type OutlineEditor } from './OutlineEditor.ts';
import type { MeasurementPatch, MeasurementView, OutlineProblem } from './types.ts';

const SAVE_DEBOUNCE_MS = 500;
const START_ZOOM = 20;
const MAX_ZOOM = 21;
const PITCHES = [4, 5, 6, 7, 8, 9, 10, 11, 12] as const;
const MAX_OVERHANG_FT = 3;
const DIAGRAM_SIZE = 24;

/** The only place the two build-time map settings are read. It is called at use time, so tests can stub them. */
function readMapEnv(): MapEnv {
  return { maptilerKey: import.meta.env.VITE_MAPTILER_KEY, tiles: import.meta.env.VITE_MAP_TILES };
}

/** Creates the map, or answers null when it cannot start (MapLibre throws when the browser has no WebGL). */
function createMap(container: HTMLElement, center: [number, number]): MapLibreMap | null {
  try {
    const env = readMapEnv();
    return new MapLibreMap({
      container,
      style: mapStyle(env, satelliteAvailable(env) ? 'satellite' : 'streets'),
      center,
      zoom: START_ZOOM,
      maxZoom: MAX_ZOOM,
    });
  } catch {
    return null;
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

function Loaded({ m }: { m: MeasurementView }) {
  const navigate = useNavigate();
  const [lng, lat] = m.center;
  const patch = usePatchMeasurement(m.id);
  const exact = useExactReport(m.id);
  const me = useMe();
  const canOrderReport = (me.data?.role === 'owner' || me.data?.role === 'office') && m.kind !== 'exact';
  const handoff = readHandoff(useLocation().state);
  const build = useBuildProposal();
  const send = useSendProposal();
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
  const startRef = useRef({ ring: m.outline?.[0] ?? [], drawMode: m.drawMode || !m.outline?.[0]?.length, locked: m.locked });
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
      // The buildings tint goes in first, so the editable outline draws on top of it
      addStructureLayers(instance, structuresRef.current);
      editorRef.current = createOutlineEditor(instance, {
        ring: startRef.current.ring,
        drawMode: startRef.current.drawMode,
        readOnly: startRef.current.locked,
        onChange: (result) => onEdit.current(result),
      });
      setMapInstance(instance);
    });
    return () => {
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

  // Price-changing edits go out at once through the same path as the outline, so Make proposal can wait for them
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
    redraw: () => {
      editorRef.current?.setDrawMode(true);
      setDrawMode(true);
      setProblem(null);
    },
  };

  const panelsNode = (
    <>
        {m.structures.length > 0 ? (
          <section className={styles.panel} aria-labelledby="measure-structures">
            <h2 id="measure-structures" className={styles.title}>
              {measure.structuresTitle}
            </h2>
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
          <h2 className={styles.title}>{measure.pitchTitle}</h2>
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
            onChange={(e) => changeOverhang(e.target.value)}
          />
        </section>

        <section className={styles.panel} aria-labelledby="measure-numbers">
          <h2 id="measure-numbers" className={styles.title}>
            {measure.numbersTitle}
          </h2>
          <dl className={styles.numbers}>
            {rows.map(([label, value]) => (
              <div key={label} className={styles.row}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        </section>
    </>
  );

  const actions = (
    <>
        {canOrderReport ? <EstimateChoice choice={choice} onChoose={setChoice} disabled={exact.isPending || exact.isSuccess} /> : null}
        {needsCustomer && !ordering ? <CustomerStep value={customer} onChange={setCustomer} disabled={making} /> : null}
        <div className={styles.actions}>
          {!ordering ? null : exact.isSuccess ? (
            <div className={styles.waiting} role="status">
              <Button variant="ghost" className={styles.wide} href={`/approvals/${exact.data.taskId}`}>
                {measure.waitingForOk}
              </Button>
            </div>
          ) : (
            <Button
              variant="ghost"
              className={styles.wide}
              busy={exact.isPending}
              disabled={exact.isPending}
              onClick={() => void flushPending().then(() => exact.mutate(), () => {})}
            >
              {measure.getExactReport}
            </Button>
          )}
          {exact.isError ? <Banner tone="danger">{measure.exactFailed}</Banner> : null}
          {ordering ? null : (
            <Button
              className={styles.wide}
              busy={making}
              disabled={proposalBlocked}
              onClick={() => void makeProposal()}
            >
              {measure.makeProposal}
            </Button>
          )}
          {makeFailed !== null ? (
            <div role="alert">
              <Banner tone="danger">{makeFailed}</Banner>
            </div>
          ) : null}
        </div>
    </>
  );

  return (
    <MeasureSlotsContext value={{ roof, panels: panelsNode, estimate }}>
      <PropertyStrip measurementId={m.id} />
      <div className={styles.stage}>
        <RoofView measurementId={m.id} />
        <div className={styles.stats}>
          <StatsPanel measurementId={m.id} actions={actions} />
        </div>
      </div>
    </MeasureSlotsContext>
  );
}

/** The measuring screen: the requests list on the left, then the roof with its numbers over it. */
export function MeasureWindow() {
  const { measurementId = '' } = useParams();
  const query = useMeasurement(measurementId);
  const [listOpen, setListOpen] = useState(false);

  return (
    <div className={styles.window}>
      <header className={styles.header}>
        <h1 className={styles.heading}>{measure.title}</h1>
        <span className={styles.subtitle}>{measure.subtitle}</span>
        <Button
          variant="ghost"
          className={styles.listToggle}
          aria-expanded={listOpen}
          onClick={() => setListOpen((open) => !open)}
        >
          {listOpen ? measure.closeRequests : measure.openRequests}
        </Button>
      </header>
      <div className={styles.body}>
        <aside className={styles.list} data-open={listOpen ? 'true' : undefined}>
          <RequestsList selectedId={measurementId} onPick={() => setListOpen(false)} />
        </aside>
        <main className={styles.main}>
          {query.isError ? (
            <EmptyState title={measure.loadFailed} />
          ) : !query.data ? (
            <p className={styles.loading}>{measure.loading}</p>
          ) : (
            <Loaded key={query.data.id} m={query.data} />
          )}
        </main>
      </div>
    </div>
  );
}
