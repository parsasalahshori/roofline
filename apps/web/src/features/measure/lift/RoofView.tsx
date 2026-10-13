import 'maplibre-gl/dist/maplibre-gl.css';
import { Banner, Button, Skeleton } from '@roofline/ui';
import type { Ring } from '@roofline/shared';
import { Marker, type Map as MapLibreMap } from 'maplibre-gl';
import { useContext, useEffect, useReducer } from 'react';
import { legal } from '../../../copy/legal.ts';
import { liftMeasure } from '../../../copy/liftMeasure.ts';
import { measure } from '../../../copy/measure.ts';
import { useMeasurement } from '../api.ts';
import type { MeasurementView } from '../types.ts';
import { AiMark } from './AiMark.tsx';
import { cardNumbers, MeasureCard } from './MeasureCard.tsx';
import { facetName, LINE_COLORS, lineKinds, setRoofLayers, type RoofModel } from './roofModel.ts';
import styles from './RoofView.module.css';
import { ScanBar } from './ScanBar.tsx';
import type { ScanSession } from './scan.ts';
import { MeasureSlotsContext, type MeasureSlots, type RoofSession } from './slots.ts';
import { STRUCTURES_SOURCE, structuresData } from './structures.ts';

const FT_PER_METRE = 3.28084;
const SCALE_MAX_PX = 110;
// Metres per pixel at zoom 0 on the equator for 512 px tiles (MapLibre's tile size).
const METRES_PER_PIXEL_ZOOM0 = 78271.517;
const NICE_FEET = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000] as const;
/** How far through the scan the facets and lines are drawn (the tracing stage ends here). */
const ROOF_DRAWN_AT = 0.55;
/** A facet this large gets the wide label; a smaller one the stacked label. */
const WIDE_LABEL_SQFT = 700;

/** The longest round number of feet that fits in the scale bar at this zoom, and how wide it draws. */
export function scaleBarFor(latitude: number, zoom: number): { feet: number; widthPx: number } {
  const metresPerPixel = (METRES_PER_PIXEL_ZOOM0 * Math.cos((latitude * Math.PI) / 180)) / 2 ** zoom;
  const feetPerPixel = metresPerPixel * FT_PER_METRE;
  const maxFeet = feetPerPixel * SCALE_MAX_PX;
  let feet: number = NICE_FEET[0];
  for (const candidate of NICE_FEET) if (candidate <= maxFeet) feet = candidate;
  return { feet, widthPx: Math.round(feet / feetPerPixel) };
}

/** The average of a ring's corners. */
export function ringCenter(ring: Ring): [number, number] {
  const n = Math.max(ring.length, 1);
  return [ring.reduce((sum, p) => sum + p[0], 0) / n, ring.reduce((sum, p) => sum + p[1], 0) / n];
}

type Loose = {
  getLayer?: (id: string) => unknown;
  getSource?: (id: string) => unknown;
  setLayoutProperty?: (id: string, name: string, value: string) => void;
  project?: (p: [number, number]) => { x: number; y: number };
  on?: (type: string, fn: () => void) => void;
  off?: (type: string, fn: () => void) => void;
  resize?: () => void;
};

const OUTLINE_LAYERS = ['outline-fill', 'outline-line'] as const;
const STRUCTURE_LAYERS = ['lift-structures-fill', 'lift-structures-line'] as const;

function setVisible(instance: MapLibreMap, ids: readonly string[], visible: boolean): void {
  const loose = instance as unknown as Loose;
  for (const id of ids) {
    try {
      if (loose.getLayer?.(id) !== undefined) loose.setLayoutProperty?.(id, 'visibility', visible ? 'visible' : 'none');
    } catch {
      // Ignored: the map is going away.
    }
  }
}

