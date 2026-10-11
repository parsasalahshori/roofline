import { DateTime, Settings } from 'luxon';
import { describe, expect, test } from 'vitest';
import { GATE_RULES } from '@roofline/shared';
import { decide, type GateDecision, type GateRequest } from '../src/index.ts';

const CHICAGO = 'America/Chicago';

/** A wall-clock moment in Chicago, as the Date the gate receives. */
const chi = (iso: string): Date => DateTime.fromISO(iso, { zone: CHICAGO }).toJSDate();
const hours = (n: number) => n * 3_600_000;
const days = (n: number) => n * 86_400_000;

const MARKETING_BODY = 'Acme Roofing: spring roof check is open. Reply STOP to opt out.';
const INFO_BODY = 'Your crew arrives tomorrow at 9am.';
const PHONE = '+14025550123';

type Overrides = { [K in keyof GateRequest]?: Partial<GateRequest[K]> };

/** A request that sends: marketing, 10:00 in Chicago (June, CDT), Nebraska, attested consent, empty history. */
function baseline(over: Overrides = {}): GateRequest {
  return {
    now: chi('2026-06-10T10:00:00'),
    company: {
      name: 'Acme Roofing',
      timezone: CHICAGO,
      status: 'active',
      campaignStatus: 'approved',
      marketingCapPer7d: 2,
      ...over.company,
    },
    recipient: {
      phoneE164: PHONE,
      consent: 'attested',
      doNotContact: false,
      optedOut: false,
      timezone: null,
      state: 'NE',
      ...over.recipient,
    },
    message: {
      purpose: 'marketing',
      body: MARKETING_BODY,
      dedupeKey: 'spring-2026',
      replyToInboundAt: null,
      ...over.message,
    },
    history: { dedupeAlreadySent: false, marketingSentAt: [], ...over.history },
  };
}

/** The baseline, moved to `nowIso` (a Chicago wall-clock time). */
const at = (nowIso: string, over: Overrides = {}): GateRequest => ({ ...baseline(over), now: chi(nowIso) });

/** An informational reply-style request at `nowIso`, answering an inbound text at `replyIso`. */
const informational = (nowIso: string, replyIso: string | null, over: Overrides = {}): GateRequest =>
  at(nowIso, {
    ...over,
    message: { purpose: 'informational', body: INFO_BODY, replyToInboundAt: replyIso ? chi(replyIso) : null },
  });

function blocked(d: GateDecision) {
  if (d.action !== 'block') throw new Error(`expected block, got ${JSON.stringify(d)}`);
  return d;
}

function scheduled(d: GateDecision) {
  if (d.action !== 'schedule') throw new Error(`expected schedule, got ${JSON.stringify(d)}`);
  return d;
}

describe('the baseline', () => {
  test('sends', () => {
    expect(decide(baseline())).toEqual({ action: 'send' });
  });

  test('a trial company can send too', () => {
    expect(decide(baseline({ company: { status: 'trial' } }))).toEqual({ action: 'send' });
  });
});

describe('billing', () => {
  test.each(['trial_ended', 'past_due', 'canceled'] as const)('blocks a %s company', (status) => {
    expect(decide(baseline({ company: { status } }))).toEqual({
      action: 'block',
      rule: 'billing',
      reason: 'Texting is paused until billing is sorted out.',
    });
  });
});

describe('registration', () => {
  test.each(['none', 'pending', 'rejected'] as const)('blocks while the campaign is %s', (campaignStatus) => {
    expect(decide(baseline({ company: { campaignStatus } }))).toEqual({
      action: 'block',
      rule: 'registration',
      reason: 'Texting turns on after the phone carriers approve your registration.',
    });
  });
});

describe('contact', () => {
  test('blocks a customer with no mobile number', () => {
    expect(decide(baseline({ recipient: { phoneE164: null } }))).toEqual({
      action: 'block',
      rule: 'contact',
      reason: 'No mobile number on file.',
    });
  });

  test('blocks a do-not-contact customer', () => {
    expect(decide(baseline({ recipient: { doNotContact: true } }))).toEqual({
      action: 'block',
      rule: 'contact',
      reason: 'This customer asked not to be texted.',
    });
  });

  test('blocks a customer who replied STOP', () => {
    expect(decide(baseline({ recipient: { optedOut: true } }))).toEqual({
      action: 'block',
      rule: 'contact',
      reason: 'This customer asked not to be texted.',
    });
  });

  test('blocks a do-not-contact customer even for an informational message', () => {
    const req = informational('2026-06-10T10:00:00', null, { recipient: { doNotContact: true } });
    expect(decide(req)).toMatchObject({ action: 'block', rule: 'contact' });
  });
});

