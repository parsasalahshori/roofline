import { asc, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, test } from 'vitest';
import { agentTaskEvents, agentTaskSteps, agentTasks } from '@roofline/db';
import { startLiveTask, writeLiveNote } from '../src/tasks/service.ts';
import { inCompany } from './crm-helpers.ts';
import { makeTestApp, type TestApp } from './helpers.ts';
import { agentCtx } from './task-helpers.ts';

/*
 * G1's live one-step tasks go through the task service (the one-writer rule, sentinel pass 14):
 * `writeLiveNote` for a finished note and `startLiveTask` for a step the agent starts at once.
 */

let t: TestApp;

beforeEach(async () => {
  t = await makeTestApp();
});

async function read(taskId: string) {
  return inCompany(t, t.seed.a.companyId, async (tx) => ({
    task: (await tx.select().from(agentTasks).where(eq(agentTasks.id, taskId)))[0]!,
    steps: await tx.select().from(agentTaskSteps).where(eq(agentTaskSteps.taskId, taskId)),
    events: await tx.select().from(agentTaskEvents).where(eq(agentTaskEvents.taskId, taskId)).orderBy(asc(agentTaskEvents.at)),
  }));
}

describe('writeLiveNote', () => {
  test('a finished live task: its no-op step done, events created, step_done (0 minutes), finished; no time saved', async () => {
    const ctx = agentCtx(t.seed.a.companyId);
    const now = t.clock.now();
    const taskId = await inCompany(t, ctx.companyId, (tx) =>
      writeLiveNote(tx, ctx, { agent: 'claims', kind: 'claims_reply_noted', title: 'Claim updated', label: 'Claim updated' }, now),
    );
    const { task, steps, events } = await read(taskId);
    expect(task).toMatchObject({ mode: 'live', status: 'done', agent: 'claims', kind: 'claims_reply_noted' });
    expect(Number(task.minutesSaved ?? 0)).toBe(0);
    expect(steps.map((s) => [s.type, s.status])).toEqual([['demo_noop', 'done']]);
    expect(Number(steps[0]!.minutesSaved ?? 0)).toBe(0);
    expect(events.map((e) => e.kind)).toEqual(['created', 'step_done', 'finished']);
    expect(events[1]!.data).toEqual({ units: 0, minutes: 0 });
  });
});

describe('startLiveTask', () => {
  test('a running live task whose one step is queued, approved now', async () => {
    const ctx = agentCtx(t.seed.a.companyId);
    const now = t.clock.now();
    const { taskId, stepId } = await inCompany(t, ctx.companyId, (tx) =>
      startLiveTask(
        tx,
        ctx,
        { agent: 'claims', kind: 'claim_packet', title: 'Build the claim packet', step: { type: 'demo_noop', payload: { label: 'Packet' } } },
        now,
      ),
    );
    const { task, steps, events } = await read(taskId);
    expect(task).toMatchObject({ mode: 'live', status: 'running' });
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ id: stepId, status: 'queued' });
    expect(steps[0]!.approvedAt?.getTime()).toBe(now.getTime());
    expect(events.map((e) => e.kind)).toEqual(['created']);
  });
});
