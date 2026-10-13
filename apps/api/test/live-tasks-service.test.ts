import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, test } from 'vitest';
import { agentTasks, agentTaskSteps, listRecountSteps, listTaskEvents, loadBaselineOverrides, setBaselineOverrides } from '@roofline/db';
import { stepMinutes, stepTypes, type StepResult } from '@roofline/shared';
import { addToLiveTask, closeLiveTasksForSubject, createLiveTask, listApprovals, type NewLiveTask } from '../src/tasks/service.ts';
import { Actors, inCompany } from './crm-helpers.ts';
import { makeTestApp, type TestApp } from './helpers.ts';

const NOW = new Date('2026-10-12T15:00:00.000Z');

let t: TestApp;
let actors: Actors;

beforeEach(async () => {
  t = await makeTestApp();
  t.clock.set(NOW);
  actors = new Actors(t);
});

const idOf = (company: 'a' | 'b') => t.seed[company].companyId;
const ctxOf = (company: 'a' | 'b') => ({ companyId: idOf(company), userId: null, role: 'system' as const, canApproveSpend: false });

function live(overrides: Partial<NewLiveTask> = {}): NewLiveTask {
  return {
    agent: 'front_desk',
    kind: 'call',
    title: 'Answered a call',
    subjectType: 'job',
    subjectId: randomUUID(),
    step: { type: 'front_desk_call', result: { seconds: 180, bookings: 0, spam: 0 } },
    status: 'done',
    idempotencyKey: `fd-call:${randomUUID()}`,
    ...overrides,
  };
}

const make = (input: NewLiveTask, company: 'a' | 'b' = 'a') =>
  inCompany(t, idOf(company), (tx) => createLiveTask(tx, ctxOf(company), input, t.clock.now()));

const close = (subjectId: string, company: 'a' | 'b' = 'a') =>
  inCompany(t, idOf(company), (tx) => closeLiveTasksForSubject(tx, ctxOf(company), 'job', subjectId, t.clock.now()));

const taskRow = (id: string, company: 'a' | 'b' = 'a') =>
  inCompany(t, idOf(company), async (tx) => (await tx.select().from(agentTasks).where(eq(agentTasks.id, id)))[0]!);
const stepRows = (taskId: string) =>
  inCompany(t, idOf('a'), (tx) => tx.select().from(agentTaskSteps).where(eq(agentTaskSteps.taskId, taskId)));
const events = (taskId: string, company: 'a' | 'b' = 'a') =>
  inCompany(t, idOf(company), (tx) => listTaskEvents(tx, ctxOf(company), taskId));
const allTasks = () => inCompany(t, idOf('a'), (tx) => tx.select().from(agentTasks));

/** The minutes the shared rules give a finished step, with the company's own baselines. */
async function expectedMinutes(type: 'front_desk_call' | 'front_desk_texts', result: StepResult): Promise<number> {
  const overrides = await inCompany(t, idOf('a'), (tx) => loadBaselineOverrides(tx, ctxOf('a')));
  const m = stepMinutes(stepTypes[type] as never, { label: 'x' } as never, result, overrides);
  return Math.round(m.minutes);
}

describe('createLiveTask', () => {
  test('createLiveTask makes a done live task with one finished step and events created, step_done, finished', async () => {
    const { taskId, created } = await make(live());
    expect(created).toBe(true);
    const task = await taskRow(taskId);
    expect(task).toMatchObject({ mode: 'live', agent: 'front_desk', status: 'done', kind: 'call' });
    const steps = await stepRows(taskId);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ type: 'front_desk_call', status: 'done', approvalClass: 'internal' });
    const kinds = (await events(taskId)).map((e) => e.kind);
    expect(kinds).toEqual(['created', 'step_done', 'finished']);
  });

  test('createLiveTask is idempotent on the key (second call created:false, one task row)', async () => {
    const input = live();
    const first = await make(input);
    const second = await make(input);
    expect(second).toEqual({ taskId: first.taskId, created: false });
    expect((await allTasks()).filter((r) => r.id === first.taskId)).toHaveLength(1);
    expect((await events(first.taskId)).filter((e) => e.kind === 'finished')).toHaveLength(1);
  });

  test('front_desk_call minutes: seconds 180, bookings 0 -> call baseline + 3 call minutes', async () => {
    const result = { seconds: 180, bookings: 0, spam: 0 };
    const { taskId } = await make(live({ step: { type: 'front_desk_call', result } }));
    const want = await expectedMinutes('front_desk_call', result);
    expect(want).toBeGreaterThan(0);
    expect((await taskRow(taskId)).minutesSaved).toBe(want);
  });

  test('spam call result {seconds:60,spam:1} saves 1 minute', async () => {
    const result = { seconds: 60, bookings: 0, spam: 1 };
    const { taskId } = await make(live({ step: { type: 'front_desk_call', result } }));
    expect((await taskRow(taskId)).minutesSaved).toBe(await expectedMinutes('front_desk_call', result));
    expect((await taskRow(taskId)).minutesSaved).toBe(1);
  });

  test('booking adds 3 minutes per booking', async () => {
    const none = await make(live({ step: { type: 'front_desk_call', result: { seconds: 120, bookings: 0, spam: 0 } } }));
    const two = await make(live({ step: { type: 'front_desk_call', result: { seconds: 120, bookings: 2, spam: 0 } } }));
    expect((await taskRow(two.taskId)).minutesSaved! - (await taskRow(none.taskId)).minutesSaved!).toBe(6);
  });

  test('front_desk_texts replies 4 bookings 1 -> 2*4 + 3 = 11', async () => {
    const result = { replies: 4, bookings: 1 };
    const { taskId } = await make(
      live({ kind: 'text_conversation', step: { type: 'front_desk_texts', result }, idempotencyKey: `fd-texts:${randomUUID()}:2026-10-12` }),
    );
    expect(await expectedMinutes('front_desk_texts', result)).toBe(11);
    expect((await taskRow(taskId)).minutesSaved).toBe(11);
  });

  test('needs_attention status writes step_attention and no finished event', async () => {
    const { taskId } = await make(live({ status: 'needs_attention' }));
    const task = await taskRow(taskId);
    expect(task.status).toBe('needs_attention');
    expect(task.minutesSaved).toBeGreaterThan(0);
    const kinds = (await events(taskId)).map((e) => e.kind);
    expect(kinds).toContain('step_attention');
    expect(kinds).not.toContain('finished');
    expect((await stepRows(taskId))[0]!.status).toBe('done');
  });
});

