import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, test } from 'vitest';
import { calls, companies, conversations, conversationTurns, messages } from '@roofline/db';
import type { FrontDeskWeekStats } from '@roofline/shared';
import { Actors, inCompany } from '../crm-helpers.ts';
import { makeTestApp, type TestApp } from '../helpers.ts';

/*
 * D1 Task 18, weekly stats: GET /api/front-desk/stats?week=. Database-backed: CI runs it.
 * The company is in Central time (CDT, UTC-5, in October), so the week of Monday 2026-10-12 runs
 * from 2026-10-12T05:00Z to 2026-10-19T05:00Z.
 */

const URL = '/api/front-desk/stats';
const WEEK = '2026-10-12';
const TEST_CALLER = '+14025550100';
const NUMBER = '+14025550200';
const CALLER = '+14025550777';
const BAD_WEEK = 'Use a week start like 2026-10-12.';
const NOT_ALLOWED = "Your role can't do that. Ask the owner.";

let t: TestApp;
let who: Actors;
let sid = 0;

const idA = () => t.seed.a.companyId;
const at = (iso: string) => new Date(iso);
/** Inside the week, in UTC: Wednesday 2026-10-14 at the given hour. */
const wed = (hour: number, minute = 0) => new Date(Date.UTC(2026, 9, 14, hour, minute));

beforeEach(async () => {
  t = await makeTestApp({ TWILIO_TEST_CALLER_NUMBER: TEST_CALLER });
  who = new Actors(t);
  t.clock.set(wed(15));
});

async function get(week?: string, as: 'owner' | 'office' | 'rep' = 'owner', company: 'a' | 'b' = 'a') {
  const agent = await who.as(as, company);
  return agent.get(week === undefined ? URL : `${URL}?week=${week}`);
}

async function conv(o: { company?: 'a' | 'b'; channel?: 'voice' | 'sms'; outcome?: 'booked' | 'spam' | 'message' | null; createdAt?: Date } = {}) {
  const companyId = o.company === 'b' ? t.seed.b.companyId : idA();
  return inCompany(t, companyId, async (tx) => {
    const [row] = await tx
      .insert(conversations)
      .values({
        companyId,
        channel: o.channel ?? 'voice',
        phoneE164: CALLER,
        companyNumberE164: NUMBER,
        outcome: o.outcome ?? null,
        createdAt: o.createdAt ?? wed(14),
      })
      .returning({ id: conversations.id });
    return row!.id;
  });
}

async function call(
  o: {
    company?: 'a' | 'b';
    conversationId?: string | null;
    from?: string;
    status?: 'ended' | 'ai' | 'ringing' | 'rejected' | 'failed' | 'transferred';
    startedAt?: Date;
    aiSeconds?: number;
    transferResult?: 'answered' | 'no_answer' | 'none';
    spamReason?: string | null;
  } = {},
) {
  const companyId = o.company === 'b' ? t.seed.b.companyId : idA();
  await inCompany(t, companyId, (tx) =>
    tx.insert(calls).values({
      companyId,
      conversationId: o.conversationId ?? null,
      callSid: `CA${String(++sid).padStart(32, '0')}`,
      fromE164: o.from ?? CALLER,
      toE164: NUMBER,
      status: o.status ?? 'ended',
      startedAt: o.startedAt ?? wed(14),
      aiSeconds: o.aiSeconds ?? 0,
      transferResult: o.transferResult ?? 'none',
      spamReason: o.spamReason ?? null,
    }),
  );
}

async function text(conversationId: string, direction: 'in' | 'out', createdAt: Date, company: 'a' | 'b' = 'a') {
  const companyId = company === 'b' ? t.seed.b.companyId : idA();
  await inCompany(t, companyId, (tx) =>
    tx.insert(messages).values({
      companyId,
      conversationId,
      channel: 'sms',
      direction,
      body: 'hello',
      status: direction === 'in' ? 'received' : 'sent',
      createdAt,
    }),
  );
}

async function turn(conversationId: string, position: number, guardHits: string[], when: Date = wed(14)) {
  await inCompany(t, idA(), (tx) =>
    tx.insert(conversationTurns).values({ companyId: idA(), conversationId, position, speaker: 'assistant', text: 'ok', at: when, guardHits }),
  );
}

