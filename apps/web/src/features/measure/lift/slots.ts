import type { instantEstimate, Ring } from '@roofline/shared';
import type { Map as MapLibreMap } from 'maplibre-gl';
import { createContext, type ReactNode, type RefObject } from 'react';
import type { OutlineProblem } from '../types.ts';
import type { RoofModel } from './roofModel.ts';
import type { ScanSession } from './scan.ts';

/**
 * The one roof editor, owned by MeasureWindow (it has the saves, the draw mode and the lock), handed down so
 * RoofView can place the map container and draw its overlays around it.
 */
export type RoofSession = {
  /** MeasureWindow's map is created inside this element, so RoofView must render it exactly once. */
  containerRef: RefObject<HTMLDivElement | null>;
  /** The map once it has loaded; null before then and when it could not start. */
  map: MapLibreMap | null;
  zoom: number;
  ring: Ring;
  drawMode: boolean;
  locked: boolean;
  conflict: boolean;
  problem: OutlineProblem | null;
  mapFailed: boolean;
  saving: boolean;
  saveFailed: boolean;
  finishDrawing: () => void;
  clearDrawing: () => void;
  redraw: () => void;
};

/**
 * What MeasureWindow hands down. `roof` is the editor; `panels` are the controls that change the estimate
 * (buildings, pitch, overhang, the numbers) shown under Adjust; `estimate` is the live number set, ahead of what
 * is saved; `model` the measured facets and lines; `editing` whether Adjust is open (the outline's handles show).
 */
export type MeasureSlots = {
  roof: RoofSession | null;
  panels: ReactNode;
  estimate: ReturnType<typeof instantEstimate> | null;
  scan: ScanSession | null;
  model: RoofModel | null;
  /** The waste the proposal adds, when the roof has no facets to say. */
  wastePct: number | null;
  editing: boolean;
  setEditing: (next: boolean) => void;
  /** The facets being priced (part of the roof), or null for the whole roof. */
  section: string[] | null;
  /** Adds a facet to the section or takes it out; null while the roof cannot change (scanning, editing, sent). */
  pickFacet: ((id: string) => void) | null;
  /** Prices the whole roof again. */
  wholeRoof: () => void;
};

export const MeasureSlotsContext = createContext<MeasureSlots>({
  roof: null,
  panels: null,
  estimate: null,
  scan: null,
  model: null,
  wastePct: null,
  editing: false,
  setEditing: () => undefined,
  section: null,
  pickFacet: null,
  wholeRoof: () => undefined,
});
