import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, test } from 'vitest';
import {
  agentSettings,
  agentTasks,
  appointments,
  companySettings,
  customers,
  followUpLog,
  jobs,
  messages,
  properties,
} from '@roofline/db';
import { runFollowUps } from '../src/agents/followup/daily.ts';
import { inCompany } from './crm-helpers.ts';
import { makeTestApp, type TestApp } from './helpers.ts';
import { dbSteps } from './task-helpers.ts';

let t: TestApp;

const DAY = 86_400_000;
/** Tuesday 13 October 2026, 9:00 AM in Chicago (CDT). */
const NINE_AM = new Date('2026-10-13T14:00:00.000Z');
const META = { attempt: 1, lastAttempt: false };
const USAGE = { model: 'scripted', inputTokens: 1, cachedTokens: 0, outputTokens: 1, firstTokenMs: 1, totalMs: 1 };
const LINK = 'https://example.com/review';
const GOOD = `Hi Pat, thanks for choosing us. A short review helps a lot: ${LINK} Reply STOP to opt out.`;

beforeEach(async () => {
  t = await makeTestApp();
  t.clock.set(NINE_AM);
  await setAgent();
  await setSettings({ followupReviews: true, reviewLink: LINK, reviewDelayDays: 3 });
});

const companyId = () => t.seed.a.companyId;
const run = () => runFollowUps(t.deps, companyId(), META);

/** The follow_up agent row, unpaused (app_tenant has no DELETE; Ruling GX-E: a missing row means off). */
async function setAgent() {
  await inCompany(t, companyId(), async (tx) => {
    await tx
      .insert(agentSettings)
      .values({ companyId: companyId(), agent: 'follow_up', pausedAt: null })
      .onConflictDoUpdate({ target: [agentSettings.companyId, agentSettings.agent], set: { pausedAt: null } });
  });
}

async function setSettings(set: { followupReviews?: boolean; reviewLink?: string | null; reviewDelayDays?: number }) {
  await inCompany(t, companyId(), (tx) =>
    tx
      .insert(companySettings)
      .values({ companyId: companyId(), ...set })
      .onConflictDoUpdate({ target: companySettings.companyId, set }),
  );
}

let seq = 0;

type Seed = { installedDaysAgo?: number; consent?: 'none' | 'express' | 'attested' | 'written'; withInstall?: boolean };

/** A customer, property and job, and (unless `withInstall` is false) a completed install ending N days ago. */
async function seed(o: Seed = {}) {
  const now = t.clock.now();
  const n = ++seq;
  return inCompany(t, companyId(), async (tx) => {
    const [cust] = await tx
      .insert(customers)
      .values({
        companyId: companyId(),
        displayName: 'Pat Customer',
        firstName: 'Pat',
        phones: [{ e164: `+1402555${String(2000 + n)}`, label: 'mobile', primary: true }],
        smsConsentStatus: o.consent ?? 'attested',
      })
      .returning({ id: customers.id });
    const [prop] = await tx
      .insert(properties)
      .values({ companyId: companyId(), customerId: cust!.id, addressLine: `${n} Elm St`, city: 'Omaha', state: 'NE', zip: '68102', addressKey: `fr${n}` })
      .returning({ id: properties.id });
    const [job] = await tx
      .insert(jobs)
      .values({ companyId: companyId(), customerId: cust!.id, propertyId: prop!.id, stage: 'installed', createdAt: new Date(now.getTime() - 60 * DAY), stageChangedAt: new Date(now.getTime() - 5 * DAY) })
      .returning({ id: jobs.id });
    if (o.withInstall !== false) {
      const endsAt = new Date(now.getTime() - (o.installedDaysAgo ?? 3) * DAY);
      await tx.insert(appointments).values({
        companyId: companyId(),
        kind: 'install',
        jobId: job!.id,
        customerId: cust!.id,
        propertyId: prop!.id,
        startsAt: new Date(endsAt.getTime() - 4 * 3_600_000),
        endsAt,
        status: 'completed',
      });
    }
    return { customerId: cust!.id, jobId: job!.id };
  });
}

const logRow = (s: { customerId: string; jobId: string }, kind: 'review' | 'lead', daysAgo: number) =>
  inCompany(t, companyId(), (tx) =>
    tx.insert(followUpLog).values({ companyId: companyId(), customerId: s.customerId, jobId: s.jobId, kind, n: 1, messageId: null, at: new Date(NINE_AM.getTime() - daysAgo * DAY) }),
  );

const tasksOf = (kind: string) =>
  inCompany(t, companyId(), (tx) => tx.select().from(agentTasks).where(and(eq(agentTasks.agent, 'follow_up'), eq(agentTasks.kind, kind))));

type Payload = { kind: string; purpose: string; dedupePrefix: string; messages: { customerId: string; jobId: string; body: string }[] };
const payloads = async (taskId: string) => (await dbSteps(t, 'a', taskId)).map((s) => s.payload as Payload);

function scriptGood(jobIds: string[]) {
  t.llm.scriptDraft({ texts: jobIds.map((jobId) => ({ jobId, body: GOOD })), refused: false, usage: USAGE });
}