/** A white label card on each facet: its letter, area and pitch, at the facet's label point. */
function facetLabel(letter: string, sqFt: number, pitch: string, wide: boolean): HTMLDivElement {
  const el = document.createElement('div');
  el.className = styles.facetLabel ?? '';
  el.dataset.layout = wide ? 'wide' : 'tall';
  el.setAttribute('data-facet-label', letter);
  el.setAttribute('role', 'img');
  el.setAttribute('aria-label', liftMeasure.facetLabel(letter, Math.round(sqFt), pitch));
  const badge = document.createElement('span');
  badge.className = styles.facetLetter ?? '';
  badge.textContent = letter;
  const text = document.createElement('span');
  text.className = styles.facetText ?? '';
  const area = document.createElement('strong');
  area.textContent = liftMeasure.facetArea(sqFt);
  const slope = document.createElement('span');
  slope.textContent = liftMeasure.facetPitch(pitch);
  text.append(area, slope);
  el.append(badge, text);
  return el;
}

/** Facets smaller than this show only their letter. */
const LETTER_ONLY_SQFT = 150;
/** The label cards' sizes in pixels (about, with a little room), for the overlap check. */
const LABEL_SIZE = { wide: [90, 34], tall: [66, 46] } as const;

type Rect = { x0: number; y0: number; x1: number; y1: number };
const overlaps = (a: Rect, b: Rect) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

/**
 * Which label each facet gets, largest facet first: its full card where there is room, else (a small facet, or a card
 * that would cover another) just its letter.
 */
export function labelLayouts(facets: { planSqFt: number; at: { x: number; y: number } | null }[]): ('wide' | 'tall' | 'mini')[] {
  const order = facets.map((_, i) => i).sort((a, b) => facets[b]!.planSqFt - facets[a]!.planSqFt);
  const placed: Rect[] = [];
  const out: ('wide' | 'tall' | 'mini')[] = facets.map(() => 'mini');
  for (const i of order) {
    const f = facets[i]!;
    if (f.at === null || f.planSqFt < LETTER_ONLY_SQFT) continue;
    const layout = f.planSqFt >= WIDE_LABEL_SQFT ? 'wide' : 'tall';
    const [w, h] = LABEL_SIZE[layout];
    const rect = { x0: f.at.x - w / 2, y0: f.at.y - h / 2, x1: f.at.x + w / 2, y1: f.at.y + h / 2 };
    if (placed.some((r) => overlaps(r, rect))) continue;
    placed.push(rect);
    out[i] = layout;
  }
  return out;
}

function useFacetLabels(instance: MapLibreMap | null, model: RoofModel | null, visible: boolean) {
  useEffect(() => {
    if (!instance || !model || !visible) return;
    const elements = model.facets.map((f, i) => facetLabel(facetName(f.id, i), f.areaSqFt, f.pitch, f.planSqFt >= WIDE_LABEL_SQFT));
    const markers = model.facets.map((f, i) => new Marker({ element: elements[i]!, draggable: false }).setLngLat(f.labelAt).addTo(instance));
    const loose = instance as unknown as Loose;
    const layout = () => {
      const at = model.facets.map((f) => {
        try {
          return loose.project?.(f.labelAt) ?? null;
        } catch {
          return null;
        }
      });
      const layouts = labelLayouts(model.facets.map((f, i) => ({ planSqFt: f.planSqFt, at: at[i] ?? null })));
      layouts.forEach((l, i) => {
        const el = elements[i];
        if (el) el.dataset.layout = l;
      });
    };
    layout();
    loose.on?.('zoomend', layout);
    loose.on?.('resize', layout);
    return () => {
      loose.off?.('zoomend', layout);
      loose.off?.('resize', layout);
      for (const marker of markers) marker.remove();
    };
  }, [instance, model, visible]);
}

/**
 * What shows on the photo when: nothing before the scan; the facets and lines once traced; the outline and the
 * buildings' tint while Adjust is open, or when the roof has no facets.
 */
function useLayerVisibility(instance: MapLibreMap | null, m: MeasurementView, model: RoofModel | null, roofDrawn: boolean, done: boolean, editing: boolean, drawMode: boolean) {
  useEffect(() => {
    if (!instance) return;
    try {
      (instance.getSource(STRUCTURES_SOURCE) as { setData?: (data: unknown) => void } | undefined)?.setData?.(structuresData(m.structures));
    } catch {
      // Ignored: the map is going away.
    }
    const outlineShown = drawMode || (done && (editing || model === null));
    setVisible(instance, OUTLINE_LAYERS, outlineShown);
    setVisible(instance, STRUCTURE_LAYERS, done && (editing || model === null));
    setRoofLayers(instance, model, roofDrawn && !(editing && drawMode));
  }, [instance, m.structures, model, roofDrawn, done, editing, drawMode]);
}

