import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, test } from 'vitest';
import {
  agentTasks,
  appointments,
  claims,
  companies,
  createAppointment,
  createCustomer,
  createJob,
  createProperty,
  customers,
  followUpLog,
  g1AgentOn,
  jobs,
  messages,
  setPaused,
  withTenant,
} from '@roofline/db';
import type { Agent, HourlyForecast } from '@roofline/shared';
import { runClaimsDaily } from '../src/agents/claims/nudges.ts';
import { runClaimsReply } from '../src/agents/claims/replies.ts';
import { runFollowUps } from '../src/agents/followup/daily.ts';
import { runAgenda } from '../src/agents/scheduler/agenda.ts';
import { runNoShow } from '../src/agents/scheduler/no-show.ts';
import { runReminders } from '../src/agents/scheduler/reminders.ts';
import { runWeatherWatch } from '../src/agents/scheduler/weather.ts';
import { LlmUnavailableError, type TurnUsage } from '../src/providers/llm.ts';
import { inCompany } from './crm-helpers.ts';
import { makeTestApp, type TestApp } from './helpers.ts';
import { agentCtx } from './task-helpers.ts';

/*
 * Ruling GX-E: every G1 job asks `g1AgentOn`. With no agent_settings row the agent is paused, so a
 * job does nothing; turned on it runs; paused again it stops; a company that may not run agents
 * (past_due, canceled) gets nothing even when the agent is on. Each test starts with a fresh app.
 */

const META = { attempt: 1, lastAttempt: false };
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const USAGE: TurnUsage = { model: 'scripted', inputTokens: 1, cachedTokens: 0, outputTokens: 1, firstTokenMs: 1, totalMs: 2 };
/** 3 PM Monday 2026-10-12 Chicago (reminders, no-show). */
const THREE_PM = new Date('2026-10-12T20:00:00.000Z');
/** 6 PM Monday 2026-10-12 Chicago (agenda). */
const SIX_PM = new Date('2026-10-12T23:00:00.000Z');
/** 6 AM Monday 2026-10-12 Chicago (weather). */
const SIX_AM = new Date('2026-10-12T11:00:00.000Z');
/** 9 AM Tuesday 2026-10-13 Chicago (follow-up). */
const NINE_AM = new Date('2026-10-13T14:00:00.000Z');
/** Local midnight Monday 2026-10-12, Chicago. */
const MIDNIGHT = Date.parse('2026-10-12T05:00:00.000Z');
const TUE_10 = new Date('2026-10-13T15:00:00.000Z');
const TUE_11 = new Date('2026-10-13T16:00:00.000Z');

let t: TestApp;
let seq = 0;
const A = () => t.seed.a.companyId;
const ctxA = () => agentCtx(A());
const setAgent = (agent: Agent, paused: boolean) => inCompany(t, A(), (tx) => setPaused(tx, ctxA(), agent, paused, t.clock.now()));
const agentTaskCount = async (agent: Agent) => (await inCompany(t, A(), (tx) => tx.select({ id: agentTasks.id }).from(agentTasks).where(eq(agentTasks.agent, agent)))).length;

/** A customer with a unique phone, a unique house and a job. */
async function house(tag: string) {
  seq += 1;
  const now = t.clock.now();
  const ctx = ctxA();
  return inCompany(t, A(), async (tx) => {
    const customer = await createCustomer(
      tx,
      ctx,
      { displayName: `${tag} Gate`, firstName: tag, phones: [{ e164: `+1512557${String(1000 + seq)}`, primary: true }] },
      { now },
    );
    const property = await createProperty(
      tx,
      ctx,
      { customerId: customer.id, addressLine: `${3000 + seq} Gate St`, city: 'Austin', state: 'TX', zip: '78701', location: [-97.74, 30.27] },
      { now },
    );
    await tx.update(customers).set({ smsConsentStatus: 'express' }).where(eq(customers.id, customer.id));
    const job = await createJob(tx, ctx, { customerId: customer.id, propertyId: property.id }, { now });
    return { customerId: customer.id, propertyId: property.id, jobId: job.id };
  });
}

