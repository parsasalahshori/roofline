import { describe, expect, test } from 'vitest';
import { monthlyPaymentCents } from '../src/tiers-finance.ts';

function unroundedPayment(p: number, aprBps: number, n: number): number {
  const r = aprBps / 10000 / 12;
  return aprBps === 0 ? p / n : (p * r) / (1 - (1 + r) ** -n);
}

describe('monthlyPaymentCents', () => {
  test('matches the amortization formula', () => {
    const P = 1_425_000;
    const r = 999 / 10000 / 12;
    const n = 120;
    const expected = Math.ceil((P * r) / (1 - (1 + r) ** -n) - 1e-9);
    const got = monthlyPaymentCents(P, 999, n);
    expect(got).toBe(expected);
    // about $189 per month
    expect(got).toBeGreaterThanOrEqual(18000);
    expect(got).toBeLessThanOrEqual(19500);
  });

  test('0% APR is ceil(P/n)', () => {
    expect(monthlyPaymentCents(1_425_000, 0, 120)).toBe(11875);
    expect(monthlyPaymentCents(1_000_001, 0, 12)).toBe(83334);
    expect(monthlyPaymentCents(100, 0, 3)).toBe(34);
  });

  test('rounds up, never down', () => {
    const combos: Array<[number, number, number]> = [
      [1_425_000, 999, 120],
      [1_000_000, 1250, 60],
      [500_001, 599, 36],
      [2_345_678, 1899, 180],
      [99_999, 0, 7],
    ];
    for (const [P, apr, n] of combos) {
      const result = monthlyPaymentCents(P, apr, n);
      const exact = unroundedPayment(P, apr, n);
      // the rounded payment covers the principal
      expect(result * n).toBeGreaterThanOrEqual(P);
      // one cent less would fall short of the exact payment
      expect(result - 1).toBeLessThan(exact);
      // and it is not more than one cent above the exact payment
      expect(result).toBeLessThan(exact + 1 + 1e-6);
    }
  });

  test('longer terms are cheaper per month; higher APR costs more', () => {
    const P = 1_425_000;
    expect(monthlyPaymentCents(P, 999, 60)).toBeGreaterThan(monthlyPaymentCents(P, 999, 120));
    expect(monthlyPaymentCents(P, 999, 120)).toBeGreaterThan(monthlyPaymentCents(P, 999, 180));
    expect(monthlyPaymentCents(P, 1499, 120)).toBeGreaterThan(monthlyPaymentCents(P, 999, 120));
    expect(monthlyPaymentCents(P, 999, 120)).toBeGreaterThan(monthlyPaymentCents(P, 0, 120));
  });

  test('zero principal gives 0', () => {
    expect(monthlyPaymentCents(0, 999, 120)).toBe(0);
    expect(monthlyPaymentCents(0, 0, 12)).toBe(0);
  });

  test('invalid inputs throw', () => {
    expect(() => monthlyPaymentCents(1_000_000, 999, 0)).toThrow(RangeError);
    expect(() => monthlyPaymentCents(1_000_000, 999, -5)).toThrow(RangeError);
    expect(() => monthlyPaymentCents(1_000_000, 999, 1.5)).toThrow(RangeError);
    expect(() => monthlyPaymentCents(1_000_000, 999, NaN)).toThrow(RangeError);
    expect(() => monthlyPaymentCents(1_000_000, -1, 120)).toThrow(RangeError);
    expect(() => monthlyPaymentCents(1_000_000, NaN, 120)).toThrow(RangeError);
    expect(() => monthlyPaymentCents(1_000_000, 999, 0)).toThrow('invalid financing inputs');
  });
});