describe('consent', () => {
  const NO_CONSENT = { action: 'block', rule: 'consent', reason: 'No texting consent on file.' };

  test.each(['none', 'express', 'revoked'] as const)('blocks a marketing text when consent is %s', (consent) => {
    expect(decide(baseline({ recipient: { consent } }))).toEqual(NO_CONSENT);
  });

  test.each(['attested', 'written'] as const)('lets a marketing text through on %s consent', (consent) => {
    expect(decide(baseline({ recipient: { consent } }))).toEqual({ action: 'send' });
  });

  test.each(['none', 'revoked'] as const)('blocks an informational text when consent is %s', (consent) => {
    expect(decide(informational('2026-06-10T10:00:00', null, { recipient: { consent } }))).toEqual(NO_CONSENT);
  });

  test.each(['express', 'attested', 'written'] as const)(
    'lets an informational text through on %s consent',
    (consent) => {
      expect(decide(informational('2026-06-10T10:00:00', null, { recipient: { consent } }))).toEqual({
        action: 'send',
      });
    },
  );
});

describe('content', () => {
  const BAD_CONTENT = {
    action: 'block',
    rule: 'content',
    reason: 'Marketing texts must include your company name and how to opt out.',
  };

  test('blocks a marketing body that never names the company', () => {
    expect(decide(baseline({ message: { body: 'Spring roof check is open. Reply STOP to opt out.' } }))).toEqual(
      BAD_CONTENT,
    );
  });

  test('blocks a marketing body with no opt-out wording', () => {
    expect(decide(baseline({ message: { body: 'Acme Roofing: spring roof check is open.' } }))).toEqual(BAD_CONTENT);
  });

  test('blocks opt-out wording that is not the exact phrase', () => {
    expect(decide(baseline({ message: { body: 'Acme Roofing: spring check. Text STOP to opt out.' } }))).toEqual(
      BAD_CONTENT,
    );
  });

  test('matches the company name and the opt-out phrase without regard to case', () => {
    const body = 'ACME ROOFING: spring roof check is open. rEpLy StOp To OpT oUt.';
    expect(decide(baseline({ message: { body } }))).toEqual({ action: 'send' });
  });

  test('checks the rendered body: an unreplaced {company} token does not name the company', () => {
    const body = '{company}: spring roof check is open. Reply STOP to opt out.';
    expect(decide(baseline({ message: { body } }))).toEqual(BAD_CONTENT);
  });

  test('a company with a blank name cannot satisfy the check', () => {
    expect(decide(baseline({ company: { name: '  ' } }))).toEqual(BAD_CONTENT);
  });

  test('does not content-check informational messages', () => {
    expect(decide(informational('2026-06-10T10:00:00', null))).toEqual({ action: 'send' });
  });
});

describe('dedupe', () => {
  test('blocks a message already sent to this customer', () => {
    expect(decide(baseline({ history: { dedupeAlreadySent: true } }))).toEqual({
      action: 'block',
      rule: 'dedupe',
      reason: 'Already sent this message to this customer.',
    });
  });
});

describe('weekly frequency cap', () => {
  const TOO_MANY = {
    action: 'block',
    rule: 'frequency',
    reason: 'Already texted this customer the most allowed this week.',
  };
  const now = chi('2026-06-10T10:00:00');
  const ago = (ms: number) => new Date(now.getTime() - ms);
  const withSent = (marketingSentAt: Date[], over: Overrides = {}) =>
    baseline({ ...over, history: { dedupeAlreadySent: false, marketingSentAt } });

  test('blocks a marketing text once the 7-day cap is reached', () => {
    expect(decide(withSent([ago(days(1)), ago(days(3))]))).toEqual(TOO_MANY);
  });

  test('sends while the customer is one under the cap', () => {
    expect(decide(withSent([ago(days(3))]))).toEqual({ action: 'send' });
  });

  test('ignores sends older than 7 days, in any order', () => {
    expect(decide(withSent([ago(days(8)), ago(days(2)), ago(days(30))]))).toEqual({ action: 'send' });
  });

  test('counts a send made exactly 7 days ago, but not one a millisecond older', () => {
    expect(decide(withSent([ago(days(7)), ago(days(1))]))).toEqual(TOO_MANY);
    expect(decide(withSent([ago(days(7) + 1), ago(days(1))]))).toEqual({ action: 'send' });
  });

  test('uses the cap it is given', () => {
    expect(decide(withSent([ago(days(1))], { company: { marketingCapPer7d: 1 } }))).toEqual(TOO_MANY);
    expect(decide(withSent([], { company: { marketingCapPer7d: 0 } }))).toEqual(TOO_MANY);
  });

  test('does not apply to informational messages', () => {
    const req = informational('2026-06-10T10:00:00', null, {
      history: { marketingSentAt: [ago(days(1)), ago(days(3))] },
    });
    expect(decide(req)).toEqual({ action: 'send' });
  });
});

