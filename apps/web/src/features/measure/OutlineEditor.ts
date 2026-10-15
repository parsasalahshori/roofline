import type { LngLat, Ring } from '@roofline/shared';
import { outlineProblem } from '@roofline/shared';
import { Marker } from 'maplibre-gl';
import type { Map as MapLibreMap } from 'maplibre-gl';
import { measure } from '../../copy/measure.ts';
import type { OutlineProblem } from './types.ts';

/** What every pure reducer answers: the new ring and the first problem `outlineProblem(ring)` finds (null = fine). */
export type EditResult = {
  ring: Ring;
  problem: OutlineProblem | null;
  /** True when the edit was turned down and the ring is exactly as it was (the problem says why). */
  refused?: true;
};

const METRES_PER_DEGREE = 111320;
const NUDGE_METRES = 0.5;
const MIN_CORNERS = 3;
const LONG_PRESS_MS = 600;
const LONG_PRESS_SLOP_PX = 4;

function result(ring: Ring): EditResult {
  return { ring, problem: outlineProblem(ring) };
}

/** Move one corner to a new spot. A bad index leaves the outline as it was. */
export function moveCorner(ring: Ring, index: number, to: LngLat): EditResult {
  if (!Number.isInteger(index) || index < 0 || index >= ring.length) return result(ring.slice());
  const next = ring.slice();
  next[index] = [to[0], to[1]];
  return result(next);
}

/** Move one corner a small number of metres east and north (negative means west and south). */
export function nudgeCorner(ring: Ring, index: number, eastM: number, northM: number): EditResult {
  const corner = ring[index];
  if (!corner) return result(ring.slice());
  const dLat = northM / METRES_PER_DEGREE;
  const dLng = eastM / (METRES_PER_DEGREE * Math.cos((corner[1] * Math.PI) / 180));
  return moveCorner(ring, index, [corner[0] + dLng, corner[1] + dLat]);
}

/** Add a new corner right after the given corner. Using the last index adds it at the end. */
export function insertCorner(ring: Ring, afterIndex: number, at: LngLat): EditResult {
  const next = ring.slice();
  const position = Math.min(Math.max(afterIndex + 1, 0), next.length);
  next.splice(position, 0, [at[0], at[1]]);
  return result(next);
}

/** Remove one corner. An outline never goes below three corners: that delete is refused and the problem says so. */
export function deleteCorner(ring: Ring, index: number): EditResult {
  if (!Number.isInteger(index) || index < 0 || index >= ring.length) return result(ring.slice());
  if (ring.length <= MIN_CORNERS) return { ring: ring.slice(), problem: 'too_few_corners', refused: true };
  const next = ring.slice();
  next.splice(index, 1);
  return result(next);
}

/** Finish a drawing: drop the extra last point a double-click adds, then check the shape. */
export function closeDrawing(points: Ring): EditResult {
  const cleaned = points.slice();
  const last = cleaned[cleaned.length - 1];
  const before = cleaned[cleaned.length - 2];
  if (last && before && last[0] === before[0] && last[1] === before[1]) cleaned.pop();
  return result(cleaned);
}

export type OutlineEditorOptions = {
  ring: Ring;
  drawMode: boolean;
  /** True for a measurement behind a sent proposal: the outline shows but cannot be changed. */
  readOnly?: boolean;
  /** Called on every edit with the new ring and its problem. */
  onChange: (result: EditResult) => void;
};
export type OutlineEditor = {
  setRing: (ring: Ring) => void;
  setDrawMode: (draw: boolean) => void;
  setReadOnly: (readOnly: boolean) => void;
  finishDrawing: () => void;
  clearDrawing: () => void;
  destroy: () => void;
};

// The few map members we use, typed loosely so the editor also runs against a small test double.
type MapEvent = { lngLat?: { lng: number; lat: number }; preventDefault?: () => void };
type Handler = (event: MapEvent) => void;
type LooseMap = {
  addSource: (id: string, spec: unknown) => unknown;
  addLayer: (spec: unknown) => unknown;
  getSource: (id: string) => { setData?: (data: unknown) => void } | undefined;
  getLayer: (id: string) => unknown;
  removeLayer: (id: string) => unknown;
  removeSource: (id: string) => unknown;
  on: (type: string, fn: Handler) => unknown;
  off: (type: string, fn: Handler) => unknown;
  unproject: (point: [number, number]) => { lng: number; lat: number };
  project: (point: [number, number]) => { x: number; y: number };
  getCanvas: () => HTMLCanvasElement;
  doubleClickZoom: { enable: () => void; disable: () => void };
  dragPan?: { enable: () => void; disable: () => void; isEnabled?: () => boolean };
  isStyleLoaded: () => boolean;
};

