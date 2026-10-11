import { eq } from 'drizzle-orm';
import pg from 'pg';
import { beforeEach, describe, expect, inject, test } from 'vitest';
import { customers, messages, optOuts, properties } from '@roofline/db';
import { companiesWithDueMessages, companiesWithParkedSteps } from '@roofline/db/system';
import { FakeSmsAdapter } from '@roofline/send-gate';
import { dispatchDueMessages } from '../src/jobs/scheduler/dispatch-messages.ts';
import { SCHEDULES } from '../src/jobs/worker.ts';
import { dispatchCompanyMessages } from '../src/messaging/dispatcher.ts';
import { Actors, inCompany } from './crm-helpers.ts';
import { makeTestApp, type TestApp } from './helpers.ts';
import {
  addSmsCustomers,
  approvedBatch,
  ARCHIVED,
  BATCH_AT,
  BRIEF_FIVE,
  HeldSmsAdapter,
  HOUR,
  MINUTE,
  NEXT_MORNING_NY,
  NO_CONSENT,
  OPTED_OUT,
  rowFor,
  sentTo,
  stepMessages,
  UNCONFIRMED,
  usageRows,
} from './sms-helpers.ts';
import { dbSteps, dbTask } from './task-helpers.ts';

let t: TestApp;
let actors: Actors;

beforeEach(async () => {
  t = await makeTestApp();
  t.clock.set(BATCH_AT);
  actors = new Actors(t);
});

const idOf = (company: 'a' | 'b') => t.seed[company].companyId;
const at = (base: Date, ms: number) => new Date(base.getTime() + ms);
/** 08:01 in New York, the morning after the batch. */
const MORNING = at(NEXT_MORNING_NY, MINUTE);

const STEP_FAILED = "Some texts didn't go out. You can retry them.";
const NOT_TAKEN_LATER = "The texting service didn't take this message. You can retry it.";
const BILLING = 'Texting is paused until billing is sorted out.';

/** The brief's batch, run at 20:30 Chicago: c1 sent, c5 scheduled for 08:00 New York, the step parked. */
async function parkedBatch() {
  const [c1, c2, c3, c4, c5] = await addSmsCustomers(t, 'a', BRIEF_FIVE);
  const { taskId, stepId } = await approvedBatch(t, actors, [c1!, c2!, c3!, c4!, c5!]);
  await t.queue.drain(t.deps);
  expect((await dbSteps(t, 'a', taskId))[0]).toMatchObject({ status: 'running', leaseExpiresAt: null });
  return { taskId, stepId, c1: c1!, c5: c5! };
}

const stepOf = async (taskId: string) => (await dbSteps(t, 'a', taskId))[0]!;

/** Runs the scheduler job at `now`, as the worker does every minute. */
async function dispatchAt(now: Date) {
  t.clock.set(now);
  return dispatchDueMessages(t.deps, t.clock.now());
}

