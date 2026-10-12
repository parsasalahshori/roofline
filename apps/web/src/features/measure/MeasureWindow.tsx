import 'maplibre-gl/dist/maplibre-gl.css';
import { Banner, Button, Checkbox, EmptyState, Field } from '@roofline/ui';
import { instantEstimate, type Ring } from '@roofline/shared';
import { Map as MapLibreMap } from 'maplibre-gl';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { ApiError } from '../../api/client.ts';
import { legal } from '../../copy/legal.ts';
import { measure } from '../../copy/measure.ts';
import { mapStyle, satelliteAvailable } from '../../shell/map/mapStyle.ts';
import type { MapEnv } from '../../shell/map/types.ts';
import { useExactReport, useMakeProposal, useMeasurement, usePatchMeasurement } from './api.ts';
import styles from './MeasureWindow.module.css';
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
  const proposal = useMakeProposal(m.id);

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
  const flushPending = useRef((): Promise<void> => {
    clearTimeout(saveTimer.current);
    clearTimeout(overhangTimer.current);
    const body = pending.current;
    pending.current = {};
    if (Object.keys(body).length === 0) return Promise.resolve();
    return patchAsyncRef.current(body).then(() => undefined);
  }).current;
  const startRef = useRef({ ring: m.outline?.[0] ?? [], drawMode: m.drawMode || !m.outline?.[0]?.length });
  const [mapFailed, setMapFailed] = useState(false);

  const conflict = patch.error instanceof ApiError && patch.error.status === 409;
  const locked = m.locked || conflict;

  const onEdit = useRef((result: EditResult) => {
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
    instance.on('load', () => {
      editorRef.current = createOutlineEditor(instance, {
        ring: startRef.current.ring,
        drawMode: startRef.current.drawMode,
        onChange: (result) => onEdit.current(result),
      });
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

  const save = (body: MeasurementPatch) => patch.mutate(body);

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

  const noOutline = drawMode && ring.length < 3;
  const proposalBlocked = proposal.isPending || problem !== null || noOutline || locked;
  const rows: [string, string][] = [
    [measure.area, format(estimate.surfaceSqFt)],
    [measure.squares, format(estimate.squares)],
    [measure.pitch, measure.pitchOption(pitch)],
    [measure.edges, format(estimate.edgeFt)],
    [measure.ridge, format(estimate.ridgeFt)],
    [measure.valley, format(estimate.valleyFt)],
  ];

  return (
    <div className={styles.root}>
      <section className={styles.mapColumn}>
        <div ref={containerRef} className={styles.map} role="region" aria-label={measure.mapLabel} />
        {mapFailed ? <Banner tone="warning">{measure.mapFailed}</Banner> : null}
        {drawMode ? <p className={styles.hint}>{measure.drawHint}</p> : null}
        {drawMode && !mapFailed ? (
          <>
            <Button onClick={() => editorRef.current?.finishDrawing()} disabled={locked}>
              {measure.finishDrawing}
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                editorRef.current?.clearDrawing();
                setProblem(null);
              }}
            >
              {measure.clearDrawing}
            </Button>
          </>
        ) : null}
        <p className={styles.attribution}>{legal.footprintAttribution}</p>
        <p className={styles.attribution}>{measure.attribution}</p>
      </section>
      <div className={styles.panels}>
        <span className={styles.kind} data-kind={m.kind}>
          {m.kind === 'exact' ? measure.exactLabel : measure.estimateLabel}
        </span>
        {locked ? <Banner tone="warning">{measure.locked}</Banner> : null}
        {problem !== null ? (
          <div role="alert">
            <Banner tone="danger">{measure.problems[problem]}</Banner>
          </div>
        ) : null}
        {patch.isError && !conflict ? <Banner tone="danger">{measure.saveFailed}</Banner> : null}

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

        <div className={styles.actions}>
          {exact.isSuccess ? (
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
          <Button
            className={styles.wide}
            busy={proposal.isPending}
            disabled={proposalBlocked}
            onClick={() =>
              void flushPending().then(
                () =>
                  proposal.mutate(undefined, {
                    onSuccess: (created) => {
                      void navigate(`/estimator/proposals/${created.id}`);
                    },
                  }),
                () => {},
              )
            }
          >
            {measure.makeProposal}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** The measuring screen: a satellite map with the editable roof outline, and the numbers beside it. */
export function MeasureWindow() {
  const { measurementId = '' } = useParams();
  const query = useMeasurement(measurementId);

  if (query.isError) return <EmptyState title={measure.loadFailed} />;
  if (!query.data) return <p className={styles.loading}>{measure.loading}</p>;
  return <Loaded key={query.data.id} m={query.data} />;
}
