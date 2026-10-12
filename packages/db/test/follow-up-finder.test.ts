import { afterAll, beforeEach, describe, expect, inject, test } from 'vitest';
import { createPools } from '../src/pools.ts';
import { recordFollowUp } from '../src/repos/follow-up-log.ts';
import { findLeadCandidates, findReviewCandidates, findStuckCandidates, followUpSettings, recordStuckNudge } from '../src/repos/follow-up-finder.ts';
import { appointments, customers, jobs, messages, properties } from '../src/schema/index.ts';
import { type TenantContext, withTenant } from '../src/tenant.ts';
import { resetDb, type SeededCompany, seedTwoCompanies } from '../src/testing/index.ts';

const urls = inject('dbUrls');
const pools = createPools({ tenant: urls.tenant, system: urls.system });

let seed: { a: SeededCompany; b: SeededCompany };

afterAll(async () => {
  await pools.end();
});

beforeEach(async () => {
  await resetDb(urls.owner);
  seed = await seedTwoCompanies(urls.owner);
});

const DAY = 86_400_000;
const NOW = new Date(Date.UTC(2026, 9, 14, 15));
const ago = (days: number, from: Date = NOW) => new Date(from.getTime() - days * DAY);

function ctxFor(c: SeededCompany): TenantContext {
  return { companyId: c.companyId, userId: null, role: 'owner', canApproveSpend: true };
}

let addrN = 0;

type JobSeed = {
  stage?: 'lead' | 'proposal' | 'installed' | 'lost';
  createdAt?: Date;
  stageChangedAt?: Date;
  assigned?: boolean;
  nextStep?: string | null;
  phones?: { e164: string; label?: string; primary?: boolean }[];
  doNotContact?: boolean;
  lostReason?: string;
  consent?: 'none' | 'express' | 'attested' | 'written';
  customerArchived?: boolean;
};

/** A customer with one job; returns the ids. */
async function makeJob(c: SeededCompany, j: JobSeed = {}) {
  const ctx = ctxFor(c);
  return withTenant(pools, ctx, async (tx) => {
    const [cust] = await tx
      .insert(customers)
      .values({
        companyId: c.companyId,
        displayName: 'Pat Customer',
        firstName: 'Pat',
        phones: j.phones ?? [{ e164: '+14025550101', label: 'mobile' }],
        ...(j.doNotContact !== undefined && { doNotContact: j.doNotContact }),
        ...(j.consent !== undefined && { smsConsentStatus: j.consent }),
        ...(j.customerArchived === true && { archivedAt: NOW }),
        createdByUserId: c.owner.userId,
      })
      .returning({ id: customers.id });
    const [prop] = await tx
      .insert(properties)
      .values({ companyId: c.companyId, customerId: cust!.id, addressLine: '1 Main St', city: 'Omaha', state: 'NE', zip: '68102', addressKey: `fin${++addrN}` })
      .returning({ id: properties.id });
    const [job] = await tx
      .insert(jobs)
      .values({
        companyId: c.companyId,
        customerId: cust!.id,
        propertyId: prop!.id,
        createdByUserId: c.owner.userId,
        stage: j.stage ?? 'lead',
        ...(j.lostReason !== undefined && { lostReason: j.lostReason }),
        ...(j.createdAt !== undefined && { createdAt: j.createdAt }),
        ...(j.stageChangedAt !== undefined && { stageChangedAt: j.stageChangedAt }),
        assignedUserId: j.assigned === true ? c.owner.userId : null,
        nextStep: j.nextStep ?? null,
      })
      .returning({ id: jobs.id });
    return { customerId: cust!.id, jobId: job!.id, propertyId: prop!.id };
  });
}

async function makeMessage(c: SeededCompany, customerId: string, direction: 'in' | 'out', at: Date): Promise<string> {
  return withTenant(pools, ctxFor(c), async (tx) => {
    const [row] = await tx
      .insert(messages)
      .values({
        companyId: c.companyId,
        customerId,
        channel: 'sms',
        direction,
        body: 'Hello',
        status: direction === 'in' ? 'received' : 'sent',
        createdAt: at,
        updatedAt: at,
      })
      .returning({ id: messages.id });
    return row!.id;
  });
}

async function leads(c: SeededCompany, now = NOW) {
  const ctx = ctxFor(c);
  return withTenant(pools, ctx, (tx) => findLeadCandidates(tx, ctx, now, { leadFollowupDays: 2 }));
}

async function stuck(c: SeededCompany, now = NOW) {
  const ctx = ctxFor(c);
  return withTenant(pools, ctx, (tx) => findStuckCandidates(tx, ctx, now, { timeZone: 'America/Chicago', stuckAfterDays: 14 }));
}

