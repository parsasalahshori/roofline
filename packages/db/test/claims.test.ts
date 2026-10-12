import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, inject, test } from 'vitest';
import type { ClaimView } from '@roofline/shared';
import { createPools } from '../src/pools.ts';
import { ClaimFieldError, getJobClaim, listClaims, type ClaimPatch, saveClaim } from '../src/repos/claims.ts';
import { appointments, auditLog, claimIntakes, claims, customers, jobs, properties } from '../src/schema/index.ts';
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

const NOW = new Date('2026-10-12T15:00:00.000Z');
const LATER = new Date('2026-10-12T16:00:00.000Z');
const LATEST = new Date('2026-10-12T17:00:00.000Z');

function ownerCtx(c: SeededCompany): TenantContext {
  return { companyId: c.companyId, userId: c.owner.userId, role: 'owner', canApproveSpend: true };
}

function repCtx(c: SeededCompany): TenantContext {
  return { companyId: c.companyId, userId: c.rep.userId, role: 'rep', canApproveSpend: false };
}

let addressCounter = 0;

/** A customer, an address and a job in the company. `assignedUserId` decides who a rep sees it through. */
async function makeJob(c: SeededCompany, assignedUserId: string | null = null): Promise<string> {
  addressCounter += 1;
  const n = addressCounter;
  const ctx = ownerCtx(c);
  return withTenant(pools, ctx, async (tx) => {
    const [customer] = await tx
      .insert(customers)
      .values({ companyId: c.companyId, displayName: `Customer ${n}` })
      .returning({ id: customers.id });
    const [property] = await tx
      .insert(properties)
      .values({
        companyId: c.companyId,
        customerId: customer!.id,
        addressLine: `${100 + n} Oak St`,
        city: 'Omaha',
        state: 'NE',
        zip: '68102',
        addressKey: `${100 + n} oak st|68102`,
      })
      .returning({ id: properties.id });
    const [job] = await tx
      .insert(jobs)
      .values({
        companyId: c.companyId,
        customerId: customer!.id,
        propertyId: property!.id,
        stage: 'inspection',
        assignedUserId,
        createdByUserId: c.owner.userId,
      })
      .returning({ id: jobs.id });
    return job!.id;
  });
}

async function save(
  c: SeededCompany,
  jobId: string,
  patch: ClaimPatch,
  now: Date = NOW,
  ctx: TenantContext = ownerCtx(c),
  by: { actor: 'user' | 'agent'; userId: string | null } = { actor: 'user', userId: c.owner.userId },
): Promise<ClaimView | null> {
  return withTenant(pools, ctx, (tx) => saveClaim(tx, ctx, jobId, patch, by, now));
}

async function claimRows(c: SeededCompany, jobId: string) {
  return withTenant(pools, ownerCtx(c), (tx) => tx.select().from(claims).where(eq(claims.jobId, jobId)));
}

