import 'maplibre-gl/dist/maplibre-gl.css';
import { Banner, Button, Skeleton } from '@roofline/ui';
import type { Ring } from '@roofline/shared';
import { Map as MapLibreMap, Marker } from 'maplibre-gl';
import { useContext, useEffect, useRef, useState } from 'react';
import { ApiError } from '../../../api/client.ts';
import { liftMeasure } from '../../../copy/liftMeasure.ts';
import { legal } from '../../../copy/legal.ts';
import { measure } from '../../../copy/measure.ts';
import { mapStyle, satelliteAvailable } from '../../../shell/map/mapStyle.ts';
import type { MapEnv } from '../../../shell/map/types.ts';
import { useMeasurement, usePatchMeasurement } from '../api.ts';
import { createOutlineEditor, type EditResult, type OutlineEditor } from '../OutlineEditor.ts';
import type { MeasurementPatch, MeasurementView, OutlineProblem } from '../types.ts';
import styles from './RoofView.module.css';
import { ScanBar, ScanSweep } from './ScanBar.tsx';
import type { ScanSession } from './scan.ts';
import { MeasureSlotsContext, type RoofSession } from './slots.ts';
import { addStructureLayers, STRUCTURES_SOURCE, structuresData } from './structures.ts';

const SAVE_DEBOUNCE_MS = 500;
const START_ZOOM = 20;
const MAX_ZOOM = 21;
const FT_PER_METRE = 3.28084;
const SCALE_MAX_PX = 96;
// Metres per pixel at zoom 0 on the equator for 512 px tiles (MapLibre's tile size).
const METRES_PER_PIXEL_ZOOM0 = 78271.517;
const NICE_FEET = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000] as const;

