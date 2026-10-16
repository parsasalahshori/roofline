import type { instantEstimate, Ring } from '@roofline/shared';
import type { Map as MapLibreMap } from 'maplibre-gl';
import { createContext, type ReactNode, type RefObject } from 'react';
import type { OutlineProblem } from '../types.ts';
import type { RoofModel } from './roofModel.ts';
import type { ScanSession } from './scan.ts';
import type { BuildingRow } from './structures.ts';

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
  /** Google's roof photo is past its 30 days (deleted): the roof view says so instead of showing it. */
  roofPhotoExpired: boolean;
  saving: boolean;
  saveFailed: boolean;
  finishDrawing: () => void;
  clearDrawing: () => void;
  redraw: () => void;
};

/**
 * Which parts of the roof the quote covers, and the buildings around it. The roof view's clicks and labels act on it.
 * - Sections: a facet left out is in `excluded` (shown at once; saved and priced by the server).
 * - Buildings: `buildings` are the home's nearby buildings described for people (main house, detached, neighbour's);
 *   `onlyIncluded` is the one that cannot be left out, so the quote never ends up with no roof.
 * - Another roof: `measureOther` starts a new measurement for a clicked building (owner and office only).
 */
export type QuoteSession = {
  excluded: readonly string[];
  toggleFacet: (id: string) => void;
  includeAll: () => void;
  /** The last save put every section back in the quote because the roof's sections changed. */
  sectionsReset: boolean;
  buildings: BuildingRow[];
  onlyIncluded: string | null;
  toggleBuilding: (id: string) => void;
  hovered: string | null;
  setHovered: (id: string | null) => void;
  canMeasureOther: boolean;
  /** Measures the clicked building as its own estimate and opens it; resolves false when that failed. */
  measureOther: (target: { lng: number; lat: number; footprintId: string | null }) => Promise<boolean>;
  measuringOther: boolean;
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
  quote: QuoteSession | null;
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
  quote: null,
});
