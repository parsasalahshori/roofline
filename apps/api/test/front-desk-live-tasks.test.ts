import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, test } from 'vitest';
import {
  agentTaskEvents,
  agentTasks,
  calls,
  conversations,
  conversationTurns,
  customers,
  jobs,
  type ToolCallRecord,
} from '@roofline/db';
import { stepMinutes, stepTypes } from '@roofline/shared';
import { runAfterCall } from '../src/front-desk/after-call.ts';
import { ScriptedLlm } from '../src/providers/fakes/scripted-llm.ts';
import { Actors, addressFor, inCompany, mustCreate } from './crm-helpers.ts';
import { makeTestApp, type TestApp } from './helpers.ts';
import { DAYTIME } from './sms-helpers.ts';

/*
 * A1 Task 4: Front Desk calls become live agent tasks. The real runAfterCall runs against the database with a
 * ScriptedLlm. Database-backed: CI runs it.
 */

let t: TestApp;
let who: Actors;
let sidCounter = 0;

const A_NUMBER = '+14025550100';
const B_NUMBER = '+14025550200';
const CALLER = '+14025550999';
const idA = () => t.seed.a.companyId;
const idB = () => t.seed.b.companyId;
const nextSid = (): string => `CA${String(++sidCounter).padStart(32, '0')}`;

const BOOKING: ToolCallRecord = { name: 'book_inspection', input: {}, result: 'ok', ok: true };
const MESSAGE_TOOL: ToolCallRecord = { name: 'take_message', input: {}, result: 'ok', ok: true };

beforeEach(async () => {
  t = await makeTestApp();
  t.clock.set(DAYTIME);
  who = new Actors(t);
  (t.deps as unknown as { llm: ScriptedLlm }).llm = new ScriptedLlm([], { summary: 'The caller asked about a leak.' });
});

type Seed = { aiSeconds?: number; spam?: boolean; toolCalls?: ToolCallRecord[]; company?: 'a' | 'b' };
type Seeded = { callId: string; callSid: string; customerId: string | null; companyId: string };

/** A finished call (with its conversation, customer and one caller turn) as the relay would have left it. */
async function seedCall(o: Seed = {}): Promise<Seeded> {
  const companyId = o.company === 'b' ? idB() : idA();
  const callSid = nextSid();
  return inCompany(t, companyId, async (tx) => {
    let customerId: string | null = null;
    let conversationId: string | null = null;
    if (o.spam !== true) {
      const [c] = await tx
        .insert(customers)
        .values({ companyId, displayName: 'Nina Customer', firstName: 'Nina', phones: [{ e164: CALLER, label: 'mobile', primary: true }] })
        .returning({ id: customers.id });
      customerId = c!.id;
      const [conv] = await tx
        .insert(conversations)
        .values({ companyId, channel: 'voice', customerId, phoneE164: CALLER, companyNumberE164: A_NUMBER, status: 'active' })
        .returning({ id: conversations.id });
      conversationId = conv!.id;
    }
    const [call] = await tx
      .insert(calls)
      .values({
        companyId,
        callSid,
        fromE164: CALLER,
        toE164: o.company === 'b' ? B_NUMBER : A_NUMBER,
        status: 'ended',
        conversationId,
        aiSeconds: o.aiSeconds ?? 0,
        spamReason: o.spam === true ? 'robocall' : null,
        transcriptStored: false,
        startedAt: t.clock.now(),
        endedAt: t.clock.now(),
      })
      .returning({ id: calls.id });
    if (conversationId !== null) {
      await tx.insert(conversationTurns).values({ companyId, conversationId, callId: call!.id, position: 0, speaker: 'caller', text: 'Hello' });
      await tx.insert(conversationTurns).values({
        companyId,
        conversationId,
        callId: call!.id,
        position: 1,
        speaker: 'assistant',
        text: 'One moment.',
        toolCalls: o.toolCalls ?? null,
      });
    }
    return { callId: call!.id, callSid, customerId, companyId };
  });
}

const run = (s: Seeded) => runAfterCall(t.deps, { companyId: s.companyId, callSid: s.callSid });

