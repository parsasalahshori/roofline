import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, test } from 'vitest';
import {
  companies,
  customers,
  insertStepText,
  messages,
  optOuts,
  properties,
  type StepRow,
  textingRegistrations,
  withTenant,
} from '@roofline/db';
import { FakeSmsAdapter, SmsRefusedError, type SmsAdapter } from '@roofline/send-gate';
import { dispatchDueMessages } from '../src/jobs/scheduler/dispatch-messages.ts';
import { buildGateRequest } from '../src/messaging/gate-request.ts';
import { sendSmsBatch } from '../src/messaging/send-batch.ts';
import { runStep } from '../src/tasks/runner.ts';
import { Actors, inCompany } from './crm-helpers.ts';
import { makeTestApp, type TestApp } from './helpers.ts';
import {
  addSmsCustomers,
  approvedBatch,
  ARCHIVED,
  gate,
  BATCH_AT,
  BRIEF_FIVE,
  DAY,
  DAYTIME,
  HeldSmsAdapter,
  HOUR,
  MINUTE,
  NEXT_MORNING_NY,
  NO_CONSENT,
  NO_LOCAL_TIME,
  NO_MOBILE,
  NOT_TAKEN,
  OPTED_OUT,
  rowFor,
  ScriptedSmsAdapter,
  sentTo,
  stepMessages,
  UNCONFIRMED,
  usageRows,
} from './sms-helpers.ts';
import { agentCtx, dbSteps, dbTask, RETRYING, setStep } from './task-helpers.ts';

let t: TestApp;
let actors: Actors;

beforeEach(async () => {
  t = await makeTestApp();
  t.clock.set(BATCH_AT);
  actors = new Actors(t);
});

const idOf = (company: 'a' | 'b') => t.seed[company].companyId;
const stepRow = async (taskId: string): Promise<StepRow> => (await dbSteps(t, 'a', taskId))[0]!;

/** The brief's five customers in company A, texted in one approved marketing batch at 20:30 Chicago. */
async function briefBatch(overrides: Record<string, unknown> = {}) {
  const [c1, c2, c3, c4, c5] = await addSmsCustomers(t, 'a', BRIEF_FIVE);
  const { taskId, stepId } = await approvedBatch(t, actors, [c1!, c2!, c3!, c4!, c5!], overrides);
  return { taskId, stepId, c1: c1!, c2: c2!, c3: c3!, c4: c4!, c5: c5! };
}

const BRIEF_RESULT = { sent: 1, scheduled: 1, failed: 0, blocked: { consent: 1, contact: 2 } };