describe('addToLiveTask', () => {
  test('a repeat keeps past replies at their old value: 1 reply at 2 min, baseline to 5, 1 more reply -> 7 minutes, 2 units', async () => {
    const key = `fd-texts:${randomUUID()}:2026-10-12`;
    const { taskId } = await make(
      live({ kind: 'text_conversation', step: { type: 'front_desk_texts', result: { replies: 1, bookings: 0 } }, idempotencyKey: key }),
    );
    await inCompany(t, idOf('a'), (tx) => setBaselineOverrides(tx, ctxOf('a'), { text_reply: 5 }, t.clock.now()));
    await inCompany(t, idOf('a'), (tx) => addToLiveTask(tx, ctxOf('a'), key, { replies: 1, bookings: 0 }, t.clock.now()));
    const [step] = await stepRows(taskId);
    expect(step!.minutesSaved).toBe(7);
    expect(step!.units).toBe(2);
    expect(step!.minutesPerUnit).toBe(3.5);
    expect((await taskRow(taskId)).minutesSaved).toBe(7);
  });

  test('listRecountSteps runs inside a transaction (it locks the steps it returns)', async () => {
    await make(live({ kind: 'text_conversation', step: { type: 'front_desk_texts', result: { replies: 1, bookings: 0 } }, idempotencyKey: `fd-texts:${randomUUID()}:2026-10-12` }));
    const rows = await inCompany(t, idOf('a'), (tx) =>
      listRecountSteps(tx, ctxOf('a'), { from: new Date('2026-01-01T00:00:00Z'), to: new Date('2027-01-01T00:00:00Z'), afterId: null, limit: 10 }),
    );
    expect(rows.length).toBeGreaterThan(0);
  });
});

describe('closeLiveTasksForSubject', () => {
  test('closeLiveTasksForSubject moves it to done and writes exactly one finished event; second call closes 0', async () => {
    const subjectId = randomUUID();
    const { taskId } = await make(live({ status: 'needs_attention', subjectId }));
    expect(await close(subjectId)).toBe(1);
    expect((await taskRow(taskId)).status).toBe('done');
    expect(await close(subjectId)).toBe(0);
    expect((await events(taskId)).filter((e) => e.kind === 'finished')).toHaveLength(1);
  });

  test('another company cannot see or close the task (cross-tenant)', async () => {
    const subjectId = randomUUID();
    const input = live({ status: 'needs_attention', subjectId });
    const { taskId } = await make(input);
    expect(await close(subjectId, 'b')).toBe(0);
    expect((await taskRow(taskId)).status).toBe('needs_attention');
    const seenByB = await inCompany(t, idOf('b'), (tx) => tx.select().from(agentTasks).where(eq(agentTasks.id, taskId)));
    expect(seenByB).toHaveLength(0);
    // Company B's own call is its own task, not company A's.
    const other = await make(live({ idempotencyKey: `fd-call:${randomUUID()}` }), 'b');
    expect(other.created).toBe(true);
    expect(other.taskId).not.toBe(taskId);
  });
});

describe('live tasks and the approval queue', () => {
  test('live tasks never appear in listApprovals / GET /api/approvals', async () => {
    await make(live());
    await make(live({ status: 'needs_attention' }));
    const owner = await actors.as('owner');
    const res = await owner.get('/api/approvals');
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(0);
    expect(res.body.tasks).toEqual([]);
    const direct = await inCompany(t, idOf('a'), (tx) =>
      listApprovals(tx, { ...ctxOf('a'), role: 'owner', canApproveSpend: true }, t.clock.now()),
    );
    expect(direct.tasks).toEqual([]);
  });
});
