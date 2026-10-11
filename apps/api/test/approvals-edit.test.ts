import { eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, inject, test } from 'vitest';
import {
  agentTasks,
  agentTaskSteps,
  auditLog,
  createCustomer,
  createPools,
  type Pools,
  type TenantContext,
  updatePendingStep,
  withTenant,
  type Tx,
} from '@roofline/db';
import type { StepType } from '@roofline/shared';
import { AppError } from '../src/errors.ts';
import { createTask, editStep, type NewTask } from '../src/tasks/service.ts';
import { Actors, dbAudit, inCompany, NO_UUID, NOT_FOUND } from './crm-helpers.ts';
import { makeTestApp, type TestApp } from './helpers.ts';

const STALE = "This changed while you were looking. Here's the latest.";
const NOT_ALLOWED = "Your role can't do that. Ask the owner.";
const NOTHING = "There's nothing to change.";
const MARKETING = 'Marketing texts must include your company name and "Reply STOP to opt out".';
const NO_CUSTOMERS = "Some of these customers don't exist.";
const STOP_BODY = "Hi {first_name}, it's {company}. Free roof check this week. Reply STOP to opt out.";

const NOW = new Date('2026-10-12T15:00:00.000Z');
const HOUR = 60 * 60 * 1000;

let t: TestApp;
let actors: Actors;

beforeEach(async () => {
  t = await makeTestApp();
  t.clock.set(NOW);
  actors = new Actors(t);
});

// ---------------------------------------------------------------------------------------------
// helpers

type Company = 'a' | 'b';

/** The runner / an agent acting for a company: no signed-in person. */
const agentCtx = (companyId: string): TenantContext => ({ companyId, userId: null, role: 'system', canApproveSpend: false });

const idOf = (company: Company) => t.seed[company].companyId;

/** Creates a task the way an agent does: through the service, inside the company's transaction. */
function newTask(company: Company, input: Partial<NewTask> = {}): Promise<{ taskId: string }> {
  const ctx = agentCtx(idOf(company));
  const full: NewTask = {
    agent: 'storm_scout',
    kind: 'storm_plan',
    title: 'Storm plan: Elm Street',
    summary: 'Three steps for the Elm Street hail swath.',
    steps: [
      { type: 'demo_message', payload: { label: 'Text 31 customers' } },
      { type: 'demo_noop', payload: { label: 'Door-knock routes for 4 reps' } },
      { type: 'demo_spend', payload: { label: 'Google + Facebook ads on the swath', maxSpendCents: 27000 } },
    ],
    ...input,
  };
  return withTenant(t.deps.pools, ctx, (tx) => createTask(tx, ctx, full, { now: t.clock.now(), ip: '203.0.113.9' }));
}

/** Adds customers with first names to a company and returns their ids, in the order given. */
async function newCustomers(company: Company, firstNames: string[]): Promise<string[]> {
  const ctx = agentCtx(idOf(company));
  return inCompany(t, idOf(company), async (tx) => {
    const ids: string[] = [];
    for (const [i, firstName] of firstNames.entries()) {
      const row = await createCustomer(tx, ctx, { displayName: `${firstName} Test ${i}`, firstName }, { now: t.clock.now() });
      ids.push(row.id);
    }
    return ids;
  });
}

const smsStep = (customerIds: string[], overrides: Record<string, unknown> = {}) => ({
  type: 'send_sms_batch' as StepType,
  payload: { purpose: 'marketing', body: STOP_BODY, customerIds, ...overrides },
});

const dbTask = (company: Company, id: string) =>
  inCompany(t, idOf(company), async (tx) => (await tx.select().from(agentTasks).where(eq(agentTasks.id, id)))[0]!);

const dbSteps = (company: Company, taskId: string) =>
  inCompany(t, idOf(company), (tx) =>
    tx.select().from(agentTaskSteps).where(eq(agentTaskSteps.taskId, taskId)).orderBy(agentTaskSteps.position),
  );

const setTask = (company: Company, id: string, set: Partial<typeof agentTasks.$inferInsert>) =>
  inCompany(t, idOf(company), (tx) => tx.update(agentTasks).set(set).where(eq(agentTasks.id, id)));

const setStep = (company: Company, id: string, set: Partial<typeof agentTaskSteps.$inferInsert>) =>
  inCompany(t, idOf(company), (tx) => tx.update(agentTaskSteps).set(set).where(eq(agentTaskSteps.id, id)));

/** Lets company A's office user approve spend (the owner flips it in the team screen). */
async function delegateSpendToOffice(): Promise<void> {
  const owner = await actors.as('owner');
  const team = await owner.get('/api/team');
  const office = team.body.members.find((m: { email: string }) => m.email === t.seed.a.office.email);
  const res = await owner.patch(`/api/team/members/${office.id}`).send({ canApproveSpend: true });
  expect(res.status).toBe(200);
}

// ---------------------------------------------------------------------------------------------

