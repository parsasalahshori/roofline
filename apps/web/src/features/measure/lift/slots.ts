import type { instantEstimate, Ring } from '@roofline/shared';
import type { Map as MapLibreMap } from 'maplibre-gl';
import { createContext, type ReactNode, type RefObject } from 'react';
import type { OutlineProblem } from '../types.ts';
import type { ScanSession } from './scan.ts';

/**
 * The one roof editor, owned by MeasureWindow (it has the saves, the draw mode and the lock), handed down so
 * RoofView can place the map container and draw its overlays around it. RoofView never makes a second map
 * when this is present.
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
 * (buildings, pitch, overhang, the numbers); `estimate` is the live number set, ahead of what is saved.
 * A RoofView or StatsPanel used on its own gets the empty value and draws from its own data.
 */
export type MeasureSlots = {
  roof: RoofSession | null;
  panels: ReactNode;
  estimate: ReturnType<typeof instantEstimate> | null;
  /** The measure-roof reveal; null (the standalone views) means the roof is simply shown. */
  scan: ScanSession | null;
};

export const MeasureSlotsContext = createContext<MeasureSlots>({ roof: null, panels: null, estimate: null, scan: null });
