import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, test } from 'vitest';
import { listTaskEvents } from '@roofline/db';
import { addressFor, Actors, inCompany, mustCreate, type Who } from './crm-helpers.ts';
import { makeTestApp, type TestApp } from './helpers.ts';
import {
  agentCtx,
  dbSteps,
  delegateSpendToOffice,
  newCustomers,
  newTask,
  seenOf,
  setStep,
  setTask,
  smsStep,
  STOP_BODY,
} from './task-helpers.ts';

const NOW = new Date('2026-10-12T15:00:00.000Z');
const MINUTE = 60 * 1000;

let t: TestApp;
let actors: Actors;

beforeEach(async () => {
  t = await makeTestApp();
  t.clock.set(NOW);
  actors = new Actors(t);
});

const A = () => t.seed.a.companyId;
const B = () => t.seed.b.companyId;

const at = (minutes: number) => {
  t.clock.set(new Date(NOW.getTime() + minutes * MINUTE));
};

type FeedItem = { id: string; agent: string; kind: string; text: string; at: string; href: string | null };
type FeedBody = { items: FeedItem[]; nextCursor: string | null };
type WaitingItem = { id: string; agent: string; kind: string; text: string; since: string; waitingOn: { kind: string; name?: string }; href: string | null };

/** GET a path as a member of a company; returns the status and body. */
async function get(who: Who, path: string, company: 'a' | 'b' = 'a') {
  const res = await (await actors.as(who, company)).get(path);
  return { status: res.status, body: res.body };
}

/** The ids of the events one task wrote, in company A or B. */
const eventIds = (companyId: string, taskId: string) =>
  inCompany(t, companyId, async (tx) => (await listTaskEvents(tx, agentCtx(companyId), taskId)).map((e) => e.id));

async function approveAs(who: 'owner' | 'office', taskId: string) {
  const steps = await dbSteps(t, 'a', taskId);
  const res = await (await actors.as(who)).post(`/api/approvals/${taskId}/approve`).send(seenOf(steps));
  expect(res.status).toBe(200);
}

const NOOP = [{ type: 'demo_noop' as const, payload: { label: 'Routes' } }];

/**
 * A job in company A: a customer and a house, with the job assigned to `assignedUserId` (or nobody).
 * Created by the owner through the API, the way the rep-visibility tests build them.
 */
async function makeJob(n: number, name: string, assignedUserId?: string): Promise<string> {
  const owner = await actors.as('owner');
  const customer = await mustCreate(owner, '/api/customers', { displayName: name });
  const house = await mustCreate(owner, '/api/properties', { customerId: customer.id, ...addressFor(n) });
  const job = await mustCreate(owner, '/api/jobs', {
    customerId: customer.id,
    propertyId: house.id,
    ...(assignedUserId !== undefined && { assignedUserId }),
  });
  return job.id;
}

/** The rep's job and the other rep's job, for the rep-scope cases. */
async function repJobs() {
  const repJob = await makeJob(11, 'Rep Customer', actors.user('rep').userId);
  const otherJob = await makeJob(12, 'Other Customer', actors.user('otherRep').userId);
  return { repJob, otherJob };
}

/** Sets the job's next step and gives its customer a Front Desk conversation with this outcome. */
async function seedFollowUp(jobId: string, nextStep: string, outcome: string, lastMessageAt: Date): Promise<void> {
  await inCompany(t, A(), async (tx) => {
    await tx.execute(sql`update jobs set next_step = ${nextStep} where id = ${jobId}`);
    await tx.execute(sql`insert into conversations (company_id, channel, customer_id, phone_e164, company_number_e164, status, outcome, last_message_at)
      select ${A()}, 'voice', customer_id, '+14025550111', '+14025550000', 'ended', ${outcome}, ${lastMessageAt.toISOString()}::timestamptz from jobs where id = ${jobId}`);
  });
}