describe('send_sms_batch', () => {
  test('the brief\'s five: c1 sent, c5 waits for 08:00 New York, the others blocked; the step is parked', async () => {
    const { taskId, stepId, c1, c2, c3, c4, c5 } = await briefBatch();

    await t.queue.drain(t.deps);

    const rows = await stepMessages(t, 'a', stepId);
    expect(rows).toHaveLength(5);
    expect(rowFor(rows, c1)).toMatchObject({
      status: 'sent',
      channel: 'sms',
      direction: 'out',
      purpose: 'marketing',
      body: "Hi Nina, it's Acme Roofing. Free roof check this week. Reply STOP to opt out.",
      toE164: '+14025550101',
      providerMessageSid: 'SMFAKE000001',
      segments: 1,
      sentAt: BATCH_AT,
      dedupeKey: null,
      retryable: false,
      blockRule: null,
      blockReason: null,
    });
    expect(rowFor(rows, c5)).toMatchObject({
      status: 'scheduled',
      scheduledFor: NEXT_MORNING_NY,
      blockRule: 'quiet_hours',
      blockReason: 'Will send at 8:00 AM their time (quiet hours).',
      toE164: '+13055550105',
      body: "Hi Rosa, it's Acme Roofing. Free roof check this week. Reply STOP to opt out.",
      sentAt: null,
    });
    expect(rowFor(rows, c2)).toMatchObject({ status: 'blocked', blockRule: 'consent', blockReason: NO_CONSENT });
    expect(rowFor(rows, c3)).toMatchObject({ status: 'blocked', blockRule: 'contact', blockReason: OPTED_OUT });
    expect(rowFor(rows, c4)).toMatchObject({ status: 'blocked', blockRule: 'contact', blockReason: NO_MOBILE, toE164: null });

    expect(t.sms.sent).toEqual([
      { companyId: idOf('a'), to: '+14025550101', body: "Hi Nina, it's Acme Roofing. Free roof check this week. Reply STOP to opt out." },
    ]);
    expect(await stepRow(taskId)).toMatchObject({ status: 'running', leaseExpiresAt: null, attempts: 1, result: BRIEF_RESULT });
    expect((await dbTask(t, 'a', taskId)).status).toBe('running');

    const usage = await usageRows(t, 'a');
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ kind: 'sms_segment', quantity: 1, refType: 'message', refId: rowFor(rows, c1).id, at: BATCH_AT });
  });

  test('running the step again (a re-delivery, a retry) texts nobody twice', async () => {
    const { taskId, stepId } = await briefBatch();
    await t.queue.drain(t.deps);
    const before = await stepMessages(t, 'a', stepId);

    // The handler itself, as a second run after a lost lease would call it...
    const again = await sendSmsBatch(t.deps, agentCtx(idOf('a')), await stepRow(taskId));
    expect(again).toEqual({ status: 'running', result: BRIEF_RESULT });
    // ...and through the runner, after the step is put back in the queue.
    await setStep(t, 'a', stepId, { status: 'queued' });
    await runStep(t.deps, idOf('a'), stepId);

    expect(t.sms.sent).toHaveLength(1);
    expect(await stepMessages(t, 'a', stepId)).toEqual(before);
    expect(await usageRows(t, 'a')).toHaveLength(1);
    expect(await stepRow(taskId)).toMatchObject({ status: 'running', leaseExpiresAt: null, result: BRIEF_RESULT });
  });

  test('a provider failure: the row fails (retryable), the handler throws once every customer is done, the retry sends it once', async () => {
    const { taskId, stepId, c1 } = await briefBatch();
    t.sms.failNext(1);

    const error = await runStep(t.deps, idOf('a'), stepId).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    // No customer data in what gets logged.
    const text = `${(error as Error).message} ${(error as Error).stack ?? ''}`;
    for (const secret of ['4025550101', 'Nina', 'Free roof check', c1]) expect(text).not.toContain(secret);

    let rows = await stepMessages(t, 'a', stepId);
    expect(rows).toHaveLength(5); // every customer was still decided
    expect(rowFor(rows, c1)).toMatchObject({ status: 'failed', retryable: true, blockReason: NOT_TAKEN, sentAt: null, providerMessageSid: null });
    expect(await stepRow(taskId)).toMatchObject({ status: 'queued', errorPlain: RETRYING, attempts: 1 });
    expect(t.sms.sent).toEqual([]);
    expect(await usageRows(t, 'a')).toEqual([]);

    await t.queue.drain(t.deps);

    rows = await stepMessages(t, 'a', stepId);
    expect(rowFor(rows, c1)).toMatchObject({ status: 'sent', retryable: false, blockReason: null, providerMessageSid: 'SMFAKE000001' });
    expect(sentTo(t.sms.sent)).toEqual(['+14025550101']);
    expect(await usageRows(t, 'a')).toHaveLength(1);
    expect(await stepRow(taskId)).toMatchObject({ status: 'running', attempts: 2, errorPlain: null, result: BRIEF_RESULT });
  });

  test('a provider that never takes the text: after 5 runs the step needs attention, and the text was never sent', async () => {
    const { taskId, stepId, c1 } = await briefBatch();
    t.sms.failNext(10);
    await t.queue.drain(t.deps);
    expect(await stepRow(taskId)).toMatchObject({ status: 'needs_attention', attempts: 5 });
    expect(rowFor(await stepMessages(t, 'a', stepId), c1)).toMatchObject({ status: 'failed', retryable: true });
    expect(t.sms.sent).toEqual([]);
    expect((await dbTask(t, 'a', taskId)).status).toBe('needs_attention');
  });

  test('a send whose outcome is unknown (a timeout, not a refusal) is never resent: failed, not retryable, and no retry', async () => {
    const { taskId, stepId, c1 } = await briefBatch();
    t.sms.failUnknownNext(1);

    await runStep(t.deps, idOf('a'), stepId);

    expect(rowFor(await stepMessages(t, 'a', stepId), c1)).toMatchObject({ status: 'failed', retryable: false, blockReason: UNCONFIRMED });
    expect(t.sms.sent).toEqual([]);
    // Not thrown: there is nothing a retry may do for it. c5 still waits, so the step is parked.
    expect(await stepRow(taskId)).toMatchObject({
      status: 'running',
      attempts: 1,
      result: { sent: 0, scheduled: 1, failed: 1, blocked: { consent: 1, contact: 2 } },
    });
    expect(await sendSmsBatch(t.deps, agentCtx(idOf('a')), await stepRow(taskId))).toMatchObject({ status: 'running' });
    expect(t.sms.sent).toEqual([]);
  });

  test('a refused text the run did not reach itself still makes it throw, and the next run sends it', async () => {
    t.clock.set(DAYTIME);
    const [ann, ben] = await addSmsCustomers(t, 'a', [
      { firstName: 'Ann', phone: '+14025550111', consent: 'attested' },
      { firstName: 'Ben', phone: '+14025550112', consent: 'attested' },
    ]);
    const { taskId, stepId } = await approvedBatch(t, actors, [ann!, ben!]);
    // Ben's text was refused by the provider in some other run (or by the dispatcher).
    await inCompany(t, idOf('a'), (tx) =>
      tx.insert(messages).values({
        companyId: idOf('a'),
        customerId: ben!,
        stepId,
        channel: 'sms',
        direction: 'out',
        purpose: 'marketing',
        body: 'refused earlier',
        status: 'failed',
        retryable: true,
        blockReason: NOT_TAKEN,
      }),
    );
    const step = await stepRow(taskId);
    const ctx = agentCtx(idOf('a'));
    // A run that only covers Ann (as if it passed Ben while his text was still on its way).
    const onlyAnn = { ...step, payload: { ...step.payload, customerIds: [ann!] } };
    await expect(sendSmsBatch(t.deps, ctx, onlyAnn)).rejects.toThrow();
    expect(sentTo(t.sms.sent)).toEqual(['+14025550111']);

    expect(await sendSmsBatch(t.deps, ctx, step)).toEqual({ status: 'done', result: { sent: 2, scheduled: 0, failed: 0, blocked: {} } });
    expect(sentTo(t.sms.sent)).toEqual(['+14025550111', '+14025550112']);
  });

  test('two runs: B passes X while A is sending it, A\'s send is refused, B must not finish the step; the retry texts X once', async () => {
    t.clock.set(DAYTIME);
    const [x, y] = await addSmsCustomers(t, 'a', [
      { firstName: 'Xia', phone: '+14025550121', consent: 'attested' },
      { firstName: 'Yan', phone: '+14025550122', consent: 'attested' },
    ]);
    const { taskId, stepId } = await approvedBatch(t, actors, [x!, y!]);
    const sms = new ScriptedSmsAdapter();
    const deps = { ...t.deps, sms };
    const ctx = agentCtx(idOf('a'));
    const step = await stepRow(taskId);
    const [xEntered, xRelease, yEntered, yRelease] = [gate(), gate(), gate(), gate()];
    sms.on('+14025550121', async () => {
      xEntered.open();
      await xRelease.opened;
      throw new SmsRefusedError('refused');
    });
    sms.on('+14025550122', async () => {
      yEntered.open();
      await yRelease.opened;
    });
    const settle = (p: Promise<unknown>) => p.then((v) => ({ ok: v }), (e: unknown) => ({ threw: (e as Error).message }));

    const runA = settle(sendSmsBatch(deps, ctx, step)); // claims X and waits in the provider
    await xEntered.opened;
    const runB = settle(sendSmsBatch(deps, ctx, step)); // X is A's; claims Y and waits
    await yEntered.opened;
    xRelease.open(); // A's send of X is refused; A skips Y (B's) and throws
    expect(await runA).toHaveProperty('threw');
    yRelease.open(); // B sends Y, then finds X refused: it throws too, rather than finish without X
    expect(await runB).toHaveProperty('threw');
    expect(rowFor(await stepMessages(t, 'a', stepId), x!)).toMatchObject({ status: 'failed', retryable: true, blockReason: NOT_TAKEN });

    expect(await sendSmsBatch(deps, ctx, step)).toEqual({ status: 'done', result: { sent: 2, scheduled: 0, failed: 0, blocked: {} } });
    expect(sentTo(sms.sent)).toEqual(['+14025550121', '+14025550122']);
  });

  test('an archived customer is not texted (contact: "This customer is archived."), after the billing and registration rules', async () => {
    t.clock.set(DAYTIME);
    const [ann, ben] = await addSmsCustomers(t, 'a', [
      { firstName: 'Ann', phone: '+14025550111', consent: 'attested' },
      { firstName: 'Ben', phone: '+14025550112', consent: 'attested' },
    ]);
    await inCompany(t, idOf('a'), (tx) => tx.update(customers).set({ archivedAt: DAYTIME }).where(eq(customers.id, ann!)));
    const { stepId } = await approvedBatch(t, actors, [ann!, ben!]);
    await t.queue.drain(t.deps);
    let rows = await stepMessages(t, 'a', stepId);
    expect(rowFor(rows, ann!)).toMatchObject({ status: 'blocked', blockRule: 'contact', blockReason: ARCHIVED });
    expect(rowFor(rows, ben!)).toMatchObject({ status: 'sent' });
    expect(sentTo(t.sms.sent)).toEqual(['+14025550112']);

    // With texting not registered, the registration rule (which comes first) is the one reported.
    await t.deps.pools.system.$client.query('delete from texting_registrations where company_id = $1', [idOf('a')]);
    const second = await approvedBatch(t, actors, [ann!]);
    await t.queue.drain(t.deps);
    rows = await stepMessages(t, 'a', second.stepId);
    expect(rowFor(rows, ann!)).toMatchObject({ status: 'blocked', blockRule: 'registration' });
  });

  test('a batch where nothing has to wait finishes the step and the task, with the minutes saved', async () => {
    t.clock.set(DAYTIME);
    const ids = await addSmsCustomers(t, 'a', [
      { firstName: 'Ann', phone: '+14025550111', consent: 'attested', state: 'NE', timezone: 'America/Chicago' },
      { firstName: 'Ben', phone: '+14025550112', consent: 'written' },
      { firstName: 'Cal', phone: '+14025550113', consent: 'none' },
    ]);
    const { taskId, stepId } = await approvedBatch(t, actors, ids);
    await t.queue.drain(t.deps);
    expect(await stepRow(taskId)).toMatchObject({ status: 'done', result: { sent: 2, scheduled: 0, failed: 0, blocked: { consent: 1 } } });
    expect(await dbTask(t, 'a', taskId)).toMatchObject({ status: 'done', minutesSaved: 3 });
    expect((await stepMessages(t, 'a', stepId)).map((r) => r.status).sort()).toEqual(['blocked', 'sent', 'sent']);
  });

  test('an informational text needs only express consent, and is not held by the marketing rules', async () => {
    t.clock.set(DAYTIME);
    const [id] = await addSmsCustomers(t, 'a', [{ firstName: 'Omar', phone: '+14025550102', consent: 'express' }]);
    const { taskId } = await approvedBatch(t, actors, [id!], { purpose: 'informational', body: 'Hi {first_name}, your crew arrives at 8am Tuesday.' });
    await t.queue.drain(t.deps);
    expect(t.sms.sent.map((m) => m.body)).toEqual(['Hi Omar, your crew arrives at 8am Tuesday.']);
    expect((await stepRow(taskId)).status).toBe('done');
  });

  test('a customer whose local time cannot be worked out fails (not retryable) and the batch goes on', async () => {
    t.clock.set(DAYTIME);
    // The company's own zone is broken and Nina has no home on file; Rosa's home has its own zone.
    await inCompany(t, idOf('a'), (tx) => tx.update(companies).set({ timezone: 'Mars/Olympus_Mons' }).where(eq(companies.id, idOf('a'))));
    const [nina, rosa] = await addSmsCustomers(t, 'a', [
      { firstName: 'Nina', phone: '+14025550101', consent: 'attested' },
      { firstName: 'Rosa', phone: '+13055550105', consent: 'attested', state: 'FL', timezone: 'America/New_York' },
    ]);
    const { taskId, stepId } = await approvedBatch(t, actors, [nina!, rosa!]);

    await t.queue.drain(t.deps);

    const rows = await stepMessages(t, 'a', stepId);
    expect(rowFor(rows, nina!)).toMatchObject({ status: 'failed', retryable: false, blockReason: NO_LOCAL_TIME, blockRule: null });
    expect(rowFor(rows, rosa!)).toMatchObject({ status: 'sent' });
    expect(sentTo(t.sms.sent)).toEqual(['+13055550105']);
    // Not a provider failure, so nothing to retry: the step is done, with the failure counted.
    expect(await stepRow(taskId)).toMatchObject({ status: 'done', attempts: 1, result: { sent: 1, scheduled: 0, failed: 1, blocked: {} } });
  });

  test('a row left queued by a run that died: after 5 minutes it fails as unconfirmed and is never resent; a fresher one is left to its run', async () => {
    t.clock.set(DAYTIME);
    const [old, fresh, other] = await addSmsCustomers(t, 'a', [
      { firstName: 'Ann', phone: '+14025550111', consent: 'attested' },
      { firstName: 'Ben', phone: '+14025550112', consent: 'attested' },
      { firstName: 'Cal', phone: '+14025550113', consent: 'attested' },
    ]);
    const { taskId, stepId } = await approvedBatch(t, actors, [old!, fresh!, other!]);
    const queuedRow = (customerId: string, since: Date) =>
      inCompany(t, idOf('a'), (tx) =>
        tx.insert(messages).values({
          companyId: idOf('a'),
          customerId,
          stepId,
          channel: 'sms',
          direction: 'out',
          purpose: 'marketing',
          body: 'claimed by an earlier run',
          status: 'queued',
          createdAt: since,
          updatedAt: since,
        }),
      );
    await queuedRow(old!, new Date(DAYTIME.getTime() - 6 * MINUTE));
    await queuedRow(fresh!, new Date(DAYTIME.getTime() - 1 * MINUTE));

    await t.queue.drain(t.deps);

    const rows = await stepMessages(t, 'a', stepId);
    expect(rowFor(rows, old!)).toMatchObject({ status: 'failed', retryable: false, blockReason: UNCONFIRMED });
    expect(rowFor(rows, fresh!)).toMatchObject({ status: 'queued' });
    expect(rowFor(rows, other!)).toMatchObject({ status: 'sent' });
    expect(sentTo(t.sms.sent)).toEqual(['+14025550113']);
    // A text still on its way under another run: this run parks the step rather than finish without it.
    expect(await stepRow(taskId)).toMatchObject({ status: 'running', leaseExpiresAt: null, result: { sent: 1, scheduled: 0, failed: 1, blocked: {} } });
  });

  test('two runs of one step at the same time: every customer is texted exactly once', async () => {
    t.clock.set(DAYTIME);
    const ids = await addSmsCustomers(t, 'a', [
      { firstName: 'Ann', phone: '+14025550111', consent: 'attested' },
      { firstName: 'Ben', phone: '+14025550112', consent: 'attested' },
      { firstName: 'Cal', phone: '+14025550113', consent: 'attested' },
      { firstName: 'Dee', phone: '+14025550114', consent: 'attested' },
    ]);
    const { taskId, stepId } = await approvedBatch(t, actors, ids);
    const fake = new FakeSmsAdapter();
    // Both runs are inside a send before either is let through.
    const held = new HeldSmsAdapter(fake, 2);
    const deps = { ...t.deps, sms: held };
    const step = await stepRow(taskId);
    const ctx = agentCtx(idOf('a'));

    const outcomes = await Promise.all([sendSmsBatch(deps, ctx, step), sendSmsBatch(deps, ctx, step)]);

    expect(sentTo(fake.sent)).toEqual(['+14025550111', '+14025550112', '+14025550113', '+14025550114']);
    const rows = await stepMessages(t, 'a', stepId);
    expect(rows.map((r) => r.status)).toEqual(['sent', 'sent', 'sent', 'sent']);
    expect(await usageRows(t, 'a')).toHaveLength(4);
    for (const outcome of outcomes) expect(['done', 'running']).toContain(outcome.status);
    // Whichever finished, a later run sees the whole batch sent.
    expect(await sendSmsBatch(deps, ctx, step)).toEqual({ status: 'done', result: { sent: 4, scheduled: 0, failed: 0, blocked: {} } });
    expect(fake.sent).toHaveLength(4);
  });

  test('the database backstop: a second insert for the same step and customer writes nothing and returns null', async () => {
    t.clock.set(DAYTIME);
    const [ann] = await addSmsCustomers(t, 'a', [{ firstName: 'Ann', phone: '+14025550111', consent: 'attested' }]);
    const { stepId } = await approvedBatch(t, actors, [ann!]);
    const ctx = agentCtx(idOf('a'));
    const text = { customerId: ann!, purpose: 'marketing' as const, body: 'Hi', toE164: '+14025550111', dedupeKey: null };
    const first = await withTenant(t.deps.pools, ctx, (tx) => insertStepText(tx, ctx, stepId, text, { status: 'queued' }, DAYTIME));
    const second = await withTenant(t.deps.pools, ctx, (tx) =>
      insertStepText(tx, ctx, stepId, text, { status: 'blocked', blockRule: 'consent', blockReason: NO_CONSENT }, DAYTIME),
    );
    expect(first).toEqual(expect.any(String));
    expect(second).toBeNull();
    expect((await stepMessages(t, 'a', stepId)).map((r) => [r.id, r.status])).toEqual([[first, 'queued']]);
  });

  test('a payload that is not a batch\'s needs attention at once, and texts nobody', async () => {
    t.clock.set(DAYTIME);
    const [ann] = await addSmsCustomers(t, 'a', [{ firstName: 'Ann', phone: '+14025550111', consent: 'attested' }]);
    const { taskId } = await approvedBatch(t, actors, [ann!]);
    const step = await stepRow(taskId);
    const outcome = await sendSmsBatch(t.deps, agentCtx(idOf('a')), { ...step, payload: { body: 'Hi', customerIds: 'everyone' } });
    expect(outcome).toEqual({
      status: 'needs_attention',
      result: {},
      errorPlain: "We couldn't read who to text or what to send. Please make this plan again.",
    });
    expect(t.sms.sent).toEqual([]);
  });

  test('a dedupe prefix: the key is <prefix>:<customer>, and a second batch with the same prefix blocks who already got it', async () => {
    t.clock.set(DAYTIME);
    const [ann, ben] = await addSmsCustomers(t, 'a', [
      { firstName: 'Ann', phone: '+14025550111', consent: 'attested' },
      { firstName: 'Ben', phone: '+14025550112', consent: 'attested' },
    ]);
    const first = await approvedBatch(t, actors, [ann!], { dedupePrefix: 'storm:elm' });
    await t.queue.drain(t.deps);
    expect(rowFor(await stepMessages(t, 'a', first.stepId), ann!)).toMatchObject({ status: 'sent', dedupeKey: `storm:elm:${ann}` });

    const second = await approvedBatch(t, actors, [ann!, ben!], { dedupePrefix: 'storm:elm' });
    await t.queue.drain(t.deps);
    const rows = await stepMessages(t, 'a', second.stepId);
    expect(rowFor(rows, ann!)).toMatchObject({
      status: 'blocked',
      blockRule: 'dedupe',
      blockReason: 'Already sent this message to this customer.',
      dedupeKey: `storm:elm:${ann}`,
    });
    expect(rowFor(rows, ben!)).toMatchObject({ status: 'sent', dedupeKey: `storm:elm:${ben}` });
    expect(sentTo(t.sms.sent)).toEqual(['+14025550111', '+14025550112']);
  });

  test('the weekly cap counts marketing texts from other batches: the third in 7 days is blocked', async () => {
    t.clock.set(DAYTIME);
    const [ann] = await addSmsCustomers(t, 'a', [{ firstName: 'Ann', phone: '+14025550111', consent: 'attested' }]);
    for (let i = 0; i < 2; i++) {
      await approvedBatch(t, actors, [ann!]);
      await t.queue.drain(t.deps);
      t.clock.advance(DAY);
    }
    const third = await approvedBatch(t, actors, [ann!]);
    await t.queue.drain(t.deps);
    expect(rowFor(await stepMessages(t, 'a', third.stepId), ann!)).toMatchObject({ status: 'blocked', blockRule: 'frequency' });
    expect(t.sms.sent).toHaveLength(2);
  });
});