describe('findLeadCandidates', () => {
  test('a lead 2 days old with no appointment and a mobile phone is returned', async () => {
    const j = await makeJob(seed.a, { createdAt: ago(2) });
    const found = await leads(seed.a);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ jobId: j.jobId, customerId: j.customerId, customerFirstName: 'Pat', propertyId: j.propertyId });
  });

  test('a lead 1 day old is not returned', async () => {
    await makeJob(seed.a, { createdAt: ago(1) });
    expect(await leads(seed.a)).toEqual([]);
  });

  test('a customer who texted in yesterday is not returned', async () => {
    const j = await makeJob(seed.a, { createdAt: ago(5) });
    await makeMessage(seed.a, j.customerId, 'in', ago(1));
    expect(await leads(seed.a)).toEqual([]);
  });

  test('a customer whose last inbound text is older than 3 days is returned', async () => {
    const j = await makeJob(seed.a, { createdAt: ago(8) });
    await makeMessage(seed.a, j.customerId, 'in', ago(5));
    expect(await leads(seed.a)).toHaveLength(1);
  });

  test('a lead with a scheduled appointment is not returned, nor is a lost job', async () => {
    const booked = await makeJob(seed.a, { createdAt: ago(5) });
    await withTenant(pools, ctxFor(seed.a), (tx) =>
      tx.insert(appointments).values({
        companyId: seed.a.companyId,
        kind: 'inspection',
        jobId: booked.jobId,
        customerId: booked.customerId,
        propertyId: booked.propertyId,
        startsAt: ago(-1),
        endsAt: ago(-1, new Date(NOW.getTime() + 3_600_000)),
      }),
    );
    await makeJob(seed.a, { stage: 'lost', lostReason: 'Went elsewhere', createdAt: ago(5) });
    expect(await leads(seed.a)).toEqual([]);
  });

  test('a customer with no mobile phone is not returned', async () => {
    await makeJob(seed.a, { createdAt: ago(5), phones: [] });
    expect(await leads(seed.a)).toEqual([]);
  });

  test('a customer whose only phone is a landline is not returned', async () => {
    await makeJob(seed.a, { createdAt: ago(5), phones: [{ e164: '+14025550102', label: 'landline' }] });
    expect(await leads(seed.a)).toEqual([]);
  });

  test('a primary landline with a second mobile is not returned (the gate texts the primary)', async () => {
    await makeJob(seed.a, {
      createdAt: ago(5),
      phones: [
        { e164: '+14025550102', label: 'Landline', primary: true },
        { e164: '+14025550103', label: 'mobile' },
      ],
    });
    expect(await leads(seed.a)).toEqual([]);
  });

  test('a phone with no label is returned', async () => {
    const j = await makeJob(seed.a, { createdAt: ago(5), phones: [{ e164: '+14025550104' }] });
    expect((await leads(seed.a)).map((l) => l.jobId)).toEqual([j.jobId]);
  });

  test('a do-not-contact customer is not returned', async () => {
    await makeJob(seed.a, { createdAt: ago(5), doNotContact: true });
    expect(await leads(seed.a)).toEqual([]);
  });

  test('a lead that already got a lead follow-up text is not returned', async () => {
    const j = await makeJob(seed.a, { createdAt: ago(10) });
    const messageId = await makeMessage(seed.a, j.customerId, 'out', ago(6));
    const ctx = ctxFor(seed.a);
    await withTenant(pools, ctx, (tx) => recordFollowUp(tx, ctx, { customerId: j.customerId, jobId: j.jobId, kind: 'lead', messageId, at: ago(6) }));
    expect(await leads(seed.a)).toEqual([]);
  });

  test('another company sees nothing', async () => {
    await makeJob(seed.a, { createdAt: ago(5) });
    expect(await leads(seed.b)).toEqual([]);
  });
});

describe('findStuckCandidates', () => {
  test('a stuck job with a rep and no next step is returned with its days', async () => {
    const j = await makeJob(seed.a, { stage: 'proposal', stageChangedAt: ago(20), assigned: true });
    const found = await stuck(seed.a);
    expect(found).toEqual([{ jobId: j.jobId, customerId: j.customerId, customerName: 'Pat Customer', assignedUserId: seed.a.owner.userId, days: 20 }]);
  });

  test('a job with its own next step, or without a rep, or not yet stuck is left alone', async () => {
    await makeJob(seed.a, { stage: 'proposal', stageChangedAt: ago(20), assigned: true, nextStep: 'Call on Friday' });
    await makeJob(seed.a, { stage: 'proposal', stageChangedAt: ago(20), assigned: false });
    await makeJob(seed.a, { stage: 'proposal', stageChangedAt: ago(5), assigned: true });
    expect(await stuck(seed.a)).toEqual([]);
  });

  test('after a nudge the job is not returned 6 days later, and is returned 8 days later', async () => {
    const j = await makeJob(seed.a, { stage: 'proposal', stageChangedAt: ago(20), assigned: true });
    const ctx = ctxFor(seed.a);
    await withTenant(pools, ctx, (tx) => recordStuckNudge(tx, ctx, j.jobId, 20, NOW));
    expect(await stuck(seed.a, new Date(NOW.getTime() + 6 * DAY))).toEqual([]);
    const later = await stuck(seed.a, new Date(NOW.getTime() + 8 * DAY));
    expect(later).toHaveLength(1);
    expect(later[0]?.days).toBe(28);
  });
});

