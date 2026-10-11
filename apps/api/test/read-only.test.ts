import pg from 'pg';
import { beforeEach, describe, expect, inject, test } from 'vitest';
import { READ_ONLY_MESSAGE } from '../src/billing/read-only.ts';
import { dispatchDueMessages } from '../src/jobs/scheduler/dispatch-messages.ts';
import { Actors } from './crm-helpers.ts';
import { loginAs, makeTestApp, type TestApp } from './helpers.ts';
import { addSmsCustomers, approvedBatch, BATCH_AT, BRIEF_FIVE, NEXT_MORNING_NY, rowFor, stepMessages } from './sms-helpers.ts';

const NO_UUID = '00000000-0000-4000-8000-000000000000';

let t: TestApp;
let actors: Actors;

beforeEach(async () => {
  t = await makeTestApp();
  t.clock.set(BATCH_AT);
  actors = new Actors(t);
});

/** Sets company A's status with the owner role (the app role cannot change it). */
async function setStatus(status: 'active' | 'past_due' | 'trial_ended' | 'canceled'): Promise<void> {
  const owner = new pg.Client({ connectionString: inject('dbUrls').owner });
  await owner.connect();
  try {
    await owner.query('update companies set status = $1 where id = $2', [status, t.seed.a.companyId]);
  } finally {
    await owner.end();
  }
}

describe('read-only mode', () => {
  test('reads work, writes are refused with the plain message', async () => {
    const owner = await actors.as('owner');
    await setStatus('trial_ended');

    expect((await owner.get('/api/customers')).status).toBe(200);

    const refused = { error: READ_ONLY_MESSAGE.trial_ended };
    const create = await owner.post('/api/customers').send({ displayName: 'Walk-in' });
    expect(create.status).toBe(403);
    expect(create.body).toEqual(refused);

    const patch = await owner.patch('/api/company').send({ name: 'Renamed Roofing' });
    expect(patch.status).toBe(403);
    expect(patch.body).toEqual(refused);

    const approve = await owner.post(`/api/approvals/${NO_UUID}/approve`).send();
    expect(approve.status).toBe(403);
    expect(approve.body).toEqual(refused);
  });

  test('signing out, billing and today-shown still work', async () => {
    const owner = await actors.as('owner');
    const signOut = await loginAs(t.app, t.seed.a.owner);
    await setStatus('trial_ended');

    const logout = await signOut.post('/api/auth/logout').send();
    expect(logout.status).toBe(200);

    const checkout = await owner.post('/api/billing/checkout').send({});
    expect(checkout.body?.error).not.toBe(READ_ONLY_MESSAGE.trial_ended);

    const shown = await owner.post('/api/me/today-shown').send();
    expect(shown.status).toBe(200);
  });

  test('canceled has its own message', async () => {
    const owner = await actors.as('owner');
    await setStatus('canceled');

    const create = await owner.post('/api/customers').send({ displayName: 'Walk-in' });
    expect(create.status).toBe(403);
    expect(create.body).toEqual({ error: READ_ONLY_MESSAGE.canceled });
  });

  test('the next request sees a status change without signing in again', async () => {
    const owner = await actors.as('owner');

    expect((await owner.post('/api/customers').send({ displayName: 'Before the trial ended' })).status).toBe(201);

    await setStatus('trial_ended');
    const refused = await owner.post('/api/customers').send({ displayName: 'During the trial end' });
    expect(refused.status).toBe(403);
    expect(refused.body).toEqual({ error: READ_ONLY_MESSAGE.trial_ended });

    await setStatus('active');
    expect((await owner.post('/api/customers').send({ displayName: 'After paying' })).status).toBe(201);
  });

  test('past due is not read-only', async () => {
    const owner = await actors.as('owner');
    await setStatus('past_due');

    expect((await owner.post('/api/customers').send({ displayName: 'Past due walk-in' })).status).toBe(201);
  });

  test('the dispatcher blocks a scheduled text once the trial ended', async () => {
    // Rosa lives in Florida: at 20:30 in Chicago her text waits for the morning.
    const [rosa] = await addSmsCustomers(t, 'a', [BRIEF_FIVE[4]!]);
    const { stepId } = await approvedBatch(t, actors, [rosa!]);
    await t.queue.drain(t.deps);
    expect(rowFor(await stepMessages(t, 'a', stepId), rosa!)).toMatchObject({ status: 'scheduled' });

    // Approval happened while the company was active; only now does the trial end.
    await setStatus('trial_ended');
    t.clock.set(NEXT_MORNING_NY);
    await dispatchDueMessages(t.deps, t.clock.now());

    expect(rowFor(await stepMessages(t, 'a', stepId), rosa!)).toMatchObject({ status: 'blocked', blockRule: 'billing' });
    expect(t.sms.sent).toEqual([]);
  });
});
