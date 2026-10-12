import type { ProposalOptionView, ProposalView } from '@roofline/shared';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, test } from 'vitest';
import { measurements, proposals } from '@roofline/db';
import { addressFor, Actors, inCompany, mustCreate, NO_UUID, NOT_FOUND } from './crm-helpers.ts';
import { makeTestApp, type TestApp } from './helpers.ts';
import { SENT_PROPOSAL_MESSAGE } from '../src/routes/proposals.ts';

let t: TestApp;
let who: Actors;

beforeEach(async () => {
  t = await makeTestApp();
  who = new Actors(t);
  t.clock.set(new Date('2026-10-12T15:00:00.000Z'));
});

/** A customer, a property and a job (optionally assigned), plus an estimate measurement on the property. */
async function seed(assignedTo?: string) {
  const owner = await who.as('owner');
  const customer = await mustCreate(owner, '/api/customers', { displayName: 'Molly Lindgren' });
  const property = await mustCreate(owner, '/api/properties', { customerId: customer.id, ...addressFor(0) });
  const job = await mustCreate(owner, '/api/jobs', {
    customerId: customer.id,
    propertyId: property.id,
    ...(assignedTo !== undefined && { assignedUserId: assignedTo }),
  });
  const measurementId = await measurement(t.seed.a.companyId, property.id, job.id);
  return { owner, customer, property, job, measurementId };
}

async function measurement(companyId: string, propertyId: string, jobId: string): Promise<string> {
  const [row] = await inCompany(t, companyId, (tx) =>
    tx
      .insert(measurements)
      .values({
        companyId, propertyId, jobId, kind: 'estimate', method: 'outline',
        surfaceSqFt: 2400, pitchX12: 6, edgeFt: 220, ridgeFt: 60, valleyFt: 20,
      })
      .returning({ id: measurements.id }),
  );
  return row!.id;
}

const setStatus = (id: string, status: 'sent') =>
  inCompany(t, t.seed.a.companyId, (tx) => tx.update(proposals).set({ status }).where(eq(proposals.id, id)));

async function build() {
  const s = await seed();
  const res = await s.owner.post('/api/proposals').send({ measurementId: s.measurementId });
  return { ...s, res, proposal: res.body as ProposalView };
}

describe('building a proposal', () => {
  test('answers 201 with a full draft view', async () => {
    const { res, proposal } = await build();
    expect(res.status).toBe(201);
    expect(proposal.options).toHaveLength(3);
    expect(proposal.number).toBe('P-0001');
    expect(proposal.status).toBe('draft');
    expect(proposal.canEdit).toBe(true);
  });

  test('accepts a customer', async () => {
    const s = await seed();
    const res = await s.owner
      .post('/api/proposals')
      .send({ measurementId: s.measurementId, customer: { name: 'Sam Roe', phone: '(402) 555-0100', askedByText: true } });
    expect(res.status).toBe(201);
  });

  test('refuses a bad measurement id and bad customer fields', async () => {
    const s = await seed();
    const bad = await s.owner.post('/api/proposals').send({ measurementId: 'nope' });
    expect(bad.status).toBe(400);
    expect(bad.body.field).toBe('measurementId');
    const noName = await s.owner.post('/api/proposals').send({ measurementId: s.measurementId, customer: { name: '', phone: '1', askedByText: false } });
    expect(noName.body.field).toBe('customer.name');
    const noPhone = await s.owner.post('/api/proposals').send({ measurementId: s.measurementId, customer: { name: 'A', askedByText: false } });
    expect(noPhone.body.field).toBe('customer.phone');
  });
});

describe('reading proposals', () => {
  test('lists with a total and filters by status and q', async () => {
    const { owner, proposal } = await build();
    const all = await owner.get('/api/proposals');
    expect(all.status).toBe(200);
    expect(all.body.total).toBe(1);
    expect(all.body.proposals[0].id).toBe(proposal.id);
    expect((await owner.get('/api/proposals?status=draft')).body.total).toBe(1);
    expect((await owner.get('/api/proposals?status=signed')).body.total).toBe(0);
    expect((await owner.get('/api/proposals?q=Lindgren')).body.total).toBe(1);
    expect((await owner.get('/api/proposals?q=Zzzz')).body.total).toBe(0);
    expect((await owner.get('/api/proposals?status=bogus')).body.field).toBe('status');
    expect((await owner.get('/api/proposals?signedOn=yesterday')).body.field).toBe('signedOn');
  });

  test('gets one; unknown, malformed and other-company ids are 404', async () => {
    const { owner, proposal } = await build();
    expect((await owner.get(`/api/proposals/${proposal.id}`)).status).toBe(200);
    const unknown = await owner.get(`/api/proposals/${NO_UUID}`);
    expect(unknown.status).toBe(404);
    expect(unknown.body.error).toBe(NOT_FOUND);
    expect((await owner.get('/api/proposals/not-a-uuid')).status).toBe(404);
    const b = await who.as('owner', 'b');
    expect((await b.get(`/api/proposals/${proposal.id}`)).status).toBe(404);
  });

  test('a rep cannot open a proposal on a job they cannot see', async () => {
    const s = await seed(who.user('otherRep').userId);
    const made = await s.owner.post('/api/proposals').send({ measurementId: s.measurementId });
    expect(made.status).toBe(201);
    const rep = await who.as('rep');
    expect((await rep.get(`/api/proposals/${made.body.id}`)).status).toBe(404);
    expect((await rep.get(`/api/proposals/${made.body.id}/pdf`)).status).toBe(404);
    expect((await rep.get('/api/proposals')).body.total).toBe(0);
  });
});

