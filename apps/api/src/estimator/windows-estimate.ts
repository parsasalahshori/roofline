import { type EstimatedWindows, WINDOW_SIZE_CLASSES, type WindowSizeClass } from '@roofline/shared';
import { levelOf, MAX_EAVE_M, MIN_EAVE_M, ONE_FLOOR_MAX_EAVE_M, TWO_FLOOR_MAX_EAVE_M } from './windows-heights.ts';

/*
 * Windows worked out from the house's walls (pure, no I/O): the default result of Measure windows, like the roof's
 * estimate from its outline. No photo and no AI: each wall's length (the footprint's sides) times its height (Google's
 * heights, wall by wall when known, else 9 ft a floor) is the wall area; low one-storey wings next to a taller house (an
 * attached garage, a porch) are left out of it; a share of the rest is glass; the glass divided by a typical window's
 * area is the count, split into size classes by a typical mix. When the inputs are shaky (no height data, a storey and
 * a half, a low wing that may be a garage or a living room, an outline from Google's roof instead of a footprint) the
 * count comes with a range.
 */

const M_TO_FT = 3.28084;

/**
 * Glass as a share of the gross wall area of a US single-family house: THE calibration constant of the estimate.
 * Building-energy studies of US homes put the window-to-wall ratio of typical single-family houses at roughly 10-15%
 * (the US DOE prototype single-family house models about 15% including doors' glass; NREL ResStock's housing-stock
 * distributions centre near 12-15%). 0.12 is the low-middle of that range, because doors and garage doors take part of
 * the front wall. Checked: a 1,800 sq ft single-storey house (about 180 ft of wall, 9 ft high) gives 13 windows, in the
 * 12-15 a contractor would expect. To calibrate: with real counts (e.g. WinChoice's measured jobs), set it to
 * sum(windows x TYPICAL_WINDOW_SQFT) / sum(window wall area) over those houses (HouseWalls.windowWallSqFt).
 */
export const WINDOW_TO_WALL_RATIO = 0.12;
/** A typical replacement window: 36 x 60 in = 15 sq ft. */
export const TYPICAL_WINDOW_SQFT = 15;
/** The size mix assumed when no window has been measured (most replacement windows are 'standard' double-hungs). */
export const DEFAULT_SIZE_MIX: Readonly<Record<WindowSizeClass, number>> = { small: 0.2, standard: 0.65, large: 0.1, picture: 0.05 };
/** Wall height per floor when Google has no heights for the house, feet. */
export const ASSUMED_FLOOR_HEIGHT_FT = 9;
/**
 * The window wall's height a floor, feet: WINDOW_TO_WALL_RATIO was checked on 9 ft walls (one row of windows a floor).
 * A floor counts this much wall whatever its eave's real height (HouseWalls.wallHeightFt, shown).
 */
export const FLOOR_HEIGHT_FT = 9;
/**
 * A storey and a half (a Cape Cod, a bungalow with rooms in the roof): the main eave too high for one storey's wall and
 * too low for two (ONE_FLOOR_MAX_EAVE_M to this, metres), with room under the roof for a half storey (the ridge at least
 * HALF_STOREY_MIN_RISE_M above the eave) and a ridge lower than a two-storey house's (HALF_STOREY_MAX_RIDGE_M).
 */
export const HALF_STOREY_MAX_EAVE_M = 5.2;
export const HALF_STOREY_MIN_RISE_M = 2.5;
export const HALF_STOREY_MAX_RIDGE_M = 9.5;
/**
 * A one-storey reading under a roof this tall (ridge above the eave, metres) may hide rooms in the roof (a Cape Cod with
 * low eaves, dormers) or be a wide hip roof: the floors stay one, the range's top allows for a half storey.
 */
export const ROOM_IN_ROOF_RISE_M = 5;
/**
 * A low wing: a wall whose eave is at most this high (metres) and at least LOW_WING_DROP_M below the main eave of a house
 * of two floors or more. That is a one-storey part beside a taller house: an attached garage, a carport or a porch most
 * often (few or no windows), sometimes a one-storey room. Left out of the window wall; the range's top puts it back.
 */
export const LOW_WING_MAX_EAVE_M = 3.8;
export const LOW_WING_DROP_M = 1.5;
/** A wall read higher than the main eave by more than this share is a tree or a chimney on it: capped there. */
const WALL_OVER_MAIN = 0.15;
/** Marked windows needed before their size mix is used for the rest of the house. */
const MIN_FOR_OWN_MIX = 3;
/** The range: shown only when its ends are at least this many windows apart. */
const MIN_RANGE_SPREAD = 2;
/** An outline from Google's roof (no footprint) is the roof's edge, overhangs included, or a box: this much either way. */
const ROOF_OUTLINE_SHARE = 0.15;