/** Re-renders when the map moves or resizes, so overlays drawn in screen space follow the photo. */
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

function project(instance: MapLibreMap | null, ring: Ring): { x: number; y: number }[] {
  const loose = instance as unknown as Loose | null;
  if (!loose?.project) return [];
  const out: { x: number; y: number }[] = [];
  for (const p of ring) {
    try {
      const q = loose.project(p as [number, number]);
      if (Number.isFinite(q.x) && Number.isFinite(q.y)) out.push({ x: q.x, y: q.y });
    } catch {
      // A point the map cannot place is left out.
    }
  }
  return out;
}

/** The scan over the roof: yellow corner brackets, white dots on the outline's corners and a sweep, while it traces. */
function ScanOverlay({ instance, ring, scan }: { instance: MapLibreMap | null; ring: Ring; scan: ScanSession }) {
  useMapMoves(instance);
  const points = project(instance, ring);
  if (points.length < 3) return null;
  const pad = 22;
  const left = Math.min(...points.map((p) => p.x)) - pad;
  const right = Math.max(...points.map((p) => p.x)) + pad;
  const top = Math.min(...points.map((p) => p.y)) - pad;
  const bottom = Math.max(...points.map((p) => p.y)) + pad;
  const box = { left, top, width: right - left, height: bottom - top };
  const tracing = scan.progress < ROOF_DRAWN_AT;
  const dots = Math.max(1, Math.ceil(points.length * Math.min(1, scan.progress / 0.3)));
  return (
    <div className={styles.scanLayer} aria-hidden="true">
      <div className={styles.brackets} style={box}>
        <span data-corner="tl" />
        <span data-corner="tr" />
        <span data-corner="bl" />
        <span data-corner="br" />
        {tracing ? (
          <div className={styles.sweepBox}>
            <div className={styles.sweep} />
          </div>
        ) : null}
      </div>
      {tracing
        ? points.slice(0, dots).map((p, i) => <span key={i} className={styles.vertex} style={{ left: p.x, top: p.y }} />)
        : null}
    </div>
  );
}

function NorthArrow() {
  return (
    <svg className={styles.north} viewBox="0 0 26 34" width="26" height="34" role="img" aria-label={liftMeasure.north} focusable="false">
      <polygon points="13,12 19,31 13,27 7,31" fill="currentColor" />
      <text x="13" y="8" textAnchor="middle" fontSize="9" fontWeight="700" fill="currentColor">
        {liftMeasure.northLetter}
      </text>
    </svg>
  );
}

function ScaleAndNorth({ latitude, zoom }: { latitude: number; zoom: number }) {
  const scale = scaleBarFor(latitude, zoom);
  return (
    <div className={styles.scaleNorth}>
      <div className={styles.scale} role="img" aria-label={liftMeasure.scaleBarLabel(scale.feet)}>
        <span className={styles.scaleLabel}>{liftMeasure.scaleBar(scale.feet)}</span>
        <span className={styles.scaleBar} style={{ width: `${scale.widthPx}px` }} />
      </div>
      <NorthArrow />
    </div>
  );
}

function ImageryChip({ scanning, captured }: { scanning: boolean; captured: Date | null }) {
  if (scanning) {
    return (
      <span className={styles.chip} data-tone="measuring">
        <AiMark size={18} />
        {liftMeasure.measuring}
      </span>
    );
  }
  const when = captured?.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  return (
    <span className={styles.chip}>
      <span className={styles.chipDot} aria-hidden="true" />
      {when !== undefined ? liftMeasure.imageryCaptured(when) : liftMeasure.imageryPlain}
    </span>
  );
}

function Legend({ model }: { model: RoofModel }) {
  return (
    <ul className={styles.legend} aria-label={liftMeasure.legendLabel}>
      {lineKinds(model).map((kind) => (
        <li key={kind} className={styles.legendItem}>
          <span className={styles.legendDash} style={{ background: LINE_COLORS[kind] }} aria-hidden="true" />
          {liftMeasure.lineName[kind]}
        </li>
      ))}
    </ul>
  );
}