async function visit(tag: string, kind: 'inspection' | 'install', startsAt: Date, endsAt: Date, userId: string = t.seed.a.owner.userId) {
  const h = await house(tag);
  const { row } = await inCompany(t, A(), (tx) =>
    createAppointment(
      tx,
      ctxA(),
      { kind, customerId: h.customerId, propertyId: h.propertyId, jobId: h.jobId, assignedUserId: userId, startsAt, endsAt },
      t.clock.now(),
    ),
  );
  return { ...h, appointmentId: row.id };
}

type JobSpec = {
  name: string;
  agent: Agent;
  now: Date;
  /** Makes the data the job acts on; returns whatever `run` needs. */
  seed: () => Promise<unknown>;
  /** Runs the job; `ctx` is what `seed` returned. */
  run: (seeded: unknown) => Promise<void>;
  /** How many results the job has made (tasks, mails or claim updates). */
  made: () => Promise<number>;
  /** Called just before the run that is allowed to make something. */
  script?: () => void;
};

const unavailable = () => t.llm.scriptDraft(new LlmUnavailableError('down'));

const rainForecast = (): HourlyForecast[] =>
  Array.from({ length: 24 * 8 }, (_, i) => ({
    at: new Date(MIDNIGHT + i * HOUR).toISOString(),
    precipPct: Math.floor(i / 24) === 1 ? 70 : 0,
    gustMph: 5,
  }));

const SPECS: JobSpec[] = [
  {
    name: 'claims-daily',
    agent: 'claims',
    now: new Date('2026-10-13T15:00:00.000Z'),
    seed: async () => {
      const h = await house('Claim');
      const now = t.clock.now();
      await inCompany(t, A(), async (tx) => {
        await tx.insert(appointments).values({
          companyId: A(),
          kind: 'inspection',
          jobId: h.jobId,
          customerId: h.customerId,
          propertyId: h.propertyId,
          startsAt: new Date(now.getTime() - 4 * DAY - HOUR),
          endsAt: new Date(now.getTime() - 4 * DAY),
          status: 'completed',
          createdAt: now,
          updatedAt: now,
        });
        await tx.insert(claims).values({ companyId: A(), jobId: h.jobId, status: 'not_filed', statusChangedAt: new Date(now.getTime() - 4 * DAY), createdAt: now, updatedAt: now });
      });
    },
    run: () => runClaimsDaily(t.deps, A(), META),
    made: () => agentTaskCount('claims'),
    script: unavailable,
  },
  {
    name: 'scheduler-reminders',
    agent: 'scheduler',
    now: THREE_PM,
    seed: async () => {
      await visit('Remind', 'inspection', TUE_10, TUE_11);
    },
    run: () => runReminders(t.deps, A(), META),
    made: () => agentTaskCount('scheduler'),
    script: unavailable,
  },
  {
    name: 'scheduler-agenda',
    agent: 'scheduler',
    now: SIX_PM,
    seed: async () => {
      await visit('Agenda', 'inspection', TUE_10, TUE_11);
    },
    run: () => runAgenda(t.deps, A(), META),
    made: async () => t.mailer.sent.length,
  },
  {
    name: 'scheduler-weather',
    agent: 'scheduler',
    now: SIX_AM,
    seed: async () => {
      await visit('Weather', 'install', new Date(MIDNIGHT + DAY), new Date(MIDNIGHT + 2 * DAY));
      t.weather.hourlyValue = rainForecast();
    },
    run: () => runWeatherWatch(t.deps, A(), META),
    made: () => agentTaskCount('scheduler'),
    script: unavailable,
  },
  {
    name: 'scheduler-no-show',
    agent: 'scheduler',
    now: THREE_PM,
    seed: async () => {
      const v = await visit('Missed', 'inspection', new Date('2026-10-12T15:00:00.000Z'), new Date('2026-10-12T16:00:00.000Z'));
      await inCompany(t, A(), (tx) => tx.update(appointments).set({ status: 'no_show' }).where(eq(appointments.id, v.appointmentId)));
      return v;
    },
    run: (v) => runNoShow(t.deps, A(), (v as { appointmentId: string }).appointmentId),
    made: () => agentTaskCount('scheduler'),
    script: unavailable,
  },
  {
    name: 'followup-daily',
    agent: 'follow_up',
    now: NINE_AM,
    seed: async () => {
      const h = await house('Lead');
      const created = new Date(t.clock.now().getTime() - 2 * DAY);
      await inCompany(t, A(), (tx) => tx.update(jobs).set({ stage: 'lead', createdAt: created, stageChangedAt: created }).where(eq(jobs.id, h.jobId)));
    },
    run: () => runFollowUps(t.deps, A(), META),
    made: () => agentTaskCount('follow_up'),
    script: unavailable,
  },
  {
    name: 'claims-reply',
    agent: 'claims',
    now: new Date('2026-10-13T15:00:00.000Z'),
    seed: async () => {
      const h = await house('Reply');
      const now = t.clock.now();
      return inCompany(t, A(), async (tx) => {
        await tx.insert(claims).values({ companyId: A(), jobId: h.jobId, status: 'filed', statusChangedAt: new Date(now.getTime() - 10 * DAY), createdAt: now, updatedAt: now });
        await tx.insert(followUpLog).values({ companyId: A(), customerId: h.customerId, jobId: h.jobId, kind: 'claims', n: 1, at: new Date(now.getTime() - 2 * DAY) });
        const [m] = await tx
          .insert(messages)
          .values({ companyId: A(), customerId: h.customerId, channel: 'sms', direction: 'in', body: 'Our claim number is 0451-22.', status: 'received', fromE164: '+15125579999', createdAt: now, updatedAt: now })
          .returning({ id: messages.id });
        return { messageId: m!.id };
      });
    },
    run: (m) => runClaimsReply(t.deps, A(), (m as { messageId: string }).messageId),
    made: async () => (await inCompany(t, A(), (tx) => tx.select({ n: claims.claimNumber }).from(claims))).filter((r) => r.n !== null).length,
    script: () => t.llm.scriptExtraction({ facts: { claimNumber: '0451-22' }, usage: USAGE }),
  },
];