export type Floors = 1 | 1.5 | 2 | 3;

export type HouseWalls = {
  perimeterFt: number;
  /** The main part of the house's wall height, feet. */
  wallHeightFt: number;
  /** Every wall's length times its own height (its eave's), sq ft. */
  wallAreaSqFt: number;
  /** The wall the windows are counted on: each wall's length times FLOOR_HEIGHT_FT a floor, less the low wings', sq ft. */
  windowWallSqFt: number;
  /** Low one-storey wings next to a taller house (an attached garage, a carport, a porch): feet of wall, and their window wall. */
  lowWingFt: number;
  lowWingSqFt: number;
  /** The wall(s) facing the street camera, feet; null without a photo to say which is the front. */
  frontWallFt: number | null;
  floors: Floors;
  /** 'google': height from Google's height map; 'photo': a person's fit on the street photo; 'assumed': ASSUMED_FLOOR_HEIGHT_FT and one floor. */
  heightSource: 'google' | 'photo' | 'assumed';
  /** Where the outline came from: a building footprint, else Google's roof (its mask's outline, or its box). */
  outlineFrom: 'footprint' | 'google-roof';
  /** The ridge's height above the main eave, metres (null without heights). */
  roofRiseM: number | null;
};

const plausibleEave = (m: number | null | undefined): m is number => m !== null && m !== undefined && Number.isFinite(m) && m >= MIN_EAVE_M && m <= MAX_EAVE_M;

/** Floors from the main eave's height above the ground and the ridge's (metres; ridge null when unknown). */
export function floorsFromEave(eaveM: number, ridgeM: number | null = null): Floors {
  if (eaveM < ONE_FLOOR_MAX_EAVE_M) return 1;
  if (eaveM < HALF_STOREY_MAX_EAVE_M) {
    // Without the ridge (older measurements): the old split at 4.5 m.
    if (ridgeM === null || !Number.isFinite(ridgeM)) return eaveM < 4.5 ? 1 : 2;
    if (ridgeM >= HALF_STOREY_MAX_RIDGE_M) return 2;
    if (ridgeM - eaveM < HALF_STOREY_MIN_RISE_M) return 1;
    return 1.5;
  }
  if (eaveM < TWO_FLOOR_MAX_EAVE_M) return 2;
  return 3;
}

export type WallsInput = {
  /** Each wall's length and its own eave above the ground (null: not read), metres; the perimeter is their sum. */
  walls?: readonly { lengthM: number; eaveM: number | null }[] | null;
  /** The roof's top above the ground, metres. */
  ridgeM?: number | null;
  outlineSource?: 'footprint' | 'solar-mask' | 'solar-box';
  /** The eave height is a person's fit on the street photo, not Google's height map. */
  fromPhoto?: boolean;
};

/**
 * The walls from the outline's perimeter (m), the front wall's length (m) and the main eave's height above ground (m),
 * when known; with each wall's own height (`more.walls`) the area is wall by wall and low wings are found.
 */