function safe(fn: () => void): void {
  try {
    fn();
  } catch {
    // The map may be mid-teardown or its style not ready; editing must never throw.
  }
}

function polygonData(ring: Ring): unknown {
  if (ring.length >= 3) {
    return {
      type: 'FeatureCollection',
      features: [{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[...ring, ring[0]]] } }],
    };
  }
  if (ring.length === 2) {
    return {
      type: 'FeatureCollection',
      features: [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: ring } }],
    };
  }
  return { type: 'FeatureCollection', features: [] };
}

function lineData(points: Ring): unknown {
  if (points.length < 2) return { type: 'FeatureCollection', features: [] };
  return {
    type: 'FeatureCollection',
    features: [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: points } }],
  };
}

function midpoint(a: LngLat, b: LngLat): LngLat {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
}

// Corners grab a 40 px area and sit above the add-a-corner dots, which grab only 22 px: where corners are close
// together a dot's area would otherwise cover a corner, and grabbing that corner would grab the dot.
const CORNER_BOX_PX = 40;
const MID_BOX_PX = 22;
const CORNER_LAYER = '2';
const MID_LAYER = '1';

function handleBox(sizePx: number, layer: string): HTMLDivElement {
  const el = document.createElement('div');
  el.style.width = `${sizePx}px`;
  el.style.height = `${sizePx}px`;
  el.style.zIndex = layer;
  el.style.display = 'flex';
  el.style.alignItems = 'center';
  el.style.justifyContent = 'center';
  el.style.cursor = 'grab';
  el.style.touchAction = 'none';
  return el;
}

function dot(size: number, fill: string): HTMLDivElement {
  const d = document.createElement('div');
  d.style.width = `${size}px`;
  d.style.height = `${size}px`;
  d.style.borderRadius = '50%';
  d.style.background = fill;
  d.style.border = '2px solid #ffffff';
  d.style.boxSizing = 'border-box';
  d.style.pointerEvents = 'none';
  return d;
}

