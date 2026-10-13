import 'maplibre-gl/dist/maplibre-gl.css';
import { Banner, Button, Skeleton } from '@roofline/ui';
import type { Ring } from '@roofline/shared';
import { Map as MapLibreMap, Marker } from 'maplibre-gl';
import { useEffect, useRef, useState } from 'react';
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

const SAVE_DEBOUNCE_MS = 500;
const START_ZOOM = 20;
const MAX_ZOOM = 21;
const FT_PER_METRE = 3.28084;
const SCALE_MAX_PX = 96;
// Metres per pixel at zoom 0 on the equator for 512 px tiles (MapLibre's tile size).
const METRES_PER_PIXEL_ZOOM0 = 78271.517;
const NICE_FEET = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000] as const;
const STRUCTURES_SOURCE = 'lift-structures-src';
const INCLUDED_COLOR = '#2563eb';
const LEFT_OUT_COLOR = '#475569';

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

function structuresData(structures: MeasurementView['structures']) {
  return {
    type: 'FeatureCollection' as const,
    features: structures
      .filter((s) => s.ring.length >= 3)
      .map((s) => ({
        type: 'Feature' as const,
        properties: { included: s.included },
        geometry: { type: 'Polygon' as const, coordinates: [[...s.ring, s.ring[0] as [number, number]]] },
      })),
  };
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

function Loaded({ m }: { m: MeasurementView }) {
  const [lng, lat] = m.center;
  const patch = usePatchMeasurement(m.id);
  const [ring, setRing] = useState<Ring>(m.outline?.[0] ?? []);
  const [problem, setProblem] = useState<OutlineProblem | null>(null);
  const [drawMode, setDrawMode] = useState<boolean>(m.drawMode || !m.outline?.[0]?.length);
  const [mapFailed, setMapFailed] = useState(false);
  const [mapReady, setMapReady] = useState(false);
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
      try {
        instance.addSource(STRUCTURES_SOURCE, { type: 'geojson', data: structuresData(structuresRef.current) });
        instance.addLayer({
          id: 'lift-structures-fill',
          type: 'fill',
          source: STRUCTURES_SOURCE,
          paint: {
            'fill-color': ['case', ['get', 'included'], INCLUDED_COLOR, LEFT_OUT_COLOR],
            'fill-opacity': ['case', ['get', 'included'], 0.28, 0.1],
          },
        });
        instance.addLayer({
          id: 'lift-structures-line',
          type: 'line',
          source: STRUCTURES_SOURCE,
          paint: {
            'line-color': ['case', ['get', 'included'], INCLUDED_COLOR, LEFT_OUT_COLOR],
            'line-width': 2,
            'line-opacity': ['case', ['get', 'included'], 1, 0.35],
          },
        });
      } catch {
        // The map may be mid-teardown; the outline still works without the tint.
      }
      editorRef.current = createOutlineEditor(instance, {
        ring: startRef.current.ring,
        drawMode: startRef.current.drawMode,
        readOnly: startRef.current.locked,
        onChange: (result) => onEdit.current(result),
      });
      setMapReady(true);
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

  // Tint and dim follow the saved structures; each structure carries its own label.
  useEffect(() => {
    const instance = mapRef.current;
    if (!mapReady || !instance) return;
    try {
      (instance.getSource(STRUCTURES_SOURCE) as { setData?: (data: unknown) => void } | undefined)?.setData?.(
        structuresData(m.structures),
      );
    } catch {
      // Ignored: the map is going away.
    }
    const markers = m.structures
      .filter((s) => s.ring.length >= 3)
      .map((s) => new Marker({ element: labelElement(s), draggable: false }).setLngLat(ringCenter(s.ring)).addTo(instance));
    return () => {
      for (const marker of markers) marker.remove();
    };
  }, [mapReady, m.structures]);

  const scale = scaleBarFor(lat, zoom);
  const noOutline = drawMode && ring.length < 3;

  return (
    <div className={styles.frame}>
      <div className={styles.mapBox}>
        <div ref={containerRef} className={styles.map} role="region" aria-label={liftMeasure.mapLabel} />
        <div className={styles.compass}>
          <NorthArrow />
        </div>
        <div className={styles.scale} role="img" aria-label={liftMeasure.scaleBarLabel(scale.feet)}>
          <span className={styles.scaleLabel}>{liftMeasure.scaleBar(scale.feet)}</span>
          <span className={styles.scaleBar} style={{ width: `${scale.widthPx}px` }} />
        </div>
        {patch.isPending ? (
          <span className={styles.pill} role="status">
            {liftMeasure.measuring}
          </span>
        ) : null}
      </div>
      {mapFailed ? <Banner tone="warning">{measure.mapFailed}</Banner> : null}
      {locked ? <Banner tone="warning">{measure.locked}</Banner> : null}
      {problem !== null ? (
        <div role="alert">
          <Banner tone="danger">{measure.problems[problem]}</Banner>
        </div>
      ) : null}
      {patch.isError && !conflict ? <Banner tone="danger">{measure.saveFailed}</Banner> : null}
      {drawMode ? <p className={styles.hint}>{measure.drawHint}</p> : null}
      {!mapFailed && !locked ? (
        <div className={styles.tools}>
          {drawMode ? (
            <>
              <Button onClick={() => editorRef.current?.finishDrawing()} disabled={noOutline && ring.length === 0}>
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
      <p className={styles.attribution}>{legal.footprintAttribution}</p>
      <p className={styles.attribution}>{measure.attribution}</p>
    </div>
  );
}

export function RoofView({ measurementId }: { measurementId: string }) {
  const query = useMeasurement(measurementId);
  if (query.data !== undefined) return <Loaded m={query.data} />;
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
        <span className={styles.pill} role="status">
          {liftMeasure.measuring}
        </span>
      </div>
    </div>
  );
}
