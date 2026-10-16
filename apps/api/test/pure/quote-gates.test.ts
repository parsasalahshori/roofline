import { describe, expect, test } from 'vitest';
import type { QuoteEstimateRow } from '@roofline/db';
import { type MeasurementView, ROOF_QUALITY_REASONS, ROOF_QUALITY_SEVERITY, type RoofQualityReason } from '@roofline/shared';
import { shownSummary } from '../../src/public/quote.ts';
import { scaleMix, windowsForCount } from '../../src/quote/estimate.ts';
import { type LookupFacts, lookupGate, measurementGate, QUOTE_GATES, rangePctFor, streetMatches, typedUnit } from '../../src/quote/gates.ts';

/*
 * The instant quote page's checks (quote/gates.ts) on fake lookups and fake measurements: every reason a home gets a
 * call back instead of a price, and the widening. No database, no network.
 */

const ROOFTOP: LookupFacts = { accuracy: 1, accuracyType: 'rooftop', unit: null, number: '4810', streetName: 'Underwood Ave' };
const TYPED = '4810 Underwood Ave, Omaha, NE 68132';

type View = Parameters<typeof measurementGate>[0];

/** A plain house: 2,000 sq ft footprint, 24 squares, 6/12, the roof in 3D with no review reasons. */
function house(over: { reasons?: RoofQualityReason[]; footprintSqFt?: number; squares?: number; pitchX12?: number; no3d?: boolean; mainAreaSqFt?: number } = {}): View {
  return {
    estimate: {
      footprintSqFt: over.footprintSqFt ?? 2000,
      planSqFt: 2200,
      surfaceSqFt: 2400,
      squares: over.squares ?? 24,
      edgeFt: 200,
      ridgeFt: 40,
      valleyFt: 0,
      pitchX12: over.pitchX12 ?? 6,
    },
    structures: [{ footprintId: 'f1', included: true, areaSqFt: over.mainAreaSqFt ?? over.footprintSqFt ?? 2000, ring: [], main: true }],
    needsReview: over.reasons && over.reasons.length > 0 ? { reasons: over.reasons } : null,
    roof3d: over.no3d ? null : ({ outline: [], faces: [], lines: [] } as unknown as MeasurementView['roof3d']),
  };
}

describe('lookupGate (before anything is measured)', () => {
  test('a house the lookup put a rooftop on, with the street as typed: no call back', () => {
    expect(lookupGate(TYPED, ROOFTOP)).toBeNull();
  });

  test('a unit the lookup read, or one typed that it dropped, is an apartment: call back', () => {
    expect(lookupGate('2200 Riverfront Dr Apt 1203, Little Rock, AR 72202', { ...ROOFTOP, number: '2200', streetName: 'Riverfront Dr', unit: 'Apt 1203' })).toBe('unit');
    expect(lookupGate('2200 Riverfront Dr Apt 1203, Little Rock, AR 72202', { ...ROOFTOP, number: '2200', streetName: 'Riverfront Dr' })).toBe('unit');
    expect(lookupGate('2200 Riverfront Dr #1203, Little Rock, AR', { ...ROOFTOP, number: '2200', streetName: 'Riverfront Dr' })).toBe('unit');
    expect(lookupGate('500 Main St Suite 200, Omaha, NE', { ...ROOFTOP, number: '500', streetName: 'Main St' })).toBe('unit');
  });

  test('typedUnit finds units and leaves street names and states alone', () => {
    expect(typedUnit('12 Elm St, Apt 2, Omaha NE')).toBe('Apt 2');
    expect(typedUnit('12 Elm St Unit C, Omaha NE')).toBe('Unit C');
    expect(typedUnit('12 Elm St Ste. 200')).toBe('Ste. 200');
    expect(typedUnit('120 Ste Genevieve Ave, St Louis, MO')).toBeNull();
    expect(typedUnit('40 Floral Ave, Miami, FL 33101')).toBeNull();
    expect(typedUnit('9 Lotus Dr, Austin, TX')).toBeNull();
  });

  test('a point not on the house (between houses, the street, a nearby rooftop) or a weak score: call back', () => {
    for (const accuracyType of ['range_interpolation', 'street_center', 'nearest_rooftop_match', 'place', 'intersection']) {
      expect(lookupGate(TYPED, { ...ROOFTOP, accuracyType }), accuracyType).toBe('not-rooftop');
    }
    expect(lookupGate(TYPED, { ...ROOFTOP, accuracyType: 'point' })).toBeNull();
    expect(lookupGate(TYPED, { ...ROOFTOP, accuracy: 0.8 })).toBe('not-rooftop');
  });

  test('another house number or street name than the one typed: call back', () => {
    expect(lookupGate(TYPED, { ...ROOFTOP, number: '4812' })).toBe('street-changed');
    expect(lookupGate(TYPED, { ...ROOFTOP, streetName: 'Underhill Ave' })).toBe('street-changed');
  });

  test('streetMatches tolerates abbreviations, ordinals, directions and case', () => {
    expect(streetMatches('701 W 112th St, Kansas City, MO 64114', { number: '701', streetName: 'W 112th St' })).toBe(true);
    expect(streetMatches('701 west 112 street kansas city mo', { number: '701', streetName: 'W 112th St' })).toBe(true);
    expect(streetMatches('2587 Linwood Avenue, Shreveport LA', { number: '2587', streetName: 'Linwood Ave' })).toBe(true);
    expect(streetMatches('10 Saint Charles Ave, New Orleans', { number: '10', streetName: 'St Charles Ave' })).toBe(true);
    expect(streetMatches('5 First St, Omaha', { number: '5', streetName: '1st St' })).toBe(true);
    expect(streetMatches('2200 Riverfront Dr, Little Rock', { number: '2200', streetName: 'Riverside Dr' })).toBe(false);
  });
});

