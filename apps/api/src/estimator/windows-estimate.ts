import { type EstimatedWindows, WINDOW_SIZE_CLASSES, type WindowSizeClass } from '@roofline/shared';

/*
 * Windows worked out from the house's walls (pure, no I/O): the default result of Measure windows, like the roof's
 * estimate from its outline. No photo and no AI: wall length (the footprint's perimeter) times wall height (Google's
 * heights, else 9 ft a floor) is the wall area; a share of it is glass; the glass divided by a typical window's area
 * is the count, split into size classes by a typical mix.
 */

const M_TO_FT = 3.28084;

/**
 * Glass as a share of the gross wall area of a US single-family house. Building-energy studies of US homes put the
 * window-to-wall ratio of typical single-family houses at roughly 10-15% (the US DOE prototype single-family house
 * models about 15% including doors' glass; NREL ResStock's housing-stock distributions centre near 12-15%). 0.12 is
 * the low-middle of that range, because doors and garage doors take part of the front wall. Checked: a 1,800 sq ft
 * single-storey house (about 180 ft of wall, 9 ft high) gives 13 windows, in the 12-15 a contractor would expect.
 */
export const WINDOW_TO_WALL_RATIO = 0.12;
/** A typical replacement window: 36 x 60 in = 15 sq ft. */
export const TYPICAL_WINDOW_SQFT = 15;
/** The size mix assumed when no window has been measured (most replacement windows are 'standard' double-hungs). */
export const DEFAULT_SIZE_MIX: Readonly<Record<WindowSizeClass, number>> = { small: 0.2, standard: 0.65, large: 0.1, picture: 0.05 };
/** Wall height per floor when Google has no heights for the house, feet. */
export const ASSUMED_FLOOR_HEIGHT_FT = 9;
/** Floors from the eave's height above the ground, metres: below 4.5 one floor, below 7.5 two, else three. */
const ONE_FLOOR_MAX_EAVE_M = 4.5;
const TWO_FLOOR_MAX_EAVE_M = 7.5;
/** Marked windows needed before their size mix is used for the rest of the house. */
const MIN_FOR_OWN_MIX = 3;

export type HouseWalls = {
  perimeterFt: number;
  wallHeightFt: number;
  wallAreaSqFt: number;
  /** The wall(s) facing the street camera, feet; null without a photo to say which is the front. */
  frontWallFt: number | null;
  floors: number;
  /** 'google': height from Google's height map; 'assumed': ASSUMED_FLOOR_HEIGHT_FT and one floor. */
  heightSource: 'google' | 'assumed';
};

export function floorsFromEave(eaveM: number): number {
  if (eaveM < ONE_FLOOR_MAX_EAVE_M) return 1;
  if (eaveM < TWO_FLOOR_MAX_EAVE_M) return 2;
  return 3;
}

/** The walls from the outline's perimeter, the front wall's length (m) and the eave's height above ground (m), when known. */
export function houseWalls(perimeterM: number, frontWallM: number | null, eaveHeightM: number | null): HouseWalls {
  const perimeterFt = Math.round(perimeterM * M_TO_FT);
  const known = eaveHeightM !== null && Number.isFinite(eaveHeightM) && eaveHeightM >= 2 && eaveHeightM <= 15;
  const floors = known ? floorsFromEave(eaveHeightM) : 1;
  const wallHeightFt = known ? Math.round(eaveHeightM * M_TO_FT * 10) / 10 : ASSUMED_FLOOR_HEIGHT_FT;
  return {
    perimeterFt,
    wallHeightFt,
    wallAreaSqFt: Math.round(perimeterFt * wallHeightFt),
    frontWallFt: frontWallM === null ? null : Math.round(frontWallM * M_TO_FT),
    floors,
    heightSource: known ? 'google' : 'assumed',
  };
}

/** `count` split by `mix` (largest remainder, so the parts add up). */
export function splitByMix(count: number, mix: Readonly<Record<WindowSizeClass, number>>): Record<WindowSizeClass, number> {
  const total = WINDOW_SIZE_CLASSES.reduce((t, c) => t + mix[c], 0);
  const exact = WINDOW_SIZE_CLASSES.map((c) => (total > 0 ? (count * mix[c]) / total : 0));
  const out = exact.map(Math.floor);
  let left = count - out.reduce((t, v) => t + v, 0);
  const order = exact.map((v, i) => ({ i, r: v - Math.floor(v) })).sort((a, b) => b.r - a.r || a.i - b.i);
  for (const { i } of order) {
    if (left <= 0) break;
    out[i]! += 1;
    left -= 1;
  }
  return Object.fromEntries(WINDOW_SIZE_CLASSES.map((c, i) => [c, out[i]!])) as Record<WindowSizeClass, number>;
}

const plural = (n: number, one: string, many: string) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

function heightText(w: HouseWalls): string {
  return w.heightSource === 'google' ? `${Math.round(w.wallHeightFt)} ft high` : `${w.wallHeightFt} ft high (assumed, no height data)`;
}

/** Every window worked out from the walls (nothing on the front measured): covers 'all-sides'. */
export function estimateAllSides(w: HouseWalls): EstimatedWindows {
  const count = Math.max(1, Math.round((w.wallAreaSqFt * WINDOW_TO_WALL_RATIO) / TYPICAL_WINDOW_SQFT));
  return {
    covers: 'all-sides',
    bySizeClass: splitByMix(count, DEFAULT_SIZE_MIX),
    basis: `${plural(w.floors, 'floor', 'floors')}, ${w.perimeterFt.toLocaleString('en-US')} ft of wall, ${heightText(w)}: about ${plural(count, 'window', 'windows')}`,
  };
}

/**
 * The sides and back once front windows are measured: the same wall ratio on the walls that are not the front.
 * The front's own density is not carried round the house on purpose: the front usually has more glass than the sides
 * and back (it faces the street), and a few marked windows are a small sample, so the front's spacing would overcount.
 * The marked windows' size mix is used when there are at least MIN_FOR_OWN_MIX of them, else the default mix.
 */
export function estimateSidesAndBack(w: HouseWalls, measured: readonly { sizeClass: WindowSizeClass }[]): EstimatedWindows {
  const frontFt = Math.min(w.frontWallFt ?? 0, w.perimeterFt);
  const restFt = Math.max(0, w.perimeterFt - frontFt);
  const count = Math.round((restFt * w.wallHeightFt * WINDOW_TO_WALL_RATIO) / TYPICAL_WINDOW_SQFT);
  let mix: Record<WindowSizeClass, number> = { ...DEFAULT_SIZE_MIX };
  let mixText = 'typical sizes';
  if (measured.length >= MIN_FOR_OWN_MIX) {
    mix = Object.fromEntries(WINDOW_SIZE_CLASSES.map((c) => [c, measured.filter((m) => m.sizeClass === c).length])) as Record<WindowSizeClass, number>;
    mixText = 'sizes like the front';
  }
  return {
    covers: 'sides-and-back',
    bySizeClass: splitByMix(count, mix),
    basis: `${plural(w.floors, 'floor', 'floors')}, ${restFt.toLocaleString('en-US')} ft of side and back wall, ${heightText(w)}, ${mixText}: about ${plural(count, 'window', 'windows')}`,
  };
}
