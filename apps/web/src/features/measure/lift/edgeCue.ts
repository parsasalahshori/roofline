import type { Map as MapLibreMap } from 'maplibre-gl';
import { type LngLat, type Ring, type Roof3d, sameOutline } from '@roofline/shared';
import { liftMeasure } from '../../../copy/liftMeasure.ts';

/*
 * Outline edges the height map cannot verify (a tree crown or a taller building stands beside the eave, so there is
 * no drop in the heights where the roof should end: Roof3d.edges, support 'none'), drawn dashed in amber over the
 * photo with a one-line cue. Only while the outline is still the reconstruction's own: once someone moves it, the
 * evidence is about another outline and the dashes go.
 */

export const EDGE_CUE_SOURCE = 'roof-edge-cue';
export const EDGE_CUE_LAYERS = ['roof-edge-cue-casing', 'roof-edge-cue'] as const;
/** Shorter unverified edges than this are not drawn (a corner's chamfer, a jog): two metres. */
const MIN_EDGE_FT = 6.6;
/** An edge is drawn dashed only when at least this share of its length is unverified (its median says 'none'). */
const MIN_UNVERIFIED_SHARE = 0.5;
/**
 * The card's one line shows only when the roof is reviewed for its edges ('edges-unverified') or the dashed edges are at
 * least this share of the outline: a few short dashes on a roof that is otherwise checked do not need words too, and a
 * cue on almost every roof trains people to skip it.
 */
const CUE_MIN_SHARE = 0.1;
const CUE_COLOR = '#ffb020';

export type HiddenEdge = { coords: [LngLat, LngLat]; lengthFt: number; reason: string | null };

/** The unverified edges of the 3D roof whose outline `ring` still is; [] for an older roof without edges. */
export function hiddenEdges(roof3d: Roof3d | null | undefined, ring: Ring | null | undefined): HiddenEdge[] {
  const edges = roof3d?.edges;
  if (roof3d == null || edges === undefined || ring == null || ring.length < 3 || !sameOutline(ring, roof3d)) return [];
  const n = roof3d.outline.length;
  // Edges the hidden-edge step inferred are drawn dashed whatever the heights say about them (they were not measured).
  const inferred = new Set((roof3d.inferredEdges?.edges ?? []).filter((e) => e.lengthFt >= MIN_EDGE_FT).map((e) => e.from));
  return edges
    .filter((e) => (inferred.has(e.from) || (e.support === 'none' && e.unverifiedShare >= MIN_UNVERIFIED_SHARE && e.lengthFt >= MIN_EDGE_FT)) && e.from >= 0 && e.from < n)
    .map((e) => ({ coords: [roof3d.outline[e.from]!, roof3d.outline[(e.from + 1) % n]!], lengthFt: e.lengthFt, reason: e.reason }));
}

/**
 * The cue under the photo: trees when trees hide most of the dashed length, else the general one; null with none, and
 * (given the roof) null unless the roof is reviewed for its edges or the dashes are CUE_MIN_SHARE of its outline.
 */
export function edgeCueText(edges: readonly HiddenEdge[], roof3d?: Roof3d | null): string | null {
  if (edges.length === 0) return null;
  const total = edges.reduce((t, e) => t + e.lengthFt, 0);
  if (roof3d != null) {
    const perimeter = (roof3d.edges ?? []).reduce((t, e) => t + e.lengthFt, 0);
    const flagged = roof3d.quality?.reasons.some((r) => r === 'edges-unverified' || r === 'roof-inferred') === true;
    if (!flagged && !(perimeter > 0 && total >= CUE_MIN_SHARE * perimeter)) return null;
  }
  const trees = edges.filter((e) => e.reason === 'crown').reduce((t, e) => t + e.lengthFt, 0);
  return trees >= total / 2 ? liftMeasure.edgeHidden.crown : liftMeasure.edgeHidden.other;
}

export function edgeCueData(edges: readonly HiddenEdge[]): { type: 'FeatureCollection'; features: unknown[] } {
  return {
    type: 'FeatureCollection',
    features: edges.map((e) => ({ type: 'Feature', properties: { reason: e.reason ?? '' }, geometry: { type: 'LineString', coordinates: e.coords } })),
  };
}

type Loose = {
  getSource?: (id: string) => unknown;
  getLayer?: (id: string) => unknown;
  addSource?: (id: string, source: unknown) => void;
  addLayer?: (layer: unknown) => void;
  setLayoutProperty?: (id: string, name: string, value: string) => void;
};

/** Draws (or updates, or hides) the dashed edges; the layers are made on first use, over everything else. */
export function setEdgeCue(instance: MapLibreMap | null, edges: readonly HiddenEdge[], visible: boolean): void {
  if (instance === null) return;
  const loose = instance as unknown as Loose;
  try {
    const source = loose.getSource?.(EDGE_CUE_SOURCE) as { setData?: (d: unknown) => void } | undefined;
    if (source === undefined) {
      if (edges.length === 0) return;
      loose.addSource?.(EDGE_CUE_SOURCE, { type: 'geojson', data: edgeCueData(edges) });
      loose.addLayer?.({
        id: EDGE_CUE_LAYERS[0],
        type: 'line',
        source: EDGE_CUE_SOURCE,
        layout: { 'line-cap': 'butt' },
        paint: { 'line-color': '#151c22', 'line-opacity': 0.55, 'line-width': 5.5 },
      });
      loose.addLayer?.({
        id: EDGE_CUE_LAYERS[1],
        type: 'line',
        source: EDGE_CUE_SOURCE,
        layout: { 'line-cap': 'butt' },
        paint: { 'line-color': CUE_COLOR, 'line-width': 3, 'line-dasharray': [2, 1.5] },
      });
    } else {
      source.setData?.(edgeCueData(edges));
    }
    for (const id of EDGE_CUE_LAYERS) {
      if (loose.getLayer?.(id) !== undefined) loose.setLayoutProperty?.(id, 'visibility', visible && edges.length > 0 ? 'visible' : 'none');
    }
  } catch {
    // Ignored: the map is going away; the cue line under the photo still says it.
  }
}
