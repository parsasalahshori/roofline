import { describe, expect, test } from 'vitest';
import {
  CLAIM_STATUS_FLOW,
  CLAIM_STATUSES,
  CLAIMS_MAX_PER_CLAIM,
  CLAIMS_SPACING_DAYS,
  FOLLOW_UP_SPACING_DAYS,
  REPLY_STOP_DAYS,
  STORM_QUIET_DAYS,
  canMoveClaim,
  claimNudgeDue,
  followUpAllowed,
  leadFollowUpDue,
  proposalFollowUpDue,
  weatherRisk,
} from '../src/more-agents.ts';
import { DEFAULT_WORK_HOURS, type WorkHours } from '../src/availability.ts';
import type { FollowUpCheck, FollowUpKind, FollowUpLogEntry, HourlyForecast } from '../src/more-agents.ts';

const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;
const NOW = new Date('2026-10-12T15:00:00Z');

/** The instant `ms` before NOW. */
function ago(ms: number): Date {
  return new Date(NOW.getTime() - ms);
}
const daysAgo = (days: number): Date => ago(days * DAY);
const minutesAgo = (minutes: number): Date => ago(minutes * MIN);

/** A follow-up log row for the default customer c1 and job j1 unless overridden. */
function entry(kind: FollowUpKind, at: Date, over: Partial<FollowUpLogEntry> = {}): FollowUpLogEntry {
  return { customerId: 'c1', jobId: 'j1', kind, n: 1, at, ...over };
}

function check(over: Partial<FollowUpCheck> = {}): FollowUpCheck {
  return {
    log: [],
    kind: 'proposal',
    customerId: 'c1',
    jobId: 'j1',
    now: NOW,
    lastInboundAt: null,
    lastStormTextAt: null,
    ...over,
  };
}

describe('follow-up limit constants', () => {
  test('match the brief values', () => {
    expect(FOLLOW_UP_SPACING_DAYS).toBe(3);
    expect(STORM_QUIET_DAYS).toBe(3);
    expect(REPLY_STOP_DAYS).toBe(3);
    expect(CLAIMS_SPACING_DAYS).toBe(4);
    expect(CLAIMS_MAX_PER_CLAIM).toBe(4);
  });
});

