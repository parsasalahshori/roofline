import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { beforeEach, describe, expect, test } from 'vitest';
import { customers, jobs, measurements, properties, proposalOptions, proposalSignatures, proposals } from '@roofline/db';
import { Actors, inCompany } from './crm-helpers.ts';
import { makeTestApp, type SuperAgent, type TestApp } from './helpers.ts';

/** Tuesday 2026-10-13, 10:00 in Chicago (CDT). The week starts Monday 2026-10-12; the month on 2026-10-01. */
const NOW = new Date('2026-10-13T15:00:00.000Z');

let t: TestApp;
let who: Actors;
let seq = 0;

beforeEach(async () => {
  t = await makeTestApp();
  who = new Actors(t);
  t.clock.set(NOW);
});

type Seed = { status: 'sent' | 'viewed' | 'signed' | 'draft'; optionCents: number[]; signedAt?: string; signedCents?: number };

/** A customer, property, job, measurement and a proposal with one option per entry of `optionCents`, for `key` (a or b). */
async function seedProposal(o: Seed, key: 'a' | 'b' = 'a'): Promise<void> {
  const companyId = t.seed[key].companyId;
  const n = ++seq;
  await inCompany(t, companyId, async (tx) => {
    const [cust] = await tx.insert(customers).values({ companyId, displayName: `Signed Customer ${n}` }).returning({ id: customers.id });
    const [prop] = await tx
      .insert(properties)
      .values({ companyId, customerId: cust!.id, addressLine: `${n} Elm St`, city: 'Omaha', state: 'NE', zip: '68102', addressKey: `hs${n}` })
      .returning({ id: properties.id });
    const [job] = await tx.insert(jobs).values({ companyId, customerId: cust!.id, propertyId: prop!.id, stage: 'proposal' }).returning({ id: jobs.id });
    const [m] = await tx
      .insert(measurements)
      .values({ companyId, propertyId: prop!.id, jobId: job!.id, kind: 'estimate', method: 'outline', surfaceSqFt: 2400, pitchX12: 6 })
      .returning({ id: measurements.id });
    const signedAt = o.signedAt === undefined ? null : new Date(o.signedAt);
    const [p] = await tx
      .insert(proposals)
      .values({
        companyId,
        jobId: job!.id,
        customerId: cust!.id,
        propertyId: prop!.id,
        measurementId: m!.id,
        number: `P-${String(n).padStart(4, '0')}`,
        status: o.status,
        validUntil: '2026-12-31',
        linkTokenHash: randomBytes(32),
        linkTokenEncrypted: randomBytes(16),
        sentAt: o.status === 'draft' ? null : new Date('2026-10-01T15:00:00.000Z'),
        signedAt,
        estimateBasis: 'estimate',
      })
      .returning({ id: proposals.id });
    const optionIds: string[] = [];
    for (const [i, totalCents] of o.optionCents.entries()) {
      const [opt] = await tx
        .insert(proposalOptions)
        .values({
          companyId,
          proposalId: p!.id,
          tier: (['good', 'better', 'best'] as const)[i]!,
          position: i + 1,
          name: `Option ${i + 1}`,
          scope: {},
          prices: {},
          addOns: [],
          calculation: {},
          totalCents,
        })
        .returning({ id: proposalOptions.id });
      optionIds.push(opt!.id);
    }
    if (signedAt !== null) {
      await tx.insert(proposalSignatures).values({
        companyId,
        proposalId: p!.id,
        optionId: optionIds[0]!,
        signerName: 'Pat Customer',
        typedSignature: 'Pat Customer',
        consentText: 'I agree.',
        consentVersion: 'v1',
        documentSha256: 'a'.repeat(64),
        totalCents: o.signedCents ?? o.optionCents[0]!,
        signedAt,
      });
    }
  });
}

type Body = {
  monthTotalCents: number;
  goalCents: number | null;
  weekly: { weekStart: string; totalCents: number }[];
  openPipelineCents: number;
};

async function get(who2: Promise<SuperAgent>): Promise<Body> {
  const res = await (await who2).get('/api/home/signed');
  expect(res.status).toBe(200);
  return res.body as Body;
}

describe('GET /api/home/signed', () => {
  test('needs a signed-in member', async () => {
    const res = await request(t.app).get('/api/home/signed');
    expect(res.status).toBe(401);
  });

  test('an empty company answers zeros and twelve Monday weeks ending this week', async () => {
    const body = await get(who.as('owner'));
    expect(body.monthTotalCents).toBe(0);
    expect(body.openPipelineCents).toBe(0);
    expect(body.goalCents).toBeNull();
    expect(body.weekly).toHaveLength(12);
    expect(body.weekly[0]).toEqual({ weekStart: '2026-07-27', totalCents: 0 });
    expect(body.weekly[11]).toEqual({ weekStart: '2026-10-12', totalCents: 0 });
  });

  test('counts the month and the weeks in the company zone', async () => {
    // 2026-10-01 04:30Z is still 30 September in Chicago: last month, the week of 2026-09-28.
    await seedProposal({ status: 'signed', optionCents: [1_000_000], signedAt: '2026-10-01T04:30:00.000Z' });
    // 2026-10-01 05:30Z is 00:30 on 1 October: this month, still the week of 2026-09-28.
    await seedProposal({ status: 'signed', optionCents: [2_000_000], signedAt: '2026-10-01T05:30:00.000Z' });
    // This week (Monday 2026-10-12 onward).
    await seedProposal({ status: 'signed', optionCents: [500_000, 900_000], signedAt: '2026-10-12T20:00:00.000Z', signedCents: 900_000 });
    // Older than twelve weeks (before 2026-07-27): in no week and not this month.
    await seedProposal({ status: 'signed', optionCents: [700_000], signedAt: '2026-07-20T20:00:00.000Z' });
    const body = await get(who.as('owner'));
    expect(body.monthTotalCents).toBe(2_900_000);
    const byWeek = new Map(body.weekly.map((w) => [w.weekStart, w.totalCents]));
    expect(byWeek.get('2026-10-12')).toBe(900_000);
    expect(byWeek.get('2026-09-28')).toBe(3_000_000);
    expect(body.weekly.reduce((sum, w) => sum + w.totalCents, 0)).toBe(3_900_000);
  });

  test('the open pipeline is sent and viewed unsigned proposals at their lowest option', async () => {
    await seedProposal({ status: 'sent', optionCents: [1_100_000, 1_400_000] });
    await seedProposal({ status: 'viewed', optionCents: [800_000] });
    await seedProposal({ status: 'draft', optionCents: [300_000] });
    await seedProposal({ status: 'signed', optionCents: [600_000], signedAt: '2026-10-12T20:00:00.000Z' });
    const body = await get(who.as('office'));
    expect(body.openPipelineCents).toBe(1_900_000);
  });

  test("another company's proposals never show", async () => {
    await seedProposal({ status: 'signed', optionCents: [4_000_000], signedAt: '2026-10-12T20:00:00.000Z' }, 'b');
    await seedProposal({ status: 'sent', optionCents: [3_000_000] }, 'b');
    const body = await get(who.as('rep'));
    expect(body.monthTotalCents).toBe(0);
    expect(body.openPipelineCents).toBe(0);
    const other = await get(who.as('owner', 'b'));
    expect(other.monthTotalCents).toBe(4_000_000);
    expect(other.openPipelineCents).toBe(3_000_000);
  });
});
