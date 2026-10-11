import { eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, test } from 'vitest';
import { agentTaskSteps, renewStepLease } from '@roofline/db';
import { FakeSmsAdapter, type OutboundSms, type SmsAdapter, type SmsSendResult } from '@roofline/send-gate';
import { sweepQueued } from '../src/jobs/scheduler/sweep-queued.ts';
import { sendSmsBatch } from '../src/messaging/send-batch.ts';
import { LEASE_MS, LEASE_RENEW_EVERY_MS, leaseKeeper } from '../src/tasks/runner.ts';
import { Actors, inCompany } from './crm-helpers.ts';
import { makeTestApp, type TestApp } from './helpers.ts';
import { addSmsCustomers, approvedBatch, DAYTIME, MINUTE, sentTo, stepMessages } from './sms-helpers.ts';
import { agentCtx, dbSteps, newTask, setStep } from './task-helpers.ts';

/*
 * The lease heartbeat (Task 12). A long handler renews its step's lease while it works, so the
 * sweeper does not hand a live batch to a second run. A run that has lost the step (its run number
 * moved on) must stop texting, and its outcome must be dropped.
 */

let t: TestApp;
let actors: Actors;

beforeEach(async () => {
  t = await makeTestApp();
  t.clock.set(DAYTIME);
  actors = new Actors(t);
});

const idOf = (company: 'a' | 'b') => t.seed[company].companyId;
const stepRow = (stepId: string) =>
  inCompany(t, idOf('a'), async (tx) => (await tx.select().from(agentTaskSteps).where(eq(agentTaskSteps.id, stepId)))[0]!);

/** Renews a step's lease the way the keeper does: one UPDATE, in that company's own transaction. */
const renew = (company: 'a' | 'b', stepId: string, runSeq: number, leaseExpiresAt: Date) =>
  inCompany(t, idOf(company), (tx) => renewStepLease(tx, agentCtx(idOf(company)), stepId, runSeq, leaseExpiresAt));

/**
 * A text provider that records each text the fake accepts, then runs `after` with the count of
 * texts so far (1-based). The hook may move the clock or change the step between two texts.
 */
class HookedSms implements SmsAdapter {
  readonly inner = new FakeSmsAdapter();
  private count = 0;

  constructor(private readonly after: (sendsSoFar: number) => Promise<void>) {}

  async send(m: OutboundSms): Promise<SmsSendResult> {
    const result = await this.inner.send(m);
    this.count += 1;
    await this.after(this.count);
    return result;
  }
}

/** Phones +14025550110, +14025550111, ... No state or zone, so the company zone (Chicago) applies; DAYTIME is inside sending hours there. */
const customersFor = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ firstName: `Cust${i}`, phone: `+140255501${String(10 + i)}`, consent: 'attested' as const }));

/** A one-step task put straight into `running` with this run number and lease (no approval, no queue). */
async function runningStep(runSeq: number, leaseExpiresAt: Date | null) {
  const { taskId } = await newTask(t, 'a', { steps: [{ type: 'demo_noop', payload: { label: 'Routes' } }] });
  const [created] = await dbSteps(t, 'a', taskId);
  await setStep(t, 'a', created!.id, { status: 'running', attempts: 1, runSeq, leaseExpiresAt });
  return { stepId: created!.id, step: await stepRow(created!.id) };
}