describe('followUpAllowed', () => {
  test('replied: exactly 3 days after an inbound text is allowed, 1 minute less is blocked', () => {
    expect(followUpAllowed(check({ lastInboundAt: daysAgo(3) }))).toEqual({ allowed: true });
    expect(followUpAllowed(check({ lastInboundAt: ago(3 * DAY - MIN) }))).toEqual({
      allowed: false,
      reason: 'replied',
    });
  });

  test('storm_text: exactly 3 days after a storm text is allowed, 1 minute less is blocked', () => {
    expect(followUpAllowed(check({ lastStormTextAt: daysAgo(3) }))).toEqual({ allowed: true });
    expect(followUpAllowed(check({ lastStormTextAt: ago(3 * DAY - MIN) }))).toEqual({
      allowed: false,
      reason: 'storm_text',
    });
  });

  test('spacing: a proposal entry exactly 3 days ago is allowed, 1 minute less is blocked', () => {
    expect(followUpAllowed(check({ log: [entry('proposal', daysAgo(3))] }))).toEqual({ allowed: true });
    expect(followUpAllowed(check({ log: [entry('proposal', ago(3 * DAY - MIN))] }))).toEqual({
      allowed: false,
      reason: 'spacing',
    });
  });

  test('spacing is cross-kind: a lead text 2 days ago blocks proposal and review', () => {
    const log = [entry('lead', daysAgo(2))];
    expect(followUpAllowed(check({ kind: 'proposal', log }))).toEqual({ allowed: false, reason: 'spacing' });
    expect(followUpAllowed(check({ kind: 'review', log }))).toEqual({ allowed: false, reason: 'spacing' });
  });

  test('entries for another customer do not block', () => {
    const log = [entry('proposal', minutesAgo(60), { customerId: 'c2' })];
    expect(followUpAllowed(check({ log }))).toEqual({ allowed: true });
  });

  test('check order: replied beats spacing', () => {
    expect(
      followUpAllowed(check({ lastInboundAt: NOW, log: [entry('proposal', NOW)] })),
    ).toEqual({ allowed: false, reason: 'replied' });
  });

  test('check order: replied beats storm_text', () => {
    expect(followUpAllowed(check({ lastInboundAt: NOW, lastStormTextAt: NOW }))).toEqual({
      allowed: false,
      reason: 'replied',
    });
  });

  test('check order: storm_text beats spacing', () => {
    expect(
      followUpAllowed(check({ lastStormTextAt: NOW, log: [entry('proposal', NOW)] })),
    ).toEqual({ allowed: false, reason: 'storm_text' });
  });

  test('claims_spacing: a claims entry 4 days ago is allowed, 1 minute less is blocked', () => {
    expect(followUpAllowed(check({ kind: 'claims', log: [entry('claims', daysAgo(4))] }))).toEqual({
      allowed: true,
    });
    expect(
      followUpAllowed(check({ kind: 'claims', log: [entry('claims', ago(4 * DAY - MIN))] })),
    ).toEqual({ allowed: false, reason: 'claims_spacing' });
  });

  test('Decision 8 across agents: a claims text blocks a proposal text for 3 days, and the other way round', () => {
    expect(followUpAllowed(check({ kind: 'proposal', log: [entry('claims', minutesAgo(60))] }))).toEqual({
      allowed: false,
      reason: 'spacing',
    });
    expect(followUpAllowed(check({ kind: 'claims', log: [entry('proposal', minutesAgo(60))] }))).toEqual({
      allowed: false,
      reason: 'spacing',
    });
    expect(followUpAllowed(check({ kind: 'lead', log: [entry('claims', daysAgo(3))] }))).toEqual({ allowed: true });
    expect(followUpAllowed(check({ kind: 'claims', log: [entry('review', daysAgo(3))] }))).toEqual({ allowed: true });
  });

  test('claims_max: 4 claims entries on the same job block, 3 allow', () => {
    const four = [5, 9, 13, 17].map((d) => entry('claims', daysAgo(d)));
    expect(followUpAllowed(check({ kind: 'claims', jobId: 'j1', log: four }))).toEqual({
      allowed: false,
      reason: 'claims_max',
    });
    expect(followUpAllowed(check({ kind: 'claims', jobId: 'j1', log: four.slice(1) }))).toEqual({
      allowed: true,
    });
  });

  test('claims_max counts per job: 4 entries on another job do not block', () => {
    const four = [5, 9, 13, 17].map((d) => entry('claims', daysAgo(d), { jobId: 'j2' }));
    expect(followUpAllowed(check({ kind: 'claims', jobId: 'j1', log: four }))).toEqual({ allowed: true });
  });

  test('claims_spacing beats claims_max when both apply', () => {
    const log = [
      entry('claims', ago(3.5 * DAY)),
      entry('claims', daysAgo(5)),
      entry('claims', daysAgo(9)),
      entry('claims', daysAgo(13)),
    ];
    expect(followUpAllowed(check({ kind: 'claims', log }))).toEqual({
      allowed: false,
      reason: 'claims_spacing',
    });
  });

  test('reminder and no_show are always allowed, even with fresh contact and log', () => {
    const busy = {
      lastInboundAt: NOW,
      lastStormTextAt: NOW,
      log: [entry('proposal', NOW), entry('claims', NOW), entry('reminder', NOW)],
    };
    for (const kind of ['reminder', 'no_show'] as const) {
      expect(followUpAllowed(check({ ...busy, kind }))).toEqual({ allowed: true });
    }
  });
});