describe('a home saved without a time zone', () => {
  test("follows the company's zone when it is fixed later: 21:30 New York (20:30 Chicago) waits for 08:00 New York", async () => {
    // A New York roofer adds a customer and their home while the company zone is still the
    // America/Chicago default (F3 sets it from the geocoded address), and only then fixes the zone.
    const owner = await actors.as('owner');
    const [ann] = await addSmsCustomers(t, 'a', [{ firstName: 'Ann', phone: '+12125550131', consent: 'attested' }]);
    const home = await owner
      .post('/api/properties')
      .send({ customerId: ann, addressLine: '5 Bleecker St', city: 'New York', state: 'NY', zip: '10012' });
    expect(home.status).toBe(201);
    expect((await owner.patch('/api/company').send({ timezone: 'America/New_York' })).status).toBe(200);

    // The marketing batch runs at 20:30 Chicago: 21:30 in New York, after 21:00 there.
    expect(t.clock.now()).toEqual(BATCH_AT);
    const { taskId, stepId } = await approvedBatch(t, actors, [ann!]);
    await t.queue.drain(t.deps);

    expect(rowFor(await stepMessages(t, 'a', stepId), ann!)).toMatchObject({
      status: 'scheduled',
      scheduledFor: NEXT_MORNING_NY,
      blockRule: 'quiet_hours',
      blockReason: 'Will send at 8:00 AM their time (quiet hours).',
      sentAt: null,
    });
    expect(t.sms.sent).toEqual([]);
    expect(await stepRow(taskId)).toMatchObject({ status: 'running', result: { sent: 0, scheduled: 1, failed: 0, blocked: {} } });
    // Because the home has no zone of its own: the company's is the one that applies.
    expect((await owner.get(`/api/properties/${home.body.id}`)).body.timezone).toBeNull();

    // At 08:01 New York the dispatcher sends it.
    t.clock.set(new Date(NEXT_MORNING_NY.getTime() + MINUTE));
    await dispatchDueMessages(t.deps, t.clock.now());
    expect(sentTo(t.sms.sent)).toEqual(['+12125550131']);
  });
});

