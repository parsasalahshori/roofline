import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, test } from 'vitest';
import { agentTasks, agentTaskSteps, timeRecounts } from '@roofline/db';
import { Actors, type CompanyKey, dbAudit, inCompany } from './crm-helpers.ts';
import { makeTestApp, type TestApp } from './helpers.ts';
import { dbSteps, dbTask, newTask } from './task-helpers.ts';

const DAY = 24 * 60 * 60 * 1000;
const RECOUNT = '/api/agents/time-baselines/recount';
const BASELINES = '/api/agents/time-baselines';

let t: TestApp;
let actors: Actors;

beforeEach(async () => {
  t = await makeTestApp();
  actors = new Actors(t);
});

type Spec = {
  /** Whole days ago the step last changed. */
  daysAgo?: number;
  type?: string;
  sent?: number;
  /** The frozen snapshot. */
  units?: number;
  minutesPerUnit?: number;
  minutesSaved?: number;
};

/** Makes a task and turns its first steps into done steps with the given frozen snapshots. */
async function seedTask(specs: Spec[], company: CompanyKey = 'a'): Promise<{ taskId: string; stepIds: string[] }> {
  const { taskId } = await newTask(t, company);
  const steps = await dbSteps(t, company, taskId);
  const stepIds: string[] = [];
  for (const [i, spec] of specs.entries()) {
    const step = steps[i]!;
    stepIds.push(step.id);
    const units = spec.units ?? spec.sent ?? 10;
    const mpu = spec.minutesPerUnit ?? 1.5;
    await inCompany(t, t.seed[company].companyId, (tx) =>
      tx
        .update(agentTaskSteps)
        .set({
          type: spec.type ?? 'send_sms_batch',
          payload: { purpose: 'informational', body: 'Hello', customerIds: [] },
          status: 'done',
          result: { sent: spec.sent ?? 10 },
          baselineKey: 'text_sent',
          units,
          minutesPerUnit: mpu,
          minutesSaved: spec.minutesSaved ?? Math.round(units * mpu * 100) / 100,
          updatedAt: new Date(t.clock.now().getTime() - (spec.daysAgo ?? 1) * DAY),
        })
        .where(eq(agentTaskSteps.id, step.id)),
    );
  }
  return { taskId, stepIds };
}

const stepRow = async (company: CompanyKey, id: string) =>
  inCompany(t, t.seed[company].companyId, async (tx) => (await tx.select().from(agentTaskSteps).where(eq(agentTaskSteps.id, id)))[0]!);

async function setTextBaseline(minutes: number | null): Promise<void> {
  const owner = await actors.as('owner');
  const res = await owner.put(BASELINES).send({ minutes: { text_sent: minutes } });
  expect(res.status).toBe(200);
}

const recounts = (company: CompanyKey) =>
  inCompany(t, t.seed[company].companyId, (tx) => tx.select().from(timeRecounts));