describe('dispatchDueMessages', () => {
  test('at 08:01 New York the next morning c5 is sent; the step and the task are done', async () => {
    const { taskId, stepId, c5 } = await parkedBatch();

    const summary = await dispatchAt(MORNING);

    expect(summary).toMatchObject({ sent: 1, finished: 1 });
    expect(rowFor(await stepMessages(t, 'a', stepId), c5)).toMatchObject({
      status: 'sent',
      sentAt: MORNING,
      providerMessageSid: 'SMFAKE000002',
      segments: 1,
      blockRule: null,
      blockReason: null,
      retryable: false,
    });
    expect(t.sms.sent[1]).toEqual({
      companyId: idOf('a'),
      to: '+13055550105',
      body: "Hi Rosa, it's Acme Roofing. Free roof check this week. Reply STOP to opt out.",
    });
    expect(await stepOf(taskId)).toMatchObject({
      status: 'done',
      leaseExpiresAt: null,
      errorPlain: null,
      result: { sent: 2, scheduled: 0, failed: 0, blocked: { consent: 1, contact: 2 } },
    });
    expect(await dbTask(t, 'a', taskId)).toMatchObject({ status: 'done', minutesSaved: 3 });
    expect(await usageRows(t, 'a')).toHaveLength(2);

    // The next minute finds nothing to do.
    expect(await dispatchAt(at(MORNING, MINUTE))).toMatchObject({ sent: 0, finished: 0 });
    expect(t.sms.sent).toHaveLength(2);
  });

  test('before 08:00 New York nothing is due: the text keeps waiting and the step stays parked', async () => {
    const { taskId, stepId, c5 } = await parkedBatch();
    await dispatchAt(at(NEXT_MORNING_NY, -MINUTE));
    expect(rowFor(await stepMessages(t, 'a', stepId), c5)).toMatchObject({ status: 'scheduled', scheduledFor: NEXT_MORNING_NY });
    expect(t.sms.sent).toHaveLength(1);
    expect(await stepOf(taskId)).toMatchObject({ status: 'running', leaseExpiresAt: null });
  });

  // What changed overnight is honoured at send time: the gate is asked again.
  const OVERNIGHT: [string, (c5: string) => Promise<unknown>, { rule: string; reason: string }][] = [
    [
      'c5 texted STOP',
      () => inCompany(t, idOf('a'), (tx) => tx.insert(optOuts).values({ companyId: idOf('a'), phoneE164: '+13055550105', keyword: 'stop' })),
      { rule: 'contact', reason: OPTED_OUT },
    ],
    [
      'the office marked c5 do-not-contact',
      (c5) => inCompany(t, idOf('a'), (tx) => tx.update(customers).set({ doNotContact: true }).where(eq(customers.id, c5))),
      { rule: 'contact', reason: OPTED_OUT },
    ],
    [
      'c5 withdrew consent',
      (c5) => inCompany(t, idOf('a'), (tx) => tx.update(customers).set({ smsConsentStatus: 'revoked' }).where(eq(customers.id, c5))),
      { rule: 'consent', reason: NO_CONSENT },
    ],
    [
      'the office archived c5',
      (c5) => inCompany(t, idOf('a'), (tx) => tx.update(customers).set({ archivedAt: BATCH_AT }).where(eq(customers.id, c5))),
      { rule: 'contact', reason: ARCHIVED },
    ],
    [
      "the company's billing lapsed",
      () => t.deps.pools.system.$client.query(`update companies set status = 'past_due' where id = $1`, [idOf('a')]),
      { rule: 'billing', reason: BILLING },
    ],
    [
      'two other marketing texts reached c5 overnight (the weekly cap)',
      (c5) =>
        inCompany(t, idOf('a'), (tx) =>
          tx.insert(messages).values(
            [1, 2].map((n) => ({
              companyId: idOf('a'),
              customerId: c5,
              channel: 'sms' as const,
              direction: 'out' as const,
              purpose: 'marketing' as const,
              body: `other ${n}`,
              status: 'sent' as const,
              sentAt: at(BATCH_AT, n * HOUR),
            })),
          ),
        ),
      { rule: 'frequency', reason: 'Already texted this customer the most allowed this week.' },
    ],
  ];

  test.each(OVERNIGHT)('%s: c5 is blocked instead of sent, and the step finishes', async (_name, change, expected) => {
    const { taskId, stepId, c5 } = await parkedBatch();
    await change(c5);

    await dispatchAt(MORNING);

    expect(rowFor(await stepMessages(t, 'a', stepId), c5)).toMatchObject({
      status: 'blocked',
      blockRule: expected.rule,
      blockReason: expected.reason,
      sentAt: null,
    });
    expect(t.sms.sent).toHaveLength(1);
    const blocked: Record<string, number> = { consent: 1, contact: 2 };
    blocked[expected.rule] = (blocked[expected.rule] ?? 0) + 1;
    expect(await stepOf(taskId)).toMatchObject({ status: 'done', result: { sent: 1, scheduled: 0, failed: 0, blocked } });
    expect((await dbTask(t, 'a', taskId)).status).toBe('done');
    expect(await usageRows(t, 'a')).toHaveLength(1);
  });

  test("c5's home moved to Pacific time overnight: the text waits again, for 08:00 there, then goes", async () => {
    const { taskId, stepId, c5 } = await parkedBatch();
    await inCompany(t, idOf('a'), (tx) =>
      tx.update(properties).set({ timezone: 'America/Los_Angeles' }).where(eq(properties.customerId, c5)),
    );

    await dispatchAt(MORNING); // 05:01 in Los Angeles

    const eightLA = new Date('2026-10-15T15:00:00.000Z');
    expect(rowFor(await stepMessages(t, 'a', stepId), c5)).toMatchObject({
      status: 'scheduled',
      scheduledFor: eightLA,
      blockRule: 'quiet_hours',
      blockReason: 'Will send at 8:00 AM their time (quiet hours).',
    });
    expect(t.sms.sent).toHaveLength(1);
    expect(await stepOf(taskId)).toMatchObject({ status: 'running', leaseExpiresAt: null });

    await dispatchAt(at(eightLA, MINUTE));
    expect(rowFor(await stepMessages(t, 'a', stepId), c5)).toMatchObject({ status: 'sent' });
    expect(await stepOf(taskId)).toMatchObject({ status: 'done' });
  });

  test('the provider refuses the text at dispatch: it fails (retryable), the step fails, the task is partly done; a retry sends it once', async () => {
    const { taskId, stepId, c5 } = await parkedBatch();
    t.sms.failNext(1);

    await dispatchAt(MORNING);

    expect(rowFor(await stepMessages(t, 'a', stepId), c5)).toMatchObject({
      status: 'failed',
      retryable: true,
      blockReason: NOT_TAKEN_LATER,
      sentAt: null,
    });
    expect(await stepOf(taskId)).toMatchObject({
      status: 'failed',
      errorPlain: STEP_FAILED,
      result: { sent: 1, scheduled: 0, failed: 1, blocked: { consent: 1, contact: 2 } },
    });
    expect((await dbTask(t, 'a', taskId)).status).toBe('partly_done');
    expect(t.logged).toEqual([]);

    const owner = await actors.as('owner');
    const res = await owner.post(`/api/approvals/${taskId}/steps/${stepId}/retry`).send();
    expect(res.status).toBe(200);
    await t.queue.drain(t.deps);

    expect(rowFor(await stepMessages(t, 'a', stepId), c5)).toMatchObject({ status: 'sent', retryable: false, blockReason: null });
    expect(sentTo(t.sms.sent)).toEqual(['+13055550105', '+14025550101']);
    expect(await stepOf(taskId)).toMatchObject({ status: 'done', result: { sent: 2, scheduled: 0, failed: 0, blocked: { consent: 1, contact: 2 } } });
    expect((await dbTask(t, 'a', taskId)).status).toBe('done');
  });

  test('a send whose outcome is unknown at dispatch is never resent: failed, not retryable; the step is done', async () => {
    const { taskId, stepId, c5 } = await parkedBatch();
    t.sms.failUnknownNext(1);

    await dispatchAt(MORNING);

    expect(rowFor(await stepMessages(t, 'a', stepId), c5)).toMatchObject({ status: 'failed', retryable: false, blockReason: UNCONFIRMED });
    expect(await stepOf(taskId)).toMatchObject({
      status: 'done',
      errorPlain: null,
      result: { sent: 1, scheduled: 0, failed: 1, blocked: { consent: 1, contact: 2 } },
    });
    expect((await dbTask(t, 'a', taskId)).status).toBe('done');
    await dispatchAt(at(MORNING, 10 * MINUTE));
    expect(t.sms.sent).toHaveLength(1);
  });

  test('one parked step that cannot be settled does not stop the others; it is logged and tried again next time', async () => {
    const first = await parkedBatch();
    t.clock.advance(MINUTE); // so the second batch is the younger one, settled after the first
    const [ann] = await addSmsCustomers(t, 'a', [
      { firstName: 'Ann', phone: '+13055550111', consent: 'attested', state: 'FL', timezone: 'America/New_York' },
    ]);
    const second = await approvedBatch(t, actors, [ann!]);
    await t.queue.drain(t.deps);
    // Both batches' waiting texts are dealt with some other way, so both steps are ready to finish.
    await inCompany(t, idOf('a'), (tx) =>
      tx.update(messages).set({ status: 'blocked', blockRule: 'contact', blockReason: OPTED_OUT }).where(eq(messages.status, 'scheduled')),
    );
    // The first step's row refuses every change (standing in for a fault on that one step).
    const owner = new pg.Client({ connectionString: inject('dbUrls').owner });
    await owner.connect();
    try {
      await owner.query(`create function test_refuse_step() returns trigger language plpgsql as $$
        begin raise exception 'this step is broken'; end $$`);
      await owner.query(`create trigger test_refuse_step before update on agent_task_steps
        for each row when (old.id = '${first.stepId}') execute function test_refuse_step()`);

      await dispatchAt(at(BATCH_AT, 2 * MINUTE));

      expect(await stepOf(first.taskId)).toMatchObject({ status: 'running' });
      expect((await dbSteps(t, 'a', second.taskId))[0]).toMatchObject({ status: 'done' });
      expect((await dbTask(t, 'a', second.taskId)).status).toBe('done');
      expect(t.logged.map((l) => l.where)).toEqual([`dispatch-messages: step ${first.stepId}`]);
    } finally {
      await owner.query('drop trigger if exists test_refuse_step on agent_task_steps');
      await owner.query('drop function if exists test_refuse_step()');
      await owner.end();
    }

    await dispatchAt(at(BATCH_AT, 3 * MINUTE));
    expect(await stepOf(first.taskId)).toMatchObject({ status: 'done' });
  });

  test('two dispatchers at once: every due text is sent exactly once and the step finishes once', async () => {
    const ids = await addSmsCustomers(t, 'a', [
      { firstName: 'Ann', phone: '+13055550111', consent: 'attested', state: 'FL', timezone: 'America/New_York' },
      { firstName: 'Ben', phone: '+13055550112', consent: 'attested', state: 'FL', timezone: 'America/New_York' },
      { firstName: 'Cal', phone: '+13055550113', consent: 'attested', state: 'FL', timezone: 'America/New_York' },
    ]);
    const { taskId } = await approvedBatch(t, actors, ids);
    await t.queue.drain(t.deps);
    expect(t.sms.sent).toEqual([]);

    const fake = new FakeSmsAdapter();
    const held = new HeldSmsAdapter(fake, 2);
    const deps = { ...t.deps, sms: held };
    t.clock.set(MORNING);
    const results = await Promise.all([
      dispatchCompanyMessages(deps, idOf('a'), MORNING),
      dispatchCompanyMessages(deps, idOf('a'), MORNING),
    ]);

    expect(sentTo(fake.sent)).toEqual(['+13055550111', '+13055550112', '+13055550113']);
    expect(results.reduce((n, r) => n + r.sent, 0)).toBe(3);
    expect(results.reduce((n, r) => n + r.finished, 0)).toBe(1);
    expect(await stepOf(taskId)).toMatchObject({ status: 'done', result: { sent: 3, scheduled: 0, failed: 0, blocked: {} } });
    expect(await dbTask(t, 'a', taskId)).toMatchObject({ status: 'done', minutesSaved: 5 });
  });

  test('one company failing does not stop the others; the failure is logged with the company only', async () => {
    await parkedBatch();
    // Company B has a text waiting too, sent by hand (no step).
    const [rosaB] = await addSmsCustomers(t, 'b', [BRIEF_FIVE[4]!]);
    await inCompany(t, idOf('b'), (tx) =>
      tx.insert(messages).values({
        companyId: idOf('b'),
        customerId: rosaB!,
        channel: 'sms',
        direction: 'out',
        purpose: 'informational',
        body: 'Hi Rosa, your crew arrives at 9am.',
        status: 'scheduled',
        scheduledFor: NEXT_MORNING_NY,
        toE164: '+13055550105',
      }),
    );
    t.clock.set(MORNING);

    const summary = await dispatchDueMessages(t.deps, MORNING, async (deps, companyId, now) => {
      if (companyId === idOf('a')) throw new Error('company A is broken');
      return dispatchCompanyMessages(deps, companyId, now);
    });

    expect(summary).toMatchObject({ sent: 1 });
    expect(t.sms.sent.slice(1)).toEqual([{ companyId: idOf('b'), to: '+13055550105', body: 'Hi Rosa, your crew arrives at 9am.' }]);
    expect(t.logged.map((l) => [(l.err as Error).message, l.where])).toEqual([
      ['company A is broken', `dispatch-messages: company ${idOf('a')}`],
    ]);
    const rowsA = await inCompany(t, idOf('a'), (tx) => tx.select().from(messages).where(eq(messages.status, 'scheduled')));
    expect(rowsA).toHaveLength(1);
  });

  test('a parked step whose texts were all dealt with some other way is finished by the next dispatch', async () => {
    const { taskId, stepId, c5 } = await parkedBatch();
    const row = rowFor(await stepMessages(t, 'a', stepId), c5);
    await inCompany(t, idOf('a'), (tx) =>
      tx.update(messages).set({ status: 'blocked', blockRule: 'contact', blockReason: OPTED_OUT }).where(eq(messages.id, row.id)),
    );

    await dispatchAt(at(BATCH_AT, MINUTE));

    expect(await stepOf(taskId)).toMatchObject({ status: 'done', result: { sent: 1, scheduled: 0, failed: 0, blocked: { consent: 1, contact: 3 } } });
    expect((await dbTask(t, 'a', taskId)).status).toBe('done');
  });

  test('a text left queued by a dispatcher that died mid-send: after 5 minutes it is unconfirmed, never resent, and the step finishes', async () => {
    const { taskId, stepId, c5 } = await parkedBatch();
    const row = rowFor(await stepMessages(t, 'a', stepId), c5);
    const claimAt = MORNING;
    await inCompany(t, idOf('a'), (tx) =>
      tx.update(messages).set({ status: 'queued', updatedAt: claimAt }).where(eq(messages.id, row.id)),
    );

    await dispatchAt(at(claimAt, 4 * MINUTE));
    expect(rowFor(await stepMessages(t, 'a', stepId), c5)).toMatchObject({ status: 'queued' });
    expect(await stepOf(taskId)).toMatchObject({ status: 'running' });

    await dispatchAt(at(claimAt, 6 * MINUTE));
    expect(rowFor(await stepMessages(t, 'a', stepId), c5)).toMatchObject({ status: 'failed', retryable: false, blockReason: UNCONFIRMED });
    expect(t.sms.sent).toHaveLength(1);
    expect(await stepOf(taskId)).toMatchObject({ status: 'done', result: { sent: 1, scheduled: 0, failed: 1, blocked: { consent: 1, contact: 2 } } });
    expect((await dbTask(t, 'a', taskId)).status).toBe('done');
  });

  test('the system queries run as app_system and return company ids only', async () => {
    await parkedBatch();
    await expect(t.deps.pools.system.$client.query('select body from messages')).rejects.toThrow(/permission denied/);
    expect(await companiesWithDueMessages(t.deps.pools.system, at(NEXT_MORNING_NY, -MINUTE))).toEqual([]);
    expect(await companiesWithDueMessages(t.deps.pools.system, NEXT_MORNING_NY)).toEqual([idOf('a')]);
    expect(await companiesWithParkedSteps(t.deps.pools.system)).toEqual([idOf('a')]);
  });

  test('the worker runs it every minute', () => {
    const job = SCHEDULES.find((s) => s.name === 'dispatch-messages');
    expect(job).toMatchObject({ cron: '* * * * *', run: dispatchDueMessages });
  });
});