describe('rule order', () => {
  test('a request failing both consent and dedupe reports consent', () => {
    const req = baseline({ recipient: { consent: 'none' }, history: { dedupeAlreadySent: true } });
    expect(decide(req)).toMatchObject({ action: 'block', rule: 'consent' });
  });

  test('a request failing every blocking rule reports them in GATE_RULES order as each is fixed', () => {
    let req = baseline({
      company: { status: 'canceled', campaignStatus: 'none', marketingCapPer7d: 1 },
      recipient: { phoneE164: null, consent: 'none' },
      message: { body: 'no name, no opt out' },
      history: { dedupeAlreadySent: true, marketingSentAt: [new Date(baseline().now.getTime() - hours(2))] },
    });
    const fixes: Array<(r: GateRequest) => GateRequest> = [
      (r) => ({ ...r, company: { ...r.company, status: 'active' } }),
      (r) => ({ ...r, company: { ...r.company, campaignStatus: 'approved' } }),
      (r) => ({ ...r, recipient: { ...r.recipient, phoneE164: PHONE } }),
      (r) => ({ ...r, recipient: { ...r.recipient, consent: 'attested' } }),
      (r) => ({ ...r, message: { ...r.message, body: MARKETING_BODY } }),
      (r) => ({ ...r, history: { ...r.history, dedupeAlreadySent: false } }),
    ];
    const seen: string[] = [];
    for (const fix of fixes) {
      seen.push(blocked(decide(req)).rule);
      req = fix(req);
    }
    seen.push(blocked(decide(req)).rule);
    expect(seen).toEqual(GATE_RULES.slice(0, 7));
  });
});

describe('quiet hours', () => {
  test('marketing at 21:30 Chicago is scheduled for 08:00 Chicago the next day', () => {
    expect(decide(at('2026-06-10T21:30:00'))).toEqual({
      action: 'schedule',
      at: chi('2026-06-11T08:00:00'),
      rule: 'quiet_hours',
      reason: 'Will send at 8:00 AM their time (quiet hours).',
    });
  });

  test('marketing at 06:00 Chicago is scheduled for 08:00 the same day', () => {
    const d = scheduled(decide(at('2026-06-10T06:00:00')));
    expect(d.at).toEqual(chi('2026-06-10T08:00:00'));
    expect(d.rule).toBe('quiet_hours');
  });

  test('sends right at 08:00 and at 20:59, but not at 21:00', () => {
    expect(decide(at('2026-06-10T08:00:00'))).toEqual({ action: 'send' });
    expect(decide(at('2026-06-10T20:59:00'))).toEqual({ action: 'send' });
    expect(scheduled(decide(at('2026-06-10T21:00:00'))).at).toEqual(chi('2026-06-11T08:00:00'));
  });

  test("uses the recipient's own time zone and names the time in it", () => {
    const west = { recipient: { timezone: 'America/Los_Angeles', state: 'CA' } };
    // 21:30 in Chicago is 19:30 in Los Angeles: inside the window there, so it sends.
    expect(decide(at('2026-06-10T21:30:00', west))).toEqual({ action: 'send' });
    // 09:30 in Chicago is 07:30 in Los Angeles: held until 08:00 there, which is 10:00 in Chicago.
    const early = scheduled(decide(at('2026-06-10T09:30:00', west)));
    expect(early.at).toEqual(chi('2026-06-10T10:00:00'));
    expect(early.reason).toBe('Will send at 8:00 AM their time (quiet hours).');
  });

  test("falls back to the company's zone when the recipient has none", () => {
    const d = scheduled(decide(at('2026-06-10T21:30:00', { recipient: { timezone: null } })));
    expect(d.at).toEqual(chi('2026-06-11T08:00:00'));
  });

  test('falls back to the company zone when the recipient zone is not a real zone', () => {
    const d = scheduled(decide(at('2026-06-10T21:30:00', { recipient: { timezone: 'Not/AZone' } })));
    expect(d.at).toEqual(chi('2026-06-11T08:00:00'));
    const blank = scheduled(decide(at('2026-06-10T21:30:00', { recipient: { timezone: '' } })));
    expect(blank.at).toEqual(chi('2026-06-11T08:00:00'));
  });

  test('words the time the same whatever the server locale is', () => {
    const before = Settings.defaultLocale;
    Settings.defaultLocale = 'ja-JP';
    try {
      expect(decide(at('2026-06-10T21:30:00'))).toMatchObject({
        reason: 'Will send at 8:00 AM their time (quiet hours).',
      });
    } finally {
      Settings.defaultLocale = before;
    }
  });

  test('on the spring-forward day, 07:30 is held to 08:00 that morning', () => {
    expect(decide(at('2026-03-08T07:30:00'))).toEqual({
      action: 'schedule',
      at: chi('2026-03-08T08:00:00'),
      rule: 'quiet_hours',
      reason: 'Will send at 8:00 AM their time (quiet hours).',
    });
  });

  test('applies to an informational message that is not a reply', () => {
    const d = scheduled(decide(informational('2026-06-10T23:00:00', null)));
    expect(d).toMatchObject({ rule: 'quiet_hours', at: chi('2026-06-11T08:00:00') });
  });
});

