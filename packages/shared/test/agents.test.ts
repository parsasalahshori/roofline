import { describe, expect, test } from 'vitest';
import {
  G1_AGENTS_SHIPPED,
  isPaused,
  TIME_BASELINES,
  VISIBLE_BASELINE_KEYS,
  isEditableBaselineKey,
  minutesFor,
  type BaselineKey,
} from '../src/agents.ts';

const SPEC_KEYS = [
  'text_sent',
  'email_sent',
  'route_built',
  'ad_campaign',
  'proposal_sent',
  'exact_report',
  'call_answered',
  'spam_call',
  'booking',
  'text_reply',
  'claim_packet',
  'reminder_sent',
  'install_moved',
  'follow_up_sent',
];

describe('TIME_BASELINES defaults (spec 3.1)', () => {
  test('every spec key has its default minutes, unit and cap', () => {
    expect(TIME_BASELINES.text_sent).toMatchObject({ minutes: 1.5, capMinutes: 120, unit: 'text' });
    expect(TIME_BASELINES.email_sent).toMatchObject({ minutes: 0.5, capMinutes: 120, unit: 'email' });
    expect(TIME_BASELINES.route_built).toMatchObject({ minutes: 45, unit: 'route' });
    expect(TIME_BASELINES.ad_campaign).toMatchObject({ minutes: 45, unit: 'campaign' });
    expect(TIME_BASELINES.proposal_sent).toMatchObject({ minutes: 20, unit: 'proposal' });
    expect(TIME_BASELINES.exact_report).toMatchObject({ minutes: 10, unit: 'order' });
    expect(TIME_BASELINES.call_answered).toMatchObject({ minutes: 2, perCallLength: true, unit: 'call' });
    expect(TIME_BASELINES.spam_call).toMatchObject({ minutes: 0, perCallLength: true, unit: 'call' });
    expect(TIME_BASELINES.booking).toMatchObject({ minutes: 3, unit: 'booking' });
    expect(TIME_BASELINES.text_reply).toMatchObject({ minutes: 2, unit: 'reply' });
  });

  test('the four G1 keys have their minutes, caps and units and are visible', () => {
    expect(TIME_BASELINES.claim_packet).toMatchObject({ minutes: 30, unit: 'packet' });
    expect(TIME_BASELINES.reminder_sent).toMatchObject({ minutes: 1, capMinutes: 120, unit: 'reminder' });
    expect(TIME_BASELINES.install_moved).toMatchObject({ minutes: 10, unit: 'move' });
    expect(TIME_BASELINES.follow_up_sent).toMatchObject({ minutes: 2, capMinutes: 120, unit: 'text' });
    for (const key of ['claim_packet', 'reminder_sent', 'install_moved', 'follow_up_sent'] as const) {
      expect(VISIBLE_BASELINE_KEYS).toContain(key);
      expect(TIME_BASELINES[key]).not.toHaveProperty('hidden', true);
    }
  });

  test('the hidden demo key counts 5 minutes per step and is hidden', () => {
    expect(TIME_BASELINES.demo).toMatchObject({ minutes: 5, unit: 'step', hidden: true });
  });

  test('every spec key is present in the table', () => {
    for (const key of SPEC_KEYS) expect(TIME_BASELINES).toHaveProperty(key);
  });

  test('only the text, email, reminder and follow-up keys carry a cap', () => {
    const capped = Object.entries(TIME_BASELINES)
      .filter(([, def]) => 'capMinutes' in def)
      .map(([key]) => key)
      .sort();
    expect(capped).toEqual(['email_sent', 'follow_up_sent', 'reminder_sent', 'text_sent']);
  });

  test('only the two call keys use the per-call length', () => {
    const perCall = Object.entries(TIME_BASELINES)
      .filter(([, def]) => 'perCallLength' in def && def.perCallLength === true)
      .map(([key]) => key)
      .sort();
    expect(perCall).toEqual(['call_answered', 'spam_call']);
  });

  test('every non-demo key has a non-empty basis sentence and unit', () => {
    for (const [key, def] of Object.entries(TIME_BASELINES)) {
      if (key === 'demo') continue;
      expect(def.unit.trim(), key).not.toBe('');
      expect(def.basis.trim(), key).not.toBe('');
    }
  });
});

describe('VISIBLE_BASELINE_KEYS and isEditableBaselineKey', () => {
  test('lists exactly the fourteen spec keys in table order and not demo', () => {
    expect([...VISIBLE_BASELINE_KEYS]).toEqual(SPEC_KEYS);
    expect(VISIBLE_BASELINE_KEYS).not.toContain('demo');
  });

  test('a visible key is editable; demo and unknown keys are not', () => {
    expect(isEditableBaselineKey('text_sent')).toBe(true);
    expect(isEditableBaselineKey('spam_call')).toBe(true);
    expect(isEditableBaselineKey('demo')).toBe(false);
    expect(isEditableBaselineKey('send_proposal')).toBe(false);
    expect(isEditableBaselineKey('')).toBe(false);
  });
});

describe('G1_AGENTS_SHIPPED (Ruling AX-B)', () => {
  test('is true once G1 Task 15 ships', () => {
    expect(G1_AGENTS_SHIPPED).toBe(true);
  });
});

