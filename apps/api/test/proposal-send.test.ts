import { createHash } from 'node:crypto';
import { PROPOSAL_LINK_MESSAGE, type ProposalEventKind, type ProposalView } from '@roofline/shared';
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { customers, measurements, proposalEvents, proposals } from '@roofline/db';
import { addressFor, Actors, dbJob, inCompany, mustCreate, NO_UUID } from './crm-helpers.ts';
import { makeTestApp, type TestApp } from './helpers.ts';
import { BATCH_AT, DAYTIME, NO_CONSENT, stepMessages } from './sms-helpers.ts';
import { dbSteps, seenOf } from './task-helpers.ts';
import { dispatchCompanyMessages } from '../src/messaging/dispatcher.ts';

// The Estimator's send (E1 Task 11): POST /send drafts one send_proposal step; approving it texts the link once.
// DB-backed: runs on CI (Platform), never locally without Docker.

let t: TestApp;
let who: Actors;

const LINK_BASE = 'https://app.roofline.test';
const TOKEN_PATTERN = /\/p\/([A-Za-z0-9_-]+)/;
const NOT_SENT_YET = 'Send the proposal first, then you can copy its link.';
const SIGNED_MESSAGE = 'This proposal is signed. Make a new proposal for more work.';
const ROLE_CANNOT = "Your role can't do that. Ask the owner.";
const PHONE = '+14025550101';

