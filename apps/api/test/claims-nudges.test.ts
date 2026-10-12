import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, test } from 'vitest';
import {
  agentTasks,
  appointments,
  claims,
  customers,
  followUpLog,
  jobs,
  properties,
  setPaused,
  withTenant,
} from '@roofline/db';
import type { ClaimStatus } from '@roofline/shared';
import { FROM_TEMPLATE, runClaimsDaily, templateFor } from '../src/agents/claims/nudges.ts';
import { LlmUnavailableError, type DraftTextsResult, type TurnUsage } from '../src/providers/llm.ts';
import { inCompany } from './crm-helpers.ts';
import { makeTestApp, type TestApp } from './helpers.ts';
import { DAY, DAYTIME } from './sms-helpers.ts';
import { agentCtx, dbSteps } from './task-helpers.ts';

let t: TestApp;
let houses = 0;

beforeEach(async () => {
  t = await makeTestApp();
  t.clock.set(DAYTIME);
  houses = 0;
});

const idOf = () => t.seed.a.companyId;
const USAGE: TurnUsage = { model: 'scripted', inputTokens: 1, cachedTokens: 0, outputTokens: 1, firstTokenMs: 1, totalMs: 2 };
const META = { attempt: 1, lastAttempt: false };
const ago = (days: number, from: Date = DAYTIME) => new Date(from.getTime() - days * DAY);

/** The Claims agent is on for the company (a missing `agent_settings` row means paused). */
const turnOn = () =>
  withTenant(t.deps.pools, agentCtx(idOf()), (tx) => setPaused(tx, agentCtx(idOf()), 'claims', false, t.clock.now()));

type CaseSpec = {
  first: string;
  status: ClaimStatus;
  /** The end of a completed inspection on the job. */
  inspectedAt?: Date;
  /** The start of the claim's adjuster appointment. */
  adjusterAt?: Date;
  statusChangedAt?: Date;
  /** Claims are listed oldest first by this. */
  createdAt?: Date;
  phone?: string | null;
  repUserId?: string | null;
};

/** One customer with a home, a job and a claim, as the spec describes. */
async function claimCase(spec: CaseSpec): Promise<{ customerId: string; jobId: string; claimId: string }> {
  houses += 1;
  const companyId = idOf();
  const now = t.clock.now();
  return inCompany(t, companyId, async (tx) => {
    const phone = spec.phone === undefined ? `+1402555${String(1000 + houses)}` : spec.phone;
    const [customer] = await tx
      .insert(customers)
      .values({
        companyId,
        displayName: `${spec.first} Customer`,
        firstName: spec.first,
        phones: phone === null ? [] : [{ e164: phone, label: 'mobile', primary: true }],
        smsConsentStatus: 'express',
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: customers.id });
    const customerId = customer!.id;
    const [property] = await tx
      .insert(properties)
      .values({
        companyId,
        customerId,
        addressLine: `${100 + houses} Oak St`,
        city: 'Omaha',
        state: 'NE',
        zip: '68102',
        addressKey: `${100 + houses} oak st|68102`,
        timezone: 'America/Chicago',
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: properties.id });
    const [job] = await tx
      .insert(jobs)
      .values({
        companyId,
        customerId,
        propertyId: property!.id,
        assignedUserId: spec.repUserId ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: jobs.id });
    const jobId = job!.id;

    if (spec.inspectedAt) {
      await tx.insert(appointments).values({
        companyId,
        kind: 'inspection',
        jobId,
        customerId,
        propertyId: property!.id,
        startsAt: new Date(spec.inspectedAt.getTime() - 60 * 60 * 1000),
        endsAt: spec.inspectedAt,
        status: 'completed',
        createdAt: now,
        updatedAt: now,
      });
    }
    let adjusterAppointmentId: string | null = null;
    if (spec.adjusterAt) {
      const [appt] = await tx
        .insert(appointments)
        .values({
          companyId,
          kind: 'adjuster',
          jobId,
          customerId,
          propertyId: property!.id,
          startsAt: spec.adjusterAt,
          endsAt: new Date(spec.adjusterAt.getTime() + 60 * 60 * 1000),
          status: 'scheduled',
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: appointments.id });
      adjusterAppointmentId = appt!.id;
    }
    const [claim] = await tx
      .insert(claims)
      .values({
        companyId,
        jobId,
        status: spec.status,
        adjusterAppointmentId,
        statusChangedAt: spec.statusChangedAt ?? ago(30),
        createdAt: spec.createdAt ?? now,
        updatedAt: now,
      })
      .returning({ id: claims.id });
    return { customerId, jobId, claimId: claim!.id };
  });
}