describe('isPaused (Ruling GX-E)', () => {
  const when = new Date('2026-05-01T12:00:00Z');
  test.each([
    ['storm_scout', null, false],
    ['estimator', null, false],
    ['front_desk', null, false],
    ['storm_scout', { pausedAt: null }, false],
    ['estimator', { pausedAt: null }, false],
    ['front_desk', { pausedAt: null }, false],
    ['storm_scout', { pausedAt: when }, true],
    ['estimator', { pausedAt: when }, true],
    ['front_desk', { pausedAt: when }, true],
    ['claims', null, true],
    ['scheduler', null, true],
    ['follow_up', null, true],
    ['claims', { pausedAt: null }, false],
    ['scheduler', { pausedAt: null }, false],
    ['follow_up', { pausedAt: null }, false],
    ['claims', { pausedAt: when }, true],
    ['scheduler', { pausedAt: when }, true],
    ['follow_up', { pausedAt: when }, true],
  ] as const)('%s with %j is paused: %s', (agent, row, expected) => {
    expect(isPaused(agent, row)).toBe(expected);
  });
});

describe('minutesFor', () => {
  test('text_sent is 1.5 minutes per text, uncapped below 120 minutes', () => {
    expect(minutesFor('text_sent', 31, {})).toEqual({ minutesPerUnit: 1.5, minutes: 46.5 });
  });

  test('text_sent caps the step at 120 minutes', () => {
    expect(minutesFor('text_sent', 200, {})).toEqual({ minutesPerUnit: 0.6, minutes: 120 });
  });

  test('an owner override changes the per-unit minutes', () => {
    expect(minutesFor('text_sent', 10, { text_sent: 3 })).toEqual({ minutesPerUnit: 3, minutes: 30 });
  });

  test('the cap holds when an override is set', () => {
    expect(minutesFor('text_sent', 100, { text_sent: 3 })).toEqual({ minutesPerUnit: 1.2, minutes: 120 });
  });

  test('keys without a cap are not capped', () => {
    expect(minutesFor('route_built', 2, {})).toEqual({ minutesPerUnit: 45, minutes: 90 });
  });

  test('a call adds its length on top of the fixed minutes', () => {
    expect(minutesFor('call_answered', 1, {}, { callMinutes: 4 })).toEqual({ minutesPerUnit: 6, minutes: 6 });
  });

  test('a spam call counts only the length of the call', () => {
    expect(minutesFor('spam_call', 1, {}, { callMinutes: 0.5 })).toEqual({ minutesPerUnit: 0.5, minutes: 0.5 });
  });

  test('callMinutes is ignored for keys without perCallLength', () => {
    expect(minutesFor('text_sent', 2, {}, { callMinutes: 9 })).toEqual({ minutesPerUnit: 1.5, minutes: 3 });
  });

  test('bookings count at 3 minutes each', () => {
    expect(minutesFor('booking', 2, {})).toEqual({ minutesPerUnit: 3, minutes: 6 });
  });

  test('text replies honour an override', () => {
    expect(minutesFor('text_reply', 3, { text_reply: 1 })).toEqual({ minutesPerUnit: 1, minutes: 3 });
  });

  test('the demo key counts 5 minutes per unit and ignores overrides', () => {
    expect(minutesFor('demo', 1, {})).toEqual({ minutesPerUnit: 5, minutes: 5 });
    expect(minutesFor('demo', 2, { demo: 1 } as Partial<Record<BaselineKey, number>>)).toEqual({
      minutesPerUnit: 5,
      minutes: 10,
    });
  });

  test('zero units give zero minutes and the base per-unit minutes', () => {
    expect(minutesFor('route_built', 0, {})).toEqual({ minutesPerUnit: 45, minutes: 0 });
    expect(minutesFor('text_sent', 0, { text_sent: 2 })).toEqual({ minutesPerUnit: 2, minutes: 0 });
  });

  test('negative and NaN units count as zero', () => {
    expect(minutesFor('text_sent', -4, {})).toEqual({ minutesPerUnit: 1.5, minutes: 0 });
    expect(minutesFor('booking', Number.NaN, {})).toEqual({ minutesPerUnit: 3, minutes: 0 });
    expect(minutesFor('booking', Number.POSITIVE_INFINITY, {})).toEqual({ minutesPerUnit: 3, minutes: 0 });
  });

  test('negative and NaN call lengths count as zero', () => {
    expect(minutesFor('spam_call', 1, {}, { callMinutes: -3 })).toEqual({ minutesPerUnit: 0, minutes: 0 });
    expect(minutesFor('call_answered', 1, {}, { callMinutes: Number.NaN })).toEqual({
      minutesPerUnit: 2,
      minutes: 2,
    });
  });

  test('minutes are not rounded', () => {
    expect(minutesFor('email_sent', 3, {})).toEqual({ minutesPerUnit: 0.5, minutes: 1.5 });
    expect(minutesFor('call_answered', 3, {}, { callMinutes: 0.1 })).toEqual({
      minutesPerUnit: (6 + 0.1) / 3,
      minutes: 6.1,
    });
  });
});