describe('lease heartbeat for long batches', () => {
  test('a batch that runs longer than the lease keeps it', async () => {
    const ids = await addSmsCustomers(t, 'a', customersFor(15));
    const { stepId } = await approvedBatch(t, actors, ids);

    const seen: {
      twelve?: { at: Date; sweep: { resent: number; reclaimed: number }; status: string; lease: Date | null };
    } = {};
    const sms = new HookedSms(async (sendsSoFar) => {
      t.clock.advance(MINUTE);
      if (sendsSoFar === 12) {
        const sweep = await sweepQueued(deps, t.clock.now());
        const row = await stepRow(stepId);
        seen.twelve = { at: t.clock.now(), sweep, status: row.status, lease: row.leaseExpiresAt };
      }
    });
    const deps = { ...t.deps, sms };

    await t.queue.drain(deps);

    const twelve = seen.twelve!;
    expect(twelve.at).toEqual(new Date(DAYTIME.getTime() + 12 * MINUTE));
    // Nothing is put back 12 minutes in: the keeper renewed before customer 12, at minute 11.
    expect(twelve.sweep).toEqual({ resent: 0, reclaimed: 0 });
    expect(twelve.status).toBe('running');
    expect(twelve.lease).toEqual(new Date(DAYTIME.getTime() + 11 * MINUTE + LEASE_MS));

    expect(sms.inner.sent).toHaveLength(15);
    expect(sentTo(sms.inner.sent)).toEqual(customersFor(15).map((c) => c.phone).sort());
    expect(await stepRow(stepId)).toMatchObject({
      status: 'done',
      attempts: 1,
      runSeq: 1,
      leaseExpiresAt: null,
      result: { sent: 15, scheduled: 0, failed: 0, blocked: {} },
    });
    // Only the approval was handed to the queue; the sweeper handed over nothing.
    expect(t.queue.calls).toHaveLength(1);
  }, 120_000);

  test('a run that lost its step stops texting', async () => {
    const ids = await addSmsCustomers(t, 'a', customersFor(6));
    const { stepId } = await approvedBatch(t, actors, ids);

    // On the third text, a newer run takes the step (run_seq moves on) and a minute passes.
    const sms = new HookedSms(async (sendsSoFar) => {
      if (sendsSoFar === 3) {
        await inCompany(t, idOf('a'), (tx) =>
          tx
            .update(agentTaskSteps)
            .set({ runSeq: sql`${agentTaskSteps.runSeq} + 1` })
            .where(eq(agentTaskSteps.id, stepId)),
        );
        t.clock.advance(61_000);
      }
    });
    const deps = { ...t.deps, sms };

    // First run: texts customers 0, 1 and 2, then stops before customer 3 (the renewal fails).
    await t.queue.drain(deps);

    expect(sms.inner.sent).toHaveLength(3);
    expect(sentTo(sms.inner.sent)).toEqual(customersFor(6).slice(0, 3).map((c) => c.phone).sort());
    expect((await stepMessages(t, 'a', stepId)).map((m) => m.status)).toEqual(['sent', 'sent', 'sent']);
    // The stale run's outcome was dropped: a saved outcome would have cleared the lease to null.
    expect(await stepRow(stepId)).toMatchObject({
      status: 'running',
      attempts: 1,
      runSeq: 2,
      leaseExpiresAt: new Date(DAYTIME.getTime() + LEASE_MS),
    });

    // Second run: the lease now looks dead, so the sweeper puts the step back and the queue runs it.
    await setStep(t, 'a', stepId, { leaseExpiresAt: new Date(t.clock.now().getTime() - MINUTE) });
    expect(await sweepQueued(deps, t.clock.now())).toEqual({ resent: 0, reclaimed: 1 });
    await t.queue.drain(deps);

    expect(sms.inner.sent).toHaveLength(6);
    const phones = sentTo(sms.inner.sent);
    expect(phones).toEqual(customersFor(6).map((c) => c.phone).sort());
    expect(new Set(phones).size).toBe(6);
    expect((await stepMessages(t, 'a', stepId)).map((m) => m.status)).toEqual(['sent', 'sent', 'sent', 'sent', 'sent', 'sent']);
    expect(await stepRow(stepId)).toMatchObject({
      status: 'done',
      attempts: 2,
      runSeq: 3,
      leaseExpiresAt: null,
      result: { sent: 6, scheduled: 0, failed: 0, blocked: {} },
    });
  }, 120_000);

  test('the handler stops and returns running with an empty result when its keeper says no', async () => {
    const ids = await addSmsCustomers(t, 'a', customersFor(4));
    const { stepId } = await approvedBatch(t, actors, ids); // approved, so queued: no run owns it (run_seq 0), so any renewal fails
    const sms = new HookedSms(async (sendsSoFar) => {
      if (sendsSoFar === 1) t.clock.advance(61_000);
    });
    const deps = { ...t.deps, sms };
    const outcome = await sendSmsBatch(deps, agentCtx(idOf('a')), await stepRow(stepId));

    expect(outcome).toEqual({ status: 'running', result: {} });
    expect(sms.inner.sent).toHaveLength(1);
    expect(sentTo(sms.inner.sent)).toEqual([customersFor(4)[0]!.phone]);
    expect((await stepMessages(t, 'a', stepId)).map((m) => m.status)).toEqual(['sent']);
    expect(await stepRow(stepId)).toMatchObject({ status: 'queued', runSeq: 0, leaseExpiresAt: null }); // the handler wrote nothing to the step
  }, 120_000);
});