export function houseWalls(perimeterM: number, frontWallM: number | null, eaveHeightM: number | null, more: WallsInput = {}): HouseWalls {
  const perimeterFt = Math.round(perimeterM * M_TO_FT);
  const known = plausibleEave(eaveHeightM);
  const ridge = more.ridgeM ?? null;
  const floors: Floors = known ? floorsFromEave(eaveHeightM, ridge) : 1;
  const wallHeightFt = known ? Math.round(eaveHeightM * M_TO_FT * 10) / 10 : ASSUMED_FLOOR_HEIGHT_FT;
  // Windows come a row a floor: the window wall is FLOOR_HEIGHT_FT a floor, whatever the eave's height (a raised floor,
  // tall ceilings or a gable end add wall, not windows).
  let area = perimeterFt * wallHeightFt;
  let windowWall = perimeterFt * floors * FLOOR_HEIGHT_FT;
  let lowWingFt = 0;
  let lowWingSqFt = 0;
  const walls = more.walls ?? null;
  if (known && walls !== null && walls.length >= 3) {
    area = 0;
    windowWall = 0;
    const lowMax = Math.min(LOW_WING_MAX_EAVE_M, eaveHeightM - LOW_WING_DROP_M);
    const mainLevel = levelOf(eaveHeightM);
    for (const w of walls) {
      const lenFt = w.lengthM * M_TO_FT;
      const read = plausibleEave(w.eaveM);
      // An unread wall (trees, no samples) is taken at the main height; one read too high is capped.
      const e = read ? Math.min(w.eaveM!, eaveHeightM * (1 + WALL_OVER_MAIN)) : eaveHeightM;
      area += lenFt * e * M_TO_FT;
      // A wall of a lower part (a one-storey wing of a two-storey house) has that part's floors.
      const wallFloors = read && levelOf(e) < mainLevel ? Math.min(levelOf(e), floors) : floors;
      const wall = lenFt * wallFloors * FLOOR_HEIGHT_FT;
      if (floors >= 2 && read && w.eaveM! <= lowMax) {
        lowWingFt += lenFt;
        lowWingSqFt += wall;
      } else windowWall += wall;
    }
  }
  const outlineFrom = more.outlineSource === undefined || more.outlineSource === 'footprint' ? 'footprint' : 'google-roof';
  return {
    perimeterFt,
    wallHeightFt,
    wallAreaSqFt: Math.round(area),
    windowWallSqFt: Math.round(windowWall),
    lowWingFt: Math.round(lowWingFt),
    lowWingSqFt: Math.round(lowWingSqFt),
    frontWallFt: frontWallM === null ? null : Math.round(frontWallM * M_TO_FT),
    floors,
    heightSource: !known ? 'assumed' : more.fromPhoto === true ? 'photo' : 'google',
    outlineFrom,
    roofRiseM: known && ridge !== null && Number.isFinite(ridge) ? Math.round((ridge - eaveHeightM) * 100) / 100 : null,
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

/** Windows on `sqft` of wall. */
export function windowsOnWall(sqft: number): number {
  return Math.round((sqft * WINDOW_TO_WALL_RATIO) / TYPICAL_WINDOW_SQFT);
}

/**
 * How far the count could be off, as windows either way of `count` (on `share` of the window wall): the inputs that are
 * shaky widen it. Null when none is (or the spread is under MIN_RANGE_SPREAD).
 *   - No height data: one floor is assumed; the house may have two (the top doubles).
 *   - A storey and a half: from one floor's wall (the eave's) to a second full floor (a third more).
 *   - One storey under a roof at least ROOM_IN_ROOF_RISE_M tall: perhaps rooms in the roof (a third more at the top).
 *   - Low wings: left out of the count; the top puts them back (they may be rooms, not a garage).
 *   - An outline from Google's roof: plus or minus ROOF_OUTLINE_SHARE.
 */
export function rangeOf(w: HouseWalls, count: number, share = 1): { low: number; high: number } | null {
  let low = count;
  let high = count;
  if (w.heightSource === 'assumed') high = Math.max(high, count * 2);
  if (w.floors === 1.5) {
    low = Math.min(low, Math.round(count * 0.8));
    high = Math.max(high, Math.round(count * 1.3));
  }
  if (w.floors === 1 && w.roofRiseM !== null && w.roofRiseM >= ROOM_IN_ROOF_RISE_M) high = Math.max(high, Math.round(count * 1.3));
  if (w.lowWingSqFt > 0) high += windowsOnWall(w.lowWingSqFt * share);
  if (w.outlineFrom === 'google-roof') {
    low = Math.min(low, Math.round(count * (1 - ROOF_OUTLINE_SHARE)));
    high = Math.max(high, Math.round(count * (1 + ROOF_OUTLINE_SHARE)));
  }
  low = Math.max(0, Math.round(low));
  high = Math.round(high);
  return high - low >= MIN_RANGE_SPREAD ? { low, high } : null;
}

const plural = (n: number, one: string, many: string) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
const about = (count: number, range: { low: number; high: number } | null) =>
  range === null ? `about ${plural(count, 'window', 'windows')}` : `about ${count} windows (${range.low}-${range.high})`;

/** Every window worked out from the walls (nothing on the front measured): covers 'all-sides'. */
export function estimateAllSides(w: HouseWalls): EstimatedWindows {
  const count = Math.max(1, windowsOnWall(w.windowWallSqFt));
  const range = rangeOf(w, count);
  return {
    covers: 'all-sides',
    bySizeClass: splitByMix(count, DEFAULT_SIZE_MIX),
    range,
    basis: `${w.windowWallSqFt.toLocaleString('en-US')} sq ft of wall: ${about(count, range)}`,
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
  const share = w.perimeterFt > 0 ? restFt / w.perimeterFt : 0;
  const count = windowsOnWall(w.windowWallSqFt * share);
  const range = rangeOf(w, count, share);
  let mix: Record<WindowSizeClass, number> = { ...DEFAULT_SIZE_MIX };
  let mixText = 'typical sizes';
  if (measured.length >= MIN_FOR_OWN_MIX) {
    mix = Object.fromEntries(WINDOW_SIZE_CLASSES.map((c) => [c, measured.filter((m) => m.sizeClass === c).length])) as Record<WindowSizeClass, number>;
    mixText = 'sizes like the front';
  }
  return {
    covers: 'sides-and-back',
    bySizeClass: splitByMix(count, mix),
    range,
    basis: `${restFt.toLocaleString('en-US')} ft of side and back wall, ${mixText}: ${about(count, range)}`,
  };
}