function readMapEnv(): MapEnv {
  return { maptilerKey: import.meta.env.VITE_MAPTILER_KEY, tiles: import.meta.env.VITE_MAP_TILES, imagery: import.meta.env.VITE_MAP_IMAGERY };
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

/** The longest round number of feet that fits in the scale bar at this zoom, and how wide it draws. */
export function scaleBarFor(latitude: number, zoom: number): { feet: number; widthPx: number } {
  const metresPerPixel = (METRES_PER_PIXEL_ZOOM0 * Math.cos((latitude * Math.PI) / 180)) / 2 ** zoom;
  const feetPerPixel = metresPerPixel * FT_PER_METRE;
  const maxFeet = feetPerPixel * SCALE_MAX_PX;
  let feet: number = NICE_FEET[0];
  for (const candidate of NICE_FEET) if (candidate <= maxFeet) feet = candidate;
  return { feet, widthPx: Math.round(feet / feetPerPixel) };
}

/** The average of a ring's corners: where a structure's label sits. */
export function ringCenter(ring: Ring): [number, number] {
  const n = Math.max(ring.length, 1);
  return [ring.reduce((sum, p) => sum + p[0], 0) / n, ring.reduce((sum, p) => sum + p[1], 0) / n];
}

function labelElement(structure: MeasurementView['structures'][number]): HTMLDivElement {
  const el = document.createElement('div');
  el.className = styles.structureLabel ?? '';
  el.setAttribute('data-structure-label', structure.footprintId);
  el.setAttribute('data-included', String(structure.included));
  el.textContent = liftMeasure.structureLabel(structure.areaSqFt);
  el.title = structure.included ? liftMeasure.structureIncluded : liftMeasure.structureLeftOut;
  return el;
}

function NorthArrow() {
  return (
    <svg
      className={styles.north}
      viewBox="0 0 24 24"
      width="32"
      height="32"
      role="img"
      aria-label={liftMeasure.north}
      focusable="false"
    >
      <polygon points="12,3 17,19 12,15.5 7,19" fill="currentColor" />
    </svg>
  );
}

/** Tint and dim follow the saved structures; each structure carries its own label. */
function useStructureLabels(instance: MapLibreMap | null, structures: MeasurementView['structures']) {
  useEffect(() => {
    if (!instance) return;
    try {
      (instance.getSource(STRUCTURES_SOURCE) as { setData?: (data: unknown) => void } | undefined)?.setData?.(
        structuresData(structures),
      );
    } catch {
      // Ignored: the map is going away.
    }
    const markers = structures
      .filter((s) => s.ring.length >= 3)
      .map((s) => new Marker({ element: labelElement(s), draggable: false }).setLngLat(ringCenter(s.ring)).addTo(instance));
    return () => {
      for (const marker of markers) marker.remove();
    };
  }, [instance, structures]);
}

/** The compass, the scale bar and the measuring pill that sit over the map. */
function Overlays({ latitude, zoom, saving }: { latitude: number; zoom: number; saving: boolean }) {
  const scale = scaleBarFor(latitude, zoom);
  return (
    <>
      <div className={styles.compass}>
        <NorthArrow />
      </div>
      <div className={styles.scale} role="img" aria-label={liftMeasure.scaleBarLabel(scale.feet)}>
        <span className={styles.scaleLabel}>{liftMeasure.scaleBar(scale.feet)}</span>
        <span className={styles.scaleBar} style={{ width: `${scale.widthPx}px` }} />
      </div>
      {saving ? <Pill /> : null}
    </>
  );
}

function Pill() {
  return (
    <span className={styles.pill} role="status">
      <svg className={styles.pillIcon} viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
        <path d="M3 10.5 8 5.5l5 5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      {liftMeasure.measuring}
    </span>
  );
}

type Notices = {
  mapFailed: boolean;
  locked: boolean;
  problem: OutlineProblem | null;
  saveFailed: boolean;
  drawMode: boolean;
};

function NoticeList({ mapFailed, locked, problem, saveFailed, drawMode }: Notices) {
  return (
    <>
      {mapFailed ? <Banner tone="warning">{measure.mapFailed}</Banner> : null}
      {locked ? <Banner tone="warning">{measure.locked}</Banner> : null}
      {problem !== null ? (
        <div role="alert">
          <Banner tone="danger">{measure.problems[problem]}</Banner>
        </div>
      ) : null}
      {saveFailed ? <Banner tone="danger">{measure.saveFailed}</Banner> : null}
      {drawMode ? <p className={styles.hint}>{measure.drawHint}</p> : null}
    </>
  );
}

function Attribution() {
  return (
    <div className={styles.credits}>
      <p className={styles.attribution}>{legal.footprintAttribution}</p>
      <p className={styles.attribution}>{measure.attribution}</p>
    </div>
  );
}

function Loaded({ m }: { m: MeasurementView }) {
  const [lng, lat] = m.center;
  const patch = usePatchMeasurement(m.id);
  const [, setRing] = useState<Ring>(m.outline?.[0] ?? []);
  const [problem, setProblem] = useState<OutlineProblem | null>(null);
  const [drawMode, setDrawMode] = useState<boolean>(m.drawMode || !m.outline?.[0]?.length);
  const [mapFailed, setMapFailed] = useState(false);
  const [readyMap, setReadyMap] = useState<MapLibreMap | null>(null);
  const [zoom, setZoom] = useState(START_ZOOM);
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const editorRef = useRef<OutlineEditor | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pending = useRef<MeasurementPatch>({});
  const patchRef = useRef(patch.mutate);
  const patchAsyncRef = useRef(patch.mutateAsync);
  const structuresRef = useRef(m.structures);
  useEffect(() => {
    patchRef.current = patch.mutate;
    patchAsyncRef.current = patch.mutateAsync;
    structuresRef.current = m.structures;
  });
  const startRef = useRef({ ring: m.outline?.[0] ?? [], drawMode: m.drawMode || !m.outline?.[0]?.length, locked: m.locked });

  const conflict = patch.error instanceof ApiError && patch.error.status === 409;
  const locked = m.locked || conflict;

  const onEdit = useRef((result: EditResult) => {
    if (result.refused) {
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
      const body = pending.current;
      pending.current = {};
      if (Object.keys(body).length > 0) patchAsyncRef.current(body).catch(() => {});
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
    mapRef.current = instance;
    instance.on('error', () => setMapFailed(true));
    instance.on('zoom', () => setZoom(instance.getZoom()));
    instance.on('load', () => {
      // The structures go in first, so the editable outline draws on top of them.
      addStructureLayers(instance, structuresRef.current);
      editorRef.current = createOutlineEditor(instance, {
        ring: startRef.current.ring,
        drawMode: startRef.current.drawMode,
        readOnly: startRef.current.locked,
        onChange: (result) => onEdit.current(result),
      });
      setReadyMap(instance);
    });
    return () => {
      clearTimeout(saveTimer.current);
      if (Object.keys(pending.current).length > 0) {
        patchRef.current(pending.current);
        pending.current = {};
      }
      editorRef.current?.destroy();
      editorRef.current = null;
      mapRef.current = null;
      instance.remove();
    };
  }, [lng, lat]);

  useEffect(() => {
    startRef.current.locked = locked;
    editorRef.current?.setReadOnly(locked);
  }, [locked]);

  useStructureLabels(readyMap, m.structures);

  return (
    <div className={styles.frame}>
      <NoticeList
        mapFailed={mapFailed}
        locked={locked}
        problem={problem}
        saveFailed={patch.isError && !conflict}
        drawMode={drawMode}
      />
      {!mapFailed && !locked ? (
        <div className={styles.tools}>
          {drawMode ? (
            <>
              <Button onClick={() => editorRef.current?.finishDrawing()}>
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
          ) : (
            <Button
              variant="ghost"
              onClick={() => {
                editorRef.current?.setDrawMode(true);
                setDrawMode(true);
                setProblem(null);
              }}
            >
              {measure.redraw}
            </Button>
          )}
        </div>
      ) : null}
      <div className={styles.mapBox}>
        <div ref={containerRef} className={styles.map} role="region" aria-label={liftMeasure.mapLabel} />
        <Overlays latitude={lat} zoom={zoom} saving={patch.isPending} />
        <Attribution />
      </div>
    </div>
  );
}

const OUTLINE_LAYERS = ['outline-fill', 'outline-line', 'lift-structures-fill', 'lift-structures-line'] as const;
const NO_STRUCTURES: MeasurementView['structures'] = [];

/** Until the scan has played, the aerial shows bare: no outline, tint or label. */
function useRevealed(instance: MapLibreMap | null, revealed: boolean) {
  useEffect(() => {
    if (!instance) return;
    const loose = instance as unknown as { setLayoutProperty?: (id: string, name: string, value: string) => void; getLayer?: (id: string) => unknown };
    for (const id of OUTLINE_LAYERS) {
      try {
        if (loose.getLayer?.(id) !== undefined) loose.setLayoutProperty?.(id, 'visibility', revealed ? 'visible' : 'none');
      } catch {
        // Ignored: the map is going away.
      }
    }
  }, [instance, revealed]);
}

function ImageryChip({ createdAt }: { createdAt: string }) {
  const when = new Date(createdAt);
  if (Number.isNaN(when.getTime())) return null;
  return (
    <span className={styles.imagery}>
      <span className={styles.imageryDot} aria-hidden="true" />
      {liftMeasure.imagery(when.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }))}
    </span>
  );
}

