import { type LngLat, type MeasurementView, ROOF_QUALITY_SEVERITY, type RoofQualityReason } from '@roofline/shared';

/*
 * When the instant quote page must NOT show a price and offers "we'll call you" instead. A confident wrong price is
 * worse than a call back, so every doubt about the home or its measurement is a call back:
 *
 * Before anything is measured (no paid call, nothing counted against the daily cap), from the address lookup:
 *   'unit'            the address names a unit, apartment or suite (a building of homes, not one roof)
 *   'not-rooftop'     the lookup placed the address on the street or between houses, not on the house itself
 *   'street-changed'  the lookup found another house number or street name than the one typed
 * After the measurement:
 *   'roof-review'     the roof in 3D carries a review reason that puts the measured AREA in doubt (every 'block'
 *                     reason in ROOF_QUALITY_SEVERITY except 'edges-unverified', which only widens the range)
 *   'too-big'         a footprint over 6,000 sq ft or a roof over 80 squares: a commercial building or a complex
 *   'flat-unmeasured' a pitch under 2/12 read without the roof in 3D: the slope (and so the area) is a guess
 * The windows come from the same outline, so the checks on the outline itself apply to them too.
 *
 * "The satellite pictures cannot be trusted" (satelliteGate below) is one answer to the homeowner however it came
 * about; the cause stays in the stored estimate for staff (SatelliteProblem). The roof is not priced; the windows
 * carry on unless the problem is the outline itself (the wrong house, or joined buildings).
 */

export type QuoteCallbackReason = 'unit' | 'not-rooftop' | 'street-changed' | 'roof-review' | 'outline-off-house' | 'too-big' | 'flat-unmeasured';

export const QUOTE_GATES = {
  maxFootprintSqFt: 6000,
  maxSquares: 80,
  minPitchWithout3d: 2,
  /** Percent added to each side of the range when the roof's edges could not all be seen ('edges-unverified'). */
  unverifiedEdgesWidenPct: 8,
  /** The geocoder's own score under which the point is not trusted. */
  minAccuracy: 0.9,
  /**
   * Imagery older than this is not trusted (a build, an addition or a removed tree since is likely to be missing).
   * Nothing in the repo records re-roofs or permits; the benchmark's 84 houses have imagery from 2.3 to 14.1 years old
   * (median 3.3), so 5 years keeps about three in four of those and drops the oldest quarter.
   */
  maxImageryAgeYears: 5,
  /** Google's best imagery. MEDIUM (0.25 m) is not enough: the roof's quality checks were tuned and benchmarked on HIGH (0.1 m) only. */
  trustedImageryQuality: 'HIGH',
  /** The geocoded point of the house may lie this far outside the measured roof outline (the geocoder's own error). */
  maxOutlineGapM: 10,
} as const;

/** Lookup kinds that put the point on the house: a rooftop, or an address point. */
const ON_THE_HOUSE: ReadonlySet<string> = new Set(['rooftop', 'point']);

/** What the address lookup said about one typed address. */
export type LookupFacts = { accuracy: number; accuracyType: string; unit: string | null; number: string | null; streetName: string | null };

/** A unit word and its number or letter ("Apt 12B", "Ste. 200", "Unit C"); "Ste Genevieve Ave" is not one. Or "#4". */
const UNIT_RE = /(?:^|[\s,])(?:apt|apartment|unit|suite|ste|bldg|building|lot|rm|room)(?:\.\s*|\s+)#?\s*(?:\d[a-z0-9-]*|[a-z]\b)|#\s*[a-z0-9-]+/i;

/** The unit typed in the address ("Apt 1203", "#4", "Suite 200"), or null. */
export function typedUnit(typed: string): string | null {
  const m = UNIT_RE.exec(typed);
  return m === null ? null : m[0].replace(/^[\s,]+/, '').trim();
}

