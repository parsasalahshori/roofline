import type { AppDeps } from '../app.ts';

/*
 * Structured counters for the roof in 3D: every way a Measure can end up with or without a 3D roof is one typed
 * outcome, counted per app and written as one JSON log line ({"event":"roof-3d","outcome":...}) that logs and
 * dashboards can count. Details are numbers, booleans and enum words only: never a URL, an address or a key.
 */

export const ROOF_3D_OUTCOMES = [
  /** A roof was reconstructed and is used. */
  'built',
  /** A kept snapshot was reused (no purchase). */
  'reused',
  /** A kept snapshot was skipped because another algorithm version made it, or its answer is never reused. */
  'stale-snapshot',
  'no-imagery',
  'no-building',
  'no-roof',
  /** The roof ran off reused layers' edge; fresh layers were bought once. */
  'clipped-retry',
  /** Still clipped after the fresh request. */
  'clipped',
  'unusable',
  'timeout',
  /** Data Layers did not answer (an HTTP error, quota, a file it could not read). */
  'unavailable',
  /** The Measure goes on without a 3D roof (the outline path). */
  'fallback',
  /** ROOF_3D_MODE=off: nothing asked. */
  'off',
  /** ROOF_3D_MODE=shadow: a roof was reconstructed and kept but not measured from. */
  'shadow',
  /** ROOF_3D_MODE=shadow: the shadow roof's plan area differs from Google's segments by more than SHADOW_DIFF_SHARE. */
  'shadow-diff',
] as const;
export type Roof3dOutcome = (typeof ROOF_3D_OUTCOMES)[number];

type Detail = Record<string, string | number | boolean>;
export type Roof3dEvent = { event: 'roof-3d'; outcome: Roof3dOutcome } & Detail;

const counts = new WeakMap<object, Map<Roof3dOutcome, number>>();
const sinks = new WeakMap<object, (e: Roof3dEvent) => void>();

/** Where this app's roof-3d events go instead of the console (tests, a metrics exporter). */
export function onRoof3dEvent(deps: AppDeps, sink: (e: Roof3dEvent) => void): void {
  sinks.set(deps, sink);
}

/** Counts one outcome and writes its log line. Never throws. */
export function countRoof3d(deps: AppDeps, outcome: Roof3dOutcome, detail: Detail = {}): void {
  try {
    let map = counts.get(deps);
    if (map === undefined) {
      map = new Map();
      counts.set(deps, map);
    }
    map.set(outcome, (map.get(outcome) ?? 0) + 1);
    const event: Roof3dEvent = { ...detail, event: 'roof-3d', outcome };
    const sink = sinks.get(deps);
    if (sink !== undefined) sink(event);
    else if (deps.config?.NODE_ENV !== 'test') console.info(JSON.stringify(event));
  } catch {
    // Counting must never fail a Measure.
  }
}

/** Every outcome's count so far for this app (zero for those that have not happened). */
export function roof3dCounts(deps: AppDeps): Record<Roof3dOutcome, number> {
  const map = counts.get(deps);
  return Object.fromEntries(ROOF_3D_OUTCOMES.map((o) => [o, map?.get(o) ?? 0])) as Record<Roof3dOutcome, number>;
}