describe('editing a draft', () => {
  test('disables an option, keyed by option id', async () => {
    const { owner, proposal } = await build();
    const better = proposal.options.find((o: ProposalOptionView) => o.tier === 'better')!;
    const res = await owner.patch(`/api/proposals/${proposal.id}`).send({ options: [{ id: better.id, enabled: false }] });
    expect(res.status).toBe(200);
    expect(res.body.options.find((o: ProposalOptionView) => o.id === better.id).enabled).toBe(false);
  });

  test('changing the waste re-prices', async () => {
    const { owner, proposal } = await build();
    const good = proposal.options.find((o: ProposalOptionView) => o.tier === 'good')!;
    const res = await owner.patch(`/api/proposals/${proposal.id}`).send({ options: [{ id: good.id, wastePercent: 30 }] });
    expect(res.status).toBe(200);
    expect(res.body.options.find((o: ProposalOptionView) => o.id === good.id).totalCents).not.toBe(good.totalCents);
  });

  test('refuses bad values with a field name', async () => {
    const { owner, proposal } = await build();
    const id = proposal.options[0].id;
    const waste = await owner.patch(`/api/proposals/${proposal.id}`).send({ options: [{ id, wastePercent: 99 }] });
    expect(waste.status).toBe(400);
    expect(waste.body.field).toBe('options.0.wastePercent');
    expect(waste.body.error).toBe('Please check this field.');
    const msg = await owner.patch(`/api/proposals/${proposal.id}`).send({ messageBody: '' });
    expect(msg.body).toEqual({ error: 'Please check this field.', field: 'messageBody' });
  });

  test("an option id that is not the proposal's is a 400 naming options.N.id", async () => {
    const { owner, proposal } = await build();
    const good = proposal.options[0]!;
    const res = await owner.patch(`/api/proposals/${proposal.id}`).send({ options: [{ id: good.id, enabled: false }, { id: NO_UUID, enabled: false }] });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Please check this field.', field: 'options.1.id' });
    const after = await owner.get(`/api/proposals/${proposal.id}`);
    expect(after.body.options[0].enabled).toBe(true);
  });

  test('a sent proposal is a 409', async () => {
    const { owner, proposal } = await build();
    await setStatus(proposal.id, 'sent');
    const res = await owner.patch(`/api/proposals/${proposal.id}`).send({ messageBody: 'New words' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe(SENT_PROPOSAL_MESSAGE);
    expect(res.body.error).toBe('This proposal was sent. Make a revised proposal to change it.');
  });
});

describe('revising', () => {
  test('a draft revises in place', async () => {
    const { owner, proposal } = await build();
    const res = await owner.post(`/api/proposals/${proposal.id}/revise`);
    expect(res.status).toBe(201);
    expect(res.body.id).toBe(proposal.id);
  });

  test('a sent proposal yields a new draft and stays as it was', async () => {
    const { owner, proposal } = await build();
    await setStatus(proposal.id, 'sent');
    const res = await owner.post(`/api/proposals/${proposal.id}/revise`);
    expect(res.status).toBe(201);
    expect(res.body.id).not.toBe(proposal.id);
    expect(res.body.number).not.toBe(proposal.number);
    expect(res.body.status).toBe('draft');
    const old = await owner.get(`/api/proposals/${proposal.id}`);
    expect(old.body.status).not.toBe('draft');
  });
});

describe('the PDF', () => {
  test('downloads as an attachment', async () => {
    const { owner, proposal } = await build();
    const res = await owner.get(`/api/proposals/${proposal.id}/pdf`).buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toMatch(/^attachment/);
    expect(res.headers['content-disposition']).toContain('proposal-P-0001.pdf');
    expect(res.headers['content-type']).toContain('application/pdf');
    expect((res.body as Buffer).subarray(0, 4).toString('latin1')).toBe('%PDF');
  });
});
