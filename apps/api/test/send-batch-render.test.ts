import { beforeEach, describe, expect, test } from 'vitest';
import { runSmsBatch } from '../src/messaging/send-batch.ts';
import { UNFILLED_TEXT_REASON } from '../src/messaging/storm-text.ts';
import { Actors } from './crm-helpers.ts';
import { makeTestApp, type TestApp } from './helpers.ts';
import { addSmsCustomers, approvedBatch, DAYTIME, rowFor, stepMessages, type SmsCustomer } from './sms-helpers.ts';
import { agentCtx, dbSteps, setStep } from './task-helpers.ts';

/*
 * The per-customer render input of the SMS batch (S1 Task 11, ruling SA) against a real database:
 * each customer's own text, an unchanged batch without fields, a body that still holds a storm token
 * blocked as content, and the lease check staying first in the per-customer loop.
 * These tests need Docker and run on CI only.
 */

let t: TestApp;
let actors: Actors;

beforeEach(async () => {
  t = await makeTestApp();
  t.clock.set(DAYTIME);
  actors = new Actors(t);
});

const idOf = () => t.seed.a.companyId;
const stepRow = async (taskId: string) => (await dbSteps(t, 'a', taskId))[0]!;

const people = (n: number): SmsCustomer[] =>
  Array.from({ length: n }, (_, i) => ({
    firstName: `Cust${i}`,
    phone: `+140255502${String(10 + i)}`,
    consent: 'attested' as const,
    state: 'NE',
    timezone: 'America/Chicago',
  }));

const STORM_BODY = "Hi {first_name}, it's {company}. Hail hit {street}. Reply STOP to opt out.";
const PLAIN_BODY = 'Free roof check from {company} this week. Reply STOP to opt out.';

describe('per-customer render in the SMS batch', () => {
  test('render gives each customer their own text', async () => {
    const ids = await addSmsCustomers(t, 'a', people(3));
    const fields = Object.fromEntries(ids.map((id, i) => [id, { street: `${i + 1} Oak Ave` }]));
    const { stepId } = await approvedBatch(t, actors, ids, { body: STORM_BODY, fields });

    await t.queue.drain(t.deps);

    const rows = await stepMessages(t, 'a', stepId);
    ids.forEach((id, i) => {
      expect(rowFor(rows, id)).toMatchObject({
        status: 'sent',
        body: `Hi Cust${i}, it's Acme Roofing. Hail hit ${i + 1} Oak Ave. Reply STOP to opt out.`,
      });
    });
    expect(t.sms.sent.map((m) => m.body).sort()).toEqual(
      ids.map((_, i) => `Hi Cust${i}, it's Acme Roofing. Hail hit ${i + 1} Oak Ave. Reply STOP to opt out.`).sort(),
    );
  });

  test('a batch without fields is unchanged', async () => {
    const ids = await addSmsCustomers(t, 'a', people(3));
    const { stepId } = await approvedBatch(t, actors, ids, { body: PLAIN_BODY });

    await t.queue.drain(t.deps);

    const rows = await stepMessages(t, 'a', stepId);
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row).toMatchObject({ status: 'sent', body: 'Free roof check from Acme Roofing this week. Reply STOP to opt out.' });
    }
    expect(new Set(t.sms.sent.map((m) => m.body)).size).toBe(1);
  });

  test('a body that still holds a storm token is blocked as content', async () => {
    const ids = await addSmsCustomers(t, 'a', people(3));
    const { taskId, stepId } = await approvedBatch(t, actors, ids, { body: PLAIN_BODY });
    // A plain (non-storm) body with a blank in it and no fields to fill it: saved straight onto the approved step.
    const step = await stepRow(taskId);
    await setStep(t, 'a', stepId, {
      payload: { ...(step.payload as Record<string, unknown>), body: "Hi {first_name}, it's {company}. We are out {day}. Reply STOP to opt out." },
    });

    await t.queue.drain(t.deps);

    const rows = await stepMessages(t, 'a', stepId);
    expect(rows).toHaveLength(3);
    for (const id of ids) {
      expect(rowFor(rows, id)).toMatchObject({ status: 'blocked', blockRule: 'content', blockReason: UNFILLED_TEXT_REASON });
    }
    expect(t.sms.sent).toEqual([]);
    expect(await stepRow(taskId)).toMatchObject({ result: { sent: 0, scheduled: 0, failed: 0, blocked: { content: 3 } } });
  });

  test('the lease check is still first', async () => {
    const ids = await addSmsCustomers(t, 'a', people(3));
    // Approved and queued: no run owns the step (run_seq 0), so the first lease renewal fails.
    const { taskId } = await approvedBatch(t, actors, ids, { body: PLAIN_BODY });
    const rendered: string[] = [];
    const render = (customerId: string) => {
      rendered.push(customerId);
      // A minute passes during the first customer's text, so the keeper must renew (and lose) before the second.
      t.clock.advance(61_000);
      return PLAIN_BODY;
    };

    const outcome = await runSmsBatch(t.deps, agentCtx(idOf()), await stepRow(taskId), { render });

    expect(outcome).toEqual({ status: 'running', result: {} });
    // Only the first customer was rendered: the lost lease stopped the loop before the second render.
    expect(rendered).toEqual([ids[0]]);
    expect(t.sms.sent).toHaveLength(1);
  });
});
