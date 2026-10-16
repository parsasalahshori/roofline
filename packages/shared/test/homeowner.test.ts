import { describe, expect, it } from 'vitest';
import {
  buildHomeownerQuote,
  DEFAULT_WINDOW_TIERS,
  HOMEOWNER_TOKEN_RE,
  inchesInEighths,
  scaleWindowMix,
  windowSizeLabel,
  windowUncertaintyLabel,
  WINDOW_SIZE_CLASSES,
} from '../src/index.ts';
import { linesFromPhotoWindows } from '../src/window-order.ts';

describe('sizes in words', () => {
  it('writes inches in eighths: a whole number, a reduced fraction, no bare zero', () => {
    expect(inchesInEighths(36)).toBe('36');
    expect(inchesInEighths(35.625)).toBe('35 5/8');
    expect(inchesInEighths(59.5)).toBe('59 1/2');
    expect(inchesInEighths(0.25)).toBe('1/4');
    expect(inchesInEighths(0.125)).toBe('1/8');
    expect(inchesInEighths(0)).toBe('0');
    expect(inchesInEighths(35.99)).toBe('36');
  });

  it('rounds to the nearest eighth, or up for a ± that must not be understated', () => {
    expect(inchesInEighths(35.6)).toBe('35 5/8');
    expect(inchesInEighths(35.56)).toBe('35 1/2');
    expect(inchesInEighths(35.5)).toBe('35 1/2');
    expect(inchesInEighths(0.13, 'up')).toBe('1/4');
    expect(inchesInEighths(0.125, 'up')).toBe('1/8');
    expect(inchesInEighths(0.3, 'up')).toBe('3/8');
    expect(inchesInEighths(1.01, 'up')).toBe('1 1/8');
  });

  it('labels a window "width x height" and an uncertainty "about ±..." (never a bare ±, never under 1/8 in)', () => {
    expect(windowSizeLabel(35.625, 59.625)).toBe('35 5/8 x 59 5/8');
    expect(windowUncertaintyLabel({ width: 0.02, height: 0.01 })).toBe('about ±1/8 in');
    expect(windowUncertaintyLabel({ width: 0.2, height: 0.31 })).toBe('about ±3/8 in');
    expect(windowUncertaintyLabel({ width: 1.2, height: 0.4 })).toBe('about ±1 1/4 in');
  });
});

describe('the token shape', () => {
  it('is 43 base64url characters (32 bytes, no padding)', () => {
    expect(HOMEOWNER_TOKEN_RE.test('A'.repeat(43))).toBe(true);
    expect(HOMEOWNER_TOKEN_RE.test(`${'a_-'.repeat(14)}A`)).toBe(true);
    expect(HOMEOWNER_TOKEN_RE.test('A'.repeat(42))).toBe(false);
    expect(HOMEOWNER_TOKEN_RE.test('A'.repeat(44))).toBe(false);
    expect(HOMEOWNER_TOKEN_RE.test(`${'A'.repeat(42)}=`)).toBe(false);
  });
});

describe('scaleWindowMix', () => {
  it('keeps the shares and the total (largest remainders)', () => {
    expect(scaleWindowMix({ small: 2, standard: 10, large: 2, picture: 0 }, 28)).toEqual({ small: 4, standard: 20, large: 4, picture: 0 });
    const odd = scaleWindowMix({ small: 1, standard: 3, large: 1, picture: 1 }, 7);
    expect(WINDOW_SIZE_CLASSES.reduce((n, c) => n + odd[c], 0)).toBe(7);
  });

  it('is all standard with no mix, and empty for zero windows', () => {
    expect(scaleWindowMix(null, 9)).toEqual({ small: 0, standard: 9, large: 0, picture: 0 });
    expect(scaleWindowMix({ standard: 5 }, 0)).toEqual({ small: 0, standard: 0, large: 0, picture: 0 });
  });
});

