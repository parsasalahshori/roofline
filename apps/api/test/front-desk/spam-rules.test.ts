import { describe, expect, test } from 'vitest';
import { shouldTextBack } from '@roofline/shared';
import { SPAM_REASONS, STIR_CALLS_PER_HOUR_LIMIT, screenCall } from '../../src/providers/call-screen.ts';

describe('screenCall rule table', () => {
  test('the STIR limit is three calls an hour', () => {
    expect(STIR_CALLS_PER_HOUR_LIMIT).toBe(3);
  });

  test.each([
    // [stirVerstat, blocked, callsLastHour, knownCustomer, expected action, reason]
    ['TN-Validation-Failed', false, 4, false, 'reject', 'stir_failed_repeat'],
    ['TN-Validation-Failed', false, 3, false, 'allow', null],
    ['No-TN-Validation', false, 5, false, 'reject', 'stir_failed_repeat'],
    ['TN-Validation-Passed-A', false, 9, false, 'allow', null],
    [null, false, 9, false, 'allow', null],
    [null, true, 1, false, 'reject', 'blocked_number'],
    ['TN-Validation-Failed', false, 9, true, 'allow', null],
    [null, true, 1, true, 'reject', 'blocked_number'],
  ] as const)(
    'stir=%s blocked=%s calls=%i known=%s -> %s %s',
    (stirVerstat, blocked, callsLastHour, knownCustomer, action, reason) => {
      const out = screenCall({ from: '+15555550100', stirVerstat, blocked, callsLastHour, knownCustomer });
      expect(out).toEqual({ action, reason });
    },
  );

  test('the suffixed failed verstat counts as failed', () => {
    const out = screenCall({
      from: '+15555550100',
      stirVerstat: 'TN-Validation-Failed-B',
      blocked: false,
      callsLastHour: 4,
      knownCustomer: false,
    });
    expect(out).toEqual({ action: 'reject', reason: SPAM_REASONS.stir });
  });

  test('the reason constants match the stored strings', () => {
    expect(SPAM_REASONS).toEqual({ blocked: 'blocked_number', stir: 'stir_failed_repeat' });
  });
});

describe('text-back never goes to a spam call', () => {
  test('a fully eligible call is texted back unless it is marked spam', () => {
    const eligible = {
      callerTurns: 3,
      secondsInCall: 120,
      status: 'failed' as const,
      lineType: 'mobile' as const,
      spam: false,
      textedBackLast24h: false,
      enabled: true,
    };
    expect(shouldTextBack(eligible)).toBe(true);
    expect(shouldTextBack({ ...eligible, spam: true })).toBe(false);
  });
});