describe('GET /api/front-desk/stats', () => {
  test('stats from seeded calls, conversations and turns (exact numbers)', async () => {
    const booked = await conv({ outcome: 'booked' });
    await call({ conversationId: booked, aiSeconds: 90 });
    await call({ status: 'transferred', transferResult: 'answered', aiSeconds: 30 });
    await call({ status: 'rejected' });
    await call({ status: 'failed' });
    await call({ spamReason: 'robocall' });
    await conv({ outcome: 'spam', channel: 'sms' });
    const sms = await conv({ channel: 'sms' });
    await text(sms, 'in', wed(16));
    await turn(booked, 1, ['no_price_quote']);
    await turn(booked, 2, []);

    const res = await get(WEEK);
    expect(res.status).toBe(200);
    const body = res.body as FrontDeskWeekStats;
    expect(body).toMatchObject({
      weekStart: WEEK,
      answered: 2,
      booked: 1,
      transferred: 1,
      messages: 1,
      spam: 2,
      guardBlocks: 1,
      aiMinutesUsed: 2,
    });
  });

  test('excludes forwarding-test calls', async () => {
    await call({ from: TEST_CALLER, status: 'ended', aiSeconds: 600 });
    await call({ from: TEST_CALLER, status: 'ringing' });
    await call({ aiSeconds: 60 });
    const body = (await get(WEEK)).body as FrontDeskWeekStats;
    expect(body.answered).toBe(1);
    expect(body.aiMinutesUsed).toBe(1);
  });

  test('week boundaries respect the company time zone', async () => {
    // Sunday 23:30 Central is Monday 04:30Z: still last week. Monday 00:30 Central is 05:30Z: this week.
    await call({ startedAt: at('2026-10-12T04:30:00Z') });
    await call({ startedAt: at('2026-10-12T05:30:00Z') });
    await call({ startedAt: at('2026-10-19T04:30:00Z') }); // Sunday night: still this week
    await call({ startedAt: at('2026-10-19T05:30:00Z') }); // next Monday
    expect(((await get(WEEK)).body as FrontDeskWeekStats).answered).toBe(2);
    expect(((await get('2026-10-19')).body as FrontDeskWeekStats).answered).toBe(1);
    // A zone change moves the boundary.
    await t.deps.pools.system.update(companies).set({ timezone: 'UTC' }).where(eq(companies.id, idA()));
    expect(((await get(WEEK)).body as FrontDeskWeekStats).answered).toBe(2);
  });

  test('a day that is not a Monday snaps back, and no week means the current one', async () => {
    await call();
    expect((await get('2026-10-15')).body).toMatchObject({ weekStart: WEEK, answered: 1 });
    expect((await get()).body).toMatchObject({ weekStart: WEEK, answered: 1 });
  });

  test('p50 first reply ms is the median and null with no replies', async () => {
    expect(((await get(WEEK)).body as FrontDeskWeekStats).firstReplyMsP50).toBeNull();
    const lone = await conv({ channel: 'sms' });
    await text(lone, 'in', wed(14, 0)); // never answered
    expect(((await get(WEEK)).body as FrontDeskWeekStats).firstReplyMsP50).toBeNull();
    for (const seconds of [10, 20, 90]) {
      const id = await conv({ channel: 'sms' });
      const first = wed(15, 0);
      await text(id, 'in', first);
      await text(id, 'out', new Date(first.getTime() + seconds * 1000));
      await text(id, 'out', new Date(first.getTime() + seconds * 1000 + 60_000)); // a later reply does not count
    }
    const body = (await get(WEEK)).body as FrontDeskWeekStats;
    expect(body.firstReplyMsP50).toBe(20_000);
    expect(body.messages).toBe(4);
  });

  test('guard blocks counted from turns', async () => {
    const id = await conv();
    await turn(id, 1, ['a', 'b']);
    await turn(id, 2, ['c']);
    await turn(id, 3, []);
    await turn(id, 4, ['d'], at('2026-10-01T12:00:00Z')); // another week
    expect(((await get(WEEK)).body as FrontDeskWeekStats).guardBlocks).toBe(2);
  });

  test('aiMinutes used vs included', async () => {
    await call({ aiSeconds: 100 });
    await call({ aiSeconds: 100 });
    const before = (await get(WEEK)).body as FrontDeskWeekStats;
    expect(before.aiMinutesUsed).toBe(3.3);
    await t.deps.pools.system.update(companies).set({ planKey: 'starter' }).where(eq(companies.id, idA()));
    const after = (await get(WEEK)).body as FrontDeskWeekStats;
    expect(after.aiMinutesIncluded).toBe(300);
    await t.deps.pools.system.update(companies).set({ planKey: null }).where(eq(companies.id, idA()));
    expect(((await get(WEEK)).body as FrontDeskWeekStats).aiMinutesIncluded).toBeNull();
  });

  test('office can read; bad week 400', async () => {
    expect((await get(WEEK, 'office')).status).toBe(200);
    for (const bad of ['yesterday', '2026-13-01', '2026-02-30', '2026-1-5', '20261012']) {
      const res = await get(bad);
      expect(res.status, bad).toBe(400);
      expect(res.body).toEqual({ error: BAD_WEEK, field: 'week' });
    }
  });

  test('rep 403', async () => {
    const res = await get(WEEK, 'rep');
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: NOT_ALLOWED });
  });

  test('cross-tenant: company B sees none of A data', async () => {
    const id = await conv({ outcome: 'booked' });
    await call({ conversationId: id, aiSeconds: 120, transferResult: 'answered' });
    await turn(id, 1, ['x']);
    const sms = await conv({ channel: 'sms' });
    await text(sms, 'in', wed(16));
    expect((await get(WEEK, 'owner', 'a')).body).toMatchObject({ answered: 1, booked: 1, guardBlocks: 1 });
    expect((await get(WEEK, 'owner', 'b')).body).toEqual({
      weekStart: WEEK,
      answered: 0,
      booked: 0,
      transferred: 0,
      messages: 0,
      spam: 0,
      firstReplyMsP50: null,
      guardBlocks: 0,
      aiMinutesUsed: 0,
      aiMinutesIncluded: null,
    });
  });
});