describe('buildHomeownerQuote', () => {
  const mix = { small: 2, standard: 10, large: 2, picture: 0 };
  const dollars = (tier: 'good' | 'better' | 'best', cls: (typeof WINDOW_SIZE_CLASSES)[number]) => DEFAULT_WINDOW_TIERS.find((t) => t.tier === tier)!.priceCents[cls] / 100;

  it('prices measured windows at their own size and the rest from the address estimate, in whole dollars', () => {
    const q = buildHomeownerQuote({
      measured: [
        { id: 'a', sizeClass: 'standard' },
        { id: 'b', sizeClass: 'large' },
      ],
      expected: { low: 12, high: 16, likely: 14 },
      override: null,
      mix,
    });
    expect(q.tiers.map((t) => t.key)).toEqual(['good', 'better', 'best']);
    expect(q.tiers.map((t) => t.label)).toEqual(['Good', 'Better', 'Best']);
    expect(q.measuredCount).toBe(2);
    expect(q.estimatedCount).toBe(12);
    const good = q.tiers[0]!;
    expect(good.perWindow).toEqual([
      { windowId: 'a', price: dollars('good', 'standard') },
      { windowId: 'b', price: dollars('good', 'large') },
    ]);
    // 12 estimated windows at the mix of 2 : 10 : 2 scaled to 12 = 2 small, 8 standard (rounded), 2 large
    const est = scaleWindowMix(mix, 12);
    const estimatedTotal = WINDOW_SIZE_CLASSES.reduce((n, c) => n + est[c] * dollars('good', c), 0);
    expect(good.estimatedCount).toBe(12);
    expect(good.estimatedTotal).toBe(estimatedTotal);
    // total = sum(perWindow) + estimatedTotal, exactly, on every tier
    for (const t of q.tiers) expect(t.total).toBe(t.perWindow.reduce((n, w) => n + w.price, 0) + t.estimatedTotal);
    for (const t of q.tiers) expect(Number.isInteger(t.total)).toBe(true);
  });

  it('with nothing measured, the whole quote is estimated; with no estimate either, it is empty', () => {
    const all = buildHomeownerQuote({ measured: [], expected: { low: 10, high: 10, likely: 10 }, override: null, mix: null });
    expect(all.measuredCount).toBe(0);
    expect(all.estimatedCount).toBe(10);
    expect(all.tiers[0]!.total).toBe(10 * dollars('good', 'standard'));
    expect(all.missingHint).toBeUndefined();
    const none = buildHomeownerQuote({ measured: [], expected: null, override: null, mix: null });
    expect(none.estimatedCount).toBe(0);
    expect(none.tiers[0]!.total).toBe(0);
  });

  it("uses the homeowner's own count as the expected total, measured ones included, and never goes below the measured ones", () => {
    const measured = [
      { id: 'a', sizeClass: 'standard' as const },
      { id: 'b', sizeClass: 'standard' as const },
      { id: 'c', sizeClass: 'small' as const },
    ];
    const q = buildHomeownerQuote({ measured, expected: { low: 12, high: 16, likely: 14 }, override: 18, mix });
    expect(q.estimatedCount).toBe(15);
    const fewer = buildHomeownerQuote({ measured, expected: { low: 12, high: 16, likely: 14 }, override: 2, mix });
    expect(fewer.estimatedCount).toBe(0);
    expect(fewer.tiers[0]!.estimatedTotal).toBe(0);
    expect(fewer.tiers[0]!.perWindow).toHaveLength(3);
  });

  it('asks "did we miss any?" only below the low end of the estimate, and never once they gave their own count', () => {
    const two = [
      { id: 'a', sizeClass: 'standard' as const },
      { id: 'b', sizeClass: 'standard' as const },
    ];
    const expected = { low: 12, high: 16, likely: 14 };
    const hint = buildHomeownerQuote({ measured: two, expected, override: null, mix }).missingHint;
    expect(hint).toMatchObject({ measured: 2, expectedLow: 12, expectedHigh: 16, expectedLikely: 14 });
    expect(hint!.text).toBe('We think your home has about 12 to 16 windows and you have measured 2. Did we miss any?');
    expect(buildHomeownerQuote({ measured: two, expected, override: 14, mix }).missingHint).toBeUndefined();
    expect(buildHomeownerQuote({ measured: [], expected, override: null, mix }).missingHint).toBeUndefined();
    const enough = Array.from({ length: 12 }, (_, i) => ({ id: `w${i}`, sizeClass: 'standard' as const }));
    expect(buildHomeownerQuote({ measured: enough, expected, override: null, mix }).missingHint).toBeUndefined();
    // A range with no spread says "about N"
    expect(buildHomeownerQuote({ measured: two, expected: { low: 10, high: 10, likely: 10 }, override: null, mix }).missingHint!.text).toBe(
      'We think your home has about 10 windows and you have measured 2. Did we miss any?',
    );
  });

  it('leaves out a tier the company turned off', () => {
    const tiers = DEFAULT_WINDOW_TIERS.map((t) => (t.tier === 'better' ? { ...t, enabled: false } : t));
    const q = buildHomeownerQuote({ measured: [], expected: { low: 4, high: 4, likely: 4 }, override: null, mix: null, tiers });
    expect(q.tiers.map((t) => t.key)).toEqual(['good', 'best']);
  });
});

describe('windows measured in the app are quote-grade on a factory order', () => {
  const win = (id: string, extra: Record<string, unknown> = {}) => ({ id, widthIn: 36, heightIn: 60, quality: 'good' as const, uploadId: 'u1', ...extra });

  it('marks a card window, a room scan and anything from the homeowner app quote-only; leaves the rest order-grade', () => {
    const lines = linesFromPhotoWindows(
      [win('card', { scale: { kind: 'card' } }), win('scan', { scale: { kind: 'roomplan' } }), win('app-ar', { scale: { kind: 'ar' }, source: 'homeowner-app' }), win('staff-ar', { scale: { kind: 'ar' } })],
      new Set(),
    );
    const flags = Object.fromEntries(lines.map((l) => [l.photoWindowIds[0]!, l.measured.every((m) => m.quoteOnly === true)]));
    expect(flags).toEqual({ card: true, scan: true, 'app-ar': true, 'staff-ar': false });
  });
});