async function waitingFor(who: Who, company: 'a' | 'b' = 'a') {
  const { status, body } = await get(who, '/api/agents/waiting', company);
  expect(status).toBe(200);
  return body.items as WaitingItem[];
}

describe('agents feed', () => {
  test('feed returns items newest first with nextCursor null under 30', async () => {
    at(0);
    await newTask(t, 'a', { title: 'First', steps: NOOP });
    at(5);
    await newTask(t, 'a', { title: 'Second', steps: NOOP });
    at(10);
    await newTask(t, 'a', { title: 'Third', steps: NOOP });

    const { status, body } = await get('owner', '/api/agents/feed');
    expect(status).toBe(200);
    const page = body as FeedBody;
    expect(page.items).toHaveLength(3);
    expect(page.nextCursor).toBeNull();
    const times = page.items.map((i) => i.at);
    expect(times).toEqual([...times].sort().reverse());
    expect(times[0]).toBe(new Date(NOW.getTime() + 10 * MINUTE).toISOString());
  });

  test('cursor paging: create 35 events, first page 30 with nextCursor, second page 5 with null, no repeats', async () => {
    const created: string[] = [];
    for (let i = 0; i < 35; i++) {
      at(i);
      const { taskId } = await newTask(t, 'a', { title: `Plan ${i}`, steps: NOOP });
      const [id] = await eventIds(A(), taskId);
      created.push(id!);
    }

    const first = (await get('owner', '/api/agents/feed')).body as FeedBody;
    expect(first.items).toHaveLength(30);
    expect(first.nextCursor).toEqual(expect.any(String));

    const second = (await get('owner', `/api/agents/feed?cursor=${encodeURIComponent(first.nextCursor!)}`)).body as FeedBody;
    expect(second.items).toHaveLength(5);
    expect(second.nextCursor).toBeNull();

    const ids = [...first.items, ...second.items].map((i) => i.id);
    expect(new Set(ids).size).toBe(35);
    expect([...ids].sort()).toEqual([...created].sort());
    expect(first.items[29]!.at >= second.items[0]!.at).toBe(true);
  });

  test('agent=bogus is 400 and agent=front_desk filters', async () => {
    await newTask(t, 'a', { agent: 'storm_scout', title: 'Storm', steps: NOOP });
    await newTask(t, 'a', { agent: 'front_desk', kind: 'texts', title: 'Front desk', steps: NOOP });

    const bogus = await get('owner', '/api/agents/feed?agent=bogus');
    expect(bogus.status).toBe(400);
    expect(bogus.body).toMatchObject({ field: 'agent' });

    const front = (await get('owner', '/api/agents/feed?agent=front_desk')).body as FeedBody;
    expect(front.items).toHaveLength(1);
    expect(front.items.every((i) => i.agent === 'front_desk')).toBe(true);
  });

  test('agent=system is 400 (not a screen agent)', async () => {
    const res = await get('owner', '/api/agents/feed?agent=system');
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ field: 'agent' });
  });

  test('an old cursor without a rank is 400', async () => {
    const old = Buffer.from(`${NOW.toISOString()}|00000000-0000-4000-8000-000000000001`, 'utf8').toString('base64url');
    const res = await get('owner', `/api/agents/feed?cursor=${encodeURIComponent(old)}`);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ field: 'cursor' });
  });

  test('bad cursor is 400', async () => {
    const res = await get('owner', '/api/agents/feed?cursor=garbage');
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ field: 'cursor' });
  });

  test('items contain text and no message body (the sms STOP body is absent from the JSON)', async () => {
    const ids = await newCustomers(t, 'a', ['Ann', 'Ben']);
    const { taskId } = await newTask(t, 'a', { title: 'Text the swath', steps: [smsStep(ids)] });
    await approveAs('owner', taskId);

    const res = await get('owner', '/api/agents/feed');
    expect(res.status).toBe(200);
    const page = res.body as FeedBody;
    expect(page.items.length).toBeGreaterThan(0);
    for (const item of page.items) expect(item.text.length).toBeGreaterThan(0);
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain(STOP_BODY);
    expect(raw).not.toContain('Reply STOP');
    expect(raw).not.toContain('Free roof check');
  });

  test('company B feed never shows company A tasks', async () => {
    const aTasks = [
      (await newTask(t, 'a', { title: 'Company A plan', steps: NOOP })).taskId,
      (await newTask(t, 'a', { title: 'Company A plan two', steps: NOOP })).taskId,
    ];
    const aIds = new Set((await Promise.all(aTasks.map((id) => eventIds(A(), id)))).flat());
    const bTask = await newTask(t, 'b', { title: 'Company B plan', steps: NOOP });

    const bFeed = (await get('owner', '/api/agents/feed', 'b')).body as FeedBody;
    expect(new Set(bFeed.items.map((i) => i.id))).toEqual(new Set(await eventIds(B(), bTask.taskId)));
    for (const item of bFeed.items) expect(aIds.has(item.id)).toBe(false);

    const aFeed = (await get('owner', '/api/agents/feed')).body as FeedBody;
    expect(new Set(aFeed.items.map((i) => i.id))).toEqual(aIds);
  });

  test('rep sees only own-job events', async () => {
    const { repJob, otherJob } = await repJobs();
    const mine = await newTask(t, 'a', { title: 'Rep job plan', subjectType: 'job', subjectId: repJob, steps: NOOP });
    await newTask(t, 'a', { title: 'Other rep plan', subjectType: 'job', subjectId: otherJob, steps: NOOP });

    const rep = (await get('rep', '/api/agents/feed')).body as FeedBody;
    expect(rep.items).toHaveLength((await eventIds(A(), mine.taskId)).length);
    for (const item of rep.items) expect(item.href).toBe(`/jobs/${repJob}`);

    const owner = (await get('owner', '/api/agents/feed')).body as FeedBody;
    expect(owner.items.some((i) => i.href === `/jobs/${otherJob}`)).toBe(false);
    expect(owner.items).toHaveLength(2);
  });
});