describe('proposalFollowUpDue', () => {
  const DAYS = [3, 4] as const;
  const proposal = (over: Partial<Parameters<typeof proposalFollowUpDue>[0]> = {}) => ({
    sentAt: daysAgo(10),
    lastViewedAt: null,
    signedAt: null,
    textsSent: 0,
    lastTextAt: null,
    callRepAt: null,
    ...over,
  });

  test('signed proposals are never due', () => {
    expect(proposalFollowUpDue(proposal({ signedAt: daysAgo(1) }), NOW, [...DAYS])).toBeNull();
  });

  test('first text: due when sent exactly 3 days ago, not at 3 days minus 1 minute', () => {
    expect(proposalFollowUpDue(proposal({ sentAt: daysAgo(3) }), NOW, [...DAYS])).toBe('text');
    expect(proposalFollowUpDue(proposal({ sentAt: ago(3 * DAY - MIN) }), NOW, [...DAYS])).toBeNull();
  });

  test('first text: a view exactly 2 days ago makes it due, 1 minute less does not', () => {
    expect(
      proposalFollowUpDue(proposal({ sentAt: daysAgo(1), lastViewedAt: daysAgo(2) }), NOW, [...DAYS]),
    ).toBe('text');
    expect(
      proposalFollowUpDue(proposal({ sentAt: daysAgo(1), lastViewedAt: ago(2 * DAY - MIN) }), NOW, [...DAYS]),
    ).toBeNull();
  });

  test('second text: 1 text sent, due at exactly 4 days after the last text', () => {
    expect(proposalFollowUpDue(proposal({ textsSent: 1, lastTextAt: daysAgo(4) }), NOW, [...DAYS])).toBe('text');
    expect(
      proposalFollowUpDue(proposal({ textsSent: 1, lastTextAt: ago(4 * DAY - MIN) }), NOW, [...DAYS]),
    ).toBeNull();
  });

  test('call_rep: 2 texts sent and 4 days since the last text, 1 minute less is null', () => {
    expect(proposalFollowUpDue(proposal({ textsSent: 2, lastTextAt: daysAgo(4) }), NOW, [...DAYS])).toBe(
      'call_rep',
    );
    expect(
      proposalFollowUpDue(proposal({ textsSent: 2, lastTextAt: ago(4 * DAY - MIN) }), NOW, [...DAYS]),
    ).toBeNull();
  });

  test('call_rep is asked once: with callRepAt recorded, nothing more is due', () => {
    expect(
      proposalFollowUpDue(proposal({ textsSent: 2, lastTextAt: daysAgo(9), callRepAt: daysAgo(5) }), NOW, [...DAYS]),
    ).toBeNull();
  });

  test('custom days [1, 2] are used', () => {
    expect(proposalFollowUpDue(proposal({ sentAt: daysAgo(1) }), NOW, [1, 2])).toBe('text');
    expect(proposalFollowUpDue(proposal({ textsSent: 1, lastTextAt: daysAgo(2) }), NOW, [1, 2])).toBe('text');
  });
});

describe('leadFollowUpDue', () => {
  const lead = (over: Partial<Parameters<typeof leadFollowUpDue>[0]> = {}) => ({
    createdAt: daysAgo(2),
    hasAppointment: false,
    textsSent: 0,
    lost: false,
    ...over,
  });

  test('due at exactly 2 days after creation, not at 2 days minus 1 minute', () => {
    expect(leadFollowUpDue(lead(), NOW, 2)).toBe(true);
    expect(leadFollowUpDue(lead({ createdAt: ago(2 * DAY - MIN) }), NOW, 2)).toBe(false);
  });

  test('not due when lost, when an appointment exists, or after a text was sent', () => {
    expect(leadFollowUpDue(lead({ lost: true }), NOW, 2)).toBe(false);
    expect(leadFollowUpDue(lead({ hasAppointment: true }), NOW, 2)).toBe(false);
    expect(leadFollowUpDue(lead({ textsSent: 1 }), NOW, 2)).toBe(false);
  });
});