describe('followUpSettings', () => {
  test('reads the company settings with their defaults', async () => {
    const ctx = ctxFor(seed.a);
    const s = await withTenant(pools, ctx, (tx) => followUpSettings(tx, ctx));
    expect(s).toEqual({ leadFollowupDays: 2, followupLeads: true, stuckAfterDays: 14 });
  });
});

let phoneN = 0;

async function makeReviewJob(
  c: SeededCompany,
  opts: JobSeed & { install?: { endedAgoDays: number; status?: 'scheduled' | 'completed' } | null } = {},
) {
  const { install, ...seedOpts } = opts;
  const j = await makeJob(c, {
    stage: 'installed',
    consent: 'attested',
    phones: [{ e164: `+1402555${String(2000 + ++phoneN)}`, label: 'mobile' }],
    ...seedOpts,
  });
  const inst = install === undefined ? { endedAgoDays: 3, status: 'completed' as const } : install;
  if (inst !== null) {
    const endsAt = ago(inst.endedAgoDays);
    await withTenant(pools, ctxFor(c), (tx) =>
      tx.insert(appointments).values({
        companyId: c.companyId,
        kind: 'install',
        status: inst.status ?? 'completed',
        jobId: j.jobId,
        customerId: j.customerId,
        propertyId: j.propertyId,
        startsAt: new Date(endsAt.getTime() - 4 * 3_600_000),
        endsAt,
      }),
    );
  }
  return j;
}

async function reviews(c: SeededCompany, delay = 3, now = NOW) {
  const ctx = ctxFor(c);
  return withTenant(pools, ctx, (tx) => findReviewCandidates(tx, ctx, now, { reviewDelayDays: delay, timeZone: 'America/Chicago' }));
}

describe('findReviewCandidates', () => {
  test('an install completed 3 days ago with delay 3 is returned', async () => {
    const j = await makeReviewJob(seed.a);
    const found = await reviews(seed.a);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ jobId: j.jobId, customerId: j.customerId, customerFirstName: 'Pat', assignedUserId: null });
    expect(found[0]?.installEndedAt.getTime()).toBe(ago(3).getTime());
  });

  test('an install completed 2 days ago, or 31 days ago, is not returned', async () => {
    await makeReviewJob(seed.a, { install: { endedAgoDays: 2 } });
    await makeReviewJob(seed.a, { install: { endedAgoDays: 31 } });
    expect(await reviews(seed.a)).toEqual([]);
  });

  test('delay 0 with an install completed today is returned', async () => {
    const j = await makeReviewJob(seed.a, { install: { endedAgoDays: 0.1 } });
    expect((await reviews(seed.a, 0)).map((r) => r.jobId)).toEqual([j.jobId]);
  });

  test('an install that is only scheduled, or a job with no install, is not returned', async () => {
    await makeReviewJob(seed.a, { install: { endedAgoDays: 3, status: 'scheduled' } });
    await makeReviewJob(seed.a, { install: null });
    expect(await reviews(seed.a)).toEqual([]);
  });

  test('a job that already has a review log row is not returned', async () => {
    const j = await makeReviewJob(seed.a);
    const messageId = await makeMessage(seed.a, j.customerId, 'out', ago(1));
    const ctx = ctxFor(seed.a);
    await withTenant(pools, ctx, (tx) => recordFollowUp(tx, ctx, { customerId: j.customerId, jobId: j.jobId, kind: 'review', messageId, at: ago(1) }));
    expect(await reviews(seed.a)).toEqual([]);
  });

  test('a lost job is not returned', async () => {
    await makeReviewJob(seed.a, { stage: 'lost', lostReason: 'Went elsewhere' });
    expect(await reviews(seed.a)).toEqual([]);
  });

  test('consent none and express are skipped; attested and written are returned', async () => {
    await makeReviewJob(seed.a, { consent: 'none' });
    await makeReviewJob(seed.a, { consent: 'express' });
    const att = await makeReviewJob(seed.a, { consent: 'attested' });
    const wri = await makeReviewJob(seed.a, { consent: 'written' });
    expect((await reviews(seed.a)).map((r) => r.jobId).sort()).toEqual([att.jobId, wri.jobId].sort());
  });

  test('do-not-contact, archived, and landline-only customers are not returned', async () => {
    await makeReviewJob(seed.a, { doNotContact: true });
    await makeReviewJob(seed.a, { customerArchived: true });
    await makeReviewJob(seed.a, { phones: [{ e164: '+14025559901', label: 'landline' }] });
    expect(await reviews(seed.a)).toEqual([]);
  });

  test('an inbound text 1 day ago blocks; 4 days ago does not', async () => {
    const blocked = await makeReviewJob(seed.a);
    await makeMessage(seed.a, blocked.customerId, 'in', ago(1));
    const open = await makeReviewJob(seed.a);
    await makeMessage(seed.a, open.customerId, 'in', ago(4));
    expect((await reviews(seed.a)).map((r) => r.jobId)).toEqual([open.jobId]);
  });

  test('another company sees nothing', async () => {
    await makeReviewJob(seed.a);
    expect(await reviews(seed.b)).toEqual([]);
  });
});