const claimsTasks = () =>
  inCompany(t, idOf(), (tx) => tx.select().from(agentTasks).where(eq(agentTasks.agent, 'claims')).orderBy(agentTasks.createdAt));

const run = () => runClaimsDaily(t.deps, idOf(), META);

type PersonalPayload = {
  purpose: string;
  kind: string;
  dedupePrefix: string;
  messages: { customerId: string; jobId: string | null; body: string }[];
};

async function payloadOf(taskId: string): Promise<PersonalPayload> {
  const [step] = await dbSteps(t, 'a', taskId);
  expect(step!.type).toBe('send_personal_texts');
  return step!.payload as PersonalPayload;
}

const drafted = (...texts: { jobId: string; body: string }[]): DraftTextsResult => ({ texts, refused: false, usage: USAGE });

describe('Claims daily nudges', () => {
  test('asks_filed after 3 days from inspection, asks_adjuster_date 5 days after filed, asks_outcome 7 days after adjuster visit', async () => {
    await turnOn();
    const a = await claimCase({ first: 'Ann', status: 'not_filed', inspectedAt: ago(3), createdAt: ago(20) });
    const b = await claimCase({ first: 'Ben', status: 'filed', statusChangedAt: ago(5), createdAt: ago(19) });
    const c = await claimCase({ first: 'Cy', status: 'adjuster_scheduled', adjusterAt: ago(7), createdAt: ago(18) });

    // One day short on every rule: nothing is due, so no task and no call to the model.
    t.clock.set(ago(1));
    await run();
    expect(await claimsTasks()).toHaveLength(0);
    expect(t.llm.draftCalls).toHaveLength(0);

    t.clock.set(DAYTIME);
    t.llm.scriptDraft(drafted({ jobId: a.jobId, body: "Hi Ann, it's Sam at Acme Roofing. Have you filed your insurance claim yet? If so, please reply with the claim number." }));
    t.llm.scriptDraft(drafted({ jobId: b.jobId, body: "Hi Ben, it's Sam at Acme Roofing. Has a date been set for the adjuster visit? Reply with the day and time." }));
    t.llm.scriptDraft(drafted({ jobId: c.jobId, body: "Hi Cy, it's Sam at Acme Roofing. How did the adjuster visit go? Reply with any update." }));
    await run();

    expect(t.llm.draftCalls.map((call) => call.instruction)).toEqual(['claims_ask_filed', 'claims_ask_adjuster_date', 'claims_ask_outcome']);
    expect(t.llm.draftCalls[0]!.facts[0]).toMatchObject({ jobId: a.jobId, customerFirstName: 'Ann', companyName: t.seed.a.name, facts: { daysSinceInspection: '3' } });
    expect(t.llm.draftCalls[1]!.facts[0]).toMatchObject({ jobId: b.jobId, facts: { daysSinceFiled: '5' } });
    expect(t.llm.draftCalls[2]!.facts[0]).toMatchObject({ jobId: c.jobId, facts: { daysSinceAdjusterVisit: '7' } });

    const tasks = await claimsTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ kind: 'claims_nudges', title: 'Claim check-ins (3 texts)', status: 'draft', mode: 'needs_approval' });
    expect(tasks[0]!.summary ?? '').not.toContain(FROM_TEMPLATE);
    // 6 PM in Chicago (CDT) on 13 October.
    expect(tasks[0]!.expiresAt).toEqual(new Date('2026-10-13T23:00:00.000Z'));
    const payload = await payloadOf(tasks[0]!.id);
    expect(payload).toMatchObject({ purpose: 'informational', kind: 'claims', dedupePrefix: 'claims:2026-10-13' });
    expect(payload.messages.map((m) => [m.customerId, m.jobId])).toEqual([
      [a.customerId, a.jobId],
      [b.customerId, b.jobId],
      [c.customerId, c.jobId],
    ]);
    expect(payload.messages[0]!.body).toContain('claim number');
  });

  test('paused: no agent_settings row means no task', async () => {
    await claimCase({ first: 'Ann', status: 'not_filed', inspectedAt: ago(4) });

    await run();
    expect(await claimsTasks()).toHaveLength(0);
    expect(t.llm.draftCalls).toHaveLength(0);

    // A row with paused_at set is paused too.
    await withTenant(t.deps.pools, agentCtx(idOf()), (tx) => setPaused(tx, agentCtx(idOf()), 'claims', true, t.clock.now()));
    await run();
    expect(await claimsTasks()).toHaveLength(0);

    // Turned on, the same claim makes a task.
    await turnOn();
    await run();
    expect(await claimsTasks()).toHaveLength(1);
  });

  test('already ran today: second run makes no second task', async () => {
    await turnOn();
    const a = await claimCase({ first: 'Ann', status: 'not_filed', inspectedAt: ago(4) });
    t.llm.scriptDraft(drafted({ jobId: a.jobId, body: "Hi Ann, it's Acme Roofing. Have you filed your insurance claim yet?" }));

    await run();
    await run();

    expect(await claimsTasks()).toHaveLength(1);
    expect(t.llm.draftCalls).toHaveLength(1);
  });

  test('spacing: a customer texted 2 days ago by follow-up gets no nudge', async () => {
    await turnOn();
    const a = await claimCase({ first: 'Ann', status: 'not_filed', inspectedAt: ago(4) });
    await inCompany(t, idOf(), (tx) =>
      tx.insert(followUpLog).values({ companyId: idOf(), customerId: a.customerId, jobId: null, kind: 'proposal', n: 1, at: ago(2) }),
    );

    await run();

    expect(await claimsTasks()).toHaveLength(0);
    expect(t.llm.draftCalls).toHaveLength(0);
  });

  test('template fallback when the llm throws LlmUnavailableError: task summary says Written from a template and body is the template', async () => {
    await turnOn();
    const a = await claimCase({ first: 'Ann', status: 'not_filed', inspectedAt: ago(4) });
    t.llm.scriptDraft(new LlmUnavailableError('down'));

    await run();

    const tasks = await claimsTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.summary).toContain('Written from a template');
    const payload = await payloadOf(tasks[0]!.id);
    expect(payload.messages).toEqual([
      { customerId: a.customerId, jobId: a.jobId, body: templateFor('claims_ask_filed', { first: 'Ann', rep: null, company: t.seed.a.name }) },
    ]);
  });

  test('a draft failing the claims guard falls back to the template', async () => {
    await turnOn();
    const a = await claimCase({ first: 'Ann', status: 'not_filed', inspectedAt: ago(4) });
    t.llm.scriptDraft(drafted({ jobId: a.jobId, body: 'Your insurance deductible is covered.' }));

    await run();

    const tasks = await claimsTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.summary).toContain('Written from a template');
    const payload = await payloadOf(tasks[0]!.id);
    expect(payload.messages[0]!.body).toBe(templateFor('claims_ask_filed', { first: 'Ann', rep: null, company: t.seed.a.name }));
  });

  test('company past_due makes no task', async () => {
    await turnOn();
    await claimCase({ first: 'Ann', status: 'not_filed', inspectedAt: ago(4) });
    await t.deps.pools.system.$client.query(`update companies set status = 'past_due' where id = $1`, [idOf()]);

    await run();

    expect(await claimsTasks()).toHaveLength(0);
    expect(t.llm.draftCalls).toHaveLength(0);
  });

  test('cap of 25 per run', async () => {
    await turnOn();
    const made: { jobId: string }[] = [];
    for (let i = 0; i < 27; i += 1) {
      made.push(await claimCase({ first: `Cust${i}`, status: 'not_filed', inspectedAt: ago(4), createdAt: ago(100 - i) }));
    }
    t.llm.scriptDraft(new LlmUnavailableError('down'));

    await run();

    const tasks = await claimsTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.title).toBe('Claim check-ins (25 texts)');
    expect(t.llm.draftCalls).toHaveLength(1);
    expect(t.llm.draftCalls[0]!.facts).toHaveLength(25);
    const payload = await payloadOf(tasks[0]!.id);
    // The oldest 25 claims, oldest first.
    expect(payload.messages.map((m) => m.jobId)).toEqual(made.slice(0, 25).map((m) => m.jobId));
  });
});