const DIRECTIONS = new Set(['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw', 'north', 'south', 'east', 'west', 'northeast', 'northwest', 'southeast', 'southwest']);
const STREET_TYPES = new Set([
  'st', 'street', 'ave', 'av', 'avenue', 'dr', 'drive', 'rd', 'road', 'ln', 'lane', 'ct', 'court', 'blvd', 'boulevard', 'pl', 'place', 'way',
  'cir', 'circle', 'ter', 'terrace', 'pkwy', 'parkway', 'hwy', 'highway', 'trl', 'trail', 'loop', 'run', 'pass', 'path', 'sq', 'square',
  'xing', 'crossing', 'cv', 'cove', 'pt', 'point', 'aly', 'alley', 'row', 'walk', 'expy', 'expressway', 'fwy', 'freeway',
]);
const SAME: Record<string, string> = {
  saint: 'st', mount: 'mt', fort: 'ft',
  first: '1', second: '2', third: '3', fourth: '4', fifth: '5', sixth: '6', seventh: '7', eighth: '8', ninth: '9', tenth: '10',
};

/** Lowercase words, punctuation gone, "112th" -> "112", "Saint" -> "st". */
function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w !== '')
    .map((w) => SAME[w] ?? w.replace(/^(\d+)(st|nd|rd|th)$/, '$1'));
}

/**
 * Whether the street the lookup found is the one typed: its house number is a typed word, and every word of its
 * street name except the direction and the street type ("W", "St") is too. "Riverfront Drive" matches "Riverfront
 * Dr"; "Riverside Dr" does not.
 */
export function streetMatches(typed: string, found: Pick<LookupFacts, 'number' | 'streetName'>): boolean {
  const said = new Set(words(typed));
  if (found.number !== null && !said.has(words(found.number)[0] ?? '')) return false;
  const core = words(found.streetName ?? '').filter((w) => !DIRECTIONS.has(w) && !STREET_TYPES.has(w));
  return core.every((w) => said.has(w));
}

/** The reason the lookup alone sends this address to a call back, or null. Runs before anything is measured. */
export function lookupGate(typed: string, found: LookupFacts): QuoteCallbackReason | null {
  if ((found.unit ?? '') !== '' || typedUnit(typed) !== null) return 'unit';
  if (!ON_THE_HOUSE.has(found.accuracyType) || found.accuracy < QUOTE_GATES.minAccuracy) return 'not-rooftop';
  if (!streetMatches(typed, found)) return 'street-changed';
  return null;
}

/** The serious review reasons: the measured area itself may be wrong. 'edges-unverified' only widens the range. */
export function seriousReasons(reasons: readonly RoofQualityReason[]): RoofQualityReason[] {
  return reasons.filter((r) => ROOF_QUALITY_SEVERITY[r] === 'block' && r !== 'edges-unverified');
}

/** Why the satellite pictures cannot be trusted for this home. Staff only: the homeowner is told one sentence. */
export type SatelliteProblem =
  | 'imagery-quality' // Solar's imagery is below HIGH
  | 'imagery-old' // older than QUOTE_GATES.maxImageryAgeYears
  | 'built-after-imagery' // the home's year built is the imagery's year or later
  | 'no-solar-building' // Solar found no building at the home (or only a neighbour's)
  | 'roof-review' // the roof in 3D carries a serious review reason (the area may be wrong)
  | 'outline-off-house'; // the measured outline is not on the geocoded house

/** The reasons that put the outline itself in doubt: the window estimate is built on the same outline. */
const OUTLINE_REASONS: ReadonlySet<RoofQualityReason> = new Set<RoofQualityReason>(['outline-off', 'joined-buildings']);

export type SatelliteFacts = {
  now: Date;
  /** Solar's building for the home: the building, null when none was found near it, undefined when not known (Solar not asked or down). */
  solarBuilding: { imageryQuality: string | null; imageryDate: string | null } | null | undefined;
  /** The 3D roof's own imagery facts, when there is one. */
  roof3d: { imageryQuality: string | null; imageryDate: string | null } | null;
  reasons: readonly RoofQualityReason[];
  yearBuilt: number | null;
  /** How far the geocoded point lies outside the measured outline, metres (0 inside); null without both. */
  outlineGapM: number | null;
};