const ownerName = () =>
  inCompany(t, A(), async (tx) => {
    const res = await tx.execute(sql`select name from company_members where role = 'owner' and status = 'active' order by id limit 1`);
    return res.rows[0]!.name as string;
  });

describe('agents waiting', () => {
  test('waiting: an awaiting_owner draft read by the office waits on the owner by name', async () => {
    const ids = await newCustomers(t, 'a', ['Ann']);
    const { taskId } = await newTask(t, 'a', { title: 'Text Ann', steps: [smsStep(ids)] });
    await setTask(t, 'a', taskId, { status: 'awaiting_owner' });

    const item = (await waitingFor('office')).find((i) => i.id === taskId);
    expect(item?.waitingOn).toEqual({ kind: 'person', name: await ownerName() });
  });

  test('waiting: a draft with no open steps is you for a reviewer and office otherwise', async () => {
    const { repJob } = await repJobs();
    const { taskId } = await newTask(t, 'a', { title: 'Nothing open', subjectType: 'job', subjectId: repJob, steps: NOOP });
    for (const step of await dbSteps(t, 'a', taskId)) await setStep(t, 'a', step.id, { enabled: false });

    expect((await waitingFor('owner')).find((i) => i.id === taskId)?.waitingOn).toEqual({ kind: 'you' });
    expect((await waitingFor('rep')).find((i) => i.id === taskId)?.waitingOn).toEqual({ kind: 'office' });
  });

  test('waiting: a draft sms task shows waitingOn you for owner and office (message class)', async () => {
    const ids = await newCustomers(t, 'a', ['Ann']);
    const { taskId } = await newTask(t, 'a', { title: 'Text Ann', steps: [smsStep(ids)] });

    for (const who of ['owner', 'office'] as const) {
      const item = (await waitingFor(who)).find((i) => i.id === taskId);
      expect(item).toMatchObject({ kind: 'draft', waitingOn: { kind: 'you' }, href: `/approvals/${taskId}` });
    }
  });

  test('waiting: a spend draft shows you for owner, office without delegation shows office, rep sees office', async () => {
    const { repJob } = await repJobs();
    const spend = await newTask(t, 'a', {
      title: 'Ads on the swath',
      subjectType: 'job',
      subjectId: repJob,
      steps: [{ type: 'demo_spend', payload: { label: 'Ads', maxSpendCents: 27000 } }],
    });

    expect((await waitingFor('owner')).find((i) => i.id === spend.taskId)?.waitingOn).toEqual({ kind: 'you' });
    // Only spend is open and the office may not approve it: the owner is who it waits on.
    expect((await waitingFor('office')).find((i) => i.id === spend.taskId)?.waitingOn).toEqual({ kind: 'person', name: await ownerName() });

    const repRow = (await waitingFor('rep')).find((i) => i.id === spend.taskId);
    expect(repRow).toMatchObject({ waitingOn: { kind: 'person', name: await ownerName() }, href: `/jobs/${repJob}` });

    await delegateSpendToOffice(t, actors);
    expect((await waitingFor('office')).find((i) => i.id === spend.taskId)?.waitingOn).toEqual({ kind: 'you' });
  });

  test('rep sees only drafts and attention tasks within their scope', async () => {
    const { repJob, otherJob } = await repJobs();
    const mine = await newTask(t, 'a', { title: 'Mine', subjectType: 'job', subjectId: repJob, steps: NOOP });
    const theirs = await newTask(t, 'a', { title: 'Theirs', subjectType: 'job', subjectId: otherJob, steps: NOOP });
    const unowned = await newTask(t, 'a', { title: 'No subject', steps: NOOP });

    const ids = (await waitingFor('rep')).map((i) => i.id);
    expect(ids).toContain(mine.taskId);
    expect(ids).not.toContain(theirs.taskId);
    expect(ids).not.toContain(unowned.taskId);
    expect((await waitingFor('owner')).map((i) => i.id)).toEqual(expect.arrayContaining([mine.taskId, theirs.taskId, unowned.taskId]));
  });

  test('waiting: a needs_attention task shows its error_plain as part of text', async () => {
    const { repJob } = await repJobs();
    const { taskId } = await newTask(t, 'a', { title: 'Hail swath', subjectType: 'job', subjectId: repJob, steps: NOOP });
    await setTask(t, 'a', taskId, { status: 'needs_attention' });
    const step = (await dbSteps(t, 'a', taskId))[0]!;
    await setStep(t, 'a', step.id, { status: 'needs_attention', errorPlain: 'The address list is missing 3 houses.' });

    const owner = (await waitingFor('owner')).find((i) => i.id === taskId);
    expect(owner).toMatchObject({ kind: 'attention', waitingOn: { kind: 'you' }, href: `/jobs/${repJob}` });
    expect(owner!.text).toContain('The address list is missing 3 houses.');

    const rep = (await waitingFor('rep')).find((i) => i.id === taskId);
    expect(rep).toMatchObject({ kind: 'attention', waitingOn: { kind: 'office' } });
  });

  test('waiting href is /approvals/<id> for a draft and /jobs/<id> for a job-subject attention task', async () => {
    const { repJob } = await repJobs();
    const draft = await newTask(t, 'a', { title: 'Plain draft', steps: NOOP });
    const attention = await newTask(t, 'a', { title: 'Job attention', subjectType: 'job', subjectId: repJob, steps: NOOP });
    await setTask(t, 'a', attention.taskId, { status: 'needs_attention' });

    const rows = await waitingFor('owner');
    expect(rows.find((i) => i.id === draft.taskId)?.href).toBe(`/approvals/${draft.taskId}`);
    expect(rows.find((i) => i.id === attention.taskId)?.href).toBe(`/jobs/${repJob}`);
  });

  test('waiting: an attention task with no job (a storm plan) opens its own review for the owner and the office', async () => {
    const plan = await newTask(t, 'a', { title: 'Storm plan for Bellevue', steps: NOOP });
    await setTask(t, 'a', plan.taskId, { status: 'needs_attention' });

    for (const who of ['owner', 'office'] as const) {
      const row = (await waitingFor(who)).find((i) => i.id === plan.taskId);
      expect(row).toMatchObject({ kind: 'attention', href: `/approvals/${plan.taskId}` });
    }
    // A rep never sees it: a task with no job is outside their scope
    expect((await waitingFor('rep')).some((i) => i.id === plan.taskId)).toBe(false);
  });

  test('expired drafts are not waiting', async () => {
    const { taskId } = await newTask(t, 'a', { title: 'Old plan', steps: NOOP });
    await setTask(t, 'a', taskId, { expiresAt: new Date(NOW.getTime() - MINUTE) });
    expect((await waitingFor('owner')).some((i) => i.id === taskId)).toBe(false);
  });

  test('waiting has no front_desk_follow_up rows without a Front Desk message or transfer', async () => {
    await newTask(t, 'a', { title: 'Plan', steps: NOOP });
    const rows = await waitingFor('owner');
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(['draft', 'attention']).toContain(row.kind);
    expect(rows.some((row) => row.kind === 'front_desk_follow_up')).toBe(false);
  });

  test('waiting lists Front Desk follow-ups with who they wait on, a job link, and ordered by since among drafts', async () => {
    const assigned = await makeJob(21, 'Called Ann', actors.user('rep').userId);
    const unassigned = await makeJob(22, 'Called Bo');
    const quiet = await makeJob(23, 'Booked Cy', actors.user('rep').userId);
    const since = new Date(NOW.getTime() - 3 * MINUTE);
    await seedFollowUp(assigned, 'Call Ann back', 'message', since);
    await seedFollowUp(unassigned, 'Ring Bo about the estimate', 'transferred', new Date(NOW.getTime() - 9 * MINUTE));
    await seedFollowUp(quiet, 'Already booked', 'booked', since);
    const draft = await newTask(t, 'a', { title: 'Plan', steps: NOOP });

    const rows = await waitingFor('owner');
    const items = rows.filter((row) => row.kind === 'front_desk_follow_up');
    expect(items.map((row) => row.id)).toEqual([`fd-follow-up:${unassigned}`, `fd-follow-up:${assigned}`]);
    expect(items[0]).toMatchObject({ agent: 'front_desk', waitingOn: { kind: 'office' }, href: `/jobs/${unassigned}`, since: new Date(NOW.getTime() - 9 * MINUTE).toISOString() });
    expect(items[0]!.text).toContain('Ring Bo about the estimate');
    expect(items[1]).toMatchObject({ waitingOn: { kind: 'person', name: expect.any(String) }, href: `/jobs/${assigned}` });
    expect(items[1]!.text).toContain('Call Ann back');
    const sinceMs = rows.map((row) => Date.parse(row.since));
    expect(sinceMs).toEqual([...sinceMs].sort((a, b) => a - b));
    expect(rows.some((row) => row.id === draft.taskId)).toBe(true);

    // The assigned rep sees their own follow-up as theirs, and an unassigned lead (in every rep's scope)
    // as the office's; they never see a job assigned to someone else.
    const repRows = (await waitingFor('rep')).filter((row) => row.kind === 'front_desk_follow_up');
    expect(repRows.map((row) => row.id)).toEqual([`fd-follow-up:${unassigned}`, `fd-follow-up:${assigned}`]);
    expect(repRows[1]!.waitingOn).toEqual({ kind: 'you' });
    expect(repRows[0]!.waitingOn).toEqual({ kind: 'office' });
  });
});