describe('buildGateRequest', () => {
  const build = (customerId: string, over: { purpose?: 'marketing' | 'informational'; dedupeKey?: string | null; body?: string } = {}) =>
    inCompany(t, idOf('a'), (tx) =>
      buildGateRequest(
        tx,
        agentCtx(idOf('a')),
        {
          customerId,
          purpose: over.purpose ?? 'marketing',
          body: over.body ?? 'Hi {first_name}, {company} here. Reply STOP to opt out.',
          dedupeKey: over.dedupeKey ?? null,
          replyToInboundAt: null,
        },
        t.clock.now(),
      ),
    );

  /** A sent (or other) outbound text to a customer from no step, `ago` before now. */
  const pastText = (customerId: string, ago: number, set: Partial<typeof messages.$inferInsert> = {}) =>
    inCompany(t, idOf('a'), (tx) =>
      tx.insert(messages).values({
        companyId: idOf('a'),
        customerId,
        channel: 'sms',
        direction: 'out',
        purpose: 'marketing',
        body: 'earlier',
        status: 'sent',
        sentAt: new Date(t.clock.now().getTime() - ago),
        ...set,
      }),
    );

  test('the company, the customer and the rendered body, as the gate needs them', async () => {
    const [nina] = await addSmsCustomers(t, 'a', [BRIEF_FIVE[0]!]);
    const built = await build(nina!);
    expect(built).toEqual({
      toE164: '+14025550101',
      archived: false,
      sender: null,
      req: {
        now: BATCH_AT,
        company: { name: 'Acme Roofing', timezone: 'America/Chicago', status: 'trial', campaignStatus: 'approved', marketingCapPer7d: 2 },
        recipient: { phoneE164: '+14025550101', consent: 'attested', doNotContact: false, optedOut: false, timezone: 'America/Chicago', state: 'NE' },
        message: { purpose: 'marketing', body: 'Hi Nina, Acme Roofing here. Reply STOP to opt out.', dedupeKey: null, replyToInboundAt: null },
        history: { dedupeAlreadySent: false, marketingSentAt: [] },
      },
    });
  });

  test('the primary number, else the first; none means null', async () => {
    const [id] = await addSmsCustomers(t, 'a', [{ firstName: 'Ann', phone: null, consent: 'attested' }]);
    const setPhones = (phones: { e164: string; primary?: boolean }[]) =>
      inCompany(t, idOf('a'), (tx) => tx.update(customers).set({ phones }).where(eq(customers.id, id!)));
    expect((await build(id!))!.toE164).toBeNull();
    await setPhones([{ e164: '+14025550001' }, { e164: '+14025550002', primary: true }]);
    expect((await build(id!))!.req.recipient.phoneE164).toBe('+14025550002');
    await setPhones([{ e164: '+14025550001' }, { e164: '+14025550002' }]);
    expect((await build(id!))!.toE164).toBe('+14025550001');
  });

  test('the zone and state come from the most recently updated home; with none they are null', async () => {
    const [id] = await addSmsCustomers(t, 'a', [{ firstName: 'Ann', phone: '+14025550111', consent: 'attested' }]);
    expect((await build(id!))!.req.recipient).toMatchObject({ timezone: null, state: null });
    const home = (n: number, state: string, timezone: string, updatedAt: Date) =>
      inCompany(t, idOf('a'), (tx) =>
        tx.insert(properties).values({
          companyId: idOf('a'),
          customerId: id!,
          addressLine: `${n} Birch Ave`,
          city: 'Somewhere',
          state,
          zip: '00000',
          addressKey: `${n} birch ave|00000`,
          timezone,
          updatedAt,
        }),
      );
    await home(1, 'FL', 'America/New_York', new Date(BATCH_AT.getTime() - HOUR));
    await home(2, 'CO', 'America/Denver', new Date(BATCH_AT.getTime() - DAY));
    expect((await build(id!))!.req.recipient).toMatchObject({ timezone: 'America/New_York', state: 'FL' });
  });

  test('an archived home is not where they live: the latest home still in use wins; with none, zone and state are null', async () => {
    const [id] = await addSmsCustomers(t, 'a', [{ firstName: 'Ann', phone: '+14025550111', consent: 'attested' }]);
    const home = (n: number, state: string, timezone: string, updatedAt: Date, archivedAt: Date | null) =>
      inCompany(t, idOf('a'), async (tx) => {
        const [row] = await tx
          .insert(properties)
          .values({
            companyId: idOf('a'),
            customerId: id!,
            addressLine: `${n} Cedar Ct`,
            city: 'Somewhere',
            state,
            zip: '00000',
            addressKey: `${n} cedar ct|00000`,
            timezone,
            updatedAt,
            archivedAt,
          })
          .returning({ id: properties.id });
        return row!.id;
      });
    // They moved from Nebraska to Florida; archiving the old home touched it last.
    await home(1, 'FL', 'America/New_York', new Date(BATCH_AT.getTime() - DAY), null);
    await home(2, 'NE', 'America/Chicago', new Date(BATCH_AT.getTime() - HOUR), BATCH_AT);
    expect((await build(id!))!.req.recipient).toMatchObject({ timezone: 'America/New_York', state: 'FL' });

    // At 20:30 Chicago the Florida rules (20:00 end) hold the text for the morning.
    const { stepId } = await approvedBatch(t, actors, [id!]);
    await t.queue.drain(t.deps);
    expect(rowFor(await stepMessages(t, 'a', stepId), id!)).toMatchObject({ status: 'scheduled', scheduledFor: NEXT_MORNING_NY });

    await inCompany(t, idOf('a'), (tx) => tx.update(properties).set({ archivedAt: BATCH_AT }).where(eq(properties.customerId, id!)));
    expect((await build(id!))!.req.recipient).toMatchObject({ timezone: null, state: null });
  });

  test('an archived customer is marked archived for the gate', async () => {
    const [ann] = await addSmsCustomers(t, 'a', [{ firstName: 'Ann', phone: '+14025550111', consent: 'attested' }]);
    expect((await build(ann!))!.archived).toBe(false);
    await inCompany(t, idOf('a'), (tx) => tx.update(customers).set({ archivedAt: BATCH_AT }).where(eq(customers.id, ann!)));
    expect((await build(ann!))!.archived).toBe(true);
  });

  test('opted out means an opt-out row for that number, in this company', async () => {
    const [ann, ben] = await addSmsCustomers(t, 'a', [
      { firstName: 'Ann', phone: '+14025550111', consent: 'attested', optedOut: true },
      { firstName: 'Ben', phone: '+14025550112', consent: 'attested' },
    ]);
    // Company B's opt-out list does not reach company A.
    await addSmsCustomers(t, 'b', [{ firstName: 'Ben', phone: '+14025550112', consent: 'attested', optedOut: true }]);
    expect((await build(ann!))!.req.recipient.optedOut).toBe(true);
    expect((await build(ben!))!.req.recipient.optedOut).toBe(false);
  });

  test('dedupe: an outbound text with the key that went out (or is going out), from any step', async () => {
    const [ann] = await addSmsCustomers(t, 'a', [{ firstName: 'Ann', phone: '+14025550111', consent: 'attested' }]);
    const key = `storm:elm:${ann}`;
    expect((await build(ann!, { dedupeKey: key }))!.req.history.dedupeAlreadySent).toBe(false);
    await pastText(ann!, HOUR, { dedupeKey: key, status: 'blocked', sentAt: null });
    await pastText(ann!, HOUR, { dedupeKey: key, status: 'failed', sentAt: null });
    await pastText(ann!, HOUR, { dedupeKey: 'storm:oak', status: 'sent' });
    expect((await build(ann!, { dedupeKey: key }))!.req.history.dedupeAlreadySent).toBe(false);
    expect((await build(ann!))!.req.history.dedupeAlreadySent).toBe(false);
    await pastText(ann!, 30 * DAY, { dedupeKey: key, status: 'delivered' });
    expect((await build(ann!, { dedupeKey: key }))!.req.history.dedupeAlreadySent).toBe(true);
  });

  test('marketingSentAt: this customer\'s marketing texts that went out in the last 7 days, and ones on their way', async () => {
    const [ann, ben] = await addSmsCustomers(t, 'a', [
      { firstName: 'Ann', phone: '+14025550111', consent: 'attested' },
      { firstName: 'Ben', phone: '+14025550112', consent: 'attested' },
    ]);
    const now = BATCH_AT.getTime();
    await pastText(ann!, 2 * HOUR); // counts
    await pastText(ann!, 6 * DAY, { status: 'delivered' }); // counts
    await pastText(ann!, 8 * DAY); // too old
    await pastText(ann!, HOUR, { purpose: 'informational' }); // not marketing
    await pastText(ann!, HOUR, { status: 'blocked', sentAt: null }); // never went out
    await pastText(ann!, HOUR, { direction: 'in', status: 'received' }); // theirs, not ours
    await pastText(ben!, HOUR); // someone else
    // On its way under another run right now: counted from when it was queued.
    await pastText(ann!, 0, { status: 'queued', sentAt: null, updatedAt: new Date(now - MINUTE) });
    const sent = (await build(ann!))!.req.history.marketingSentAt.map((d) => d.getTime()).sort((a, b) => a - b);
    expect(sent).toEqual([now - 6 * DAY, now - 2 * HOUR, now - MINUTE]);
  });

  test('the cap comes from the company settings; no registration row means texting is not registered', async () => {
    const [ann] = await addSmsCustomers(t, 'a', [{ firstName: 'Ann', phone: '+14025550111', consent: 'attested' }]);
    await (await actors.as('owner')).patch('/api/company/settings').send({ marketingCapPer7d: 1 });
    expect((await build(ann!))!.req.company.marketingCapPer7d).toBe(1);
    // app_system owns the registration; take company A's away.
    await t.deps.pools.system.$client.query('delete from texting_registrations where company_id = $1', [idOf('a')]);
    expect((await build(ann!))!.req.company.campaignStatus).toBe('none');
  });

  test('a customer that is not in this company → null, and a batch that somehow lists one skips it', async () => {
    t.clock.set(DAYTIME);
    const [other] = await addSmsCustomers(t, 'b', [{ firstName: 'Ann', phone: '+14025550111', consent: 'attested' }]);
    expect(await build(other!)).toBeNull();

    const [own] = await addSmsCustomers(t, 'a', [{ firstName: 'Ben', phone: '+14025550112', consent: 'attested' }]);
    const { taskId } = await approvedBatch(t, actors, [own!]);
    const step = await stepRow(taskId);
    const tampered = { ...step, payload: { ...step.payload, customerIds: [other!, own!] } };
    const outcome = await sendSmsBatch(t.deps, agentCtx(idOf('a')), tampered);
    expect(outcome).toEqual({ status: 'done', result: { sent: 1, scheduled: 0, failed: 0, blocked: {} } });
    expect(sentTo(t.sms.sent)).toEqual(['+14025550112']);
    const all = await withTenant(t.deps.pools, agentCtx(idOf('a')), (tx) => tx.select().from(messages));
    expect(all.map((m) => m.customerId)).toEqual([own]);
  });
});

