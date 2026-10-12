import { describe, expect, test } from 'vitest';
import { draftBodyOk, FROM_TEMPLATE, localTimeToday, planExpiresAt, systemCtx } from '../src/agents/common.ts';

const CT = 'America/Chicago';

describe('draftBodyOk', () => {
  const opts = { repName: null, maxChars: 100 };
  test('accepts a clean two-sentence text', () => {
    expect(draftBodyOk('Hi Sam, we can visit on Friday. Reply YES to confirm.', opts)).toBe(true);
  });
  test('rejects empty and blank text', () => {
    expect(draftBodyOk('', opts)).toBe(false);
    expect(draftBodyOk('   ', opts)).toBe(false);
  });
  test('length limit is inclusive and measured after trimming', () => {
    const exact = 'a'.repeat(100);
    expect(draftBodyOk(exact, opts)).toBe(true);
    expect(draftBodyOk(`${exact}   `, opts)).toBe(true);
    expect(draftBodyOk(`${exact}b`, opts)).toBe(false);
  });
  test('rejects insurer contact and coverage promises', () => {
    expect(draftBodyOk("We'll call your insurance for you.", opts)).toBe(false);
    expect(draftBodyOk('Your insurance will cover the whole roof.', opts)).toBe(false);
  });
  test('rejects a sentence the front-desk guard flags', () => {
    expect(draftBodyOk('Thanks for your time. Your roof is damaged and insurance will pay $12,000.', opts)).toBe(false);
  });
});

describe('localTimeToday', () => {
  const cases: [string, number, string][] = [
    ['2026-03-08', 18, '2026-03-08T23:00:00.000Z'], // spring forward day, CDT = UTC-5
    ['2026-03-08', 21, '2026-03-09T02:00:00.000Z'],
    ['2026-11-01', 18, '2026-11-02T00:00:00.000Z'], // fall back day, CST = UTC-6
    ['2026-11-01', 15, '2026-11-01T21:00:00.000Z'],
    ['2026-06-10', 21, '2026-06-11T02:00:00.000Z'], // normal day, CDT
  ];
  for (const [day, hour, iso] of cases) {
    test(`${day} ${hour}:00 in ${CT}`, () => {
      expect(localTimeToday(day, hour, CT).toISOString()).toBe(iso);
    });
  }
});

describe('shared constants', () => {
  test('systemCtx', () => {
    expect(systemCtx('c1')).toEqual({ companyId: 'c1', userId: null, role: 'system', canApproveSpend: false });
  });
  test('FROM_TEMPLATE', () => {
    expect(FROM_TEMPLATE).toBe('Written from a template');
  });
});

describe('planExpiresAt', () => {
  test('before the hour: expires at that hour today', () => {
    const now = new Date('2026-10-12T20:00:00Z'); // 15:00 in Chicago
    expect(planExpiresAt(now, '2026-10-12', 18, CT).toISOString()).toBe('2026-10-12T23:00:00.000Z');
  });
  test('after the hour: expires at that hour the next local day, never already expired', () => {
    const now = new Date('2026-10-12T23:48:00Z'); // 18:48 in Chicago
    const at = planExpiresAt(now, '2026-10-12', 18, CT);
    expect(at.toISOString()).toBe('2026-10-13T23:00:00.000Z');
    expect(at.getTime()).toBeGreaterThan(now.getTime());
  });
  test('exactly at the hour counts as passed', () => {
    const now = new Date('2026-10-12T23:00:00Z');
    expect(planExpiresAt(now, '2026-10-12', 18, CT).toISOString()).toBe('2026-10-13T23:00:00.000Z');
  });
  test('the next day is the wall-clock hour across a clock change', () => {
    const now = new Date('2026-11-01T00:30:00Z'); // Oct 31 19:30 CDT; Nov 1 has the fall-back change
    expect(planExpiresAt(now, '2026-10-31', 18, CT).toISOString()).toBe('2026-11-02T00:00:00.000Z');
  });
});
