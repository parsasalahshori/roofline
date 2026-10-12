import { createHash } from 'node:crypto';
import { CONSENT_TEXT_V1, canonicalJson, signedDocument, type ProposalView, type PublicProposalView } from '@roofline/shared';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { customers, measurements, proposalSignatures, proposals } from '@roofline/db';
import { addressFor, Actors, dbJob, inCompany, mustCreate } from './crm-helpers.ts';
import { makeTestApp, type TestApp } from './helpers.ts';
import { DAYTIME } from './sms-helpers.ts';
import { dbSteps, seenOf } from './task-helpers.ts';

// Signing a proposal from the homeowner's link (E1 Task 12). DB-backed: runs on CI (Platform), never locally without Docker.

let t: TestApp;
let who: Actors;

const TOKEN_PATTERN = /\/p\/([A-Za-z0-9_-]+)/;
const PHONE = '+14025550101';
const ALREADY_SIGNED = 'This proposal is already signed.';
const EXPIRED = 'This proposal has expired.';
const CONSENT_MESSAGE = 'Check the box to agree to sign electronically.';
const NAME_MESSAGE = 'Type your full name.';
const PICK_MESSAGE = 'Pick an option.';
const sha256 = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
// A 1x1 PNG.
const TINY_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

beforeEach(async () => {
  t = await makeTestApp();
  who = new Actors(t);
  t.clock.set(DAYTIME);
});

afterEach(async () => {
  await t.close();
});

/** A sent proposal for a fresh job; returns its token and ids. */
async function sent() {
  const owner = await who.as('owner');
  const customer = await mustCreate(owner, '/api/customers', { displayName: 'Molly Lindgren' });
  const property = await mustCreate(owner, '/api/properties', { customerId: customer.id, ...addressFor(0) });
  const job = await mustCreate(owner, '/api/jobs', { customerId: customer.id, propertyId: property.id });
  const [m] = await inCompany(t, t.seed.a.companyId, (tx) =>
    tx
      .insert(measurements)
      .values({ companyId: t.seed.a.companyId, propertyId: property.id, jobId: job.id, kind: 'estimate', method: 'outline', surfaceSqFt: 2400, pitchX12: 6, edgeFt: 220, ridgeFt: 60, valleyFt: 20 })
      .returning({ id: measurements.id }),
  );
  await inCompany(t, t.seed.a.companyId, (tx) =>
    tx.update(customers).set({ phones: [{ e164: PHONE, label: 'mobile', primary: true }], smsConsentStatus: 'express' }).where(eq(customers.id, customer.id)),
  );
  const made = await owner.post('/api/proposals').send({ measurementId: m!.id });
  expect(made.status).toBe(201);
  const proposal = made.body as ProposalView;
  const ask = await owner.post(`/api/proposals/${proposal.id}/send`);
  expect(ask.status).toBe(201);
  const taskId = ask.body.taskId as string;
  const approve = await owner.post(`/api/approvals/${taskId}/approve`).send(seenOf(await dbSteps(t, 'a', taskId)));
  expect(approve.status).toBe(200);
  await t.queue.drain(t.deps);
  const match = TOKEN_PATTERN.exec(t.sms.sent[0]!.body);
  expect(match).not.toBeNull();
  return { owner, job, proposal, token: match![1]! };
}

const origin = () => t.deps.config.APP_ORIGIN;
const viewOf = async (token: string): Promise<PublicProposalView> => (await request(t.app).get(`/api/public/proposals/${token}`)).body as PublicProposalView;
const post = (token: string, body: Record<string, unknown>) => request(t.app).post(`/api/public/proposals/${token}/sign`).set('Origin', origin()).send(body);
const goodBody = (view: PublicProposalView, extra: Record<string, unknown> = {}) => ({
  optionId: view.options[1]?.id ?? view.options[0]!.id,
  consent: true,
  signerName: 'Molly Lindgren',
  typedSignature: 'Molly Lindgren',
  ...extra,
});
const signatures = (proposalId: string) =>
  inCompany(t, t.seed.a.companyId, (tx) => tx.select().from(proposalSignatures).where(eq(proposalSignatures.proposalId, proposalId)));
const proposalRow = (id: string) =>
  inCompany(t, t.seed.a.companyId, async (tx) => (await tx.select().from(proposals).where(eq(proposals.id, id)))[0]!);