describe('recount', () => {
  test('recount dry run returns before and after and writes nothing', async () => {
    const { stepIds, taskId } = await seedTask([{ sent: 10 }]);
    await setTextBaseline(2);
    const owner = await actors.as('owner');
    const res = await owner.post(`${RECOUNT}?dryRun=1`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ dryRun: true, beforeMinutes: 15, afterMinutes: 20, steps: 1 });
    expect((await stepRow('a', stepIds[0]!)).minutesSaved).toBe(15);
    expect(await recounts('a')).toHaveLength(0);
    expect(await dbAudit(t, t.seed.a.companyId, 'agents.recount')).toHaveLength(0);
    expect((await dbTask(t, 'a', taskId)).minutesSaved).not.toBe(20);
  });

  test('recount real run updates snapshots, inserts one time_recounts row and one audit_log entry with before and after totals', async () => {
    const { stepIds } = await seedTask([{ sent: 10 }]);
    await setTextBaseline(2);
    const owner = await actors.as('owner');
    const res = await owner.post(RECOUNT);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ dryRun: false, beforeMinutes: 15, afterMinutes: 20, steps: 1 });
    const step = await stepRow('a', stepIds[0]!);
    expect(step.minutesSaved).toBe(20);
    expect(step.minutesPerUnit).toBe(2);
    expect(step.units).toBe(10);
    const rows = await recounts('a');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ beforeMinutes: 15, afterMinutes: 20, byUserId: actors.user('owner').userId });
    const audit = await dbAudit(t, t.seed.a.companyId, 'agents.recount');
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit[0])).toContain('20');
  });

  test('recount only touches steps from the last 90 days', async () => {
    const { stepIds } = await seedTask([{ daysAgo: 10 }, { daysAgo: 120 }]);
    await setTextBaseline(2);
    const owner = await actors.as('owner');
    const res = await owner.post(RECOUNT);
    expect(res.body.steps).toBe(1);
    expect((await stepRow('a', stepIds[0]!)).minutesSaved).toBe(20);
    expect((await stepRow('a', stepIds[1]!)).minutesSaved).toBe(15);
  });

  test('editing a baseline alone changes no old snapshot until a recount runs', async () => {
    const { stepIds, taskId } = await seedTask([{ sent: 10 }]);
    await setTextBaseline(4);
    expect((await stepRow('a', stepIds[0]!)).minutesSaved).toBe(15);
    expect((await stepRow('a', stepIds[0]!)).minutesPerUnit).toBe(1.5);
    const before = (await dbTask(t, 'a', taskId)).minutesSaved;
    const owner = await actors.as('owner');
    await owner.post(RECOUNT);
    expect((await stepRow('a', stepIds[0]!)).minutesSaved).toBe(40);
    expect((await dbTask(t, 'a', taskId)).minutesSaved).not.toBe(before);
  });

  test('recount recomputes with stepMinutes, not units times minutes_per_unit', async () => {
    // 200 texts at 1.5 is 300 minutes, but text_sent is capped at 120.
    const { stepIds } = await seedTask([{ sent: 200, units: 200, minutesPerUnit: 1.5, minutesSaved: 120 }]);
    await setTextBaseline(1);
    const owner = await actors.as('owner');
    const res = await owner.post(RECOUNT);
    expect(res.body).toMatchObject({ beforeMinutes: 120, afterMinutes: 120 });
    const step = await stepRow('a', stepIds[0]!);
    expect(step.minutesSaved).toBe(120);
    expect(step.minutesPerUnit).toBe(0.6);
    expect(step.minutesSaved).not.toBe(step.units! * 1);
  });

  test('recount skips steps whose type is unknown', async () => {
    const { stepIds } = await seedTask([{ type: 'retired_step_type', minutesSaved: 99 }, { sent: 10 }]);
    await setTextBaseline(2);
    const owner = await actors.as('owner');
    const res = await owner.post(RECOUNT);
    expect(res.status).toBe(200);
    expect((await stepRow('a', stepIds[0]!)).minutesSaved).toBe(99);
    expect((await stepRow('a', stepIds[1]!)).minutesSaved).toBe(20);
    expect(res.body.steps).toBe(1);
  });

  test('recount is owner only: office and rep get 403 and company B is untouched', async () => {
    const mine = await seedTask([{ sent: 10 }]);
    const theirs = await seedTask([{ sent: 10 }], 'b');
    await setTextBaseline(2);
    for (const who of ['office', 'rep'] as const) {
      const agent = await actors.as(who);
      expect((await agent.post(RECOUNT)).status).toBe(403);
      expect((await agent.post(`${RECOUNT}?dryRun=1`)).status).toBe(403);
    }
    expect((await stepRow('a', mine.stepIds[0]!)).minutesSaved).toBe(15);
    const owner = await actors.as('owner');
    expect((await owner.post(RECOUNT)).status).toBe(200);
    expect((await stepRow('b', theirs.stepIds[0]!)).minutesSaved).toBe(15);
    expect(await recounts('b')).toHaveLength(0);
    expect(await dbAudit(t, t.seed.b.companyId, 'agents.recount')).toHaveLength(0);
  });

  test('recount task minutes_saved equals the rounded sum of its steps', async () => {
    const { taskId, stepIds } = await seedTask([{ sent: 7 }, { sent: 5 }]);
    await setTextBaseline(2.5);
    const owner = await actors.as('owner');
    await owner.post(RECOUNT);
    const steps = await Promise.all(stepIds.map((id) => stepRow('a', id)));
    const sum = steps.reduce((acc, s) => acc + (s.minutesSaved ?? 0), 0);
    expect(sum).toBe(30);
    expect((await dbTask(t, 'a', taskId)).minutesSaved).toBe(Math.round(sum));
    const [task] = await inCompany(t, t.seed.a.companyId, (tx) => tx.select().from(agentTasks).where(eq(agentTasks.id, taskId)));
    expect(task!.minutesSaved).toBe(30);
  });
});
