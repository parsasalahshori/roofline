import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, test } from 'vitest';
import {
  activities,
  claimIntakes,
  conversations,
  createCustomer,
  createJob,
  createProperty,
  jobs,
  type TenantContext,
} from '@roofline/db';
import { takeClaimDetails } from '../../src/front-desk/tools/claim.ts';
import type { ConversationState } from '../../src/front-desk/engine-types.ts';
import { inCompany } from '../crm-helpers.ts';
import { makeTestApp, type TestApp } from '../helpers.ts';

/* D1 Task 9: take_claim_details against the database. Database-backed: CI runs it. */

let t: TestApp;
const idA = () => t.seed.a.companyId;
const sys = (): TenantContext => ({ companyId: idA(), userId: null, role: 'system', canApproveSpend: false });

beforeEach(async () => {
  t = await makeTestApp();
});

const INPUT = {
  jobId: null,
  insurer: 'Acme Mutual',
  claimNumber: 'CL-1',
  dateOfLoss: '2026-10-01',
  description: 'Hail damage to the north slope',
  adjusterVisitAt: '2026-10-20T15:00:00.000Z',
};

async function customerWithProperty(withProperty: boolean) {
  return inCompany(t, idA(), async (tx) => {
    const c = await createCustomer(tx, sys(), { displayName: 'Nina Test' }, { now: t.clock.now() });
    const p = withProperty
      ? await createProperty(
          tx,
          sys(),
          { customerId: c.id, addressLine: '12 Elm Street', city: 'Omaha', state: 'NE', zip: '68102' },
          { now: t.clock.now() },
        )
      : null;
    return { customerId: c.id, propertyId: p?.id ?? null };
  });
}

async function makeConversation(customerId: string | null): Promise<ConversationState> {
  const conversationId = await inCompany(t, idA(), async (tx) => {
    const [row] = await tx
      .insert(conversations)
      .values({
        companyId: idA(),
        channel: 'voice',
        customerId,
        phoneE164: '+14025550777',
        companyNumberE164: '+14025550100',
        status: 'active',
      })
      .returning({ id: conversations.id });
    return row!.id;
  });
  return {
    companyId: idA(),
    conversationId,
    channel: 'voice',
    phone: '+14025550777',
    callId: null,
    identity: customerId === null ? 'unknown' : 'verified',
    customerId,
    shownIds: new Set<string>(),
    history: [],
    companyBlock: '',
    repName: null,
    startedAt: t.clock.now(),
    turns: 0,
    failedUnderstanding: 0,
    askedForPersonCount: 0,
    taskInProgress: false,
    nextPosition: 0,
    mode: 'normal',
    modelErrors: 0,
  } as ConversationState;
}

const run = (conversation: ConversationState, input = INPUT) =>
  takeClaimDetails({ deps: t.deps, companyId: idA(), conversation, now: t.clock.now() }, input);

const intakes = (conversationId: string) =>
  inCompany(t, idA(), (tx) => tx.select().from(claimIntakes).where(eq(claimIntakes.conversationId, conversationId)));

describe('take_claim_details', () => {
  test("claim intake is stored and linked to the verified caller's single open job", async () => {
    const { customerId, propertyId } = await customerWithProperty(true);
    const job = await inCompany(t, idA(), (tx) =>
      createJob(tx, sys(), { customerId, propertyId: propertyId! }, { now: t.clock.now() }),
    );
    const conv = await makeConversation(customerId);
    const res = await run(conv);
    expect(res.ok).toBe(true);
    expect(res.shownIds).toEqual([job.id]);
    const rows = await intakes(conv.conversationId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.jobId).toBe(job.id);
    expect(rows[0]!.takenBy).toBe('front_desk');
    const acts = await inCompany(t, idA(), (tx) =>
      tx.select().from(activities).where(and(eq(activities.subjectId, job.id), eq(activities.kind, 'claim.intake_taken'))),
    );
    expect(acts.map((a) => a.summary)).toEqual(['Claim details taken by Front Desk']);
  });

  test('verified caller with no open job gets a new Lead job with source front_desk', async () => {
    const { customerId } = await customerWithProperty(true);
    const conv = await makeConversation(customerId);
    const res = await run(conv);
    expect(res.ok).toBe(true);
    const rows = await intakes(conv.conversationId);
    expect(rows[0]!.jobId).not.toBeNull();
    const [job] = await inCompany(t, idA(), (tx) => tx.select().from(jobs).where(eq(jobs.id, rows[0]!.jobId!)));
    expect(job!.stage).toBe('lead');
    expect(job!.source).toBe('front_desk');
    expect(job!.customerId).toBe(customerId);
  });

  test("unknown caller's claim is stored without a job", async () => {
    const conv = await makeConversation(null);
    const res = await run(conv);
    expect(res.ok).toBe(true);
    expect(res.shownIds).toEqual([]);
    const rows = await intakes(conv.conversationId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.jobId).toBeNull();
  });

  test('the same claim twice in one conversation stores one row', async () => {
    const conv = await makeConversation(null);
    await run(conv);
    await run(conv);
    expect(await intakes(conv.conversationId)).toHaveLength(1);
  });

  test('a repeated claim with several open jobs creates one job, one row and one activity', async () => {
    const { customerId, propertyId } = await customerWithProperty(true);
    await inCompany(t, idA(), async (tx) => {
      await createJob(tx, sys(), { customerId, propertyId: propertyId!, stage: 'lead' }, { now: t.clock.now() });
      await createJob(tx, sys(), { customerId, propertyId: propertyId!, stage: 'lead' }, { now: t.clock.now() });
    });
    const conv = await makeConversation(customerId);
    const first = await run(conv);
    const second = await run(conv);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(second.shownIds).toEqual(first.shownIds);
    const all = await inCompany(t, idA(), (tx) => tx.select().from(jobs).where(eq(jobs.customerId, customerId)));
    expect(all).toHaveLength(3);
    const created = all.filter((j) => j.source === 'front_desk');
    expect(created).toHaveLength(1);
    expect(created[0]!.stage).toBe('lead');
    expect(await intakes(conv.conversationId)).toHaveLength(1);
    const acts = await inCompany(t, idA(), (tx) =>
      tx.select().from(activities).where(eq(activities.kind, 'claim.intake_taken')),
    );
    expect(acts).toHaveLength(1);
  });
});