const liveTasks = (companyId: string = idA()) =>
  inCompany(t, companyId, (tx) => tx.select().from(agentTasks).where(and(eq(agentTasks.kind, 'call'), eq(agentTasks.mode, 'live'))));
const eventKinds = (taskId: string, companyId: string = idA()) =>
  inCompany(t, companyId, async (tx) =>
    (await tx.select().from(agentTaskEvents).where(eq(agentTaskEvents.taskId, taskId))).map((e) => e.kind),
  );

const expectedMinutes = (type: 'front_desk_call' | 'front_desk_texts', result: Record<string, number>) =>
  stepMinutes(stepTypes[type], {}, result).minutes;

/** Gives the seeded customer a job with a next step, through the API. */
async function jobWithNextStep(customerId: string, nextStep: string | null = 'Call Nina back') {
  const owner = await who.as('owner');
  const property = await mustCreate(owner, '/api/properties', { customerId, ...addressFor(0) });
  const job = await mustCreate(owner, '/api/jobs', { customerId, propertyId: property.id });
  if (nextStep !== null) {
    await inCompany(t, idA(), (tx) => tx.update(jobs).set({ nextStep }).where(eq(jobs.id, job.id)));
  }
  return job;
}

describe('Front Desk live tasks from calls', () => {
  test('runAfterCall makes one live front_desk task per call and a second run adds none', async () => {
    const s = await seedCall({ aiSeconds: 90 });
    await run(s);
    await run(s);
    const rows = await liveTasks();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ agent: 'front_desk', kind: 'call', mode: 'live', status: 'done', subjectType: 'customer', subjectId: s.customerId });
    expect(await eventKinds(rows[0]!.id)).toEqual(expect.arrayContaining(['created', 'finished']));
  });

  test('spam call task minutes equal the call length (result spam 1, seconds 120 -> minutes_saved from stepMinutes)', async () => {
    const s = await seedCall({ spam: true, aiSeconds: 120 });
    await run(s);
    const [task] = await liveTasks();
    expect(task!.title).toBe('Spam call blocked');
    expect(Number(task!.minutesSaved)).toBeCloseTo(expectedMinutes('front_desk_call', { seconds: 120, bookings: 0, spam: 1 }), 5);
    expect(Number(task!.minutesSaved)).toBeCloseTo(2, 5);
  });

  test('a booking counts 3 extra minutes', async () => {
    const plain = await seedCall({ aiSeconds: 60 });
    const booked = await seedCall({ aiSeconds: 60, toolCalls: [BOOKING] });
    await run(plain);
    await run(booked);
    const rows = await liveTasks();
    expect(rows).toHaveLength(2);
    const minutes = rows.map((r) => Number(r.minutesSaved)).sort((a, b) => a - b);
    expect(minutes[0]).toBeCloseTo(expectedMinutes('front_desk_call', { seconds: 60, bookings: 0, spam: 0 }), 5);
    expect(minutes[1]).toBeCloseTo(expectedMinutes('front_desk_call', { seconds: 60, bookings: 1, spam: 0 }), 5);
    expect(minutes[1]! - minutes[0]!).toBeCloseTo(3, 5);
  });

  test('live tasks never appear in GET /api/approvals', async () => {
    await run(await seedCall({ aiSeconds: 90 }));
    expect(await liveTasks()).toHaveLength(1);
    const res = await (await who.as('owner')).get('/api/approvals');
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain('Answered a call');
    const items = (res.body.tasks ?? res.body.items ?? res.body) as { kind?: string }[];
    if (Array.isArray(items)) expect(items.filter((i) => i.kind === 'call')).toHaveLength(0);
  });

  test('message outcome with an open job next step makes the task needs_attention with a step_attention event and no finished event', async () => {
    const s = await seedCall({ aiSeconds: 45, toolCalls: [MESSAGE_TOOL] });
    const job = await jobWithNextStep(s.customerId!);
    await run(s);
    const [task] = await liveTasks();
    expect(task).toMatchObject({ status: 'needs_attention', subjectType: 'job', subjectId: job.id, title: 'Took a message' });
    const kinds = await eventKinds(task!.id);
    expect(kinds).toContain('step_attention');
    expect(kinds).not.toContain('finished');
  });

  test('PATCH /api/jobs/:id with nextStep null makes the task done with exactly one finished event; clearing again does not add another', async () => {
    const s = await seedCall({ aiSeconds: 45, toolCalls: [MESSAGE_TOOL] });
    const job = await jobWithNextStep(s.customerId!);
    await run(s);
    const owner = await who.as('owner');
    const first = await owner.patch(`/api/jobs/${job.id}`).send({ nextStep: null });
    expect(first.status).toBe(200);
    const [task] = await liveTasks();
    expect(task!.status).toBe('done');
    expect((await eventKinds(task!.id)).filter((k) => k === 'finished')).toHaveLength(1);
    const second = await owner.patch(`/api/jobs/${job.id}`).send({ nextStep: null });
    expect(second.status).toBe(200);
    expect((await eventKinds(task!.id)).filter((k) => k === 'finished')).toHaveLength(1);
  });

  test('PATCH nextStep from one text to another closes the live task with exactly one finished event; the same text closes nothing', async () => {
    const s = await seedCall({ aiSeconds: 45, toolCalls: [MESSAGE_TOOL] });
    const job = await jobWithNextStep(s.customerId!, 'Call back');
    await run(s);
    const owner = await who.as('owner');
    const same = await owner.patch(`/api/jobs/${job.id}`).send({ nextStep: 'Call back' });
    expect(same.status).toBe(200);
    const [open] = await liveTasks();
    expect(open!.status).toBe('needs_attention');
    const changed = await owner.patch(`/api/jobs/${job.id}`).send({ nextStep: 'Send estimate' });
    expect(changed.status).toBe(200);
    const [task] = await liveTasks();
    expect(task!.status).toBe('done');
    expect((await eventKinds(task!.id)).filter((k) => k === 'finished')).toHaveLength(1);
  });

  test('/waiting: a needs_attention Front Desk job task waits on the job assignee, shows the next step, and is the office when unassigned', async () => {
    const s = await seedCall({ aiSeconds: 45, toolCalls: [MESSAGE_TOOL] });
    const job = await jobWithNextStep(s.customerId!, 'Bring the tarp');
    await run(s);
    const owner = await who.as('owner');
    const rep = await who.as('rep');
    const attentionFor = async (agent: typeof owner) => {
      const res = await agent.get('/api/agents/waiting');
      expect(res.status).toBe(200);
      return (res.body.items as { kind: string; href: string | null; text: string; waitingOn: { kind: string; name?: string } }[]).find(
        (i) => i.kind === 'attention' && i.href === `/jobs/${job.id}`,
      );
    };

    const unassigned = await attentionFor(owner);
    expect(unassigned!.waitingOn).toEqual({ kind: 'office' });
    expect(unassigned!.text).toContain('Bring the tarp');

    const assigned = await owner.patch(`/api/jobs/${job.id}`).send({ assignedUserId: who.user('rep').userId });
    expect(assigned.status).toBe(200);
    const forOwner = await attentionFor(owner);
    expect(forOwner!.waitingOn).toMatchObject({ kind: 'person', name: expect.stringMatching(/\S/) });
    expect(forOwner!.text).toContain('Bring the tarp');
    expect((await attentionFor(rep))!.waitingOn).toEqual({ kind: 'you' });
  });

  test('cross-tenant: company B PATCH/queries never see company A task', async () => {
    const s = await seedCall({ aiSeconds: 45, toolCalls: [MESSAGE_TOOL] });
    const job = await jobWithNextStep(s.customerId!);
    await run(s);
    expect(await liveTasks(idB())).toHaveLength(0);
    const ownerB = await who.as('owner', 'b');
    const res = await ownerB.patch(`/api/jobs/${job.id}`).send({ nextStep: null });
    expect(res.status).toBe(404);
    const [task] = await liveTasks();
    expect(task!.status).toBe('needs_attention');
    const approvalsB = await ownerB.get('/api/approvals');
    expect(JSON.stringify(approvalsB.body)).not.toContain(task!.id);
  });
});