describe('the reply exception', () => {
  const at23 = (replyIso: string | null) => informational('2026-06-10T23:00:00', replyIso);

  test('an informational reply to a text from 10 minutes ago sends at 23:00', () => {
    expect(decide(at23('2026-06-10T22:50:00'))).toEqual({ action: 'send' });
  });

  test('an inbound text from 20 minutes ago does not count: scheduled', () => {
    const d = scheduled(decide(at23('2026-06-10T22:40:00')));
    expect(d.at).toEqual(chi('2026-06-11T08:00:00'));
    expect(d.rule).toBe('quiet_hours');
  });

  test('exactly 15:00 counts, 15:01 does not', () => {
    expect(decide(at23('2026-06-10T22:45:00'))).toEqual({ action: 'send' });
    expect(decide(at23('2026-06-10T22:44:59'))).toMatchObject({ action: 'schedule' });
  });

  test('an inbound time in the future does not count', () => {
    expect(decide(at23('2026-06-10T23:05:00'))).toMatchObject({ action: 'schedule' });
  });

  test('a reply at exactly now counts', () => {
    expect(decide(at23('2026-06-10T23:00:00'))).toEqual({ action: 'send' });
  });

  test('a marketing text never gets the exception', () => {
    const req = at('2026-06-10T23:00:00', { message: { replyToInboundAt: chi('2026-06-10T22:55:00') } });
    expect(decide(req)).toMatchObject({ action: 'schedule', rule: 'quiet_hours' });
  });

  test('also lifts the earlier Florida cutoff for an informational reply', () => {
    const req = informational('2026-06-10T20:15:00', '2026-06-10T20:10:00', { recipient: { state: 'FL' } });
    expect(decide(req)).toEqual({ action: 'send' });
  });
});

describe('Florida, Oklahoma and Maryland', () => {
  test('marketing at 20:15 in FL is scheduled for 08:00 the next day', () => {
    const d = scheduled(decide(at('2026-06-10T20:15:00', { recipient: { state: 'FL' } })));
    expect(d.at).toEqual(chi('2026-06-11T08:00:00'));
    expect(d.rule).toBe('quiet_hours');
  });

  test('the same text at 20:15 in Nebraska sends', () => {
    expect(decide(at('2026-06-10T20:15:00', { recipient: { state: 'NE' } }))).toEqual({ action: 'send' });
  });

  test.each(['OK', 'MD', 'ok', ' md '])('%j gets the 20:00 cutoff too', (state) => {
    expect(decide(at('2026-06-10T20:15:00', { recipient: { state } }))).toMatchObject({ action: 'schedule' });
  });

  test('an unknown or missing state gets the standard 21:00 cutoff', () => {
    expect(decide(at('2026-06-10T20:15:00', { recipient: { state: null } }))).toEqual({ action: 'send' });
    expect(decide(at('2026-06-10T20:15:00', { recipient: { state: 'ZZ' } }))).toEqual({ action: 'send' });
  });
});

