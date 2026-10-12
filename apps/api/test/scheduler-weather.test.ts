import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, test } from 'vitest';
import {
  agentTasks,
  agentTaskSteps,
  createAppointment,
  createCustomer,
  createJob,
  createProperty,
  setPaused,
  type TenantContext,
} from '@roofline/db';
import type { AppointmentKind, HourlyForecast } from '@roofline/shared';
import { runWeatherWatch } from '../src/agents/scheduler/weather.ts';
import type { JobMeta } from '../src/jobs/queue.ts';
import { LlmUnavailableError } from '../src/providers/llm.ts';
import { inCompany } from './crm-helpers.ts';
import { makeTestApp, type TestApp } from './helpers.ts';

const META: JobMeta = { attempt: 1, lastAttempt: false };
/** 6 AM on Monday 2026-10-12 in Chicago (CDT, UTC-5). */
const SIX_AM = new Date('2026-10-12T11:00:00.000Z');
/** Local midnight Monday 2026-10-12, Chicago. */
const MIDNIGHT = Date.parse('2026-10-12T05:00:00.000Z');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const USAGE = { model: 'scripted', inputTokens: 1, cachedTokens: 0, outputTokens: 1, firstTokenMs: 1, totalMs: 2 };

/** Chicago day starts: index 0 is Monday 2026-10-12. */
const dayStart = (n: number): Date => new Date(MIDNIGHT + n * DAY);
const TUE = 1;
const WED = 2;

let phoneSeq = 0;
let addrSeq = 0;
const nextPhone = (): string => `+1512556${String(1000 + phoneSeq++)}`;

let t: TestApp;
const A = () => t.seed.a.companyId;
const ctxA = (): TenantContext => ({ companyId: A(), userId: null, role: 'system', canApproveSpend: false });

/** Eight days of hourly points from local midnight today; `rule` overrides some hours. */
function forecast(rule: (dayIndex: number, hour: number) => Partial<Pick<HourlyForecast, 'precipPct' | 'gustMph'>> = () => ({})): HourlyForecast[] {
  return Array.from({ length: 24 * 8 }, (_, i) => ({
    at: new Date(MIDNIGHT + i * HOUR).toISOString(),
    precipPct: 0,
    gustMph: 5,
    ...rule(Math.floor(i / 24), i % 24),
  }));
}
const rainOn = (...days: number[]) => forecast((d) => (days.includes(d) ? { precipPct: 70 } : {}));

type Visit = { first: string; kind?: AppointmentKind; day: number; phone?: boolean };

async function seedVisit(v: Visit): Promise<{ customerId: string; jobId: string; appointmentId: string }> {
  const ctx = ctxA();
  const now = t.clock.now();
  return inCompany(t, A(), async (tx) => {
    const customer = await createCustomer(
      tx,
      ctx,
      { displayName: `${v.first} Weather`, firstName: v.first, phones: v.phone === false ? [] : [{ e164: nextPhone(), primary: true }] },
      { now },
    );
    const property = await createProperty(
      tx,
      ctx,
      {
        customerId: customer.id,
        addressLine: `${2000 + addrSeq++} Pine St`,
        city: 'Austin',
        state: 'TX',
        zip: '78701',
        location: [-97.74, 30.27],
      },
      { now },
    );
    const job = await createJob(tx, ctx, { customerId: customer.id, propertyId: property.id }, { now });
    const install = (v.kind ?? 'install') === 'install';
    const { row } = await createAppointment(
      tx,
      ctx,
      {
        kind: v.kind ?? 'install',
        customerId: customer.id,
        propertyId: property.id,
        jobId: job.id,
        assignedUserId: t.seed.a.owner.userId,
        startsAt: install ? dayStart(v.day) : new Date(dayStart(v.day).getTime() + 10 * HOUR),
        endsAt: install ? dayStart(v.day + 1) : new Date(dayStart(v.day).getTime() + 11 * HOUR),
      },
      now,
    );
    return { customerId: customer.id, jobId: job.id, appointmentId: row.id };
  });
}

const agentOn = (paused: boolean) => inCompany(t, A(), (tx) => setPaused(tx, ctxA(), 'scheduler', paused, t.clock.now()));
const tasks = () => inCompany(t, A(), (tx) => tx.select().from(agentTasks).where(eq(agentTasks.kind, 'weather_moves')));
const stepsOf = (taskId: string) => inCompany(t, A(), (tx) => tx.select().from(agentTaskSteps).where(eq(agentTaskSteps.taskId, taskId)));
const run = () => runWeatherWatch(t.deps, A(), META);

type MovePayload = { appointmentId: string; start: string; end: string; userId: string; reason: string };
type TextPayload = { purpose: string; kind: string; dedupePrefix: string; messages: { customerId: string; jobId: string | null; body: string }[] };

async function onlyTask() {
  const rows = await tasks();
  expect(rows).toHaveLength(1);
  const task = rows[0]!;
  const steps = (await stepsOf(task.id)).sort((a, b) => a.position - b.position);
  return { task, steps };
}