beforeEach(async () => {
  t = await makeTestApp();
  who = new Actors(t);
  t.clock.set(DAYTIME);
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** A customer with a phone and the given texting consent, a property, a job (optionally assigned), and an estimate measurement. */
async function seed(opts: { assignedTo?: string; consent?: 'express' | 'none' } = {}) {
  const owner = await who.as('owner');
  const customer = await mustCreate(owner, '/api/customers', { displayName: 'Molly Lindgren' });
  const property = await mustCreate(owner, '/api/properties', { customerId: customer.id, ...addressFor(0) });
  const job = await mustCreate(owner, '/api/jobs', {
    customerId: customer.id,
    propertyId: property.id,
    ...(opts.assignedTo !== undefined && { assignedUserId: opts.assignedTo }),
  });
  const measurementId = await measurement(property.id, job.id);
  await inCompany(t, t.seed.a.companyId, (tx) =>
    tx
      .update(customers)
      .set({ phones: [{ e164: PHONE, label: 'mobile', primary: true }], smsConsentStatus: opts.consent ?? 'express' })
      .where(eq(customers.id, customer.id)),
  );
  return { owner, customer, property, job, measurementId };
}

async function measurement(propertyId: string, jobId: string): Promise<string> {
  const [row] = await inCompany(t, t.seed.a.companyId, (tx) =>
    tx
      .insert(measurements)
      .values({
        companyId: t.seed.a.companyId,
        propertyId,
        jobId,
        kind: 'estimate',
        method: 'outline',
        surfaceSqFt: 2400,
        pitchX12: 6,
        edgeFt: 220,
        ridgeFt: 60,
        valleyFt: 20,
      })
      .returning({ id: measurements.id }),
  );
  return row!.id;
}

/** A built draft proposal on a seeded job. */
async function draft(opts: { assignedTo?: string; consent?: 'express' | 'none' } = {}) {
  const s = await seed(opts);
  const made = await s.owner.post('/api/proposals').send({ measurementId: s.measurementId });
  expect(made.status).toBe(201);
  return { ...s, proposal: made.body as ProposalView };
}

/** Asks for the send as `who` and returns the task id. */
async function askToSend(agent: Awaited<ReturnType<Actors['as']>>, proposalId: string): Promise<string> {
  const res = await agent.post(`/api/proposals/${proposalId}/send`);
  expect(res.status).toBe(201);
  return res.body.taskId as string;
}

/** The owner approves the task as the screen shows it, then the queue runs the step. */
async function approveAndRun(owner: Awaited<ReturnType<Actors['as']>>, taskId: string): Promise<void> {
  const steps = await dbSteps(t, 'a', taskId);
  const res = await owner.post(`/api/approvals/${taskId}/approve`).send(seenOf(steps));
  expect(res.status).toBe(200);
  await t.queue.drain(t.deps);
}

const proposalRow = (id: string) =>
  inCompany(t, t.seed.a.companyId, async (tx) => (await tx.select().from(proposals).where(eq(proposals.id, id)))[0]!);

const eventsOf = (id: string, kind: ProposalEventKind) =>
  inCompany(t, t.seed.a.companyId, (tx) =>
    tx.select().from(proposalEvents).where(and(eq(proposalEvents.proposalId, id), eq(proposalEvents.kind, kind))),
  );

const setStatus = (id: string, status: 'sent' | 'signed') =>
  inCompany(t, t.seed.a.companyId, (tx) => tx.update(proposals).set({ status }).where(eq(proposals.id, id)));

/** The token inside the one text sent, or fails the test. */
function tokenIn(body: string): string {
  const match = TOKEN_PATTERN.exec(body);
  expect(match).not.toBeNull();
  return match![1]!;
}

const sha256 = (value: string): Buffer => createHash('sha256').update(value).digest();

describe('the send step and its preview', () => {
  test('POST /send drafts a task whose step previews the tier totals and the estimate basis', async () => {
    const s = await draft();
    const taskId = await askToSend(s.owner, s.proposal.id);

    const task = (await s.owner.get(`/api/approvals/${taskId}`)).body;
    const step = task.steps[0];
    expect(step.type).toBe('send_proposal');
    expect(step.preview.lines[0]).toMatch(/^Good \$[\d,]+ · Better \$[\d,]+ · Best \$[\d,]+$/);
    expect(step.preview.lines.join(' ')).toContain('Estimate');
    expect(step.preview.lines.join(' ')).toContain('Estimate based on the roof outline.');
  });

  test('asking to send twice gives the same task', async () => {
    const s = await draft();
    const first = await askToSend(s.owner, s.proposal.id);
    const second = await askToSend(s.owner, s.proposal.id);
    expect(second).toBe(first);
  });
});

describe('approving the send', () => {
  test('one text goes out with the link; the proposal is sent, the job is at Proposal, and one sent event is recorded', async () => {
    const s = await draft();
    const taskId = await askToSend(s.owner, s.proposal.id);
    await approveAndRun(s.owner, taskId);

    expect(t.sms.sent).toHaveLength(1);
    const body = t.sms.sent[0]!.body;
    const token = tokenIn(body);
    expect(body).toContain(`${LINK_BASE}/p/${token}`);
    expect(body).not.toMatch(/\{\w+\}/);

    expect((await s.owner.get(`/api/proposals/${s.proposal.id}`)).body.status).toBe('sent');
    expect((await dbJob(t, t.seed.a.companyId, s.job.id)).stage).toBe('proposal');
    expect(await eventsOf(s.proposal.id, 'sent')).toHaveLength(1);
  });

  test('a customer without texting consent is blocked with the gate reason, and the proposal goes back to draft', async () => {
    const s = await draft({ consent: 'none' });
    const taskId = await askToSend(s.owner, s.proposal.id);
    await approveAndRun(s.owner, taskId);

    expect(t.sms.sent).toEqual([]);
    const [step] = await dbSteps(t, 'a', taskId);
    expect(step!.status).toBe('needs_attention');
    const rows = await stepMessages(t, 'a', step!.id);
    expect(rows[0]).toMatchObject({ status: 'blocked', blockRule: 'consent', blockReason: NO_CONSENT });
    expect((await proposalRow(s.proposal.id)).status).toBe('draft');
    expect(await eventsOf(s.proposal.id, 'sent')).toEqual([]);
  });

  test('in quiet hours the text is scheduled; when the dispatcher sends it the proposal becomes sent', async () => {
    t.clock.set(BATCH_AT);
    const s = await draft();
    const taskId = await askToSend(s.owner, s.proposal.id);
    await approveAndRun(s.owner, taskId);

    expect(t.sms.sent).toEqual([]);
    const [step] = await dbSteps(t, 'a', taskId);
    const [row] = await stepMessages(t, 'a', step!.id);
    expect(row).toMatchObject({ status: 'scheduled' });
    expect((await proposalRow(s.proposal.id)).status).not.toBe('sent');

    t.clock.set(new Date(row!.scheduledFor!));
    await dispatchCompanyMessages(t.deps, t.seed.a.companyId, t.clock.now());

    expect(t.sms.sent).toHaveLength(1);
    expect(t.sms.sent[0]!.body).toContain(`${LINK_BASE}/p/${tokenIn(t.sms.sent[0]!.body)}`);
    expect((await proposalRow(s.proposal.id)).status).toBe('sent');
  });

  test('the stored link hash is the sha256 of the token in the text, and the plain token never reaches a log', async () => {
    const s = await draft();
    const logSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
    const taskId = await askToSend(s.owner, s.proposal.id);
    await approveAndRun(s.owner, taskId);

    const token = tokenIn(t.sms.sent[0]!.body);
    const row = await proposalRow(s.proposal.id);
    expect(Buffer.from(row.linkTokenHash).equals(sha256(token))).toBe(true);
    expect(row.linkTokenEncrypted.length).toBeGreaterThan(0);

    const logged = JSON.stringify([...logSpies.flatMap((spy) => spy.mock.calls), t.logged.map((l) => `${l.where} ${String(l.err)}`)]);
    expect(logged).not.toContain(token);
  });

  test('a task whose text was edited to drop {link} is refused at the edit with the plain sentence', async () => {
    const s = await draft();
    const taskId = await askToSend(s.owner, s.proposal.id);
    const [step] = await dbSteps(t, 'a', taskId);
    const res = await s.owner
      .patch(`/api/approvals/${taskId}/steps/${step!.id}`)
      .send({ version: step!.version, payload: { ...(step!.payload as Record<string, unknown>), body: 'Hi there, your proposal is ready.' } });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe(PROPOSAL_LINK_MESSAGE);
    expect(res.body.error).toBe('Keep {link} in the message so they can open the proposal.');
  });
});

describe('the link', () => {
  test('before the proposal is sent there is no link yet (409)', async () => {
    const s = await draft();
    const res = await s.owner.get(`/api/proposals/${s.proposal.id}/link`);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe(NOT_SENT_YET);
  });

  test('after the send, the owner gets the link and a link_copied event is recorded', async () => {
    const s = await draft();
    const taskId = await askToSend(s.owner, s.proposal.id);
    await approveAndRun(s.owner, taskId);
    const token = tokenIn(t.sms.sent[0]!.body);

    const res = await s.owner.get(`/api/proposals/${s.proposal.id}/link`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ url: `${LINK_BASE}/p/${token}` });
    expect(await eventsOf(s.proposal.id, 'link_copied')).toHaveLength(1);
  });

  test('a rep cannot read the link (403), even on their own job', async () => {
    const rep = await who.as('rep');
    const s = await draft({ assignedTo: who.user('rep').userId });
    const taskId = await askToSend(rep, s.proposal.id);
    await approveAndRun(s.owner, taskId);

    const res = await rep.get(`/api/proposals/${s.proposal.id}/link`);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe(ROLE_CANNOT);
  });

  test('a signed proposal keeps its link: asking again gives the same URL', async () => {
    const s = await draft();
    const taskId = await askToSend(s.owner, s.proposal.id);
    await approveAndRun(s.owner, taskId);
    const before = await s.owner.get(`/api/proposals/${s.proposal.id}/link`);
    await setStatus(s.proposal.id, 'signed');
    const after = await s.owner.get(`/api/proposals/${s.proposal.id}/link`);
    expect(after.body).toEqual(before.body);
  });
});

describe('who may ask for the send', () => {
  test("a rep who is assigned the job can ask for the send", async () => {
    const rep = await who.as('rep');
    const s = await draft({ assignedTo: who.user('rep').userId });
    expect((await rep.post(`/api/proposals/${s.proposal.id}/send`)).status).toBe(201);
  });

  test('a rep on an unassigned lead they can see is refused (403)', async () => {
    const rep = await who.as('rep');
    const s = await draft();
    const res = await rep.post(`/api/proposals/${s.proposal.id}/send`);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe(ROLE_CANNOT);
  });

  test("a rep on another rep's job cannot see it, so asks get 404", async () => {
    const rep = await who.as('rep');
    const s = await draft({ assignedTo: who.user('otherRep').userId });
    const res = await rep.post(`/api/proposals/${s.proposal.id}/send`);
    expect(res.status).toBe(404);
    expect((await rep.post(`/api/proposals/${NO_UUID}/send`)).status).toBe(404);
  });

  test('the owner and office may ask for the send', async () => {
    const s = await draft();
    const office = await who.as('office');
    expect((await office.post(`/api/proposals/${s.proposal.id}/send`)).status).toBe(201);
  });
});

describe('revising a signed proposal', () => {
  test('revise on a signed proposal is a 409 with the plain sentence, and nothing is re-priced', async () => {
    const s = await draft();
    await setStatus(s.proposal.id, 'signed');
    const res = await s.owner.post(`/api/proposals/${s.proposal.id}/revise`);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe(SIGNED_MESSAGE);
    expect(res.body.error).toBe('This proposal is signed. Make a new proposal for more work.');
  });
});

describe('replacing the old proposal on send', () => {
  test('sending a revised draft marks the older sent proposal replaced, pointing at the new one', async () => {
    const s = await draft();
    await approveAndRun(s.owner, await askToSend(s.owner, s.proposal.id));
    expect((await proposalRow(s.proposal.id)).status).toBe('sent');
    const revised = await s.owner.post(`/api/proposals/${s.proposal.id}/revise`);
    expect(revised.status).toBe(201);
    const newId = (revised.body as ProposalView).id;
    expect(newId).not.toBe(s.proposal.id);
    await approveAndRun(s.owner, await askToSend(s.owner, newId));
    expect(t.sms.sent).toHaveLength(2);
    const old = await proposalRow(s.proposal.id);
    expect(old.status).toBe('replaced');
    expect(old.replacedById).toBe(newId);
    const fresh = await proposalRow(newId);
    expect(fresh.status).toBe('sent');
    expect(fresh.replacedById).toBeNull();
  });

  test('a signed proposal is never replaced and keeps its link when a new proposal for the job is sent', async () => {
    const s = await draft();
    await approveAndRun(s.owner, await askToSend(s.owner, s.proposal.id));
    await setStatus(s.proposal.id, 'signed');
    const before = await proposalRow(s.proposal.id);
    const made = await s.owner.post('/api/proposals').send({ measurementId: s.measurementId });
    expect(made.status).toBe(201);
    const newId = (made.body as ProposalView).id;
    await approveAndRun(s.owner, await askToSend(s.owner, newId));
    expect(t.sms.sent).toHaveLength(2);
    expect((await proposalRow(newId)).status).toBe('sent');
    const after = await proposalRow(s.proposal.id);
    expect(after.status).toBe('signed');
    expect(after.replacedById).toBeNull();
    expect(Buffer.from(after.linkTokenHash).equals(Buffer.from(before.linkTokenHash))).toBe(true);
  });
});