describe('renewStepLease', () => {
  test('renewStepLease needs the run number', async () => {
    const lease = new Date(DAYTIME.getTime() + 10 * MINUTE);
    const later = new Date(DAYTIME.getTime() + 20 * MINUTE);
    const { stepId } = await runningStep(3, lease);

    // The wrong run number changes nothing.
    expect(await renew('a', stepId, 2, later)).toBe(false);
    expect((await stepRow(stepId)).leaseExpiresAt).toEqual(lease);
    expect(await renew('a', stepId, 4, later)).toBe(false);
    expect((await stepRow(stepId)).leaseExpiresAt).toEqual(lease);

    // The right one moves the lease and nothing else.
    const before = await stepRow(stepId);
    expect(await renew('a', stepId, 3, later)).toBe(true);
    expect(await stepRow(stepId)).toMatchObject({
      status: 'running',
      runSeq: 3,
      attempts: 1,
      leaseExpiresAt: later,
      updatedAt: before.updatedAt,
    });
  });

  test("renewStepLease leaves parked, queued and other companies' steps alone", async () => {
    const lease = new Date(DAYTIME.getTime() + 10 * MINUTE);
    const later = new Date(DAYTIME.getTime() + 20 * MINUTE);

    // (i) A parked step (running, no lease) is not renewed: no run owns it.
    const parked = await runningStep(3, null);
    expect(await renew('a', parked.stepId, 3, later)).toBe(false);
    expect((await stepRow(parked.stepId)).leaseExpiresAt).toBeNull();

    // (ii) A queued step is not renewed.
    const queued = await runningStep(3, lease);
    await setStep(t, 'a', queued.stepId, { status: 'queued' });
    expect(await renew('a', queued.stepId, 3, later)).toBe(false);
    expect((await stepRow(queued.stepId)).leaseExpiresAt).toEqual(lease);

    // (iii) Another company's context cannot renew company A's step.
    const other = await runningStep(3, lease);
    expect(await renew('b', other.stepId, 3, later)).toBe(false);
    expect((await stepRow(other.stepId)).leaseExpiresAt).toEqual(lease);
  });
});

describe('leaseKeeper', () => {
  test('keep() renews every 60 seconds and stays false once the step is lost', async () => {
    expect(LEASE_RENEW_EVERY_MS).toBe(60_000);
    expect(LEASE_MS).toBe(10 * 60 * 1000);

    const start = DAYTIME;
    const { stepId, step } = await runningStep(1, new Date(start.getTime() + LEASE_MS));
    const keeper = leaseKeeper(t.deps, agentCtx(idOf('a')), step);
    const leaseOf = async () => (await stepRow(stepId)).leaseExpiresAt;

    // 1. Just claimed: nothing is due, the lease is the claim's.
    expect(await keeper.keep()).toBe(true);
    expect(await leaseOf()).toEqual(new Date(start.getTime() + LEASE_MS));

    // 2. One millisecond short of 60 seconds: still not due, no write.
    t.clock.advance(LEASE_RENEW_EVERY_MS - 1);
    expect(await keeper.keep()).toBe(true);
    expect(await leaseOf()).toEqual(new Date(start.getTime() + LEASE_MS));

    // 3. At 60 seconds: renewed to now + LEASE_MS.
    t.clock.advance(1);
    expect(await keeper.keep()).toBe(true);
    expect(await leaseOf()).toEqual(new Date(start.getTime() + LEASE_RENEW_EVERY_MS + LEASE_MS));

    // 4. 30 seconds after that renewal: not due. The clock counts from the last renewal, not the claim.
    t.clock.advance(30_000);
    expect(await keeper.keep()).toBe(true);
    expect(await leaseOf()).toEqual(new Date(start.getTime() + LEASE_RENEW_EVERY_MS + LEASE_MS));

    // 5. A newer run took the step: the renewal finds nothing, so keep() is false and nothing moves.
    await setStep(t, 'a', stepId, { runSeq: 2 });
    t.clock.advance(LEASE_RENEW_EVERY_MS);
    expect(await keeper.keep()).toBe(false);
    expect(await leaseOf()).toEqual(new Date(start.getTime() + LEASE_RENEW_EVERY_MS + LEASE_MS));

    // 6. The step is back at run 1, but the keeper stays false for good: it does not renew again.
    await setStep(t, 'a', stepId, { runSeq: 1 });
    t.clock.advance(LEASE_RENEW_EVERY_MS);
    expect(await keeper.keep()).toBe(false);
    expect(await leaseOf()).toEqual(new Date(start.getTime() + LEASE_RENEW_EVERY_MS + LEASE_MS));
  });
});