describe('claimNudgeDue', () => {
  const DAYS = [3, 5, 7] as const;
  const claim = (over: Partial<Parameters<typeof claimNudgeDue>[0]> = {}) => ({
    status: 'not_filed' as const,
    inspectedAt: null,
    statusChangedAt: daysAgo(30),
    adjusterAt: null,
    ...over,
  });

  test('not_filed: ask_filed at exactly 3 days after inspection', () => {
    expect(claimNudgeDue(claim({ inspectedAt: daysAgo(3) }), NOW, [...DAYS])).toBe('ask_filed');
    expect(claimNudgeDue(claim({ inspectedAt: ago(3 * DAY - MIN) }), NOW, [...DAYS])).toBeNull();
    expect(claimNudgeDue(claim({ inspectedAt: null }), NOW, [...DAYS])).toBeNull();
  });

  test('filed: ask_adjuster_date at exactly 5 days in status, only when no adjuster date', () => {
    expect(claimNudgeDue(claim({ status: 'filed', statusChangedAt: daysAgo(5) }), NOW, [...DAYS])).toBe(
      'ask_adjuster_date',
    );
    expect(
      claimNudgeDue(claim({ status: 'filed', statusChangedAt: ago(5 * DAY - MIN) }), NOW, [...DAYS]),
    ).toBeNull();
    expect(
      claimNudgeDue(
        claim({ status: 'filed', statusChangedAt: daysAgo(5), adjusterAt: daysAgo(10) }),
        NOW,
        [...DAYS],
      ),
    ).toBeNull();
  });

  test('adjuster_scheduled: ask_adjuster_outcome at exactly 7 days after the adjuster date', () => {
    expect(
      claimNudgeDue(claim({ status: 'adjuster_scheduled', adjusterAt: daysAgo(7) }), NOW, [...DAYS]),
    ).toBe('ask_adjuster_outcome');
    expect(
      claimNudgeDue(claim({ status: 'adjuster_scheduled', adjusterAt: ago(7 * DAY - MIN) }), NOW, [...DAYS]),
    ).toBeNull();
    expect(claimNudgeDue(claim({ status: 'adjuster_scheduled', adjusterAt: null }), NOW, [...DAYS])).toBeNull();
  });

  test('other statuses never nudge, even with old dates', () => {
    const old = {
      inspectedAt: daysAgo(30),
      statusChangedAt: daysAgo(30),
      adjusterAt: daysAgo(30),
    };
    for (const status of [
      'inspected',
      'approved',
      'partly_approved',
      'denied',
      'supplement_requested',
      'closed',
    ] as const) {
      expect(claimNudgeDue(claim({ ...old, status }), NOW, [...DAYS])).toBeNull();
    }
  });
});