describe('the 3-per-24-hours limit in FL, OK and MD', () => {
  // The real settings cap is at most 2 a week, which blocks first (R6). These tests lift it to 5 so
  // the daily limit is what is under test; decide() is pure and takes whatever number it is given.
  const SENT = [chi('2026-06-09T09:00:00'), chi('2026-06-09T10:00:00'), chi('2026-06-09T11:00:00')];
  const flAt = (nowIso: string, marketingSentAt: Date[], over: Overrides = {}) =>
    at(nowIso, {
      recipient: { state: 'FL' },
      company: { marketingCapPer7d: 5 },
      history: { dedupeAlreadySent: false, marketingSentAt },
      ...over,
    });

  test('three sends in the last 24 hours (09:00, 10:00, 11:00) schedule the next one for 09:00 tomorrow', () => {
    expect(decide(flAt('2026-06-09T11:30:00', SENT))).toEqual({
      action: 'schedule',
      at: chi('2026-06-10T09:00:00'),
      rule: 'frequency',
      reason: 'Will send at 9:00 AM their time (daily limit).',
    });
  });

  test('takes the third-most-recent send whatever the order of the history', () => {
    const shuffled = [SENT[2], SENT[0], SENT[1]];
    expect(scheduled(decide(flAt('2026-06-09T11:30:00', shuffled))).at).toEqual(chi('2026-06-10T09:00:00'));
  });

  test('with four sends in the day, waits for the third-most-recent to age out', () => {
    const four = [chi('2026-06-09T08:30:00'), ...SENT];
    expect(scheduled(decide(flAt('2026-06-09T11:30:00', four))).at).toEqual(chi('2026-06-10T09:00:00'));
  });

  test('ignores sends older than 24 hours (and older than 7 days) when counting', () => {
    const old = [chi('2026-06-08T09:00:00'), chi('2026-05-01T09:00:00'), SENT[1], SENT[2]];
    expect(decide(flAt('2026-06-09T11:30:00', old))).toEqual({ action: 'send' });
  });

  test('the limit lifts at exactly 24 hours after the third-most-recent send', () => {
    expect(decide(flAt('2026-06-10T09:00:00', SENT))).toEqual({ action: 'send' });
    // One second earlier, the 09:00 send has not aged out yet.
    expect(scheduled(decide(flAt('2026-06-10T08:59:59', SENT))).at).toEqual(chi('2026-06-10T09:00:00'));
  });

  test('works for Oklahoma and Maryland', () => {
    for (const state of ['OK', 'md']) {
      const d = scheduled(decide(flAt('2026-06-09T11:30:00', SENT, { recipient: { state } })));
      expect(d.rule).toBe('frequency');
    }
  });

  test('if the lift falls in quiet hours, still reports the daily limit but waits for 08:00', () => {
    // The history is only data: sends at 20:30, 21:00 and 21:30 lift at 20:30 tomorrow, past the
    // 20:00 Florida cutoff, so the text goes out at 08:00 the day after.
    const late = [chi('2026-06-09T20:30:00'), chi('2026-06-09T21:00:00'), chi('2026-06-09T21:30:00')];
    expect(decide(flAt('2026-06-09T22:00:00', late))).toEqual({
      action: 'schedule',
      at: chi('2026-06-11T08:00:00'),
      rule: 'frequency',
      reason: 'Will send at 8:00 AM their time (daily limit).',
    });
  });

  test('is not applied to a state outside FL, OK and MD', () => {
    expect(decide(flAt('2026-06-09T11:30:00', SENT, { recipient: { state: 'NE' } }))).toEqual({ action: 'send' });
    expect(decide(flAt('2026-06-09T11:30:00', SENT, { recipient: { state: null } }))).toEqual({ action: 'send' });
  });

  test('is not applied to informational messages', () => {
    const req = flAt('2026-06-09T11:30:00', SENT, {
      message: { purpose: 'informational', body: INFO_BODY },
    });
    expect(decide(req)).toEqual({ action: 'send' });
  });

  test('with the real cap of 2 a week, the weekly block fires first', () => {
    const req = flAt('2026-06-09T11:30:00', SENT, { company: { marketingCapPer7d: 2 } });
    expect(decide(req)).toEqual({
      action: 'block',
      rule: 'frequency',
      reason: 'Already texted this customer the most allowed this week.',
    });
  });
});

describe('bad input fails closed', () => {
  test('an invalid "now" throws instead of sending', () => {
    expect(() => decide({ ...baseline(), now: new Date('nope') })).toThrow();
  });

  test('a company zone that is not a real zone throws instead of sending', () => {
    expect(() => decide(baseline({ company: { timezone: 'Not/AZone' } }))).toThrow(/time zone/i);
  });
});