/** Puts an editable roof outline on the map: draw new corners, drag, nudge with arrow keys, add and delete corners. */
export function createOutlineEditor(map: MapLibreMap, options: OutlineEditorOptions): OutlineEditor {
  const m = map as unknown as LooseMap;
  let ring: Ring = options.ring.slice();
  let readOnly = options.readOnly === true;
  let drawing = options.drawMode && !readOnly;
  let draft: Ring = [];
  let destroyed = false;
  let installed = false;
  let cornerMarkers: Marker[] = [];
  let midMarkers: Marker[] = [];
  let draftMarkers: Marker[] = [];
  let dragIndex = -1;
  let dragTimer: ReturnType<typeof setTimeout> | null = null;
  let dragStart = { x: 0, y: 0 };
  let removeDragListeners: (() => void) | null = null;
  const elementCleanups: Array<() => void> = [];

  const setSourceData = (id: string, data: unknown) => safe(() => m.getSource(id)?.setData?.(data));

  const install = () => {
    if (installed || destroyed) return;
    safe(() => {
      m.addSource('outline-src', { type: 'geojson', data: polygonData(ring) });
      m.addSource('draft-src', { type: 'geojson', data: lineData(draft) });
      m.addLayer({
        id: 'outline-fill',
        type: 'fill',
        source: 'outline-src',
        paint: { 'fill-color': '#f59e0b', 'fill-opacity': 0.2 },
      });
      m.addLayer({
        id: 'outline-line',
        type: 'line',
        source: 'outline-src',
        paint: { 'line-color': '#f59e0b', 'line-width': 3 },
      });
      m.addLayer({
        id: 'draft-line',
        type: 'line',
        source: 'draft-src',
        paint: { 'line-color': '#ffffff', 'line-width': 3, 'line-dasharray': [2, 2] },
      });
      installed = true;
    });
  };
  const onStyleLoad: Handler = () => {
    install();
    if (installed) {
      m.off('load', onStyleLoad);
      renderSources();
    }
  };

  const renderSources = () => {
    setSourceData('outline-src', polygonData(ring));
    setSourceData('draft-src', lineData(draft));
  };

  const clearHandles = () => {
    for (const cleanup of elementCleanups.splice(0)) cleanup();
    for (const mk of [...cornerMarkers, ...midMarkers]) safe(() => mk.remove());
    cornerMarkers = [];
    midMarkers = [];
  };
  const clearDraftDots = () => {
    for (const mk of draftMarkers) safe(() => mk.remove());
    draftMarkers = [];
  };

  const toLngLatFromPointer = (clientX: number, clientY: number): LngLat => {
    const rect = m.getCanvas().getBoundingClientRect();
    const p = m.unproject([clientX - rect.left, clientY - rect.top]);
    return [p.lng, p.lat];
  };

  // The map pans on any press that reaches it, so a corner drag holds panning off until the corner is let go.
  let panHeld = false;
  const holdPan = () => {
    if (panHeld) return;
    safe(() => {
      if (m.dragPan && m.dragPan.isEnabled?.() !== false) {
        m.dragPan.disable();
        panHeld = true;
      }
    });
  };
  const releasePan = () => {
    if (!panHeld) return;
    panHeld = false;
    safe(() => m.dragPan?.enable());
  };

  const endDrag = () => {
    releasePan();
    if (dragTimer) clearTimeout(dragTimer);
    dragTimer = null;
    dragIndex = -1;
    removeDragListeners?.();
    removeDragListeners = null;
  };

  const focusCorner = (index: number) => {
    const target = cornerMarkers[index]?.getElement();
    safe(() => target?.focus());
  };

  // Commit an edit: redraw everything, then tell the owner.
  const commit = (res: EditResult, focusIndex?: number) => {
    if (res.refused) {
      options.onChange(res);
      return;
    }
    editorApi.setRing(res.ring);
    if (focusIndex !== undefined && focusIndex >= 0) focusCorner(Math.min(focusIndex, res.ring.length - 1));
    options.onChange(res);
  };

  const positionHandles = () => {
    cornerMarkers.forEach((mk, i) => {
      const at = ring[i];
      if (at) mk.setLngLat(at);
    });
    midMarkers.forEach((mk, i) => {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      if (a && b) mk.setLngLat(midpoint(a, b));
    });
  };

  const listen = <E extends Event>(el: HTMLElement, type: string, fn: (e: E) => void) => {
    const handler = fn as unknown as EventListener;
    el.addEventListener(type, handler);
    elementCleanups.push(() => el.removeEventListener(type, handler));
  };

  // A press on a handle is the handle's, never the map's: without this the map pans along with the drag.
  const keepFromMap = (el: HTMLElement) => {
    for (const type of ['pointerdown', 'mousedown', 'touchstart']) listen(el, type, (e: Event) => e.stopPropagation());
  };

  /** Drag corner `index` with the pointer from (x, y) until it is let go. A long press without moving deletes it. */
  const startCornerDrag = (index: number, x: number, y: number, longPressDeletes: boolean) => {
    endDrag();
    holdPan();
    dragIndex = index;
    dragStart = { x, y };
    if (longPressDeletes) {
      dragTimer = setTimeout(() => {
        dragTimer = null;
        const i = dragIndex;
        endDrag();
        if (i >= 0) commit(deleteCorner(ring, i), i);
      }, LONG_PRESS_MS);
    }
    const onMove = (ev: PointerEvent) => {
      if (dragIndex < 0) return;
      if (dragTimer && Math.hypot(ev.clientX - dragStart.x, ev.clientY - dragStart.y) > LONG_PRESS_SLOP_PX) {
        clearTimeout(dragTimer);
        dragTimer = null;
      }
      const res = moveCorner(ring, dragIndex, toLngLatFromPointer(ev.clientX, ev.clientY));
      ring = res.ring;
      renderSources();
      positionHandles();
      options.onChange(res);
    };
    const onUp = () => endDrag();
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    removeDragListeners = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  };

  const buildCorner = (index: number): Marker => {
    const el = handleBox(CORNER_BOX_PX, CORNER_LAYER);
    el.setAttribute('role', 'button');
    el.tabIndex = 0;
    el.setAttribute('aria-label', measure.corner(index + 1, ring.length));
    el.setAttribute('data-handle', 'corner');
    el.setAttribute('data-corner-index', String(index));
    el.appendChild(dot(16, '#f59e0b'));

    listen(el, 'pointerdown', (e: PointerEvent) => {
      if (drawing) return;
      e.preventDefault();
      safe(() => el.setPointerCapture?.(e.pointerId));
      startCornerDrag(index, e.clientX, e.clientY, true);
    });

    listen(el, 'keydown', (e: KeyboardEvent) => {
      let res: EditResult;
      switch (e.key) {
        case 'ArrowLeft':
          res = nudgeCorner(ring, index, -NUDGE_METRES, 0);
          break;
        case 'ArrowRight':
          res = nudgeCorner(ring, index, NUDGE_METRES, 0);
          break;
        case 'ArrowUp':
          res = nudgeCorner(ring, index, 0, NUDGE_METRES);
          break;
        case 'ArrowDown':
          res = nudgeCorner(ring, index, 0, -NUDGE_METRES);
          break;
        case 'Delete':
        case 'Backspace':
          res = deleteCorner(ring, index);
          break;
        default:
          return;
      }
      e.preventDefault();
      commit(res, index);
    });
    keepFromMap(el);

    return new Marker({ element: el, draggable: false }).setLngLat(ring[index] as LngLat).addTo(map);
  };

  const buildMid = (index: number): Marker => {
    const el = handleBox(MID_BOX_PX, MID_LAYER);
    el.setAttribute('role', 'button');
    el.tabIndex = 0;
    el.setAttribute('aria-label', measure.addCorner);
    el.setAttribute('data-handle', 'mid');
    el.setAttribute('data-mid-index', String(index));
    el.style.cursor = 'copy';
    el.appendChild(dot(10, '#ffffff'));
    let used = false;
    let downAt: { x: number; y: number } | null = null;
    const activate = () => {
      if (used || destroyed) return;
      used = true;
      const a = ring[index] as LngLat;
      const b = ring[(index + 1) % ring.length] as LngLat;
      commit(insertCorner(ring, index, midpoint(a, b)), index + 1);
    };
    listen(el, 'click', activate);
    listen(el, 'pointerdown', (e: PointerEvent) => {
      if (drawing) return;
      e.preventDefault();
      holdPan();
      const start = { x: e.clientX, y: e.clientY };
      downAt = start;
      // Dragging the dot adds a corner and moves it with the pointer, the way the corners themselves move.
      const onMove = (ev: PointerEvent) => {
        if (used || destroyed || Math.hypot(ev.clientX - start.x, ev.clientY - start.y) <= LONG_PRESS_SLOP_PX) return;
        stop();
        activate();
        startCornerDrag(index + 1, start.x, start.y, false);
        const res = moveCorner(ring, index + 1, toLngLatFromPointer(ev.clientX, ev.clientY));
        ring = res.ring;
        renderSources();
        positionHandles();
        options.onChange(res);
      };
      const stop = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', stop);
        window.removeEventListener('pointercancel', stop);
        if (dragIndex < 0) releasePan();
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', stop);
      window.addEventListener('pointercancel', stop);
    });
    keepFromMap(el);
    listen(el, 'pointerup', (e: PointerEvent) => {
      const start = downAt;
      downAt = null;
      if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) <= LONG_PRESS_SLOP_PX) activate();
    });
    listen(el, 'keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        activate();
      }
    });
    const a = ring[index] as LngLat;
    const b = ring[(index + 1) % ring.length] as LngLat;
    return new Marker({ element: el, draggable: false }).setLngLat(midpoint(a, b)).addTo(map);
  };

  const rebuildHandles = () => {
    clearHandles();
    if (drawing || readOnly || destroyed) return;
    cornerMarkers = ring.map((_, i) => buildCorner(i));
    if (ring.length >= 3) midMarkers = ring.map((_, i) => buildMid(i));
  };

  const addDraftDot = (at: LngLat) => {
    const el = document.createElement('div');
    el.style.width = '16px';
    el.style.height = '16px';
    el.style.pointerEvents = 'none';
    el.appendChild(dot(16, '#ffffff'));
    draftMarkers.push(new Marker({ element: el, draggable: false }).setLngLat(at).addTo(map));
  };

  const clearDraft = () => {
    draft = [];
    clearDraftDots();
    setSourceData('draft-src', lineData(draft));
  };

  const finish = () => {
    if (!drawing || draft.length === 0) return;
    const res = closeDrawing(draft);
    options.onChange(res);
    if (res.problem !== null) {
      // Keep drawing: drop any doubled point and let the user add corners.
      draft = res.ring.slice();
      clearDraftDots();
      for (const pt of draft) addDraftDot(pt);
      setSourceData('draft-src', lineData(draft));
      return;
    }
    clearDraft();
    leaveDraw();
    editorApi.setRing(res.ring);
  };

  const onClick: Handler = (e) => {
    if (!drawing || !e?.lngLat) return;
    const at: LngLat = [e.lngLat.lng, e.lngLat.lat];
    draft.push(at);
    setSourceData('draft-src', lineData(draft));
    addDraftDot(at);
  };
  const onDblClick: Handler = (e) => {
    if (!drawing) return;
    e?.preventDefault?.();
    finish();
  };
  const onMouseMove: Handler = () => {
    // Keeps the cursor honest while drawing.
    if (drawing) safe(() => (m.getCanvas().style.cursor = 'crosshair'));
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (!drawing) return;
    const t = e.target;
    if (t instanceof Element && t.closest('input, textarea, select, button, a[href], [contenteditable="true"]')) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      finish();
    } else if (e.key === 'Escape') {
      clearDraft();
    }
  };

  const enterDraw = () => {
    if (readOnly) return;
    drawing = true;
    clearDraft();
    clearHandles();
    safe(() => m.doubleClickZoom.disable());
    safe(() => (m.getCanvas().style.cursor = 'crosshair'));
  };
  function leaveDraw() {
    drawing = false;
    safe(() => m.doubleClickZoom.enable());
    safe(() => (m.getCanvas().style.cursor = ''));
  }

  const editorApi: OutlineEditor = {
    // Replace the outline and redraw the shape and its corner handles.
    setRing(next) {
      if (destroyed) return;
      endDrag();
      ring = next.slice();
      renderSources();
      rebuildHandles();
    },
    // Switch between drawing a fresh outline and editing the existing one.
    setDrawMode(draw) {
      if (destroyed || readOnly) return;
      if (draw) {
        endDrag();
        enterDraw();
      } else {
        clearDraft();
        leaveDraw();
        rebuildHandles();
      }
    },
    // Lock or unlock editing; locking drops any drawing in progress and every handle.
    setReadOnly(next) {
      if (destroyed) return;
      readOnly = next;
      if (readOnly) {
        endDrag();
        if (drawing) {
          clearDraft();
          leaveDraw();
        }
      }
      rebuildHandles();
    },
    finishDrawing() {
      if (destroyed || readOnly) return;
      finish();
    },
    clearDrawing() {
      if (destroyed) return;
      if (drawing) clearDraft();
    },
    // Remove every handle, listener, layer and source this editor added.
    destroy() {
      if (destroyed) return;
      endDrag();
      clearHandles();
      clearDraftDots();
      safe(() => m.off('load', onStyleLoad));
      safe(() => m.off('click', onClick));
      safe(() => m.off('dblclick', onDblClick));
      safe(() => m.off('mousemove', onMouseMove));
      document.removeEventListener('keydown', onKeyDown);
      for (const id of ['draft-line', 'outline-line', 'outline-fill']) {
        safe(() => {
          if (m.getLayer(id)) m.removeLayer(id);
        });
      }
      for (const id of ['draft-src', 'outline-src']) {
        safe(() => {
          if (m.getSource(id)) m.removeSource(id);
        });
      }
      safe(() => m.doubleClickZoom.enable());
      safe(() => (m.getCanvas().style.cursor = ''));
      destroyed = true;
    },
  };

  safe(() => m.on('click', onClick));
  safe(() => m.on('dblclick', onDblClick));
  safe(() => m.on('mousemove', onMouseMove));
  document.addEventListener('keydown', onKeyDown);

  let ready = false;
  safe(() => {
    ready = m.isStyleLoaded();
  });
  if (ready) install();
  else safe(() => m.on('load', onStyleLoad));

  if (drawing) enterDraw();
  else rebuildHandles();

  return editorApi;
}