export type SatelliteGate = { problems: SatelliteProblem[]; imagery: { quality: string | null; date: string | null }; blocksWindows: boolean };

const YEAR_MS = 365.25 * 24 * 60 * 60 * 1000;

/** Whether the satellite pictures can be trusted to measure this roof: every problem found, and whether it also spoils the outline. */
export function satelliteGate(f: SatelliteFacts): SatelliteGate {
  const quality = f.solarBuilding?.imageryQuality ?? f.roof3d?.imageryQuality ?? null;
  const date = f.solarBuilding?.imageryDate ?? f.roof3d?.imageryDate ?? null;
  const problems: SatelliteProblem[] = [];
  if (f.solarBuilding === null) problems.push('no-solar-building');
  if (quality !== null && quality !== QUOTE_GATES.trustedImageryQuality) problems.push('imagery-quality');
  const taken = date === null ? Number.NaN : Date.parse(`${date}T00:00:00Z`);
  if (Number.isFinite(taken) && (f.now.getTime() - taken) / YEAR_MS > QUOTE_GATES.maxImageryAgeYears) problems.push('imagery-old');
  if (Number.isFinite(taken) && f.yearBuilt !== null && f.yearBuilt >= new Date(taken).getUTCFullYear()) problems.push('built-after-imagery');
  const serious = seriousReasons(f.reasons);
  if (serious.length > 0) problems.push('roof-review');
  const outlineOff = f.outlineGapM !== null && f.outlineGapM > QUOTE_GATES.maxOutlineGapM;
  if (outlineOff) problems.push('outline-off-house');
  return { problems, imagery: { quality, date }, blocksWindows: outlineOff || serious.some((r) => OUTLINE_REASONS.has(r)) };
}

/** Metres from a point to a ring: 0 inside it, else the distance to its nearest edge (flat-earth, fine at house scale). */
export function metresOutsideRing(point: LngLat, ring: readonly LngLat[]): number {
  const kx = 111_320 * Math.cos((point[1] * Math.PI) / 180);
  const ky = 111_320;
  const pts = ring.map((p) => [(p[0] - point[0]) * kx, (p[1] - point[1]) * ky] as const);
  let inside = false;
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [ax, ay] = pts[j]!;
    const [bx, by] = pts[i]!;
    if (ay > 0 !== by > 0 && (bx - ax) * (0 - ay) / (by - ay) + ax > 0) inside = !inside;
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
    best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
  }
  return inside || pts.length < 3 ? 0 : best;
}

export type MeasureGate = { callback: QuoteCallbackReason | null; widen: boolean };

type GateView = Pick<MeasurementView, 'estimate' | 'structures' | 'needsReview' | 'roof3d'>;

/** After the measurement (the satellite checks are separate: satelliteGate): a call back, or a price (widened when the roof's edges could not all be seen). */
export function measurementGate(view: GateView): MeasureGate {
  const reasons = view.needsReview?.reasons ?? [];
  const widen = reasons.includes('edges-unverified');
  const main = view.structures.find((s) => s.main) ?? view.structures.find((s) => s.included);
  const footprint = Math.max(view.estimate.footprintSqFt, main?.areaSqFt ?? 0);
  if (footprint > QUOTE_GATES.maxFootprintSqFt || view.estimate.squares > QUOTE_GATES.maxSquares) return { callback: 'too-big', widen };
  if ((view.roof3d ?? null) === null && view.estimate.pitchX12 < QUOTE_GATES.minPitchWithout3d) return { callback: 'flat-unmeasured', widen };
  return { callback: null, widen };
}

/** The range width for a measurement: the company's, plus the widening, within the page's limits. */
export function rangePctFor(pct: number, gate: MeasureGate, maxPct: number): number {
  return gate.widen ? Math.min(maxPct, pct + QUOTE_GATES.unverifiedEdgesWidenPct) : pct;
}
