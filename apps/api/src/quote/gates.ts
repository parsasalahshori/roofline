import { type MeasurementView, ROOF_QUALITY_SEVERITY, type RoofQualityReason } from '@roofline/shared';

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
 * The windows come from the same outline, so they follow the same checks.
 */

export type QuoteCallbackReason = 'unit' | 'not-rooftop' | 'street-changed' | 'roof-review' | 'too-big' | 'flat-unmeasured';

export const QUOTE_GATES = {
  maxFootprintSqFt: 6000,
  maxSquares: 80,
  minPitchWithout3d: 2,
  /** Percent added to each side of the range when the roof's edges could not all be seen ('edges-unverified'). */
  unverifiedEdgesWidenPct: 8,
  /** The geocoder's own score under which the point is not trusted. */
  minAccuracy: 0.9,
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

export type MeasureGate = { callback: QuoteCallbackReason | null; widen: boolean };

type GateView = Pick<MeasurementView, 'estimate' | 'structures' | 'needsReview' | 'roof3d'>;

/** After the measurement: a call back, or a price (widened when the roof's edges could not all be seen). */
export function measurementGate(view: GateView): MeasureGate {
  const reasons = view.needsReview?.reasons ?? [];
  const widen = reasons.includes('edges-unverified');
  if (seriousReasons(reasons).length > 0) return { callback: 'roof-review', widen };
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