describe('weatherRisk', () => {
  const CHICAGO = 'America/Chicago';
  /** 07:00-18:00 every day, so the hour-boundary tests below do not depend on the weekday. */
  const WORK: WorkHours = Object.fromEntries(
    (['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const).map((d) => [d, [['07:00', '18:00']]]),
  ) as WorkHours;
  const TH = { rainPct: 60, gustMph: 25 };

  /**
   * Forecast point at Chicago local hour `h` on 2026-10-12 (CDT, UTC-5, so local hour h is UTC hour h + 5).
   * Hours 24 and up roll into 2026-10-13 local time.
   */
  function at(h: number, precipPct = 0, gustMph: number | null = null): HourlyForecast {
    return { at: new Date(Date.UTC(2026, 9, 12, h + 5)).toISOString(), precipPct, gustMph };
  }

  /** A quiet 30-hour forecast covering local midnight to local 05:59 the next day. */
  const quiet = (): HourlyForecast[] => Array.from({ length: 30 }, (_, h) => at(h));

  test('local midnight in Chicago is 05:00Z on 2026-10-12', () => {
    expect(at(0).at).toBe('2026-10-12T05:00:00.000Z');
    expect(at(2).at).toBe('2026-10-12T07:00:00.000Z');
  });

  test('out-of-hours spikes at local 02:00, 06:00 and 18:00 do not count', () => {
    const spikes = [at(2, 100, 60), at(6, 100, 60), at(18, 100, 60)];
    expect(weatherRisk(spikes, WORK, TH, CHICAGO)).toEqual({
      risky: false,
      reasons: [],
      worstPrecipPct: 0,
      worstGustMph: null,
    });
  });

  test('in-hours spikes at local 07:00 and 17:00 count (18:00 end is exclusive)', () => {
    expect(weatherRisk([at(7, 70)], WORK, TH, CHICAGO).reasons).toEqual(['rain']);
    expect(weatherRisk([at(17, 70)], WORK, TH, CHICAGO).reasons).toEqual(['rain']);
    expect(weatherRisk([at(7, 0, 30)], WORK, TH, CHICAGO).reasons).toEqual(['wind']);
    expect(weatherRisk([at(17, 0, 30)], WORK, TH, CHICAGO).reasons).toEqual(['wind']);
  });

  test('rain threshold is inclusive: 60 is rain, 59 is not', () => {
    expect(weatherRisk([at(10, 60)], WORK, TH, CHICAGO)).toMatchObject({ risky: true, reasons: ['rain'] });
    expect(weatherRisk([at(10, 59)], WORK, TH, CHICAGO)).toMatchObject({ risky: false, reasons: [] });
  });

  test('wind threshold is inclusive: gust 25 is wind, 24 is not', () => {
    expect(weatherRisk([at(10, 0, 25)], WORK, TH, CHICAGO)).toMatchObject({ risky: true, reasons: ['wind'] });
    expect(weatherRisk([at(10, 0, 24)], WORK, TH, CHICAGO)).toMatchObject({ risky: false, reasons: [] });
  });

  test('a null gust is never wind risk', () => {
    expect(weatherRisk([at(10, 0, null)], WORK, TH, CHICAGO)).toEqual({
      risky: false,
      reasons: [],
      worstPrecipPct: 0,
      worstGustMph: null,
    });
  });

  test('both reasons are reported in order rain, wind', () => {
    expect(weatherRisk([at(10, 70, 30)], WORK, TH, CHICAGO).reasons).toEqual(['rain', 'wind']);
    expect(weatherRisk([at(9, 0, 30), at(11, 80, null)], WORK, TH, CHICAGO).reasons).toEqual(['rain', 'wind']);
  });

  test('several rainy hours give one rain reason', () => {
    expect(weatherRisk([at(8, 70), at(9, 80), at(10, 90)], WORK, TH, CHICAGO).reasons).toEqual(['rain']);
  });

  test('a forecast spanning midnight: only work hours count across the whole list', () => {
    const forecast = quiet();
    forecast[9] = at(9, 65, 10);
    forecast.push(at(25, 99, 99), at(26, 99, 99));
    expect(weatherRisk(forecast, WORK, TH, CHICAGO)).toEqual({
      risky: true,
      reasons: ['rain'],
      worstPrecipPct: 65,
      worstGustMph: 10,
    });
  });

  test('empty forecast is not risky', () => {
    expect(weatherRisk([], WORK, TH, CHICAGO)).toEqual({
      risky: false,
      reasons: [],
      worstPrecipPct: 0,
      worstGustMph: null,
    });
  });

  test('worst values reflect counted hours only', () => {
    expect(weatherRisk([at(10, 40, 20), at(3, 95, 40)], WORK, TH, CHICAGO)).toEqual({
      risky: false,
      reasons: [],
      worstPrecipPct: 40,
      worstGustMph: 20,
    });
    expect(weatherRisk([at(10, 40, 20), at(12, 70, 30)], WORK, TH, CHICAGO)).toEqual({
      risky: true,
      reasons: ['rain', 'wind'],
      worstPrecipPct: 70,
      worstGustMph: 30,
    });
  });

  test('the zone is used: 22:00Z is local 17:00 in Chicago (in hours) but 22:00 in UTC (out of hours)', () => {
    const forecast: HourlyForecast[] = [{ at: '2026-10-12T22:00:00Z', precipPct: 70, gustMph: null }];
    expect(weatherRisk(forecast, WORK, TH, CHICAGO)).toMatchObject({ risky: true, reasons: ['rain'] });
    expect(weatherRisk(forecast, WORK, TH, 'UTC')).toMatchObject({ risky: false, reasons: [] });
  });
});

describe('weatherRisk with the company work hours (C1 WorkHours)', () => {
  const CHICAGO = 'America/Chicago';
  const TH = { rainPct: 60, gustMph: 25 };
  /** Chicago local `h:00` on 2026-10-`day` (CDT, UTC-5). 2026-10-17 is a Saturday, 2026-10-18 a Sunday. */
  const local = (day: number, h: number, precipPct = 80): HourlyForecast => ({
    at: new Date(Date.UTC(2026, 9, day, h + 5)).toISOString(),
    precipPct,
    gustMph: null,
  });

  test('Saturday morning counts, Saturday afternoon and Sunday do not (DEFAULT_WORK_HOURS)', () => {
    expect(weatherRisk([local(17, 10)], DEFAULT_WORK_HOURS, TH, CHICAGO).risky).toBe(true);
    expect(weatherRisk([local(17, 14)], DEFAULT_WORK_HOURS, TH, CHICAGO).risky).toBe(false);
    expect(weatherRisk([local(18, 10)], DEFAULT_WORK_HOURS, TH, CHICAGO).risky).toBe(false);
  });

  test('a 07:30 start counts the 07:00 hour; an 18:00 end does not count the 18:00 hour', () => {
    const hours: WorkHours = { ...DEFAULT_WORK_HOURS, mon: [['07:30', '18:00']] };
    expect(weatherRisk([local(12, 7)], hours, TH, CHICAGO).risky).toBe(true);
    expect(weatherRisk([local(12, 6)], hours, TH, CHICAGO).risky).toBe(false);
    expect(weatherRisk([local(12, 18)], hours, TH, CHICAGO).risky).toBe(false);
  });
});

describe('claim status flow', () => {
  test('every status has a flow entry, and closed has none', () => {
    for (const status of CLAIM_STATUSES) {
      expect(CLAIM_STATUS_FLOW).toHaveProperty(status);
    }
    expect(CLAIM_STATUS_FLOW.closed).toEqual([]);
  });

  test('every target is a valid status', () => {
    for (const status of CLAIM_STATUSES) {
      for (const to of CLAIM_STATUS_FLOW[status]) {
        expect(CLAIM_STATUSES).toContain(to);
      }
    }
  });

  test('exact flow lists per the brief', () => {
    expect(CLAIM_STATUS_FLOW).toEqual({
      not_filed: ['filed', 'closed'],
      filed: ['adjuster_scheduled', 'approved', 'partly_approved', 'denied', 'closed'],
      adjuster_scheduled: ['inspected', 'approved', 'partly_approved', 'denied', 'closed'],
      inspected: ['approved', 'partly_approved', 'denied', 'supplement_requested', 'closed'],
      approved: ['supplement_requested', 'closed'],
      partly_approved: ['supplement_requested', 'approved', 'closed'],
      denied: ['supplement_requested', 'closed'],
      supplement_requested: ['approved', 'partly_approved', 'denied', 'closed'],
      closed: [],
    });
  });

  test('canMoveClaim follows the flow', () => {
    expect(canMoveClaim('filed', 'denied')).toBe(true);
    expect(canMoveClaim('approved', 'denied')).toBe(false);
    expect(canMoveClaim('closed', 'filed')).toBe(false);
    expect(canMoveClaim('closed', 'approved')).toBe(false);
  });

  test('canMoveClaim is false for the same status', () => {
    for (const status of CLAIM_STATUSES) {
      expect(canMoveClaim(status, status)).toBe(false);
    }
  });
});
