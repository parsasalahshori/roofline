/*
 * Choosing which tree-heavy houses to buy Google's layers for. Pure: the candidates come from
 * scripts/roof-3d-bench-candidates.ts (free sources) and the buying is scripts/roof-3d-bench-fetch.ts.
 */

export type TreeCandidate = {
  id: string;
  region: string;
  metro: string;
  state: string;
  neighbourhood: string;
  lat: number;
  lng: number;
  areaM2: number;
  over: number;
  ring: number;
  kind: 'over' | 'beside';
  score: number;
  footprint: [number, number][];
};

/** Crowns over more than this share of the outline hide the roof from the mask altogether: not worth a paid request. */
export const MAX_OVER = 0.85;
/** Houses within this many metres of one already in the benchmark are the same house. */
export const SAME_HOUSE_M = 25;
/** Of the houses chosen, about this share should have crowns over the roof (the rest: trees beside it). */
export const OVER_SHARE = 2 / 3;

const K = (Math.PI / 180) * 6371008.8;
export function metresBetween(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  return Math.hypot((a.lng - b.lng) * K * Math.cos((a.lat * Math.PI) / 180), (a.lat - b.lat) * K);
}

/** The `over` lane is drawn from these bands of crown cover over the outline in turn (partial, substantial, most hidden). */
export const OVER_BANDS: readonly [number, number][] = [
  [0.45, 0.65],
  [0.25, 0.45],
  [0.65, MAX_OVER + 1e-9],
];

/** Round robin across neighbourhoods, the neighbourhood with the best candidate first. */
function roundRobin(list: readonly TreeCandidate[]): TreeCandidate[] {
  const byHood = new Map<string, TreeCandidate[]>();
  for (const c of list) byHood.set(c.neighbourhood, [...(byHood.get(c.neighbourhood) ?? []), c]);
  const hoods = [...byHood.values()].sort((a, b) => b[0]!.score - a[0]!.score || a[0]!.id.localeCompare(b[0]!.id));
  const out: TreeCandidate[] = [];
  for (let k = 0; hoods.some((h) => h.length > k); k++) for (const h of hoods) if (h[k] !== undefined) out.push(h[k]!);
  return out;
}

/**
 * One region's candidates in the order to try them: those worth testing (trees over or beside the roof, not hidden
 * entirely, not a house already in the set), alternating `over` (crowns over the outline, from each of OVER_BANDS in
 * turn so the set spans partly to mostly hidden roofs) and `beside` (trees round it) in the OVER_SHARE proportion;
 * within a lane the best candidate of each neighbourhood in turn, so one street does not fill the quota. Ties break
 * by id: the order is the same every run.
 */
export function rankRegion(all: readonly TreeCandidate[], taken: readonly { lat: number; lng: number }[] = []): TreeCandidate[] {
  const usable = all
    .filter((c) => c.over <= MAX_OVER && (c.over >= 0.1 || c.ring >= 0.45) && !taken.some((t) => metresBetween(c, t) < SAME_HOUSE_M))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  const bands = OVER_BANDS.map(([lo, hi]) => roundRobin(usable.filter((c) => c.over >= lo && c.over < hi)));
  const over: TreeCandidate[] = [];
  for (let k = 0; bands.some((b) => b.length > k); k++) for (const b of bands) if (b[k] !== undefined) over.push(b[k]!);
  const beside = roundRobin(usable.filter((c) => c.over < 0.25));
  const out: TreeCandidate[] = [];
  const seen = new Set<string>();
  let io = 0;
  let ib = 0;
  while (io < over.length || ib < beside.length) {
    // Keep the running share of `over` at about OVER_SHARE.
    const wantOver = out.length === 0 || out.filter((c) => c.over >= 0.25).length / out.length < OVER_SHARE;
    const next = wantOver ? (io < over.length ? over[io++] : beside[ib++]) : ib < beside.length ? beside[ib++] : over[io++];
    if (next !== undefined && !seen.has(next.id)) {
      seen.add(next.id);
      out.push(next);
    }
  }
  return out;
}

/** A folder name for a tree house. */
export function treeSlug(c: Pick<TreeCandidate, 'metro' | 'id'>): string {
  return `tr-${c.metro.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}-${c.id.replace(/^osm-/, '')}`;
}
