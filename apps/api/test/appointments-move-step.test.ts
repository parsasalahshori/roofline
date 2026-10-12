import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, test } from 'vitest';
import {
  appointments,
  calendarBusyBlocks,
  calendarConnections,
  createAppointment,
  type StepRow,
  withTenant,
} from '@roofline/db';
import type { StepType } from '@roofline/shared';
import { moveAppointmentStep } from '../src/agents/appointments-steps.ts';
import { createTask } from '../src/tasks/service.ts';
import { inCompany } from './crm-helpers.ts';
import { makeTestApp, type TestApp } from './helpers.ts';
import { DAY, DAYTIME } from './sms-helpers.ts';
import { agentCtx, dbSteps } from './task-helpers.ts';

let t: TestApp;

beforeEach(async () => {
  t = await makeTestApp();
  t.clock.set(DAYTIME);
});

const idOf = () => t.seed.a.companyId;
const repId = () => t.seed.a.rep.userId;
const OLD_START = () => new Date(DAYTIME.getTime() + 2 * DAY);
const NEW_START = () => new Date(DAYTIME.getTime() + 4 * DAY);
const hour = 60 * 60 * 1000;
const CHANGED = 'That install was changed since this plan was made.';
const NOT_FREE = "That day isn't free any more.";

/** An all-day install for the rep on the old day. */
async function anInstall(): Promise<string> {
  const ctx = agentCtx(idOf());
  const made = await withTenant(t.deps.pools, ctx, (tx) =>
    createAppointment(
      tx,
      ctx,
      { kind: 'install', allDay: true, startsAt: OLD_START(), endsAt: new Date(OLD_START().getTime() + 24 * hour), assignedUserId: repId(), source: 'scheduler' },
      t.clock.now(),
    ),
  );
  return made.row.id;
}

/** A task with one `move_appointment` step; returns the step as the runner would hand it over. */
async function moveStep(appointmentId: string, over: Record<string, unknown> = {}): Promise<{ taskId: string; step: () => Promise<StepRow> }> {
  const ctx = agentCtx(idOf());
  const payload = {
    appointmentId,
    start: NEW_START().toISOString(),
    end: new Date(NEW_START().getTime() + 24 * hour).toISOString(),
    userId: repId(),
    reason: 'Rain is likely that day.',
    ...over,
  };
  const { taskId } = await withTenant(t.deps.pools, ctx, (tx) =>
    createTask(
      tx,
      ctx,
      {
        agent: 'scheduler',
        kind: 'scheduler_weather',
        title: 'Move an install',
        steps: [{ type: 'move_appointment' as StepType, payload }],
      },
      { now: t.clock.now(), allowInternalStepTypes: true },
    ),
  );
  return { taskId, step: async () => (await dbSteps(t, 'a', taskId))[0]! };
}

const run = async (m: { step: () => Promise<StepRow> }) => moveAppointmentStep(t.deps, agentCtx(idOf()), await m.step());
const rowOf = (id: string) => inCompany(t, idOf(), async (tx) => (await tx.select().from(appointments).where(eq(appointments.id, id)))[0]!);

describe('the move_appointment step', () => {
  test('moves the install, keeps it all day, marks the task and queues the calendar push', async () => {
    const id = await anInstall();
    const m = await moveStep(id);
    const out = await run(m);

    expect(out).toEqual({ status: 'done', result: { moved: 1 } });
    const row = await rowOf(id);
    expect(row.allDay).toBe(true);
    expect(row.movedByTaskId).toBe(m.taskId);
    expect(row.startsAt.getTime()).toBeGreaterThanOrEqual(NEW_START().getTime() - DAY);
    expect(row.startsAt.getTime()).toBeLessThanOrEqual(NEW_START().getTime() + DAY);
    expect(row.startsAt.getTime()).not.toBe(OLD_START().getTime());
    expect(t.jobs.sent).toContainEqual({ name: 'calendar-push', data: { companyId: idOf(), appointmentId: id }, singletonKey: id });
  });

  test('refuses when the person has another visit that day', async () => {
    const id = await anInstall();
    const ctx = agentCtx(idOf());
    await withTenant(t.deps.pools, ctx, (tx) =>
      createAppointment(
        tx,
        ctx,
        { kind: 'inspection', startsAt: new Date(NEW_START().getTime() + 2 * hour), endsAt: new Date(NEW_START().getTime() + 3 * hour), assignedUserId: repId(), source: 'scheduler' },
        t.clock.now(),
      ),
    );
    const before = await rowOf(id);
    const out = await run(await moveStep(id));

    expect(out).toEqual({ status: 'failed', result: {}, errorPlain: NOT_FREE });
    expect((await rowOf(id)).startsAt).toEqual(before.startsAt);
    expect(t.jobs.sent).toHaveLength(0);
  });

  test('refuses when a calendar busy block overlaps', async () => {
    const id = await anInstall();
    await inCompany(t, idOf(), async (tx) => {
      const [connection] = await tx
        .insert(calendarConnections)
        .values({
          companyId: idOf(),
          userId: repId(),
          provider: 'google',
          accountEmail: 'rep@example.test',
          calendarId: 'primary',
          calendarName: 'Work',
          encryptedCredentials: Buffer.from('not-a-real-token'),
        })
        .returning({ id: calendarConnections.id });
      await tx.insert(calendarBusyBlocks).values({
        companyId: idOf(),
        connectionId: connection!.id,
        userId: repId(),
        providerEventId: 'event-1',
        startsAt: new Date(NEW_START().getTime() + hour),
        endsAt: new Date(NEW_START().getTime() + 2 * hour),
      });
    });
    const before = await rowOf(id);
    const out = await run(await moveStep(id));

    expect(out).toEqual({ status: 'failed', result: {}, errorPlain: NOT_FREE });
    expect((await rowOf(id)).startsAt).toEqual(before.startsAt);
  });

  test('refuses a canceled install and a different assignee', async () => {
    const canceled = await anInstall();
    await inCompany(t, idOf(), (tx) => tx.update(appointments).set({ status: 'canceled' }).where(eq(appointments.id, canceled)));
    expect(await run(await moveStep(canceled))).toEqual({ status: 'failed', result: {}, errorPlain: CHANGED });

    const other = await anInstall();
    const out = await run(await moveStep(other, { userId: t.seed.a.owner.userId }));
    expect(out).toEqual({ status: 'failed', result: {}, errorPlain: CHANGED });
    expect((await rowOf(other)).startsAt).toEqual(OLD_START());
  });

  test('a rerun after success reports moved 1 and changes nothing more', async () => {
    const id = await anInstall();
    const m = await moveStep(id);
    expect(await run(m)).toEqual({ status: 'done', result: { moved: 1 } });
    const first = await rowOf(id);

    t.clock.set(new Date(DAYTIME.getTime() + hour));
    expect(await run(m)).toEqual({ status: 'done', result: { moved: 1 } });

    const again = await rowOf(id);
    expect(again.updatedAt).toEqual(first.updatedAt);
    expect(again.startsAt).toEqual(first.startsAt);
    expect(again.movedByTaskId).toBe(m.taskId);
  });

  test('an unreadable payload needs attention', async () => {
    const id = await anInstall();
    const step = await (await moveStep(id)).step();
    const out = await moveAppointmentStep(t.deps, agentCtx(idOf()), { ...step, payload: { appointmentId: id } });

    expect(out).toEqual({ status: 'needs_attention', result: {}, errorPlain: "We couldn't read this move. Please make this plan again." });
    expect((await rowOf(id)).startsAt).toEqual(OLD_START());
  });
});
