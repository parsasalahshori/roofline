import { beforeEach, describe, expect, test } from 'vitest';
import { Actors, addressFor, mustCreate, NO_UUID, NOT_FOUND, timeline } from './crm-helpers.ts';
import { makeTestApp, type TestApp } from './helpers.ts';

const NOTE_MESSAGE = 'Write a note, up to 2,000 characters.';

let t: TestApp;
let who: Actors;

beforeEach(async () => {
  t = await makeTestApp();
  who = new Actors(t);
  t.clock.set(new Date('2026-10-12T15:00:00.000Z'));
});

const A = () => t.seed.a.companyId;
const repId = () => who.user('rep').userId;
const otherRepId = () => who.user('otherRep').userId;

describe('adding a note', () => {
  test('adds a note and returns the timeline item', async () => {
    const owner = await who.as('owner');
    const customer = await mustCreate(owner, '/api/customers', { displayName: 'Note Writer' });
    const res = await owner.post('/api/notes').send({ subjectType: 'customer', subjectId: customer.id, body: '  Left a door hanger  ' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      type: 'activity',
      kind: 'note',
      summary: 'Left a door hanger',
      actor: { type: 'user' },
      subject: { type: 'customer', id: customer.id },
      text: null,
    });
    expect(await timeline(t, A(), customer.id)).toContainEqual(['note', 'Left a door hanger']);
  });

  test('a note on a job is on the job timeline', async () => {
    const owner = await who.as('owner');
    const customer = await mustCreate(owner, '/api/customers', { displayName: 'Job Noter' });
    const property = await mustCreate(owner, '/api/properties', { customerId: customer.id, ...addressFor(20) });
    const job = await mustCreate(owner, '/api/jobs', { customerId: customer.id, propertyId: property.id });
    const res = await owner.post('/api/notes').send({ subjectType: 'job', subjectId: job.id, body: 'Gate code is 1234' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ kind: 'note', summary: 'Gate code is 1234', subject: { type: 'job', id: job.id } });
  });

  test('2000 characters is accepted; 2001 is a 400 on body, and nothing is saved', async () => {
    const owner = await who.as('owner');
    const customer = await mustCreate(owner, '/api/customers', { displayName: 'Long Note' });

    const ok = await owner.post('/api/notes').send({ subjectType: 'customer', subjectId: customer.id, body: 'x'.repeat(2000) });
    expect(ok.status).toBe(201);
    expect(ok.body.summary).toHaveLength(2000);

    const tooLong = await owner.post('/api/notes').send({ subjectType: 'customer', subjectId: customer.id, body: 'x'.repeat(2001) });
    expect(tooLong.status).toBe(400);
    expect(tooLong.body).toEqual({ error: NOTE_MESSAGE, field: 'body' });

    const notes = (await timeline(t, A(), customer.id)).filter(([kind]) => kind === 'note');
    expect(notes).toHaveLength(1);
  });

  test.each([
    ['an empty body', ''],
    ['a body of spaces', '   \n\t  '],
  ])('%s is a 400 on body', async (_label, body) => {
    const owner = await who.as('owner');
    const customer = await mustCreate(owner, '/api/customers', { displayName: 'Blank Note' });
    const res = await owner.post('/api/notes').send({ subjectType: 'customer', subjectId: customer.id, body });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: NOTE_MESSAGE, field: 'body' });
  });

  test('a subject out of scope is 404: a rep on a customer or job they cannot see, and company B on company A', async () => {
    const owner = await who.as('owner');
    const rep = await who.as('rep');

    const hiddenCustomer = await mustCreate(owner, '/api/customers', { displayName: 'Hidden Customer' });
    const hiddenHouse = await mustCreate(owner, '/api/properties', { customerId: hiddenCustomer.id, ...addressFor(21) });
    const hiddenJob = await mustCreate(owner, '/api/jobs', {
      customerId: hiddenCustomer.id,
      propertyId: hiddenHouse.id,
      stage: 'inspection',
      assignedUserId: otherRepId(),
    });

    const repOnCustomer = await rep.post('/api/notes').send({ subjectType: 'customer', subjectId: hiddenCustomer.id, body: 'Hi' });
    expect(repOnCustomer.status).toBe(404);
    expect(repOnCustomer.body).toEqual({ error: NOT_FOUND });

    const repOnJob = await rep.post('/api/notes').send({ subjectType: 'job', subjectId: hiddenJob.id, body: 'Hi' });
    expect(repOnJob.status).toBe(404);
    expect(repOnJob.body).toEqual({ error: NOT_FOUND });

    const bOnA = await (await who.as('owner', 'b')).post('/api/notes').send({
      subjectType: 'customer',
      subjectId: hiddenCustomer.id,
      body: 'Hi',
    });
    expect(bOnA.status).toBe(404);
    expect(bOnA.body).toEqual({ error: NOT_FOUND });

    const missing = await owner.post('/api/notes').send({ subjectType: 'job', subjectId: NO_UUID, body: 'Hi' });
    expect(missing.status).toBe(404);

    expect((await timeline(t, A(), hiddenCustomer.id)).filter(([kind]) => kind === 'note')).toEqual([]);
  });

  test('a rep can note on a job they can see', async () => {
    const owner = await who.as('owner');
    const rep = await who.as('rep');
    const customer = await mustCreate(owner, '/api/customers', { displayName: 'Rep Visible' });
    const property = await mustCreate(owner, '/api/properties', { customerId: customer.id, ...addressFor(22) });
    const job = await mustCreate(owner, '/api/jobs', {
      customerId: customer.id,
      propertyId: property.id,
      stage: 'inspection',
      assignedUserId: repId(),
    });
    const res = await rep.post('/api/notes').send({ subjectType: 'job', subjectId: job.id, body: 'Roof is steep' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ kind: 'note', summary: 'Roof is steep', actor: { type: 'user' } });
  });
});