/** The roof as MeasureWindow's one editor draws it: this view only places the map's container and what goes over it. */
function Slotted({ m, roof, scan }: { m: MeasurementView; roof: RoofSession; scan: ScanSession | null }) {
  const { containerRef, zoom, saving, map } = roof;
  const revealed = scan === null || scan.phase === 'done';
  useStructureLabels(map, revealed ? m.structures : NO_STRUCTURES);
  useRevealed(map, revealed);
  return (
    <div className={styles.frame}>
      <NoticeList
        mapFailed={roof.mapFailed}
        locked={roof.locked}
        problem={roof.problem}
        saveFailed={roof.saveFailed}
        drawMode={roof.drawMode}
      />
      {!roof.mapFailed && !roof.locked ? (
        <div className={styles.tools}>
          {roof.drawMode ? (
            <>
              <Button onClick={roof.finishDrawing}>
                {measure.finishDrawing}
              </Button>
              <Button variant="ghost" onClick={roof.clearDrawing}>
                {measure.clearDrawing}
              </Button>
            </>
          ) : (
            <Button variant="ghost" onClick={roof.redraw}>
              {measure.redraw}
            </Button>
          )}
        </div>
      ) : null}
      <div className={styles.mapBox} data-revealed={revealed ? 'true' : 'false'}>
        <div ref={containerRef} className={styles.map} role="region" aria-label={liftMeasure.mapLabel} />
        <ImageryChip createdAt={m.createdAt} />
        <Overlays latitude={m.center[1]} zoom={zoom} saving={saving} />
        {scan !== null ? <ScanSweep scan={scan} /> : null}
        {scan !== null ? <ScanBar scan={scan} /> : null}
        <Attribution />
      </div>
    </div>
  );
}

export function RoofView({ measurementId }: { measurementId: string }) {
  const query = useMeasurement(measurementId);
  const { roof, scan } = useContext(MeasureSlotsContext);
  if (query.data !== undefined) return roof ? <Slotted m={query.data} roof={roof} scan={scan} /> : <Loaded m={query.data} />;
  if (query.isError) {
    return (
      <div className={styles.frame} role="alert">
        <Banner tone="danger">{liftMeasure.loadFailed}</Banner>
      </div>
    );
  }
  return (
    <div className={styles.frame} aria-busy="true">
      <div className={styles.mapBox}>
        <div className={styles.map}>
          <Skeleton width="100%" height="100%" />
        </div>
        <Pill />
      </div>
    </div>
  );
}