describe('createTask', () => {
  test('makes a draft with pending steps in order, each with its own idempotency key and a built preview', async () => {
    const { taskId } = await newTask('a', { expiresAt: new Date(NOW.getTime() + 48 * HOUR) });

    const task = await dbTask('a', taskId);
    expect(task).toMatchObject({
      companyId: idOf('a'),
      agent: 'storm_scout',
      kind: 'storm_plan',
      title: 'Storm plan: Elm Street',
      summary: 'Three steps for the Elm Street hail swath.',
      mode: 'needs_approval',
      status: 'draft',
      subjectType: null,
      subjectId: null,
      approvedAt: null,
    });
    expect(task.expiresAt).toEqual(new Date(NOW.getTime() + 48 * HOUR));
    expect(task.createdAt).toEqual(NOW);

    const steps = await dbSteps('a', taskId);
    expect(steps.map((s) => [s.position, s.type, s.approvalClass, s.status, s.version, s.enabled, s.attempts])).toEqual([
      [0, 'demo_message', 'message', 'pending', 1, true, 0],
      [1, 'demo_noop', 'internal', 'pending', 1, true, 0],
      [2, 'demo_spend', 'spend', 'pending', 1, true, 0],
    ]);
    expect(steps[0]!.payload).toEqual({ label: 'Text 31 customers' });
    expect(steps[0]!.preview).toEqual({ title: 'Text 31 customers', lines: [] });
    expect(steps[2]!.preview).toMatchObject({ title: 'Google + Facebook ads on the swath', maxSpendCents: 27000 });
    expect(steps.every((s) => s.companyId === idOf('a') && s.taskId === taskId)).toBe(true);
    expect(steps.every((s) => s.createdAt.getTime() === NOW.getTime())).toBe(true);

    const keys = steps.map((s) => s.idempotencyKey);
    expect(new Set(keys).size).toBe(3);
    for (const key of keys) expect(key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  test('keeps the optional fields it is given: subject, mode, and no expiry when none is set', async () => {
    const [customerId] = await newCustomers('a', ['Molly']);
    const { taskId } = await newTask('a', { subjectType: 'customer', subjectId: customerId!, mode: 'live' });
    expect(await dbTask('a', taskId)).toMatchObject({
      subjectType: 'customer',
      subjectId: customerId,
      mode: 'live',
      expiresAt: null,
    });
  });

  test('stores the payload as parsed (trimmed, unknown ids lowercased), not as sent', async () => {
    const [id] = await newCustomers('a', ['Molly']);
    const { taskId } = await newTask('a', {
      steps: [
        { type: 'demo_noop', payload: { label: '  Knock doors  ' } },
        smsStep([id!.toUpperCase()], { body: `  ${STOP_BODY}  ` }),
      ],
    });
    const steps = await dbSteps('a', taskId);
    expect(steps[0]!.payload).toEqual({ label: 'Knock doors' });
    expect(steps[1]!.payload).toEqual({ purpose: 'marketing', body: STOP_BODY, customerIds: [id] });
  });

  test('send_sms_batch: the preview has the recipient count and the first listed customer\'s name in the sample', async () => {
    // Listed Zed first, so a database that returns rows in another order would show another name.
    const ids = await newCustomers('a', ['Amy', 'Zed', 'Bob']);
    const { taskId } = await newTask('a', { steps: [smsStep([ids[1]!, ids[0]!, ids[2]!])] });
    const [step] = await dbSteps('a', taskId);
    expect(step!.preview).toMatchObject({
      title: 'Text 3 customers',
      recipientCount: 3,
      messageSample: "Hi Zed, it's Acme Roofing. Free roof check this week. Reply STOP to opt out.",
    });
  });

  test('send_sms_batch: a first customer with no first name reads as "there"', async () => {
    const ctx = agentCtx(idOf('a'));
    const [row] = await inCompany(t, idOf('a'), async (tx) => [
      await createCustomer(tx, ctx, { displayName: 'Walk-in' }, { now: t.clock.now() }),
    ]);
    const { taskId } = await newTask('a', { steps: [smsStep([row!.id])] });
    const [step] = await dbSteps('a', taskId);
    expect(step!.preview).toMatchObject({ title: 'Text 1 customer', messageSample: expect.stringMatching(/^Hi there, it's Acme Roofing\./) });
  });

  test('a bad payload is a 400 on steps.0.payload, in the schema\'s own words', async () => {
    await expect(newTask('a', { steps: [{ type: 'demo_message', payload: {} }] })).rejects.toMatchObject({
      status: 400,
      field: 'steps.0.payload',
      message: 'Please enter a label.',
    });
  });

  test('the field names the step: a bad second step is steps.1.payload', async () => {
    await expect(
      newTask('a', {
        steps: [
          { type: 'demo_noop', payload: { label: 'fine' } },
          { type: 'demo_spend', payload: { label: 'Ads', maxSpendCents: -5 } },
        ],
      }),
    ).rejects.toMatchObject({
      status: 400,
      field: 'steps.1.payload',
      message: 'Please enter the most to spend, in cents, as a whole number.',
    });
  });

  test('nothing zod says in its own words reaches the caller', async () => {
    for (const payload of [null, 'x', 5, [], { label: 7 }, { label: 'ok', extra: true }]) {
      const err = await newTask('a', { steps: [{ type: 'demo_noop', payload }] }).catch((e: unknown) => e);
      expect(err).toMatchObject({ status: 400, field: 'steps.0.payload' });
      expect((err as Error).message).not.toMatch(/expected|invalid input|unrecognized/i);
    }
  });

  test('a marketing text without the company name and opt-out wording is refused at draft time', async () => {
    const [id] = await newCustomers('a', ['Molly']);
    await expect(newTask('a', { steps: [smsStep([id!], { body: 'Free roof check this week.' })] })).rejects.toMatchObject({
      status: 400,
      field: 'steps.0.payload',
      message: MARKETING,
    });
  });

  test('an informational text needs neither the name nor the opt-out wording', async () => {
    const [id] = await newCustomers('a', ['Molly']);
    const { taskId } = await newTask('a', {
      steps: [smsStep([id!], { purpose: 'informational', body: 'Your crew arrives at 8am Tuesday.' })],
    });
    expect((await dbSteps('a', taskId))[0]!.status).toBe('pending');
  });

  test('the company name is looked up for the rule: another company\'s name does not count', async () => {
    const [id] = await newCustomers('a', ['Molly']);
    const body = 'Bolt Roofing here with a free roof check. Reply STOP to opt out.';
    await expect(newTask('a', { steps: [smsStep([id!], { body })] })).rejects.toMatchObject({ message: MARKETING });
    const [idB] = await newCustomers('b', ['Molly']);
    await expect(newTask('b', { steps: [smsStep([idB!], { body })] })).resolves.toHaveProperty('taskId');
  });

  test('every customer must exist in the company: 400 on steps.N.payload.customerIds', async () => {
    const [id] = await newCustomers('a', ['Molly']);
    await expect(newTask('a', { steps: [smsStep([id!, NO_UUID])] })).rejects.toMatchObject({
      status: 400,
      field: 'steps.0.payload.customerIds',
      message: NO_CUSTOMERS,
    });
    await expect(
      newTask('a', { steps: [{ type: 'demo_noop', payload: { label: 'x' } }, smsStep([NO_UUID])] }),
    ).rejects.toMatchObject({ field: 'steps.1.payload.customerIds', message: NO_CUSTOMERS });
  });

  test('a batch of 5,000 is checked in one go (a long list is a 400 on customerIds, never a 500)', async () => {
    const ids = Array.from({ length: 5000 }, (_, i) => `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`);
    await expect(newTask('a', { steps: [smsStep(ids)] })).rejects.toMatchObject({
      status: 400,
      field: 'steps.0.payload.customerIds',
      message: NO_CUSTOMERS,
    });
    await expect(newTask('a', { steps: [smsStep([...ids, NO_UUID])] })).rejects.toMatchObject({
      status: 400,
      field: 'steps.0.payload',
      message: 'You can text at most 5,000 customers in one go.',
    });
  });

  test('another company\'s customer does not exist for this one', async () => {
    const [idB] = await newCustomers('b', ['Bea']);
    await expect(newTask('a', { steps: [smsStep([idB!])] })).rejects.toMatchObject({
      status: 400,
      field: 'steps.0.payload.customerIds',
      message: NO_CUSTOMERS,
    });
  });

  test('a task needs at least one step', async () => {
    await expect(newTask('a', { steps: [] })).rejects.toMatchObject({ status: 400, field: 'steps' });
  });

  test('an unknown step type is a 400 on steps.N.type', async () => {
    await expect(newTask('a', { steps: [{ type: 'launch_missiles' as StepType, payload: {} }] })).rejects.toMatchObject({
      status: 400,
      field: 'steps.0.type',
    });
  });

  test('a refused task leaves nothing behind, not even the steps before the bad one', async () => {
    await expect(
      newTask('a', {
        steps: [
          { type: 'demo_noop', payload: { label: 'fine' } },
          { type: 'demo_noop', payload: {} },
        ],
      }),
    ).rejects.toMatchObject({ field: 'steps.1.payload' });
    const counts = await inCompany(t, idOf('a'), async (tx) => ({
      tasks: (await tx.select().from(agentTasks)).length,
      steps: (await tx.select().from(agentTaskSteps)).length,
      audits: (await tx.select().from(auditLog).where(eq(auditLog.action, 'task.create'))).length,
    }));
    expect(counts).toEqual({ tasks: 0, steps: 0, audits: 0 });
  });

  test('writes a task.create audit row (no signed-in actor)', async () => {
    const { taskId } = await newTask('a');
    const rows = await dbAudit(t, idOf('a'), 'task.create');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorUserId: null,
      targetType: 'agent_task',
      targetId: taskId,
      ip: '203.0.113.9',
      at: NOW,
      after: { agent: 'storm_scout', kind: 'storm_plan', title: 'Storm plan: Elm Street', steps: ['demo_message', 'demo_noop', 'demo_spend'] },
    });
  });

  test('it is an internal service only: there is no HTTP route that creates a task', async () => {
    const owner = await actors.as('owner');
    const res = await owner.post('/api/approvals').send({ agent: 'storm_scout', kind: 'x', title: 'x', steps: [] });
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------------------------

describe('GET /api/approvals', () => {
  test('the owner sees one draft: count 1; a rep gets count 0 and no tasks', async () => {
    await newTask('a');
    const owner = await (await actors.as('owner')).get('/api/approvals');
    expect(owner.status).toBe(200);
    expect(owner.body.count).toBe(1);
    expect(owner.body.tasks).toHaveLength(1);

    const rep = await (await actors.as('rep')).get('/api/approvals');
    expect(rep.status).toBe(200);
    expect(rep.body).toEqual({ count: 0, tasks: [] });
    const otherRep = await (await actors.as('otherRep')).get('/api/approvals');
    expect(otherRep.body).toEqual({ count: 0, tasks: [] });
  });

  test('no drafts at all: count 0 and an empty list', async () => {
    const res = await (await actors.as('owner')).get('/api/approvals');
    expect(res.body).toEqual({ count: 0, tasks: [] });
  });

  test('a TaskView carries the task, its expiry and its steps in order, each with what the viewer may do', async () => {
    const { taskId } = await newTask('a', { expiresAt: new Date(NOW.getTime() + 48 * HOUR) });
    const steps = await dbSteps('a', taskId);

    const res = await (await actors.as('owner')).get('/api/approvals');
    expect(res.body.tasks[0]).toEqual({
      id: taskId,
      agent: 'storm_scout',
      kind: 'storm_plan',
      title: 'Storm plan: Elm Street',
      summary: 'Three steps for the Elm Street hail swath.',
      status: 'draft',
      createdAt: NOW.toISOString(),
      expiresAt: new Date(NOW.getTime() + 48 * HOUR).toISOString(),
      expired: false,
      steps: [
        {
          id: steps[0]!.id,
          position: 0,
          type: 'demo_message',
          approvalClass: 'message',
          enabled: true,
          version: 1,
          status: 'pending',
          preview: { title: 'Text 31 customers', lines: [] },
          canApprove: true,
        },
        {
          id: steps[1]!.id,
          position: 1,
          type: 'demo_noop',
          approvalClass: 'internal',
          enabled: true,
          version: 1,
          status: 'pending',
          preview: { title: 'Door-knock routes for 4 reps', lines: [] },
          canApprove: true,
        },
        {
          id: steps[2]!.id,
          position: 2,
          type: 'demo_spend',
          approvalClass: 'spend',
          enabled: true,
          version: 1,
          status: 'pending',
          preview: { title: 'Google + Facebook ads on the swath', lines: ['Spends up to $270.00'], maxSpendCents: 27000 },
          canApprove: true,
        },
      ],
    });
  });

  test('a task with no summary and no expiry shows them as null', async () => {
    await newTask('a', { summary: undefined });
    const res = await (await actors.as('owner')).get('/api/approvals');
    expect(res.body.tasks[0]).toMatchObject({ summary: null, expiresAt: null, expired: false });
  });

  test('the payload is not part of the list (a batch can hold thousands of ids)', async () => {
    const [id] = await newCustomers('a', ['Molly']);
    await newTask('a', { steps: [smsStep([id!])] });
    const res = await (await actors.as('owner')).get('/api/approvals');
    const step = res.body.tasks[0].steps[0];
    expect(Object.keys(step).sort()).toEqual(
      ['approvalClass', 'canApprove', 'enabled', 'id', 'position', 'preview', 'status', 'type', 'version'],
    );
  });

  test('canApprove follows the viewer: the office cannot approve the spend step; with delegation it can', async () => {
    await newTask('a');
    const flags = (body: { tasks: { steps: { canApprove: boolean }[] }[] }) => body.tasks[0]!.steps.map((s) => s.canApprove);

    expect(flags((await (await actors.as('owner')).get('/api/approvals')).body)).toEqual([true, true, true]);
    expect(flags((await (await actors.as('office')).get('/api/approvals')).body)).toEqual([true, true, false]);
    await delegateSpendToOffice();
    expect(flags((await (await actors.as('office')).get('/api/approvals')).body)).toEqual([true, true, true]);
  });

  test('awaiting_owner tasks are listed for the owner and for office users with spend delegation, not for office without it', async () => {
    const { taskId: draftId } = await newTask('a');
    t.clock.advance(HOUR);
    const { taskId: waitingId } = await newTask('a', { title: 'Needs the owner' });
    await setTask('a', waitingId, { status: 'awaiting_owner' });

    const ids = async (who: 'owner' | 'office') =>
      ((await (await actors.as(who)).get('/api/approvals')).body.tasks as { id: string }[]).map((x) => x.id);

    expect(await ids('owner')).toEqual([waitingId, draftId]);
    expect(await ids('office')).toEqual([draftId]);
    const office = await (await actors.as('office')).get('/api/approvals');
    expect(office.body.count).toBe(1);

    await delegateSpendToOffice();
    expect(await ids('office')).toEqual([waitingId, draftId]);
  });

  test('only drafts and awaiting_owner tasks are listed: every other status is out', async () => {
    const statuses = ['approved', 'declined', 'expired', 'running', 'done', 'partly_done', 'needs_attention'] as const;
    for (const status of statuses) {
      const { taskId } = await newTask('a', { title: status });
      await setTask('a', taskId, { status });
    }
    const res = await (await actors.as('owner')).get('/api/approvals');
    expect(res.body).toEqual({ count: 0, tasks: [] });
  });

  test('newest first', async () => {
    const ids: string[] = [];
    for (const title of ['first', 'second', 'third']) {
      ids.push((await newTask('a', { title })).taskId);
      t.clock.advance(60_000);
    }
    const res = await (await actors.as('owner')).get('/api/approvals');
    expect(res.body.tasks.map((x: { title: string }) => x.title)).toEqual(['third', 'second', 'first']);
    expect(res.body.count).toBe(3);
  });

  test('count is the number of tasks returned', async () => {
    for (let i = 0; i < 4; i++) await newTask('a', { title: `task ${i}` });
    const res = await (await actors.as('owner')).get('/api/approvals');
    expect(res.body.count).toBe(res.body.tasks.length);
    expect(res.body.count).toBe(4);
  });

  test('a draft past its expiry is still listed until the expiry job runs, marked expired', async () => {
    const { taskId: lapsed } = await newTask('a', { title: 'lapsed', expiresAt: new Date(NOW.getTime() - HOUR) });
    t.clock.advance(1000);
    const { taskId: fresh } = await newTask('a', { title: 'fresh', expiresAt: new Date(NOW.getTime() + HOUR) });
    t.clock.advance(1000);
    const { taskId: open } = await newTask('a', { title: 'open ended' });

    const res = await (await actors.as('owner')).get('/api/approvals');
    const byId = Object.fromEntries(res.body.tasks.map((x: { id: string; expired: boolean }) => [x.id, x.expired]));
    expect(byId).toEqual({ [lapsed]: true, [fresh]: false, [open]: false });
    expect(res.body.count).toBe(3);
  });

  test('the time comes from the app clock: a draft that has not reached its expiry yet becomes expired when the clock passes it', async () => {
    await newTask('a', { expiresAt: new Date(NOW.getTime() + HOUR) });
    const owner = await actors.as('owner');
    expect((await owner.get('/api/approvals')).body.tasks[0].expired).toBe(false);
    t.clock.advance(HOUR + 1);
    expect((await owner.get('/api/approvals')).body.tasks[0].expired).toBe(true);
  });

  test('only this company\'s tasks are listed', async () => {
    const { taskId: aId } = await newTask('a');
    const { taskId: bId } = await newTask('b', { title: 'Bolt only' });
    const a = await (await actors.as('owner', 'a')).get('/api/approvals');
    const b = await (await actors.as('owner', 'b')).get('/api/approvals');
    expect(a.body.tasks.map((x: { id: string }) => x.id)).toEqual([aId]);
    expect(b.body.tasks.map((x: { id: string }) => x.id)).toEqual([bId]);
  });

  test('a rep of the same company still gets nothing when the company has plenty', async () => {
    await newTask('a');
    await newTask('a');
    const res = await (await actors.as('rep')).get('/api/approvals');
    expect(res.body).toEqual({ count: 0, tasks: [] });
  });

  test('you must be signed in', async () => {
    expect((await request(t.app).get('/api/approvals')).status).toBe(401);
  });
});

// ---------------------------------------------------------------------------------------------

describe('GET /api/approvals/:taskId', () => {
  test('the owner and the office get the TaskView (the same one the list shows, with what each may approve)', async () => {
    const { taskId } = await newTask('a');
    const list = await (await actors.as('owner')).get('/api/approvals');

    const owner = await (await actors.as('owner')).get(`/api/approvals/${taskId}`);
    expect(owner.status).toBe(200);
    expect(owner.body).toEqual(list.body.tasks[0]);

    const office = await (await actors.as('office')).get(`/api/approvals/${taskId}`);
    expect(office.status).toBe(200);
    expect(office.body.steps.map((s: { canApprove: boolean }) => s.canApprove)).toEqual([true, true, false]);
    expect({ ...office.body, steps: office.body.steps.map((s: object) => ({ ...s, canApprove: true })) }).toEqual(list.body.tasks[0]);
  });

  test('a task in any status can be opened (it is how the screen shows what happened), not only the ones in the list', async () => {
    const { taskId } = await newTask('a');
    await setTask('a', taskId, { status: 'done' });
    const res = await (await actors.as('owner')).get(`/api/approvals/${taskId}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('done');
  });

  test('a rep gets 404, even for a task that exists in their company', async () => {
    const { taskId } = await newTask('a');
    for (const who of ['rep', 'otherRep'] as const) {
      const res = await (await actors.as(who)).get(`/api/approvals/${taskId}`);
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: NOT_FOUND });
    }
  });

  test('another company\'s task, an unknown id and a malformed id are all the same 404', async () => {
    const { taskId } = await newTask('a');
    const ownerB = await actors.as('owner', 'b');
    for (const id of [taskId, NO_UUID, 'not-a-uuid', taskId.toUpperCase() + 'x']) {
      const res = await ownerB.get(`/api/approvals/${id}`);
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: NOT_FOUND });
    }
  });

  test('an upper-case id opens the task', async () => {
    const { taskId } = await newTask('a');
    const res = await (await actors.as('owner')).get(`/api/approvals/${taskId.toUpperCase()}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(taskId);
  });

  test('a time-expired draft opens, marked expired', async () => {
    const { taskId } = await newTask('a', { expiresAt: new Date(NOW.getTime() - 1) });
    const res = await (await actors.as('owner')).get(`/api/approvals/${taskId}`);
    expect(res.body).toMatchObject({ status: 'draft', expired: true });
  });
});

// ---------------------------------------------------------------------------------------------

describe('PATCH /api/approvals/:taskId/steps/:stepId', () => {
  const url = (taskId: string, stepId: string) => `/api/approvals/${taskId}/steps/${stepId}`;

  /** A task with the three demo steps, returning the ids. */
  async function demo(company: Company = 'a') {
    const { taskId } = await newTask(company);
    const steps = await dbSteps(company, taskId);
    return { taskId, message: steps[0]!, noop: steps[1]!, spend: steps[2]! };
  }

  test('turning a step off with the current version: 200, version 2, and the StepView back', async () => {
    const { taskId, message } = await demo();
    t.clock.advance(5 * 60_000);
    const res = await (await actors.as('owner')).patch(url(taskId, message.id)).send({ version: 1, enabled: false });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      id: message.id,
      position: 0,
      type: 'demo_message',
      approvalClass: 'message',
      enabled: false,
      version: 2,
      status: 'pending',
      preview: { title: 'Text 31 customers', lines: [] },
      canApprove: true,
    });

    const [row] = (await dbSteps('a', taskId)).filter((s) => s.id === message.id);
    expect(row).toMatchObject({
      enabled: false,
      version: 2,
      status: 'pending',
      editedByUserId: t.seed.a.owner.userId,
      editedAt: t.clock.now(),
      updatedAt: t.clock.now(),
    });
  });

  test('the same PATCH again with version 1: 409 with the exact message and the latest StepView', async () => {
    const { taskId, message } = await demo();
    const owner = await actors.as('owner');
    expect((await owner.patch(url(taskId, message.id)).send({ version: 1, enabled: false })).status).toBe(200);

    const again = await owner.patch(url(taskId, message.id)).send({ version: 1, enabled: false });
    expect(again.status).toBe(409);
    expect(again.body.error).toBe(STALE);
    expect(again.body.field).toBeUndefined();
    expect(again.body.latest).toMatchObject({ id: message.id, version: 2, enabled: false, status: 'pending', canApprove: true });
    expect(Object.keys(again.body).sort()).toEqual(['error', 'latest']);

    // The losing request changed nothing and wrote nothing.
    expect((await dbSteps('a', taskId))[0]!.version).toBe(2);
    expect(await dbAudit(t, idOf('a'), 'step.edit')).toHaveLength(1);
  });

  test('sending the latest version works: it goes up by one each time', async () => {
    const { taskId, message } = await demo();
    const owner = await actors.as('owner');
    const first = await owner.patch(url(taskId, message.id)).send({ version: 1, enabled: false });
    const second = await owner.patch(url(taskId, message.id)).send({ version: first.body.version, enabled: true });
    expect([first.body.version, second.body.version, second.body.enabled]).toEqual([2, 3, true]);
  });

  test('a version from the future is stale too', async () => {
    const { taskId, message } = await demo();
    const res = await (await actors.as('owner')).patch(url(taskId, message.id)).send({ version: 9, enabled: false });
    expect(res.status).toBe(409);
    expect(res.body.latest.version).toBe(1);
  });

  test('a payload edit rebuilds preview.messageSample', async () => {
    const ids = await newCustomers('a', ['Molly', 'Ned']);
    const { taskId } = await newTask('a', { steps: [smsStep(ids)] });
    const [step] = await dbSteps('a', taskId);
    expect((step!.preview as { messageSample: string }).messageSample).toBe(
      "Hi Molly, it's Acme Roofing. Free roof check this week. Reply STOP to opt out.",
    );

    const res = await (await actors.as('owner'))
      .patch(url(taskId, step!.id))
      .send({ version: 1, payload: { purpose: 'marketing', body: "{company} here. Storm damage? We'll look free. Reply STOP to opt out.", customerIds: ids } });

    expect(res.status).toBe(200);
    expect(res.body.version).toBe(2);
    expect(res.body.preview).toMatchObject({
      title: 'Text 2 customers',
      recipientCount: 2,
      messageSample: "Acme Roofing here. Storm damage? We'll look free. Reply STOP to opt out.",
    });
    const [after] = await dbSteps('a', taskId);
    expect(after!.payload).toMatchObject({ body: "{company} here. Storm damage? We'll look free. Reply STOP to opt out." });
    expect(after!.preview).toEqual(res.body.preview);
  });

  test('a payload edit that changes who is texted rebuilds the count and the sample name', async () => {
    const ids = await newCustomers('a', ['Molly', 'Ned', 'Olga']);
    const { taskId } = await newTask('a', { steps: [smsStep([ids[0]!, ids[1]!])] });
    const [step] = await dbSteps('a', taskId);
    const res = await (await actors.as('owner'))
      .patch(url(taskId, step!.id))
      .send({ version: 1, payload: { purpose: 'marketing', body: STOP_BODY, customerIds: [ids[2]!, ids[0]!, ids[1]!] } });
    expect(res.status).toBe(200);
    expect(res.body.preview).toMatchObject({
      recipientCount: 3,
      title: 'Text 3 customers',
      messageSample: "Hi Olga, it's Acme Roofing. Free roof check this week. Reply STOP to opt out.",
    });
  });

  test('a payload edit on a demo step rebuilds its title', async () => {
    const { taskId, spend } = await demo();
    const res = await (await actors.as('owner'))
      .patch(url(taskId, spend.id))
      .send({ version: 1, payload: { label: 'Just Facebook', maxSpendCents: 9000 } });
    expect(res.status).toBe(200);
    expect(res.body.preview).toEqual({ title: 'Just Facebook', lines: ['Spends up to $90.00'], maxSpendCents: 9000 });
  });

  test('editing enabled and payload together applies both in one version bump', async () => {
    const { taskId, noop } = await demo();
    const res = await (await actors.as('owner'))
      .patch(url(taskId, noop.id))
      .send({ version: 1, enabled: false, payload: { label: 'Door-knock routes for 3 reps' } });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ version: 2, enabled: false, preview: { title: 'Door-knock routes for 3 reps' } });
  });

  test('a payload that fails its rule is a 400 on payload, and nothing changes', async () => {
    const [id] = await newCustomers('a', ['Molly']);
    const { taskId } = await newTask('a', { steps: [smsStep([id!])] });
    const [step] = await dbSteps('a', taskId);

    const res = await (await actors.as('owner'))
      .patch(url(taskId, step!.id))
      .send({ version: 1, payload: { purpose: 'marketing', body: 'Free roof check.', customerIds: [id] } });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: MARKETING, field: 'payload' });

    const [after] = await dbSteps('a', taskId);
    expect(after).toMatchObject({ version: 1, payload: step!.payload, preview: step!.preview, editedAt: null, editedByUserId: null });
    expect(await dbAudit(t, idOf('a'), 'step.edit')).toHaveLength(0);
  });

  test('a payload with the wrong shape is a 400 on payload in plain words', async () => {
    const { taskId, noop } = await demo();
    const owner = await actors.as('owner');
    for (const payload of [{}, { label: '' }, { label: 'ok', extra: 1 }, { label: 5 }]) {
      const res = await owner.patch(url(taskId, noop.id)).send({ version: 1, payload });
      expect(res.status).toBe(400);
      expect(res.body.field).toBe('payload');
      expect(res.body.error).not.toMatch(/expected|invalid input|unrecognized/i);
    }
    expect((await dbSteps('a', taskId))[1]!.version).toBe(1);
  });

  test('customers that do not exist, or belong to another company, are a 400 on payload.customerIds', async () => {
    const [id] = await newCustomers('a', ['Molly']);
    const [idB] = await newCustomers('b', ['Bea']);
    const { taskId } = await newTask('a', { steps: [smsStep([id!])] });
    const [step] = await dbSteps('a', taskId);
    const owner = await actors.as('owner');
    for (const customerIds of [[id, NO_UUID], [idB]]) {
      const res = await owner
        .patch(url(taskId, step!.id))
        .send({ version: 1, payload: { purpose: 'marketing', body: STOP_BODY, customerIds } });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: NO_CUSTOMERS, field: 'payload.customerIds' });
    }
    expect((await dbSteps('a', taskId))[0]!.version).toBe(1);
  });

  test('a stale version wins over a bad payload: the screen has to refresh first', async () => {
    const { taskId, noop } = await demo();
    const res = await (await actors.as('owner')).patch(url(taskId, noop.id)).send({ version: 3, payload: {} });
    expect(res.status).toBe(409);
  });

  test('turning a step off does not re-check its payload (a renamed company cannot lock the toggle)', async () => {
    const [id] = await newCustomers('a', ['Molly']);
    const body = 'Acme Roofing: free roof check. Reply STOP to opt out.';
    const { taskId } = await newTask('a', { steps: [smsStep([id!], { body })] });
    const [step] = await dbSteps('a', taskId);
    // The company is renamed after the draft was made, so the stored text no longer names it.
    await t.deps.pools.system.$client.query("update companies set name = 'Acme Exteriors' where id = $1", [idOf('a')]);

    const res = await (await actors.as('owner')).patch(url(taskId, step!.id)).send({ version: 1, enabled: false });
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(false);
  });

  test('writes a step.edit audit row with before and after {enabled, payload, version}', async () => {
    const { taskId, noop } = await demo();
    t.clock.advance(60_000);
    const res = await (await actors.as('office'))
      .patch(url(taskId, noop.id))
      .send({ version: 1, enabled: false, payload: { label: 'Door-knock routes for 3 reps' } });
    expect(res.status).toBe(200);

    const rows = await dbAudit(t, idOf('a'), 'step.edit');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorUserId: t.seed.a.office.userId,
      targetType: 'agent_task_step',
      targetId: noop.id,
      at: t.clock.now(),
      before: { enabled: true, payload: { label: 'Door-knock routes for 4 reps' }, version: 1 },
      after: { enabled: false, payload: { label: 'Door-knock routes for 3 reps' }, version: 2 },
    });
    expect(rows[0]!.ip).toBeTruthy();
  });

  test('an edit never touches the task or the other steps', async () => {
    const { taskId, message } = await demo();
    const before = await dbSteps('a', taskId);
    const taskBefore = await dbTask('a', taskId);
    await (await actors.as('owner')).patch(url(taskId, message.id)).send({ version: 1, enabled: false });
    const after = await dbSteps('a', taskId);
    expect(after[1]).toEqual(before[1]);
    expect(after[2]).toEqual(before[2]);
    expect(await dbTask('a', taskId)).toEqual(taskBefore);
  });

  // -- who may edit ---------------------------------------------------------------------------

  test('editing needs the approve capability of the step\'s class: office may edit message and internal steps, not spend', async () => {
    const { taskId, message, noop, spend } = await demo();
    const office = await actors.as('office');

    expect((await office.patch(url(taskId, message.id)).send({ version: 1, enabled: false })).status).toBe(200);
    expect((await office.patch(url(taskId, noop.id)).send({ version: 1, enabled: false })).status).toBe(200);

    const refused = await office.patch(url(taskId, spend.id)).send({ version: 1, enabled: false });
    expect(refused.status).toBe(403);
    expect(refused.body).toEqual({ error: NOT_ALLOWED });
    expect((await dbSteps('a', taskId))[2]).toMatchObject({ enabled: true, version: 1 });
  });

  test('the 403 on a spend step covers payload edits too', async () => {
    const { taskId, spend } = await demo();
    const res = await (await actors.as('office'))
      .patch(url(taskId, spend.id))
      .send({ version: 1, payload: { label: 'Ads', maxSpendCents: 99999999 } });
    expect(res.status).toBe(403);
    expect((await dbSteps('a', taskId))[2]!.payload).toEqual({ label: 'Google + Facebook ads on the swath', maxSpendCents: 27000 });
  });

  test('the owner may edit a spend step, and so may an office user once spend is delegated', async () => {
    const { taskId, spend } = await demo();
    expect((await (await actors.as('owner')).patch(url(taskId, spend.id)).send({ version: 1, enabled: false })).status).toBe(200);
    await delegateSpendToOffice();
    const res = await (await actors.as('office')).patch(url(taskId, spend.id)).send({ version: 2, enabled: true });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ version: 3, enabled: true, canApprove: true });
  });

  test('permission is checked before the state: a refused spend edit on a stale version is a 403, not a 409', async () => {
    const { taskId, spend } = await demo();
    const res = await (await actors.as('office')).patch(url(taskId, spend.id)).send({ version: 7, enabled: false });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: NOT_ALLOWED });
  });

  test('a rep gets 404 on every PATCH, whatever the body, so a task\'s existence never leaks', async () => {
    const { taskId, message } = await demo();
    for (const who of ['rep', 'otherRep'] as const) {
      const rep = await actors.as(who);
      for (const body of [{ version: 1, enabled: false }, {}, { nonsense: true }, { version: 'x' }]) {
        const res = await rep.patch(url(taskId, message.id)).send(body);
        expect(res.status).toBe(404);
        expect(res.body).toEqual({ error: NOT_FOUND });
      }
      expect((await rep.patch(url(NO_UUID, NO_UUID)).send({ version: 1, enabled: false })).status).toBe(404);
    }
    expect((await dbSteps('a', taskId))[0]).toMatchObject({ enabled: true, version: 1 });
  });

  // -- what may be edited ---------------------------------------------------------------------

  test('another company\'s step is a 404 and is left alone', async () => {
    const { taskId, message } = await demo('a');
    const res = await (await actors.as('owner', 'b')).patch(url(taskId, message.id)).send({ version: 1, enabled: false });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: NOT_FOUND });
    expect((await dbSteps('a', taskId))[0]).toMatchObject({ enabled: true, version: 1 });
    expect(await dbAudit(t, idOf('a'), 'step.edit')).toHaveLength(0);
  });

  test('unknown or malformed ids are 404', async () => {
    const { taskId, message } = await demo();
    const owner = await actors.as('owner');
    const send = (path: string) => owner.patch(path).send({ version: 1, enabled: false });
    for (const path of [url(NO_UUID, message.id), url(taskId, NO_UUID), url('nope', message.id), url(taskId, 'nope')]) {
      const res = await send(path);
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: NOT_FOUND });
    }
  });

  test('a step reached through the wrong task is a 404', async () => {
    const { message } = await demo();
    const { taskId: other } = await newTask('a', { title: 'another plan' });
    const res = await (await actors.as('owner')).patch(url(other, message.id)).send({ version: 1, enabled: false });
    expect(res.status).toBe(404);
    expect((await dbSteps('a', other)).every((s) => s.version === 1)).toBe(true);
  });

  test.each(['queued', 'running', 'done', 'skipped', 'failed', 'awaiting_owner', 'needs_attention'] as const)(
    'a step that is %s can no longer be edited: 409 with the latest',
    async (status) => {
      const { taskId, message } = await demo();
      await setStep('a', message.id, { status });
      const res = await (await actors.as('owner')).patch(url(taskId, message.id)).send({ version: 1, enabled: false });
      expect(res.status).toBe(409);
      expect(res.body.error).toBe(STALE);
      expect(res.body.latest).toMatchObject({ id: message.id, status, version: 1, enabled: true });
      expect((await dbSteps('a', taskId))[0]).toMatchObject({ enabled: true, version: 1, status });
    },
  );

  test.each(['awaiting_owner', 'approved', 'declined', 'expired', 'running', 'done'] as const)(
    'a step of a %s task can no longer be edited, even if the step still says pending',
    async (status) => {
      const { taskId, message } = await demo();
      await setTask('a', taskId, { status });
      const res = await (await actors.as('owner')).patch(url(taskId, message.id)).send({ version: 1, enabled: false });
      expect(res.status).toBe(409);
      expect(res.body.error).toBe(STALE);
      expect(res.body.latest).toMatchObject({ id: message.id, version: 1 });
    },
  );

  test('a draft whose expiry has passed can no longer be edited, even before the expiry job marks it', async () => {
    const { taskId } = await newTask('a', { expiresAt: new Date(NOW.getTime() + HOUR) });
    const [step] = await dbSteps('a', taskId);
    const owner = await actors.as('owner');
    expect((await owner.patch(url(taskId, step!.id)).send({ version: 1, enabled: false })).status).toBe(200);
    t.clock.advance(HOUR + 1);
    const res = await owner.patch(url(taskId, step!.id)).send({ version: 2, enabled: true });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe(STALE);
  });

  // -- the body -------------------------------------------------------------------------------

  test('the body is checked: version is required and whole; unknown fields are named; there must be something to change', async () => {
    const { taskId, message } = await demo();
    const owner = await actors.as('owner');
    const patch = (body: unknown) => owner.patch(url(taskId, message.id)).send(body as object);

    const versionless = await patch({ enabled: false });
    expect(versionless.status).toBe(400);
    expect(versionless.body.field).toBe('version');
    expect(versionless.body.error).not.toMatch(/expected|invalid input/i);

    for (const version of [0, -1, 1.5, '1', null, true]) {
      const res = await patch({ version, enabled: false });
      expect(res.status).toBe(400);
      expect(res.body.field).toBe('version');
    }

    const unknown = await patch({ version: 1, enabled: false, status: 'done' });
    expect(unknown.status).toBe(400);
    expect(unknown.body).toEqual({ error: 'Please check this field.', field: 'status' });

    for (const body of [{}, { version: 1 }]) {
      const res = await patch(body);
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: NOTHING });
    }

    for (const enabled of ['false', 0, null]) {
      const res = await patch({ version: 1, enabled });
      expect(res.status).toBe(400);
      expect(res.body.field).toBe('enabled');
    }

    for (const payload of [null, 'text', 5, []]) {
      const res = await patch({ version: 1, payload });
      expect(res.status).toBe(400);
      expect(res.body.field).toBe('payload');
    }

    const array = await owner.patch(url(taskId, message.id)).send([1]);
    expect(array.status).toBe(400);
    expect((await dbSteps('a', taskId))[0]!.version).toBe(1);
  });

  // -- two people at once ---------------------------------------------------------------------

  test('two edits with the same version at the same time: exactly one 200 and one 409', async () => {
    const { taskId, message } = await demo();
    const owner = await actors.as('owner');
    const office = await actors.as('office');

    const results = await Promise.all([
      owner.patch(url(taskId, message.id)).send({ version: 1, enabled: false }),
      office.patch(url(taskId, message.id)).send({ version: 1, enabled: false }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const loser = results.find((r) => r.status === 409)!;
    expect(loser.body.error).toBe(STALE);
    expect(loser.body.latest).toMatchObject({ version: 2, enabled: false });

    expect((await dbSteps('a', taskId))[0]!.version).toBe(2);
    expect(await dbAudit(t, idOf('a'), 'step.edit')).toHaveLength(1);
  });

  test('six edits at once with the same version: one wins, the rest get the latest', async () => {
    const { taskId, noop } = await demo();
    const owner = await actors.as('owner');
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        owner.patch(url(taskId, noop.id)).send({ version: 1, payload: { label: `Routes for ${i + 1} reps` } }),
      ),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(5);
    const winner = results.find((r) => r.status === 200)!;
    const [row] = (await dbSteps('a', taskId)).filter((s) => s.id === noop.id);
    expect(row).toMatchObject({ version: 2 });
    expect(row!.payload).toEqual({ label: winner.body.preview.title });
    expect(await dbAudit(t, idOf('a'), 'step.edit')).toHaveLength(1);
  });

  test('edits to different steps of one task at the same time both go through', async () => {
    const { taskId, message, noop } = await demo();
    const owner = await actors.as('owner');
    const results = await Promise.all([
      owner.patch(url(taskId, message.id)).send({ version: 1, enabled: false }),
      owner.patch(url(taskId, noop.id)).send({ version: 1, enabled: false }),
    ]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    expect((await dbSteps('a', taskId)).map((s) => [s.version, s.enabled])).toEqual([
      [2, false],
      [2, false],
      [1, true],
    ]);
  });

  test('an edit racing a decline-style change to the task is refused, not applied to a task that is no longer a draft', async () => {
    const { taskId, message } = await demo();
    const owner = await actors.as('owner');
    const [patch] = await Promise.all([
      owner.patch(url(taskId, message.id)).send({ version: 1, enabled: false }),
      setTask('a', taskId, { status: 'declined' }),
    ]);
    // Either order is possible; what must hold is that the two outcomes agree with each other.
    const task = await dbTask('a', taskId);
    const step = (await dbSteps('a', taskId))[0]!;
    if (patch.status === 200) {
      expect(step).toMatchObject({ version: 2, enabled: false });
    } else {
      expect(patch.status).toBe(409);
      expect(step).toMatchObject({ version: 1, enabled: true });
    }
    expect(task.status).toBe('declined');
  });
});

// ---------------------------------------------------------------------------------------------

// ---------------------------------------------------------------------------------------------

describe('two transactions that really overlap', () => {
  // The HTTP tests above fire two requests together, but each request does a lot of work before it
  // reaches the step, so they can run one after the other. These force the overlap: the first
  // transaction does its work and then stays open, the second starts and runs into it, and only
  // then does the first commit.

  let ownerPools: Pools | undefined;
  afterAll(async () => {
    await ownerPools?.end();
  });

  /** True once some query is waiting on a lock (seen from the table owner, who can see every session). */
  async function waitUntilSomeoneIsBlocked(timeoutMs = 5000): Promise<boolean> {
    const urls = inject('dbUrls');
    ownerPools ??= createPools({ tenant: urls.owner, system: urls.owner });
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const { rows } = await ownerPools.system.$client.query(
        "select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'",
      );
      if ((rows[0] as { n: number }).n > 0) return true;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return false;
  }

  async function overlapped<A, B>(
    ctx: TenantContext,
    first: (tx: Tx) => Promise<A>,
    second: (tx: Tx) => Promise<B>,
  ): Promise<{ first: PromiseSettledResult<A>; second: PromiseSettledResult<B>; secondWaited: boolean }> {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let worked!: () => void;
    const firstWorked = new Promise<void>((resolve) => (worked = resolve));

    const p1 = withTenant(t.deps.pools, ctx, async (tx) => {
      const out = await first(tx);
      worked();
      await gate;
      return out;
    });
    p1.catch(() => worked()); // if the first fails before it signals, do not wait for it forever
    await firstWorked;
    const p2 = withTenant(t.deps.pools, ctx, second);
    const secondWaited = await waitUntilSomeoneIsBlocked();
    release();
    const [r1, r2] = await Promise.allSettled([p1, p2]);
    return { first: r1!, second: r2!, secondWaited };
  }

  const ownerCtx = (): TenantContext => ({
    companyId: idOf('a'),
    userId: t.seed.a.owner.userId,
    role: 'owner',
    canApproveSpend: false,
  });

  test('the second editor waits for the first, then finds the step changed: 409 carrying version 2', async () => {
    const { taskId } = await newTask('a');
    const [message] = await dbSteps('a', taskId);
    const ctx = ownerCtx();
    const edit = (tx: Tx) => editStep(tx, ctx, taskId, message!.id, { version: 1, enabled: false }, { now: t.clock.now() });

    const out = await overlapped(ctx, edit, edit);

    expect(out.secondWaited).toBe(true);
    expect(out.first).toMatchObject({ status: 'fulfilled', value: { version: 2, enabled: false } });
    expect(out.second.status).toBe('rejected');
    const err = (out.second as PromiseRejectedResult).reason as AppError;
    expect(err).toBeInstanceOf(AppError);
    expect(err).toMatchObject({ status: 409, message: STALE, latest: { id: message!.id, version: 2, enabled: false } });
    expect((await dbSteps('a', taskId))[0]).toMatchObject({ version: 2, enabled: false });
    expect(await dbAudit(t, idOf('a'), 'step.edit')).toHaveLength(1);
  });

  test('the UPDATE alone refuses the second writer: updatePendingStep returns null for a version that has moved on', async () => {
    const { taskId } = await newTask('a');
    const [message] = await dbSteps('a', taskId);
    const ctx = ownerCtx();

    const out = await overlapped(
      ctx,
      (tx) => updatePendingStep(tx, ctx, message!.id, 1, { enabled: false }, t.clock.now()),
      (tx) => updatePendingStep(tx, ctx, message!.id, 1, { enabled: false }, t.clock.now()),
    );

    expect(out.secondWaited).toBe(true);
    expect(out.first).toMatchObject({ status: 'fulfilled', value: { version: 2 } });
    expect(out.second).toEqual({ status: 'fulfilled', value: null });
    expect((await dbSteps('a', taskId))[0]!.version).toBe(2);
  });

  test('the UPDATE alone refuses a step that stopped being pending while the writer waited', async () => {
    const { taskId } = await newTask('a');
    const [message] = await dbSteps('a', taskId);
    const ctx = ownerCtx();

    const out = await overlapped(
      ctx,
      (tx) => tx.update(agentTaskSteps).set({ status: 'queued' }).where(eq(agentTaskSteps.id, message!.id)),
      (tx) => updatePendingStep(tx, ctx, message!.id, 1, { enabled: false }, t.clock.now()),
    );

    expect(out.secondWaited).toBe(true);
    expect(out.second).toEqual({ status: 'fulfilled', value: null });
    expect((await dbSteps('a', taskId))[0]).toMatchObject({ version: 1, enabled: true, status: 'queued' });
  });

  test('an edit that waits on a task being declined finds it declined: 409, nothing changed', async () => {
    const { taskId } = await newTask('a');
    const [message] = await dbSteps('a', taskId);
    const ctx = ownerCtx();

    const out = await overlapped(
      ctx,
      (tx) => tx.update(agentTasks).set({ status: 'declined' }).where(eq(agentTasks.id, taskId)),
      (tx) => editStep(tx, ctx, taskId, message!.id, { version: 1, enabled: false }, { now: t.clock.now() }),
    );

    expect(out.secondWaited).toBe(true);
    expect(out.second.status).toBe('rejected');
    expect(((out.second as PromiseRejectedResult).reason as AppError).status).toBe(409);
    expect((await dbSteps('a', taskId))[0]).toMatchObject({ version: 1, enabled: true });
  });
});

describe('the tables are tenant-scoped', () => {
  test('another company\'s transaction cannot read or change a task or its steps', async () => {
    const { taskId } = await newTask('a');
    const seen = await inCompany(t, idOf('b'), async (tx: Tx) => ({
      tasks: await tx.select().from(agentTasks).where(eq(agentTasks.id, taskId)),
      steps: await tx.select().from(agentTaskSteps).where(eq(agentTaskSteps.taskId, taskId)),
      changed: await tx
        .update(agentTaskSteps)
        .set({ enabled: false })
        .where(eq(agentTaskSteps.taskId, taskId))
        .returning({ id: agentTaskSteps.id }),
    }));
    expect(seen).toEqual({ tasks: [], steps: [], changed: [] });
  });
});
