import 'maplibre-gl/dist/maplibre-gl.css';
import { Banner, Button, Skeleton } from '@roofline/ui';
import type { LngLat, Ring } from '@roofline/shared';
import { Marker, type Map as MapLibreMap } from 'maplibre-gl';
import { useContext, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { legal } from '../../../copy/legal.ts';
import { usesFreeAerial } from './aerial.ts';
import { usesGoogleImagery } from './googleTiles.ts';
import { liftMeasure } from '../../../copy/liftMeasure.ts';
import { measure } from '../../../copy/measure.ts';
import { useMeasurement } from '../api.ts';
import type { MeasurementView } from '../types.ts';
import { AiMark } from './AiMark.tsx';
import { Credits } from './Credits.tsx';
import { spreadLabels, type ScreenPoint } from './labelSpread.ts';
import { cardNumbers, MeasureCard } from './MeasureCard.tsx';
import { hiddenEdges, lidarFaces, setEdgeCue, setLidarFaces } from './edgeCue.ts';
import { BuildingPopover, type PopoverAt } from './BuildingPopover.tsx';
import { facetAt, facetName, LINE_COLORS, lineKinds, setRoofLayers, type RoofModel } from './roofModel.ts';
import styles from './RoofView.module.css';
import { ScanBar } from './ScanBar.tsx';
import type { ScanSession } from './scan.ts';
import { ScanOverlay } from './ScanOverlay.tsx';
import { MeasureSlotsContext, type MeasureSlots, type QuoteSession, type RoofSession } from './slots.ts';
import { buildingAt, STRUCTURE_LAYERS, STRUCTURES_SOURCE, structuresData, type BuildingRow } from './structures.ts';

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

type MapPointerEvent = { lngLat?: { lng: number; lat: number }; originalEvent?: { target?: EventTarget | null } };
type Loose = {
  getLayer?: (id: string) => unknown;
  getSource?: (id: string) => unknown;
  setLayoutProperty?: (id: string, name: string, value: string) => void;
  project?: (p: [number, number]) => { x: number; y: number };
  on?: (type: string, fn: (e?: MapPointerEvent) => void) => void;
  off?: (type: string, fn: (e?: MapPointerEvent) => void) => void;
  getCanvas?: () => HTMLCanvasElement;
  resize?: () => void;
};

const OUTLINE_LAYERS = ['outline-fill', 'outline-line'] as const;

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

/**
 * The white label card on each facet: its letter, area and pitch. It is a button that puts the section in or out of the
 * quote (pressed: in the quote); a section left out says so instead of its pitch.
 */
function facetLabel(letter: string, sqFt: number, pitch: string, wide: boolean): HTMLButtonElement {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = styles.facetLabel ?? '';
  el.dataset.layout = wide ? 'wide' : 'tall';
  el.setAttribute('data-facet-label', letter);
  el.setAttribute('aria-label', liftMeasure.facetToggle(letter, Math.round(sqFt), pitch));
  el.title = liftMeasure.facetTitle(letter, Math.round(sqFt), pitch);
  const badge = document.createElement('span');
  badge.className = styles.facetLetter ?? '';
  badge.textContent = letter;
  const text = document.createElement('span');
  text.className = styles.facetText ?? '';
  const area = document.createElement('strong');
  area.textContent = liftMeasure.facetArea(sqFt);
  const slope = document.createElement('span');
  slope.dataset.slope = pitch;
  slope.textContent = liftMeasure.facetPitch(pitch);
  text.append(area, slope);
  el.append(badge, text);
  return el;
}

/** Shows a label as in or out of the quote. */
function setFacetState(el: HTMLButtonElement, excluded: boolean, disabled: boolean): void {
  el.setAttribute('aria-pressed', excluded ? 'false' : 'true');
  el.dataset.excluded = excluded ? 'true' : 'false';
  el.disabled = disabled;
  const slope = el.querySelector<HTMLElement>('[data-slope]');
  if (slope) slope.textContent = excluded ? liftMeasure.facetLeftOut : liftMeasure.facetPitch(slope.dataset.slope ?? '');
}

/** Label cards closer than this on screen would cover each other (and the roof): they shrink to their letter. */
const CROWDED_DX_PX = 96;
const CROWDED_DY_PX = 44;
/** A letter alone is a 26px disc: two of them closer than this (with a gap) are pushed apart so each shows whole. */
const LETTER_APART_PX = 30;

/** Where each point is on the screen; one the map cannot place stays at the origin (so it moves nothing it is not near). */
function placed(instance: MapLibreMap, points: readonly [number, number][]): ScreenPoint[] {
  const loose = instance as unknown as Loose;
  return points.map((p) => {
    try {
      const q = loose.project?.(p);
      return q !== undefined && Number.isFinite(q.x) && Number.isFinite(q.y) ? { x: q.x, y: q.y } : { x: 0, y: 0 };
    } catch {
      return { x: 0, y: 0 };
    }
  });
}

/** Whether any two label points are too close on screen for full labels at this zoom. */
function crowded(instance: MapLibreMap, points: readonly [number, number][]): boolean {
  const at = project(instance, points as Ring);
  for (let i = 0; i < at.length; i++) {
    for (let j = i + 1; j < at.length; j++) {
      if (Math.abs(at[i]!.x - at[j]!.x) < CROWDED_DX_PX && Math.abs(at[i]!.y - at[j]!.y) < CROWDED_DY_PX) return true;
    }
  }
  return false;
}

/**
 * The facet labels. They are made once per roof (so a pressed label keeps the keyboard focus) and only their state
 * follows the sections left out. A press toggles the section (not while the roof is locked). When the labels would
 * cover each other (a small roof, or zoomed out), each shows only its letter; the rest stays in its name and tooltip.
 */
function useFacetLabels(instance: MapLibreMap | null, model: RoofModel | null, visible: boolean, quote: QuoteSession | null, locked: boolean) {
  const elements = useRef(new Map<string, HTMLButtonElement>());
  const toggle = useRef<((id: string) => void) | null>(null);
  useEffect(() => {
    toggle.current = quote?.toggleFacet ?? null;
  });
  const facets = model?.facets ?? null;
  useEffect(() => {
    if (!instance || !facets || !visible) return;
    const made = elements.current;
    const markers = facets.map((f, i) => {
      const el = facetLabel(facetName(f.id, i), f.areaSqFt, f.pitch, f.planSqFt >= WIDE_LABEL_SQFT);
      el.addEventListener('click', (event) => {
        event.stopPropagation();
        toggle.current?.(f.id);
      });
      made.set(f.id, el);
      return new Marker({ element: el, draggable: false }).setLngLat(f.labelAt).addTo(instance);
    });
    const points = facets.map((f) => f.labelAt);
    const fit = () => {
      const tight = crowded(instance, points);
      for (const el of made.values()) el.dataset.compact = tight ? 'true' : 'false';
      // Letters that still touch (two facets whose label points are a few pixels apart) are moved apart: none hides another
      const offsets = tight ? spreadLabels(placed(instance, points), LETTER_APART_PX) : null;
      markers.forEach((marker, i) => (marker as unknown as { setOffset?: (offset: [number, number]) => void }).setOffset?.(offsets?.[i] ?? [0, 0]));
    };
    fit();
    const loose = instance as unknown as Loose;
    loose.on?.('zoomend', fit);
    loose.on?.('resize', fit);
    return () => {
      loose.off?.('zoomend', fit);
      loose.off?.('resize', fit);
      for (const marker of markers) marker.remove();
      made.clear();
    };
  }, [instance, facets, visible]);
  const excludedKey = (model?.excluded ?? []).join(' ');
  const canToggle = quote !== null && !locked && (facets?.length ?? 0) > 1;
  useEffect(() => {
    const out = new Set(excludedKey === '' ? [] : excludedKey.split(' '));
    for (const [id, el] of elements.current) setFacetState(el, out.has(id), !canToggle);
  }, [excludedKey, canToggle, instance, facets, visible]);
}

/**
 * What shows on the photo when: nothing before the scan; the facets and lines once traced; the outline and the
 * buildings' tint while Adjust is open, or when the roof has no facets.
 */
function useLayerVisibility(
  instance: MapLibreMap | null,
  m: MeasurementView,
  model: RoofModel | null,
  roofDrawn: boolean,
  done: boolean,
  editing: boolean,
  drawMode: boolean,
  hovered: string | null,
) {
  useEffect(() => {
    if (!instance) return;
    try {
      (instance.getSource(STRUCTURES_SOURCE) as { setData?: (data: unknown) => void } | undefined)?.setData?.(structuresData(m.structures, hovered));
    } catch {
      // Ignored: the map is going away.
    }
    const outlineShown = drawMode || (done && (editing || model === null));
    setVisible(instance, OUTLINE_LAYERS, outlineShown);
    setVisible(instance, STRUCTURE_LAYERS, done && (editing || model === null));
    setRoofLayers(instance, model, roofDrawn && !(editing && drawMode));
  }, [instance, m.structures, model, roofDrawn, done, editing, drawMode, hovered]);
}

/** Whether a click on this building opens its popover: any building but the main house while it is in the quote. */
function opensPopover(b: BuildingRow): boolean {
  return !(b.role === 'main' && b.included);
}

/**
 * Clicks and hovers on the measured photo, once the roof is measured (not while an outline is drawn):
 * - a building other than the main house (in the quote) opens its popover: add it to this quote or leave it out,
 *   or measure it as its own estimate; hovering it outlines it and shows a pointer;
 * - a facet of the roof puts that section in or out of the quote;
 * - a spot with no building outline opens the popover to measure the roof there (owner and office);
 * - with a popover open, a click elsewhere closes it (another building's click opens that one instead).
 * Clicks on a facet label or an outline handle are theirs, not the map's.
 */
function useRoofPointer(
  instance: MapLibreMap | null,
  o: { active: boolean; model: RoofModel | null; quote: QuoteSession | null; locked: boolean; popover: PopoverAt | null; setPopover: (next: PopoverAt | null) => void },
) {
  const latest = useRef(o);
  const cursorSet = useRef(false);
  useEffect(() => {
    latest.current = o;
  });
  useEffect(() => {
    const loose = instance as unknown as Loose | null;
    if (!loose?.on) return;
    const canvas = () => {
      try {
        return loose.getCanvas?.() ?? null;
      } catch {
        return null;
      }
    };
    const setCursor = (pointer: boolean) => {
      const c = canvas();
      if (!c || pointer === cursorSet.current) return;
      cursorSet.current = pointer;
      c.style.cursor = pointer ? 'pointer' : '';
    };
    const pointAt = (e?: MapPointerEvent): LngLat | null => (e?.lngLat ? [e.lngLat.lng, e.lngLat.lat] : null);
    const usable = (b: BuildingRow | null, s: typeof o): b is BuildingRow =>
      b !== null && s.quote !== null && opensPopover(b) && (!s.locked || (s.quote.canMeasureOther && b.role !== 'main'));
    const onClick = (e?: MapPointerEvent) => {
      const s = latest.current;
      const at = pointAt(e);
      if (!s.active || s.quote === null || at === null) return;
      const target = e?.originalEvent?.target;
      const c = canvas();
      if (target != null && c !== null && target !== c) return;
      const b = buildingAt(s.quote.buildings, at);
      if (s.popover !== null) {
        const other = usable(b, s) && b.footprintId !== s.popover.building?.footprintId;
        s.setPopover(other ? { lng: at[0], lat: at[1], building: b } : null);
        return;
      }
      if (usable(b, s)) {
        s.setPopover({ lng: at[0], lat: at[1], building: b });
        return;
      }
      const facet = facetAt(s.model, at);
      if (facet !== null) {
        if (!s.locked && (s.model?.facets.length ?? 0) > 1) s.quote.toggleFacet(facet);
        return;
      }
      if (b === null && s.quote.canMeasureOther) s.setPopover({ lng: at[0], lat: at[1], building: null });
    };
    const onMove = (e?: MapPointerEvent) => {
      const s = latest.current;
      const at = pointAt(e);
      if (!s.active || s.quote === null || at === null) {
        if (cursorSet.current) setCursor(false);
        if (s.quote?.hovered != null) s.quote.setHovered(null);
        return;
      }
      const b = buildingAt(s.quote.buildings, at);
      const hit = usable(b, s) ? b : null;
      if ((s.quote.hovered ?? null) !== (hit?.footprintId ?? null)) s.quote.setHovered(hit?.footprintId ?? null);
      const onFacet = hit === null && !s.locked && (s.model?.facets.length ?? 0) > 1 && facetAt(s.model, at) !== null;
      setCursor(hit !== null || onFacet);
    };
    const onOut = () => {
      const s = latest.current;
      if (cursorSet.current) setCursor(false);
      if (s.quote?.hovered != null) s.quote.setHovered(null);
    };
    loose.on('click', onClick);
    loose.on('mousemove', onMove);
    loose.on('mouseout', onOut);
    return () => {
      loose.off?.('click', onClick);
      loose.off?.('mousemove', onMove);
      loose.off?.('mouseout', onOut);
    };
  }, [instance]);
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
function RoofScanOverlay({ instance, ring, scan }: { instance: MapLibreMap | null; ring: Ring; scan: ScanSession }) {
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
  return <ScanOverlay box={box} sweeping={tracing} points={tracing ? points.slice(0, dots) : []} />;
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

type NoticeState = Pick<RoofSession, 'mapFailed' | 'locked' | 'problem' | 'saveFailed' | 'drawMode' | 'finishDrawing' | 'clearDrawing'> & { roofPhotoExpired?: boolean };

export function Notices({ roof }: { roof: NoticeState }) {
  // A sent (locked) roof says so in the measure card, off the photo
  const photoExpired = roof.roofPhotoExpired === true && !roof.mapFailed;
  const any = roof.mapFailed || roof.problem !== null || roof.saveFailed || roof.drawMode || photoExpired;
  if (!any) return null;
  return (
    <div className={styles.notices} data-notices="">
      {roof.mapFailed ? <Banner tone="warning">{measure.mapFailed}</Banner> : null}
      {photoExpired ? (
        <div data-roof-photo-expired="">
          <Banner tone="warning">{legal.googlePhotoExpired}</Banner>
        </div>
      ) : null}
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

/**
 * Whether Microsoft's building outlines are on the photo: always for a roof measured from them; for a roof measured in
 * 3D (its outline is Google's) only while Adjust shows the other buildings' outlines.
 */
export function footprintsShown(m: MeasurementView, editing: boolean): boolean {
  if (m.roof3d == null) return true;
  return editing && m.structures.some((s) => s.main !== true);
}

/** The roof as MeasureWindow's one editor draws it: this view places the map's container and what goes over it. */
function Stage({ m, slots, roof, scan, captured }: { m: MeasurementView; slots: MeasureSlots; roof: RoofSession; scan: ScanSession; captured: Date | null }) {
  const { model, editing, quote } = slots;
  const { containerRef, drawMode, saving, map, ring, zoom, mapFailed, roofPhotoExpired, locked, problem, saveFailed, finishDrawing, clearDrawing } = roof;
  const done = scan.phase === 'done';
  const roofDrawn = done || (scan.phase === 'scanning' && scan.progress >= ROOF_DRAWN_AT);
  const [popover, setPopover] = useState<PopoverAt | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const active = done && !drawMode && !mapFailed;
  // The building a popover is about, as it stands now (its row changes when it is added or left out)
  const shown = popover === null || !active ? null : { ...popover, building: popover.building === null ? null : (quote?.buildings.find((b) => b.footprintId === popover.building?.footprintId) ?? popover.building) };
  // Outlined: the building under the pointer (or its row), else the one the popover is about
  useLayerVisibility(map, m, model, roofDrawn, done, editing, drawMode, quote?.hovered ?? shown?.building?.footprintId ?? null);
  useFacetLabels(map, model, roofDrawn && !editing, quote, locked);
  // Outline edges the height map cannot verify, dashed (while the outline is the 3D roof's own)
  const hidden = useMemo(() => hiddenEdges(m.roof3d, ring), [m.roof3d, ring]);
  useEffect(() => setEdgeCue(map, hidden, roofDrawn && !drawMode), [map, hidden, roofDrawn, drawMode]);
  const lidarShaded = useMemo(() => lidarFaces(m.roof3d, ring), [m.roof3d, ring]);
  useEffect(() => setLidarFaces(map, lidarShaded, roofDrawn && !drawMode), [map, lidarShaded, roofDrawn, drawMode]);
  useRoofPointer(map, { active, model, quote, locked, popover, setPopover });
  const estimate = slots.estimate ?? m.estimate;
  const numbers = cardNumbers(m, estimate, model, slots.wastePct);

  return (
    <div className={styles.frame}>
      <div ref={boxRef} className={styles.mapBox} data-phase={scan.phase} data-editing={editing || drawMode ? 'true' : 'false'}>
        <div ref={containerRef} className={styles.map} role="region" aria-label={liftMeasure.mapLabel} />
        <div className={styles.topLeft}>
          <ImageryChip scanning={scan.phase === 'scanning' || saving} captured={captured} />
        </div>
        {roofDrawn && model !== null ? <Legend model={model} /> : null}
        {scan.phase === 'scanning' ? <RoofScanOverlay instance={map} ring={ring} scan={scan} /> : null}
        <ScaleAndNorth latitude={m.center[1]} zoom={zoom} />
        <Credits>
          <span>{usesGoogleImagery() ? legal.googleImageryAttribution : usesFreeAerial({ maptilerKey: import.meta.env.VITE_MAPTILER_KEY }) ? legal.imageryAttribution : legal.maptilerImageryAttribution}</span>
          {footprintsShown(m, editing) ? <span>{legal.footprintAttribution}</span> : null}
        </Credits>
        {/* The notices at the top and the card at the bottom share one column, so they can never overlap */}
        <div className={styles.overlay}>
          <Notices roof={{ mapFailed, roofPhotoExpired, locked, problem, saveFailed, drawMode, finishDrawing, clearDrawing }} />
          <div className={styles.overlaySpacer} />
          {scan.phase === 'idle' ? null : (
            <MeasureCard
              m={m}
              numbers={numbers}
              scan={scan}
              outlineOnly={model === null}
              locked={locked}
              editing={editing}
              onEdit={slots.setEditing}
              panels={slots.panels}
              model={model}
              quote={quote}
            />
          )}
        </div>
        {scan.phase === 'idle' ? <ScanBar scan={scan} /> : null}
        {shown !== null && quote !== null ? (
          <BuildingPopover
            key={`${shown.lng},${shown.lat}`}
            instance={map}
            box={boxRef}
            at={shown}
            avoid={ring}
            quote={quote}
            locked={locked}
            onClose={() => setPopover(null)}
          />
        ) : null}
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