describe('carrier opt-outs and the sending account', () => {
  const NUMBER = '+14025550131';
  const CARRIER_REASON = 'This person turned off texts from your number, so we stopped texting them.';
  const SUB_SID = 'AC' + '1'.repeat(32);
  const MS_SID = 'MG' + '2'.repeat(32);

  /** One attested customer with a number, texted in an approved batch at a daytime hour. */
  async function oneCustomer() {
    t.clock.set(DAYTIME);
    const [id] = await addSmsCustomers(t, 'a', [{ firstName: 'Vic', phone: NUMBER, consent: 'attested', state: 'NE', timezone: 'America/Chicago' }]);
    const { taskId, stepId } = await approvedBatch(t, actors, [id!]);
    return { id: id!, taskId, stepId };
  }

  const consentOf = (customerId: string) =>
    inCompany(t, idOf('a'), async (tx) => (await tx.select({ s: customers.smsConsentStatus }).from(customers).where(eq(customers.id, customerId)))[0]!.s);

  const optOutRows = (phone: string) =>
    inCompany(t, idOf('a'), (tx) => tx.select().from(optOuts).where(eq(optOuts.phoneE164, phone)));

  test('a carrier opt-out turns texting off for that customer', async () => {
    const { id, taskId, stepId } = await oneCustomer();
    t.sms.refuseNext(1, { permanent: true, optedOut: true, reasonPlain: CARRIER_REASON });

    await t.queue.drain(t.deps);

    expect(rowFor(await stepMessages(t, 'a', stepId), id)).toMatchObject({
      status: 'failed',
      retryable: false,
      blockReason: CARRIER_REASON,
    });
    expect(await optOutRows(NUMBER)).toMatchObject([{ keyword: 'carrier' }]);
    expect(await consentOf(id)).toBe('revoked');
    expect(await stepRow(taskId)).toMatchObject({ status: 'done' });
    expect(t.sms.sent).toEqual([]);
  });

  test("texts go out on the company's texting account", async () => {
    await t.deps.pools.system
      .update(textingRegistrations)
      .set({ subaccountSid: SUB_SID, messagingServiceSid: MS_SID })
      .where(eq(textingRegistrations.companyId, idOf('a')));
    const { id, stepId } = await oneCustomer();

    await t.queue.drain(t.deps);

    expect(t.sms.sent).toHaveLength(1);
    expect(t.sms.sent[0]!.sender).toEqual({ accountSid: SUB_SID, messagingServiceSid: MS_SID });
    expect(rowFor(await stepMessages(t, 'a', stepId), id)).toMatchObject({ status: 'sent' });
  });

  test('an earlier STOP keeps its keyword when the carrier also reports it', async () => {
    const { id, taskId, stepId } = await oneCustomer();
    // The customer's STOP lands while the send is in flight: the gate has already let the text through.
    const stopThenCarrierRefusal: SmsAdapter = {
      send: async (m) => {
        await inCompany(t, idOf('a'), (tx) =>
          tx.insert(optOuts).values({ companyId: idOf('a'), phoneE164: NUMBER, keyword: 'STOP', at: DAYTIME, createdAt: DAYTIME, updatedAt: DAYTIME }),
        );
        return t.sms.send(m);
      },
    };
    t.sms.refuseNext(1, { permanent: true, optedOut: true, reasonPlain: CARRIER_REASON });

    await runStep({ ...t.deps, sms: stopThenCarrierRefusal }, idOf('a'), stepId);

    expect(await optOutRows(NUMBER)).toMatchObject([{ keyword: 'STOP' }]);
    expect(await consentOf(id)).toBe('revoked');
    expect(rowFor(await stepMessages(t, 'a', stepId), id)).toMatchObject({ status: 'failed', retryable: false, blockReason: CARRIER_REASON });
    expect(await stepRow(taskId)).toMatchObject({ status: 'done' });
  });
});