describe('signing', () => {
  test('a signature is recorded with the document hash, the consent text, the raw ip and user agent; the job is Won with the chosen total', async () => {
    const s = await sent();
    const view = await viewOf(s.token);
    const body = goodBody(view);
    const res = await request(t.app).post(`/api/public/proposals/${s.token}/sign`).set('Origin', origin()).set('User-Agent', 'TestAgent/1.0').send(body);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ signed: true });

    const rows = await signatures(s.proposal.id);
    expect(rows).toHaveLength(1);
    const chosen = view.options.find((o) => o.id === body.optionId)!;
    // The estimate-change clause is on by default, so an estimate-based proposal signs with it.
    const clause = view.basis === 'estimate';
    expect(rows[0]!.documentSha256).toBe(sha256(canonicalJson(signedDocument(view, body.optionId, clause))));
    expect(rows[0]).toMatchObject({
      optionId: body.optionId,
      consentText: CONSENT_TEXT_V1,
      totalCents: chosen.totalCents,
      userAgent: 'TestAgent/1.0',
      signerName: 'Molly Lindgren',
      typedSignature: 'Molly Lindgren',
      drawnSignaturePngSha256: null,
    });
    expect(rows[0]!.ip).toBeTruthy();

    expect((await proposalRow(s.proposal.id)).status).toBe('signed');
    const job = await dbJob(t, t.seed.a.companyId, s.job.id);
    expect(job.stage).toBe('won');
    expect(job.valueCents).toBe(chosen.totalCents);
    expect(t.jobs.sent).toContainEqual(expect.objectContaining({ name: 'signed-pdf', data: expect.objectContaining({ proposalId: s.proposal.id }) }));
    expect((await viewOf(s.token)).status).toBe('signed');
  });

  test('other proposals of the same job become replaced', async () => {
    const s = await sent();
    const other = await s.owner.post(`/api/proposals/${s.proposal.id}/revise`);
    expect(other.status).toBe(201);
    const view = await viewOf(s.token);
    expect((await post(s.token, goodBody(view))).status).toBe(200);
    expect((await proposalRow(other.body.id as string)).status).toBe('replaced');
  });

  test('a second sign is a 409 and still one signature row', async () => {
    const s = await sent();
    const view = await viewOf(s.token);
    expect((await post(s.token, goodBody(view))).status).toBe(200);
    const again = await post(s.token, goodBody(view));
    expect(again.status).toBe(409);
    expect(again.body.error).toBe(ALREADY_SIGNED);
    expect(await signatures(s.proposal.id)).toHaveLength(1);
  });

  test('two signs at once: exactly one 200 and one 409', async () => {
    const s = await sent();
    const view = await viewOf(s.token);
    const results = await Promise.all([post(s.token, goodBody(view)), post(s.token, goodBody(view))]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await signatures(s.proposal.id)).toHaveLength(1);
  });

  test('signing after valid_until is a 409 with the plain sentence', async () => {
    const s = await sent();
    const view = await viewOf(s.token);
    t.clock.set(new Date(`${view.validUntil}T23:59:59.000Z`));
    t.clock.advance(2 * 24 * 60 * 60 * 1000);
    const res = await post(s.token, goodBody(view));
    expect(res.status).toBe(409);
    expect(res.body.error).toBe(EXPIRED);
    expect(await signatures(s.proposal.id)).toHaveLength(0);
  });
});

describe('what is checked', () => {
  test('consent missing or false', async () => {
    const s = await sent();
    const view = await viewOf(s.token);
    for (const consent of [false, undefined]) {
      const res = await post(s.token, { ...goodBody(view), consent });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe(CONSENT_MESSAGE);
    }
  });

  test('empty names and a missing option', async () => {
    const s = await sent();
    const view = await viewOf(s.token);
    const a = await post(s.token, { ...goodBody(view), signerName: '   ' });
    expect(a.body.error).toBe(NAME_MESSAGE);
    const b = await post(s.token, { ...goodBody(view), typedSignature: '' });
    expect(b.body.error).toBe(NAME_MESSAGE);
    const c = await post(s.token, { ...goodBody(view), optionId: 'nope' });
    expect(c.status).toBe(400);
    expect(c.body.error).toBe(PICK_MESSAGE);
    const d = await post(s.token, { ...goodBody(view), optionId: '00000000-0000-4000-8000-000000000000' });
    expect(d.status).toBe(400);
    expect(d.body.error).toBe(PICK_MESSAGE);
    expect(await signatures(s.proposal.id)).toHaveLength(0);
  });

  test('an oversize drawing is a 400, not a 413', async () => {
    const s = await sent();
    const view = await viewOf(s.token);
    const res = await post(s.token, goodBody(view, { drawnSignature: 'A'.repeat(250_000) }));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('That drawing is too large.');
  });

  test('a data: prefix and a non-PNG drawing are refused', async () => {
    const s = await sent();
    const view = await viewOf(s.token);
    expect((await post(s.token, goodBody(view, { drawnSignature: `data:image/png;base64,${TINY_PNG}` }))).status).toBe(400);
    const notPng = Buffer.from('this is not a png at all').toString('base64');
    const res = await post(s.token, goodBody(view, { drawnSignature: notPng }));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Draw your signature again.');
  });

  test('a tiny PNG without a prefix is accepted and its hash stored', async () => {
    const s = await sent();
    const view = await viewOf(s.token);
    const res = await post(s.token, goodBody(view, { drawnSignature: TINY_PNG }));
    expect(res.status).toBe(200);
    const [row] = await signatures(s.proposal.id);
    expect(row!.drawnSignaturePngSha256).toBe(sha256(Buffer.from(TINY_PNG, 'base64')));
  });

  test('the 11th attempt on one token within an hour is a 429', async () => {
    const s = await sent();
    const view = await viewOf(s.token);
    for (let i = 0; i < 10; i += 1) {
      expect((await post(s.token, { ...goodBody(view), consent: false })).status).toBe(400);
    }
    const res = await post(s.token, { ...goodBody(view), consent: false });
    expect(res.status).toBe(429);
  });
});
