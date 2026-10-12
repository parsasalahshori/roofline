import { describe, expect, test } from 'vitest';
import { draftBodyOk, FROM_TEMPLATE, localTimeToday, systemCtx } from '../src/agents/common.ts';

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