describe('review requests', () => {
  test('an install completed 3 days ago gets a request with the link', async () => {
    const s = await seed({ installedDaysAgo: 3 });
    scriptGood([s.jobId]);
    await run();
    const tasks = await tasksOf('follow_ups');
    expect(tasks).toHaveLength(1);
    const ps = await payloads(tasks[0]!.id);
    expect(ps).toHaveLength(1);
    expect(ps[0]!.messages).toHaveLength(1);
    expect(ps[0]!.messages[0]).toMatchObject({ customerId: s.customerId, jobId: s.jobId });
    expect(ps[0]!.messages[0]!.body).toContain(LINK);
    expect(t.llm.draftCalls[0]?.instruction).toBe('review_request');
  });

  test('2 days ago does not', async () => {
    const s = await seed({ installedDaysAgo: 2 });
    scriptGood([s.jobId]);
    await run();
    expect(await tasksOf('follow_ups')).toHaveLength(0);
  });

  test('31 days ago does not', async () => {
    const s = await seed({ installedDaysAgo: 31 });
    scriptGood([s.jobId]);
    await run();
    expect(await tasksOf('follow_ups')).toHaveLength(0);
  });

  test('a second day does not repeat it', async () => {
    const s = await seed({ installedDaysAgo: 3 });
    await logRow(s, 'review', 1);
    scriptGood([s.jobId]);
    t.clock.set(new Date(NINE_AM.getTime() + DAY));
    await run();
    expect(await tasksOf('follow_ups')).toHaveLength(0);
  });

  test('no review link -> no group and the summary does not mention it', async () => {
    await setSettings({ reviewLink: null });
    const s = await seed({ installedDaysAgo: 3 });
    scriptGood([s.jobId]);
    await run();
    expect(await tasksOf('follow_ups')).toHaveLength(0);
    expect(t.llm.draftCalls).toHaveLength(0);
  });

  test('followup_reviews off -> no group', async () => {
    await setSettings({ followupReviews: false });
    const s = await seed({ installedDaysAgo: 3 });
    scriptGood([s.jobId]);
    await run();
    expect(await tasksOf('follow_ups')).toHaveLength(0);
  });

  test('consent none and express are skipped; attested and written are included', async () => {
    const none = await seed({ consent: 'none' });
    const express = await seed({ consent: 'express' });
    const attested = await seed({ consent: 'attested' });
    const written = await seed({ consent: 'written' });
    scriptGood([attested.jobId, written.jobId]);
    await run();
    const tasks = await tasksOf('follow_ups');
    expect(tasks).toHaveLength(1);
    const ids = (await payloads(tasks[0]!.id))[0]!.messages.map((m) => m.jobId).sort();
    expect(ids).toEqual([attested.jobId, written.jobId].sort());
    expect(ids).not.toContain(none.jobId);
    expect(ids).not.toContain(express.jobId);
  });

  test('the step is marketing, kind review, dedupePrefix followup-review:2026-10-13, and the body ends with the STOP line', async () => {
    const s = await seed();
    scriptGood([s.jobId]);
    await run();
    const tasks = await tasksOf('follow_ups');
    const ps = await payloads(tasks[0]!.id);
    expect(ps[0]).toMatchObject({ purpose: 'marketing', kind: 'review', dedupePrefix: 'followup-review:2026-10-13' });
    expect(ps[0]!.messages[0]!.body.trim()).toMatch(/Reply STOP to opt out\.?$/);
  });

  test('template fallback contains the link and the STOP line', async () => {
    await seed();
    await run();
    const tasks = await tasksOf('follow_ups');
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.summary).toContain('Written from a template');
    const body = (await payloads(tasks[0]!.id))[0]!.messages[0]!.body;
    expect(body).toContain(LINK);
    expect(body).toContain('Reply STOP to opt out');
  });

  test('a lead text yesterday (follow_up_log kind lead, 1 day ago) blocks', async () => {
    const s = await seed();
    await logRow(s, 'lead', 1);
    scriptGood([s.jobId]);
    await run();
    expect(await tasksOf('follow_ups')).toHaveLength(0);
  });

  test('a customer who texted yesterday (inbound message) is skipped', async () => {
    const s = await seed();
    await inCompany(t, companyId(), (tx) =>
      tx.insert(messages).values({
        companyId: companyId(),
        customerId: s.customerId,
        channel: 'sms',
        direction: 'in',
        body: 'Hello',
        status: 'received',
        createdAt: new Date(NINE_AM.getTime() - DAY),
        updatedAt: new Date(NINE_AM.getTime() - DAY),
      }),
    );
    scriptGood([s.jobId]);
    await run();
    expect(await tasksOf('follow_ups')).toHaveLength(0);
  });

  test('a review-only task is kind follow_ups and its summary counts the request', async () => {
    const s = await seed();
    scriptGood([s.jobId]);
    await run();
    const tasks = await tasksOf('follow_ups');
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.title).toBe('Follow-ups for today (1)');
    expect(tasks[0]!.summary).toContain('1 review request');
  });
});