describe('runWeatherWatch', () => {
  beforeEach(async () => {
    t = await makeTestApp();
    t.clock.set(SIX_AM);
    await agentOn(false);
  });

  test('rain on the install day: move to the next clear free workday, then text', async () => {
    const v = await seedVisit({ first: 'Ann', day: TUE });
    t.weather.hourlyValue = rainOn(TUE);
    t.llm.scriptDraft(new LlmUnavailableError('down'));

    await run();

    const { task, steps } = await onlyTask();
    expect(task.title).toBe('Rain on Tuesday — move 1 install?');
    expect(task.agent).toBe('scheduler');
    expect(steps.map((s) => s.type)).toEqual(['move_appointment', 'send_personal_texts']);
    const move = steps[0]!.payload as unknown as MovePayload;
    expect(move.appointmentId).toBe(v.appointmentId);
    expect(move.start).toBe(dayStart(WED).toISOString());
    expect(move.end).toBe(dayStart(WED + 1).toISOString());
    expect(move.userId).toBe(t.seed.a.owner.userId);
    expect(move.reason).toContain('70% rain');
    expect(move.reason).toContain('Tuesday');
    const texts = steps[1]!.payload as unknown as TextPayload;
    expect(texts.messages.map((m) => m.customerId)).toEqual([v.customerId]);
    expect(texts.dedupePrefix).toBe('weather:2026-10-12:6');
    expect(task.expiresAt?.toISOString()).toBe(dayStart(TUE).toISOString());
    expect(t.llm.draftCalls[0]?.instruction).toBe('weather_move');
  });

  test('wind alone reads as a wind task', async () => {
    await seedVisit({ first: 'Bo', day: TUE });
    t.weather.hourlyValue = forecast((d) => (d === TUE ? { gustMph: 40 } : {}));
    t.llm.scriptDraft(new LlmUnavailableError('down'));

    await run();

    const { task, steps } = await onlyTask();
    expect(task.title.startsWith('Wind on')).toBe(true);
    expect((steps[0]!.payload as unknown as MovePayload).reason).toContain('Gusts to 40 mph');
    const body = (steps[1]!.payload as unknown as TextPayload).messages[0]!.body;
    expect(body).toContain('Wind is forecast on Tuesday');
  });

  test('a busy next day for the installer is skipped', async () => {
    await seedVisit({ first: 'Cy', day: TUE });
    await seedVisit({ first: 'Dee', kind: 'inspection', day: WED });
    t.weather.hourlyValue = rainOn(TUE);
    t.llm.scriptDraft(new LlmUnavailableError('down'));

    await run();

    const { steps } = await onlyTask();
    expect((steps[0]!.payload as unknown as MovePayload).start).toBe(dayStart(WED + 1).toISOString());
  });

  test('no forecast makes nothing', async () => {
    await seedVisit({ first: 'Eve', day: TUE });
    t.weather.hourlyValue = null;
    await run();
    expect(await tasks()).toHaveLength(0);
  });

  test('a clear forecast makes nothing', async () => {
    await seedVisit({ first: 'Fay', day: TUE });
    t.weather.hourlyValue = forecast();
    await run();
    expect(await tasks()).toHaveLength(0);
  });

  test('a paused scheduler makes nothing', async () => {
    await seedVisit({ first: 'Gus', day: TUE });
    t.weather.hourlyValue = rainOn(TUE);
    await agentOn(true);
    await run();
    expect(await tasks()).toHaveLength(0);
  });

  test('a later run the same day while the task is open makes no second task', async () => {
    await seedVisit({ first: 'Hal', day: TUE });
    t.weather.hourlyValue = rainOn(TUE);
    await run();
    t.clock.set(new Date(SIX_AM.getTime() + 8 * HOUR));
    await run();
    expect(await tasks()).toHaveLength(1);
  });

  test('a draft that mentions a price falls back to the template text', async () => {
    const v = await seedVisit({ first: 'Ida', day: TUE });
    t.weather.hourlyValue = rainOn(TUE);
    t.llm.scriptDraft({
      texts: [{ jobId: v.jobId, body: 'Hi Ida, rain is coming so we move you to Wednesday. Your total is $5,000.' }],
      refused: false,
      usage: USAGE,
    });

    await run();

    const { steps } = await onlyTask();
    const body = (steps[1]!.payload as unknown as TextPayload).messages[0]!.body;
    expect(body).toBe(
      `Hi Ida, it's ${t.seed.a.name}. Rain is forecast on Tuesday, so we'd like to move your roof install to Wednesday. Reply here or call us if that doesn't work.`,
    );
  });

  test('a good draft is used', async () => {
    const v = await seedVisit({ first: 'Jo', day: TUE });
    t.weather.hourlyValue = rainOn(TUE);
    const body = 'Hi Jo, rain is forecast on Tuesday, so can we move your install to Wednesday? Reply here to confirm.';
    t.llm.scriptDraft({ texts: [{ jobId: v.jobId, body }], refused: false, usage: USAGE });

    await run();

    const { steps } = await onlyTask();
    expect((steps[1]!.payload as unknown as TextPayload).messages.map((m) => m.body)).toEqual([body]);
  });

  test('a customer with no phone gets no text step', async () => {
    await seedVisit({ first: 'Kai', day: TUE, phone: false });
    t.weather.hourlyValue = rainOn(TUE);
    t.llm.scriptDraft(new LlmUnavailableError('down'));

    await run();

    const { steps } = await onlyTask();
    expect(steps.map((s) => s.type)).toEqual(['move_appointment']);
  });

  test('no clear day in two weeks: nothing to move, no task', async () => {
    await seedVisit({ first: 'Lee', day: TUE });
    // Rain on every forecast day, and the installer is booked on every day after the forecast ends.
    t.weather.hourlyValue = rainOn(0, 1, 2, 3, 4, 5, 6, 7);
    for (let d = 8; d <= 15; d++) await seedVisit({ first: `Busy${d}`, kind: 'inspection', day: d });
    t.llm.scriptDraft(new LlmUnavailableError('down'));

    await run();

    expect(await tasks()).toHaveLength(0);
  });
});
