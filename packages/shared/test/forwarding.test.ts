import { describe, it, expect } from 'vitest';
import { CARRIERS, forwardingSteps, type Carrier } from '../src/forwarding.ts';

const ROOFLINE = '+15551234567';
const TEN = '5551234567';
const FORMATTED = '(555) 123-4567';
const MODES = ['all', 'no_answer'] as const;

const STEP_CARRIERS: Carrier[] = [
  'ringcentral',
  'google_voice',
  'ooma',
  'spectrum',
  'comcast',
  'grasshopper',
  'other',
];

describe('CARRIERS', () => {
  it('lists the 12 carriers in order', () => {
    expect([...CARRIERS]).toEqual([
      'verizon',
      'att',
      'tmobile',
      'other_gsm',
      'landline',
      'ringcentral',
      'google_voice',
      'ooma',
      'spectrum',
      'comcast',
      'grasshopper',
      'other',
    ]);
  });
});

describe('dial codes', () => {
  it('converts E.164 to ten digits', () => {
    expect(TEN).toHaveLength(10);
    const result = forwardingSteps('verizon', 'all', ROOFLINE);
    expect(result.on[0]).toContain(TEN);
  });

  it('verizon all-calls codes', () => {
    expect(forwardingSteps('verizon', 'all', ROOFLINE)).toEqual({
      kind: 'dial',
      on: ['*725551234567'],
      off: ['*73'],
    });
  });

  it('verizon no-answer codes', () => {
    expect(forwardingSteps('verizon', 'no_answer', ROOFLINE)).toEqual({
      kind: 'dial',
      on: ['*715551234567'],
      off: ['*73'],
    });
  });

  it('AT&T, T-Mobile and other GSM use **21 / **61 codes', () => {
    for (const carrier of ['att', 'tmobile', 'other_gsm'] as const) {
      expect(forwardingSteps(carrier, 'all', ROOFLINE)).toEqual({
        kind: 'dial',
        on: ['**21*5551234567#'],
        off: ['##21#'],
      });
      expect(forwardingSteps(carrier, 'no_answer', ROOFLINE)).toEqual({
        kind: 'dial',
        on: ['**61*5551234567#'],
        off: ['##61#'],
      });
    }
  });

  it('landline uses *72 / *73 in both modes', () => {
    for (const mode of MODES) {
      expect(forwardingSteps('landline', mode, ROOFLINE)).toEqual({
        kind: 'dial',
        on: ['*725551234567'],
        off: ['*73'],
      });
    }
  });
});

describe('plain-English steps carriers', () => {
  for (const carrier of STEP_CARRIERS) {
    for (const mode of MODES) {
      it(`${carrier} ${mode} gives steps with the formatted number`, () => {
        const result = forwardingSteps(carrier, mode, ROOFLINE);
        expect(result.kind).toBe('steps');
        expect(result.on.length).toBeGreaterThan(0);
        expect(result.off.length).toBeGreaterThan(0);
        for (const line of [...result.on, ...result.off]) {
          expect(typeof line).toBe('string');
          expect(line.length).toBeGreaterThan(0);
        }
        const onText = result.on.join(' ');
        expect(onText).toContain(FORMATTED);
        expect(onText).not.toContain('+1');
      });
    }

    it(`${carrier} all-calls and no-answer on-steps differ`, () => {
      const all = forwardingSteps(carrier, 'all', ROOFLINE);
      const noAnswer = forwardingSteps(carrier, 'no_answer', ROOFLINE);
      expect(all.on).not.toEqual(noAnswer.on);
    });
  }
});

describe('cross-cutting forwarding rules', () => {
  it('no dial code contains a plus sign or a leading country code', () => {
    for (const carrier of CARRIERS) {
      for (const mode of MODES) {
        const result = forwardingSteps(carrier, mode, ROOFLINE);
        if (result.kind !== 'dial') continue;
        for (const code of [...result.on, ...result.off]) {
          expect(code, `${carrier} ${mode}`).not.toContain('+');
          expect(code, `${carrier} ${mode}`).not.toMatch(/(^|[^0-9])15551234567/);
        }
      }
    }
  });

  it('every carrier and mode returns a dial or steps result with arrays', () => {
    for (const carrier of CARRIERS) {
      for (const mode of MODES) {
        const result = forwardingSteps(carrier, mode, ROOFLINE);
        expect(['dial', 'steps']).toContain(result.kind);
        expect(Array.isArray(result.on)).toBe(true);
        expect(Array.isArray(result.off)).toBe(true);
      }
    }
  });

  it('is deterministic', () => {
    for (const carrier of CARRIERS) {
      for (const mode of MODES) {
        expect(forwardingSteps(carrier, mode, ROOFLINE)).toEqual(
          forwardingSteps(carrier, mode, ROOFLINE),
        );
      }
    }
  });
});
