import type { FeatureCollection } from 'geojson';

/*
 * The answer of GET /api/map/storm-layer?bbox=<w,s,e,n>&zoom=<n>&days=7 (built by S1 Task 8).
 * Types only: nothing here runs.
 *
 * `swaths` features are Polygon/MultiPolygon with properties { level: 1 | 2 | 3 | 4 | 5, stormId: string, sizeIn: number }.
 * `spots` features are Point with properties { sizeIn: number | null, reportedAt: string }.
 * `newestRunAt` is an ISO string, or null when no run exists. `stale` is true when the newest run is old.
 */
export type StormLayerResponse = {
  swaths: FeatureCollection;
  spots: FeatureCollection;
  newestRunAt: string | null;
  stale: boolean;
};

/** The hail levels, from smallest (1) to largest (5). Level n is drawn with the token `hail-n`. */
export type HailLevel = 1 | 2 | 3 | 4 | 5;
