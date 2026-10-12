import { describe, expect, test } from 'vitest';
import {
  SmokeRefused,
  assertConfirmed,
  assertStripeTestKey,
  parseSmokeBrand,
} from '../src/scripts/smoke/guards.ts';

// Pure checks only: the smoke scripts themselves are run by hand, never from the test suite.

describe('assertStripeTestKey', () => {
  test('refuses a live key', () => {
    expect(() => assertStripeTestKey('sk_live_x')).toThrow(SmokeRefused);
  });

  test('refuses a missing key', () => {
    expect(() => assertStripeTestKey(undefined)).toThrow(SmokeRefused);
  });

  test('returns a test key unchanged', () => {
    expect(assertStripeTestKey('sk_test_x')).toBe('sk_test_x');
  });
});

describe('assertConfirmed', () => {
  test('refuses when the confirm flag is absent', () => {
    expect(() => assertConfirmed([], '--confirm-real-registration')).toThrow(SmokeRefused);
  });

  test('accepts argv that includes the confirm flag', () => {
    expect(() => assertConfirmed(['--submit', '--confirm-real-registration'], '--confirm-real-registration')).not.toThrow();
  });
});

describe('parseSmokeBrand', () => {
  test('names the missing fields without echoing values', () => {
    let caught: unknown;
    try {
      parseSmokeBrand('{}');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SmokeRefused);
    const message = (caught as Error).message;
    expect(message).toContain('legalName');
    expect(message).toContain('ein');
  });

  test('never prints the brand values in an error', () => {
    const json = JSON.stringify({ legalName: 'Secret Roofing Co', ein: '99-9999999' });
    let caught: unknown;
    try {
      parseSmokeBrand(json);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SmokeRefused);
    const message = (caught as Error).message;
    expect(message).not.toContain('Secret Roofing Co');
    expect(message).not.toContain('99-9999999');
  });
});