describe('measurementGate (after the measurement)', () => {
  test('a plain house is priced at the company width', () => {
    const gate = measurementGate(house());
    expect(gate).toEqual({ callback: null, widen: false });
    expect(rangePctFor(12, gate, 40)).toBe(12);
  });

  test("every serious ('block') review reason but 'edges-unverified' is a call back", () => {
    const serious = ROOF_QUALITY_REASONS.filter((r) => ROOF_QUALITY_SEVERITY[r] === 'block' && r !== 'edges-unverified');
    expect(serious).toEqual(expect.arrayContaining(['roof-hidden', 'outline-off', 'joined-buildings', 'roof-inferred']));
    for (const r of serious) expect(measurementGate(house({ reasons: [r] })).callback, r).toBe('roof-review');
  });

  test("'check' reasons alone do not stop the price", () => {
    const checks = ROOF_QUALITY_REASONS.filter((r) => ROOF_QUALITY_SEVERITY[r] === 'check');
    expect(measurementGate(house({ reasons: checks })).callback).toBeNull();
  });

  test("'edges-unverified' alone widens the range (within the page's maximum)", () => {
    const gate = measurementGate(house({ reasons: ['edges-unverified'] }));
    expect(gate).toEqual({ callback: null, widen: true });
    expect(rangePctFor(12, gate, 40)).toBe(12 + QUOTE_GATES.unverifiedEdgesWidenPct);
    expect(rangePctFor(38, gate, 40)).toBe(40);
    // With a serious reason too, it is a call back all the same.
    expect(measurementGate(house({ reasons: ['edges-unverified', 'roof-hidden'] })).callback).toBe('roof-review');
  });

  test('a commercial building or a complex (over 6,000 sq ft or 80 squares) is a call back', () => {
    expect(measurementGate(house({ footprintSqFt: 13_666, squares: 140 })).callback).toBe('too-big');
    expect(measurementGate(house({ footprintSqFt: 6001 })).callback).toBe('too-big');
    expect(measurementGate(house({ footprintSqFt: 5000, squares: 81 })).callback).toBe('too-big');
    expect(measurementGate(house({ footprintSqFt: 3000, mainAreaSqFt: 7000 })).callback).toBe('too-big');
    expect(measurementGate(house({ footprintSqFt: 6000, squares: 80 })).callback).toBeNull();
  });

  test('a pitch under 2/12 read without the roof in 3D is a call back; with the roof in 3D it is measured', () => {
    expect(measurementGate(house({ pitchX12: 0, no3d: true })).callback).toBe('flat-unmeasured');
    expect(measurementGate(house({ pitchX12: 1.5, no3d: true })).callback).toBe('flat-unmeasured');
    expect(measurementGate(house({ pitchX12: 2, no3d: true })).callback).toBeNull();
    expect(measurementGate(house({ pitchX12: 0 })).callback).toBeNull();
  });
});

describe('the window count the homeowner sets', () => {
  const row = (result: Record<string, unknown>, status: 'ready' | 'fallback' = 'ready') => ({ status, result }) as unknown as QuoteEstimateRow;

  test('scaleMix keeps the shares and the total', () => {
    expect(scaleMix({ small: 2, standard: 10, large: 2, picture: 0 }, 28)).toEqual({ small: 4, standard: 20, large: 4, picture: 0 });
    const odd = scaleMix({ small: 1, standard: 3, large: 1, picture: 1 }, 7);
    expect(Object.values(odd).reduce((a, b) => a + b, 0)).toBe(7);
    expect(scaleMix(null, 9)).toEqual({ small: 0, standard: 9, large: 0, picture: 0 });
  });

  test('windowsForCount re-prices from the stored mix, clamps 1 to 80, and only for a ready estimate with windows', () => {
    const r = row({ windows: { count: 14, range: { lowCents: 1, highCents: 2 } }, windowMix: { small: 0, standard: 14, large: 0, picture: 0 }, windowPct: 12 });
    const at14 = windowsForCount(r, 14, 12)!;
    const at28 = windowsForCount(r, 28, 12)!;
    expect(at28.count).toBe(28);
    expect(at28.range.lowCents).toBeGreaterThan(at14.range.lowCents);
    expect(at14.range.lowCents % 10_000).toBe(0);
    expect(windowsForCount(r, 500, 12)!.count).toBe(80);
    expect(windowsForCount(r, 0, 12)!.count).toBe(1);
    expect(windowsForCount(row({ windows: null }), 10, 12)).toBeNull();
    expect(windowsForCount(row({ windows: { count: 14 } }, 'fallback'), 10, 12)).toBeNull();
  });

  test("the job's line says the homeowner's count, and that gutters are priced at the visit", () => {
    const shown = { roof: null, windows: { count: 14, range: { lowCents: 900_000, highCents: 1_200_000 } } };
    const line = shownSummary(shown, ['windows', 'gutters'], { count: 20, range: { lowCents: 1_300_000, highCents: 1_700_000 } });
    expect(line).toContain('about 20 windows (their count; we estimated 14), $13,000 to $17,000');
    expect(line).toContain('Gutters are priced at the visit.');
  });
});