describe.each(SPECS)('$name goes through g1AgentOn', (spec) => {
  let seeded: unknown;

  beforeEach(async () => {
    seq = 0;
    t = await makeTestApp();
    t.clock.set(spec.now);
    seeded = await spec.seed();
  });

  test('with no agent_settings row (G1 default: paused) it does nothing', async () => {
    await spec.run(seeded);
    expect(await spec.made()).toBe(0);
  });

  test('after setPaused false it runs and makes its plan', async () => {
    await setAgent(spec.agent, false);
    spec.script?.();
    await spec.run(seeded);
    expect(await spec.made()).toBeGreaterThan(0);
  });

  test('paused again after being on, it stops', async () => {
    await setAgent(spec.agent, false);
    await setAgent(spec.agent, true);
    spec.script?.();
    await spec.run(seeded);
    expect(await spec.made()).toBe(0);
  });

  test.each(['past_due', 'canceled'] as const)('company status %s: does nothing even when on', async (status) => {
    await setAgent(spec.agent, false);
    await t.deps.pools.system.update(companies).set({ status }).where(eq(companies.id, A()));
    spec.script?.();
    await spec.run(seeded);
    expect(await spec.made()).toBe(0);
  });
});

describe('g1AgentOn', () => {
  beforeEach(async () => {
    t = await makeTestApp();
    t.clock.set(NINE_AM);
  });

  const on = (agent: Agent) => withTenant(t.deps.pools, ctxA(), (tx) => g1AgentOn(tx, ctxA(), agent));

  test('no row: false for each G1 agent, true for a launch agent', async () => {
    expect(await on('claims')).toBe(false);
    expect(await on('scheduler')).toBe(false);
    expect(await on('follow_up')).toBe(false);
    expect(await on('storm_scout')).toBe(true);
  });

  test('turned on, then paused again', async () => {
    await setAgent('claims', false);
    expect(await on('claims')).toBe(true);
    await setAgent('claims', true);
    expect(await on('claims')).toBe(false);
  });

  test('a company that is not active or in trial is never on', async () => {
    await setAgent('claims', false);
    await t.deps.pools.system.update(companies).set({ status: 'past_due' }).where(eq(companies.id, A()));
    expect(await on('claims')).toBe(false);
    expect(await on('storm_scout')).toBe(false);
    await t.deps.pools.system.update(companies).set({ status: 'trial' }).where(eq(companies.id, A()));
    expect(await on('claims')).toBe(true);
  });
});