type NoticeState = Pick<RoofSession, 'mapFailed' | 'locked' | 'problem' | 'saveFailed' | 'drawMode' | 'finishDrawing' | 'clearDrawing'>;

function Notices({ roof }: { roof: NoticeState }) {
  // A sent (locked) roof says so in the measure card, off the photo
  const any = roof.mapFailed || roof.problem !== null || roof.saveFailed || roof.drawMode;
  if (!any) return null;
  return (
    <div className={styles.notices}>
      {roof.mapFailed ? <Banner tone="warning">{measure.mapFailed}</Banner> : null}
      {roof.problem !== null ? (
        <div role="alert">
          <Banner tone="danger">{measure.problems[roof.problem]}</Banner>
        </div>
      ) : null}
      {roof.saveFailed ? <Banner tone="danger">{measure.saveFailed}</Banner> : null}
      {roof.drawMode && !roof.mapFailed && !roof.locked ? (
        <div className={styles.drawTools}>
          <p className={styles.hint}>{measure.drawHint}</p>
          <Button onClick={roof.finishDrawing}>{measure.finishDrawing}</Button>
          <Button variant="ghost" onClick={roof.clearDrawing}>
            {measure.clearDrawing}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/** The roof as MeasureWindow's one editor draws it: this view places the map's container and what goes over it. */
function Stage({ m, slots, roof, scan, captured }: { m: MeasurementView; slots: MeasureSlots; roof: RoofSession; scan: ScanSession; captured: Date | null }) {
  const { model, editing } = slots;
  const { containerRef, drawMode, saving, map, ring, zoom, mapFailed, locked, problem, saveFailed, finishDrawing, clearDrawing } = roof;
  const done = scan.phase === 'done';
  const roofDrawn = done || (scan.phase === 'scanning' && scan.progress >= ROOF_DRAWN_AT);
  useLayerVisibility(map, m, model, roofDrawn, done, editing, drawMode);
  useFacetLabels(map, model, roofDrawn && !editing);
  const estimate = slots.estimate ?? m.estimate;
  const numbers = cardNumbers(m, estimate, model, slots.wastePct);

  return (
    <div className={styles.frame}>
      <div className={styles.mapBox} data-phase={scan.phase} data-editing={editing || drawMode ? 'true' : 'false'}>
        <div ref={containerRef} className={styles.map} role="region" aria-label={liftMeasure.mapLabel} />
        <div className={styles.topLeft}>
          <ImageryChip scanning={scan.phase === 'scanning' || saving} captured={captured} />
        </div>
        {roofDrawn && model !== null ? <Legend model={model} /> : null}
        <Notices roof={{ mapFailed, locked, problem, saveFailed, drawMode, finishDrawing, clearDrawing }} />
        {scan.phase === 'scanning' ? <ScanOverlay instance={map} ring={ring} scan={scan} /> : null}
        <ScaleAndNorth latitude={m.center[1]} zoom={zoom} />
        <p className={styles.credits}>
          <span>{legal.imageryAttribution}</span>
          <span>{legal.footprintAttribution}</span>
        </p>
        {scan.phase === 'idle' ? (
          <ScanBar scan={scan} />
        ) : (
          <MeasureCard
            m={m}
            numbers={numbers}
            scan={scan}
            outlineOnly={model === null}
            locked={locked}
            editing={editing}
            onEdit={slots.setEditing}
            panels={slots.panels}
          />
        )}
      </div>
    </div>
  );
}

/** The roof, its scan and its numbers. It needs MeasureWindow's editor (the slots); alone it shows the loading state. */
export function RoofView({ measurementId, captured = null }: { measurementId: string; captured?: Date | null }) {
  const query = useMeasurement(measurementId);
  const slots = useContext(MeasureSlotsContext);
  if (query.data !== undefined && slots.roof !== null && slots.scan !== null) {
    return <Stage m={query.data} slots={slots} roof={slots.roof} scan={slots.scan} captured={captured} />;
  }
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
      </div>
    </div>
  );
}