describe('claim record', () => {
  test('one claim per job: a second save updates the same row', async () => {
    const c = seed.a;
    const jobId = await makeJob(c);
    const first = (await save(c, jobId, { insurer: 'Acme Mutual', notes: 'first note' }))!;
    const second = (await save(c, jobId, { notes: 'second note', deductibleCents: 50000 }, LATER))!;

    expect(second.id).toBe(first.id);
    expect(second.insurer).toBe('Acme Mutual');
    expect(second.notes).toBe('second note');
    expect(second.deductibleCents).toBe(50000);

    const rows = await claimRows(c, jobId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: first.id, notes: 'second note', deductibleCents: 50000 });
  });

  test('events are written on a status change only', async () => {
    const c = seed.a;
    const jobId = await makeJob(c);

    const created = (await save(c, jobId, { status: 'filed' }, NOW))!;
    expect(created.events).toEqual([expect.objectContaining({ from: null, to: 'filed', by: 'user' })]);
    expect(created.statusChangedAt).toBe(NOW.toISOString());

    const notesOnly = (await save(c, jobId, { notes: 'called the homeowner' }, LATER))!;
    expect(notesOnly.events).toHaveLength(1);
    expect(notesOnly.statusChangedAt).toBe(NOW.toISOString());

    const moved = (await save(c, jobId, { status: 'adjuster_scheduled' }, LATER))!;
    expect(moved.events).toHaveLength(2);
    expect(moved.events[1]).toMatchObject({ from: 'filed', to: 'adjuster_scheduled', by: 'user' });
    expect(moved.statusChangedAt).toBe(LATER.toISOString());

    const sameAgain = (await save(c, jobId, { status: 'adjuster_scheduled' }, LATEST))!;
    expect(sameAgain.events).toHaveLength(2);
    expect(sameAgain.statusChangedAt).toBe(LATER.toISOString());
  });

  test('intake promotion fills only the missing fields', async () => {
    const c = seed.a;
    const jobId = await makeJob(c);
    await withTenant(pools, ownerCtx(c), (tx) =>
      tx.insert(claimIntakes).values({
        companyId: c.companyId,
        jobId,
        insurer: 'Acme Mutual',
        claimNumber: 'C-1',
        dateOfLoss: '2026-09-30',
        description: 'Hail on the north slope',
        takenBy: 'front_desk',
      }),
    );

    const before = await withTenant(pools, ownerCtx(c), (tx) => getJobClaim(tx, ownerCtx(c), jobId));
    expect(before?.claim).toBeNull();
    expect(before?.intake).toMatchObject({ insurer: 'Acme Mutual', claimNumber: 'C-1', dateOfLoss: '2026-09-30' });

    const claim = (await save(c, jobId, { insurer: 'Other Co' }))!;
    expect(claim).toMatchObject({ insurer: 'Other Co', claimNumber: 'C-1', dateOfLoss: '2026-09-30' });

    const after = await withTenant(pools, ownerCtx(c), (tx) => getJobClaim(tx, ownerCtx(c), jobId));
    expect(after?.intake).toBeNull();
    expect(after?.claim?.insurer).toBe('Other Co');
  });

  test('an appointment of another job is refused', async () => {
    const c = seed.a;
    const jobA = await makeJob(c);
    const jobB = await makeJob(c);
    const [apptOnB] = await withTenant(pools, ownerCtx(c), (tx) =>
      tx
        .insert(appointments)
        .values({
          companyId: c.companyId,
          kind: 'adjuster',
          jobId: jobB,
          startsAt: new Date('2026-10-20T15:00:00.000Z'),
          endsAt: new Date('2026-10-20T16:00:00.000Z'),
        })
        .returning({ id: appointments.id }),
    );
    const [apptOnA] = await withTenant(pools, ownerCtx(c), (tx) =>
      tx
        .insert(appointments)
        .values({
          companyId: c.companyId,
          kind: 'adjuster',
          jobId: jobA,
          startsAt: new Date('2026-10-21T15:00:00.000Z'),
          endsAt: new Date('2026-10-21T16:00:00.000Z'),
        })
        .returning({ id: appointments.id }),
    );

    const ok = (await save(c, jobA, { adjusterAppointmentId: apptOnA!.id }))!;
    expect(ok.adjusterAppointmentId).toBe(apptOnA!.id);

    const err = await save(c, jobA, { adjusterAppointmentId: apptOnB!.id }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ClaimFieldError);
    expect((err as ClaimFieldError).field).toBe('adjusterAppointmentId');

    const stored = await claimRows(c, jobA);
    expect(stored[0]!.adjusterAppointmentId).toBe(apptOnA!.id);
  });

  test('a rep cannot reach a job outside their scope', async () => {
    const c = seed.a;
    const jobForOtherRep = await makeJob(c, c.otherRep.userId);
    const ctx = repCtx(c);

    expect(await withTenant(pools, ctx, (tx) => getJobClaim(tx, ctx, jobForOtherRep))).toBeNull();
    expect(await save(c, jobForOtherRep, { insurer: 'Acme Mutual' }, NOW, ctx)).toBeNull();
    expect(await claimRows(c, jobForOtherRep)).toEqual([]);
  });

  test('a rep can read and save the claim on a job assigned to them', async () => {
    const c = seed.a;
    const jobId = await makeJob(c, c.rep.userId);
    const ctx = repCtx(c);

    const saved = await save(c, jobId, { insurer: 'Acme Mutual' }, NOW, ctx, { actor: 'user', userId: c.rep.userId });
    expect(saved?.insurer).toBe('Acme Mutual');
    expect(saved?.events[0]).toMatchObject({ by: 'user', byName: 'Acme Rep' });

    const read = await withTenant(pools, ctx, (tx) => getJobClaim(tx, ctx, jobId));
    expect(read?.claim?.insurer).toBe('Acme Mutual');
  });

  test('audit rows carry field names only', async () => {
    const c = seed.a;
    const jobId = await makeJob(c);
    await save(c, jobId, { insurer: 'Acme Mutual', adjusterPhone: '+14025557788' }, NOW);
    await save(c, jobId, { adjusterPhone: '+14025559911' }, LATER);

    const rows = await withTenant(pools, ownerCtx(c), (tx) =>
      tx.select().from(auditLog).where(eq(auditLog.targetType, 'claim')),
    );
    const actions = rows.map((r) => r.action).sort();
    expect(actions).toEqual(['claim.created', 'claim.updated']);

    const created = rows.find((r) => r.action === 'claim.created')!;
    expect((created.after as { fields: string[] }).fields).toEqual(expect.arrayContaining(['insurer', 'adjusterPhone']));
    const updated = rows.find((r) => r.action === 'claim.updated')!;
    expect(updated.after).toEqual({ fields: ['adjusterPhone'] });

    const json = JSON.stringify(rows);
    for (const secret of ['Acme Mutual', '4025557788', '4025559911', '5557788', '5559911']) {
      expect(json).not.toContain(secret);
    }
  });

  test('listClaims filters by status, orders newest status change first', async () => {
    const c = seed.a;
    const jobX = await makeJob(c);
    const jobY = await makeJob(c);
    const jobZ = await makeJob(c);
    await save(c, jobX, { status: 'filed' }, new Date('2026-10-10T10:00:00.000Z'));
    await save(c, jobY, { status: 'filed' }, new Date('2026-10-11T10:00:00.000Z'));
    await save(c, jobZ, { status: 'closed' }, new Date('2026-10-12T10:00:00.000Z'));

    const ctx = ownerCtx(c);
    const all = await withTenant(pools, ctx, (tx) => listClaims(tx, ctx, {}));
    expect(all.map((r) => r.jobId)).toEqual([jobZ, jobY, jobX]);
    expect(all[0]).toMatchObject({ status: 'closed', customerName: expect.any(String) });

    const filed = await withTenant(pools, ctx, (tx) => listClaims(tx, ctx, { status: 'filed' }));
    expect(filed.map((r) => r.jobId)).toEqual([jobY, jobX]);
    expect(filed.every((r) => r.status === 'filed')).toBe(true);
  });

  test('the board lists only the claims on jobs a rep can see', async () => {
    const c = seed.a;
    const mine = await makeJob(c, c.rep.userId);
    const theirs = await makeJob(c, c.otherRep.userId);
    await save(c, mine, { status: 'filed' });
    await save(c, theirs, { status: 'filed' });

    const ctx = repCtx(c);
    const rows = await withTenant(pools, ctx, (tx) => listClaims(tx, ctx, {}));
    expect(rows.map((r) => r.jobId)).toEqual([mine]);
  });

  test('another company sees none of the claims', async () => {
    const jobId = await makeJob(seed.a);
    await save(seed.a, jobId, { status: 'filed' });
    const other = ownerCtx(seed.b);
    expect(await withTenant(pools, other, (tx) => listClaims(tx, other, {}))).toEqual([]);
    expect(await withTenant(pools, other, (tx) => getJobClaim(tx, other, jobId))).toBeNull();
  });
});

describe('claims table is per company', () => {
  test('the claim row belongs to the saving company', async () => {
    const jobId = await makeJob(seed.a);
    await save(seed.a, jobId, { notes: 'x' });
    const rows = await claimRows(seed.a, jobId);
    expect(rows[0]!.companyId).toBe(seed.a.companyId);
    expect(await withTenant(pools, ownerCtx(seed.a), (tx) => tx.select().from(claims))).toHaveLength(1);
  });
});
