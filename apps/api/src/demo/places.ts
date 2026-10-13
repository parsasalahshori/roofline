import { readFileSync } from 'node:fs';

/*
 * Where the demo's houses are: real Omaha, NE buildings, so "Measure roof" over real aerial imagery shows the real roof
 * with a matching outline. The outlines are a small subset of Microsoft's Global ML Building Footprints (ODbL, see the
 * attribution inside data/omaha-footprints.json): four contiguous residential blocks, about 250 detached houses (clean rectangular, L and T footprints of 100-350 square metres, picked against Esri World Imagery). Only the
 * outlines are real; every name, street and address the demo shows is still fictional.
 *
 * Pure and deterministic (no database, no network): the same buildings go to the same homes on every run.
 */

export type DemoLngLat = readonly [number, number];

export type DemoBuilding = {
  id: string;
  /** The block it belongs to (`a`..`d`). */
  block: string;
  /** The Omaha fixture storm's hail size over the building: 1.5, 1, 0.75, or 0 outside the storm. */
  hail: number;
  /** A point well inside the outline (the pole of inaccessibility, not a raw centroid, so L-shapes work too). */
  pt: DemoLngLat;
  /** Closed ring, longitude then latitude. */
  ring: readonly DemoLngLat[];
};

type Asset = { attribution: string; license: string; blocks: { key: string; name: string }[]; buildings: DemoBuilding[] };

const asset = JSON.parse(readFileSync(new URL('./data/omaha-footprints.json', import.meta.url), 'utf8')) as Asset;

export const DEMO_FOOTPRINT_ATTRIBUTION: string = asset.attribution;
export const DEMO_BUILDINGS: readonly DemoBuilding[] = asset.buildings;

/** Houses that are not a plain rectangle: the ones worth showing a customer, since their outline is the real shape. */
const isShaped = (b: DemoBuilding): boolean => b.ring.length - 1 >= 6;

/** How many empty "lookup lots" the demo geocoder sends typed addresses to, spread evenly over the blocks. */
export const DEMO_LOT_COUNT = 48;

/** The blocks the lots are in: the two big, clear subdivisions (the other two blocks only hold the storm's hottest homes). */
const LOT_BLOCKS = ['c', 'd'];

/** The lots: the same share of shaped houses of each lot block, spread through it (never the first or the last ones). */
function pickLots(): DemoBuilding[] {
  const blocks = LOT_BLOCKS.map((key) => DEMO_BUILDINGS.filter((x) => x.block === key && isShaped(x)));
  const base = Math.floor(DEMO_LOT_COUNT / blocks.length);
  const lots: DemoBuilding[] = [];
  blocks.forEach((list, i) => {
    const take = i < blocks.length - 1 ? base : DEMO_LOT_COUNT - base * (blocks.length - 1);
    for (let k = 0; k < take; k += 1) lots.push(list[Math.floor(((k + 0.5) * list.length) / take)]!);
  });
  return lots;
}

const LOTS = pickLots();
const LOT_IDS = new Set(LOTS.map((b) => b.id));

/** A point on a building, rounded for the typed-address geocoder (7 decimals keeps it inside the outline). */
export const DEMO_LOOKUP_LOTS: readonly DemoLngLat[] = LOTS.map((b) => b.pt);

/** A small seeded shuffle (mulberry32), so the houses taken are spread through a block but the same every run. */
function shuffled<T>(list: readonly T[], seed: number): T[] {
  let s = seed >>> 0;
  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = [...list];
  for (let i = out.length - 1; i >= 1; i -= 1) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** Same hail result for the matcher: a home counts as hit when it is under the storm's lowest contour. */
const isHit = (hail: number): boolean => hail > 0;

/**
 * Hands out real buildings to the demo's homes. Ask for a hail size and get a building under that size of hail (so the
 * storm's 37 hit homes stay the same 37), preferring houses with a real, non-rectangular shape; the lots are never handed out.
 */
export class DemoPlacer {
  private readonly pools = new Map<number, DemoBuilding[]>();
  private readonly used = new Map<string, number>();

  take(hail: number): DemoBuilding {
    const exact = this.pool(hail).shift();
    if (exact !== undefined) return this.mark(exact);
    // The exact size ran out: any building on the same side of the storm edge keeps the hit count right.
    for (const size of [0, 0.75, 1, 1.5]) {
      if (isHit(size) === isHit(hail)) {
        const pool = this.pool(size);
        if (pool.length > 0) return this.mark(pool.shift()!);
      }
    }
    throw new Error(`The demo footprint asset has no free building under ${String(hail)} inch hail.`);
  }

  private pool(hail: number): DemoBuilding[] {
    let pool = this.pools.get(hail);
    if (pool === undefined) {
      const free = DEMO_BUILDINGS.filter((b) => b.hail === hail && !LOT_IDS.has(b.id));
      // Shaped houses first, each group in a seeded order.
      pool = [...shuffled(free.filter(isShaped), 11 + Math.round(hail * 100)), ...shuffled(free.filter((b) => !isShaped(b)), 29 + Math.round(hail * 100))];
      this.pools.set(hail, pool);
    }
    return pool;
  }

  private mark(b: DemoBuilding): DemoBuilding {
    this.used.set(b.id, this.used.size);
    return b;
  }

  /** Every building of the asset as a footprint to load: a home's, a lot's, or an empty neighbour's (`demo-next-*`). */
  footprints(): { sourceRef: string; ring: readonly DemoLngLat[] }[] {
    const lotIndex = new Map(LOTS.map((b, i) => [b.id, i]));
    let next = 0;
    return DEMO_BUILDINGS.map((b) => {
      const home = this.used.get(b.id);
      const lot = lotIndex.get(b.id);
      const sourceRef = home !== undefined ? `demo-home-${home}` : lot !== undefined ? `demo-lot-${lot}` : `demo-next-${next++}`;
      return { sourceRef, ring: b.ring };
    });
  }
}

/** The hail size over a point in the Omaha fixture storm (the contours are the db package's test fixture boxes). */
export function hailOver(point: DemoLngLat, contours: readonly { thresholdIn: number; box: readonly [number, number, number, number] }[]): number {
  let size = 0;
  for (const c of contours) {
    const [w, s, e, n] = c.box;
    if (point[0] >= w && point[0] <= e && point[1] >= s && point[1] <= n && c.thresholdIn > size) size = c.thresholdIn;
  }
  return size;
}
