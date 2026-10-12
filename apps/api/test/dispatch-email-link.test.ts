import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, test } from 'vitest';
import { customers } from '@roofline/db';
import { dispatchDueMessages } from '../src/jobs/scheduler/dispatch-messages.ts';
import { Actors, inCompany } from './crm-helpers.ts';
import {
  addCompanyStorm,
  addEmailCustomers,
  approvedEmailBatch,
  emailMessages,
  JUST_AFTER_EIGHT,
  LATE_EVENING,
  setCompanyAddress,
} from './email-helpers.ts';
import { makeTestApp, type TestApp } from './helpers.ts';
import { rowFor } from './sms-helpers.ts';

/* A scheduled email's body carries an unsubscribe link for the address it was written for (S1 fix 4). */

let t: TestApp;
let actors: Actors;

const CHANGED = "This customer's email address changed after this email was written, so we did not send it.";

beforeEach(async () => {
  t = await makeTestApp();
  actors = new Actors(t);
  await setCompanyAddress(t, 'a');
});

/** Schedules one email at LATE_EVENING to old@x.test; returns the customer and step. */
async function scheduled() {
  t.clock.set(LATE_EVENING);
  const [ann] = await addEmailCustomers(t, 'a', [{ firstName: 'Ann', emails: ['old@x.test'] }]);
  const stormId = await addCompanyStorm(t, 'a');
  const { stepId } = await approvedEmailBatch(t, actors, [ann!], { companyStormId: stormId });
  await t.queue.drain(t.deps);
  expect(rowFor(await emailMessages(t, 'a', stepId), ann!)).toMatchObject({ status: 'scheduled', toEmail: 'old@x.test' });
  return { ann: ann!, stepId };
}

describe('dispatching a scheduled email', () => {
  test('blocks the row when the customer email changed since it was written', async () => {
    const { ann, stepId } = await scheduled();
    await inCompany(t, t.seed.a.companyId, (tx) => tx.update(customers).set({ emails: ['new@x.test'] }).where(eq(customers.id, ann)));

    t.clock.set(JUST_AFTER_EIGHT);
    await dispatchDueMessages(t.deps, t.clock.now());

    expect(rowFor(await emailMessages(t, 'a', stepId), ann)).toMatchObject({
      status: 'blocked',
      blockRule: 'contact',
      blockReason: CHANGED,
      toEmail: 'new@x.test',
    });
    expect(t.broadcast.sent).toEqual([]);
  });

  test('sends when the email is unchanged', async () => {
    const { ann, stepId } = await scheduled();

    t.clock.set(JUST_AFTER_EIGHT);
    await dispatchDueMessages(t.deps, t.clock.now());

    expect(rowFor(await emailMessages(t, 'a', stepId), ann).status).toBe('sent');
    expect(t.broadcast.sent).toHaveLength(1);
  });
});
