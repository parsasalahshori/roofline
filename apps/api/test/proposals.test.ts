import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, test } from 'vitest';
import {
  companySettings,
  customers,
  getProposal,
  listProposals,
  measurements,
  proposalOptions,
  proposals,
  tierTemplates,
  UnknownProposalOptionError,
  updateDraftProposal,
  withTenant,
  type TenantContext,
} from '@roofline/db';
import { DEFAULT_TIER_TEMPLATES, defaultPricebook, defaultScope, monthlyPaymentCents, priceTier, type MeasuredQuantities } from '@roofline/shared';
import { Actors, addressFor, dbActivities, inCompany, mustCreate, NO_UUID } from './crm-helpers.ts';
import { makeTestApp, type TestApp } from './helpers.ts';
import { buildProposal, NO_ROOF_MESSAGE, TOO_LARGE_ESTIMATE_MESSAGE, TOO_LARGE_ROOF_MESSAGE } from '../src/estimator/build.ts';
import { REPLACED_PROPOSAL_MESSAGE, repriceFromMeasurement, SIGNED_PROPOSAL_MESSAGE } from '../src/estimator/reprice.ts';

const NOW = new Date('2026-10-12T15:00:00.000Z');
const SURFACE = 2400;
const QUANTITIES: MeasuredQuantities = { squares: 24, edgeFt: 220, ridgeFt: 60, valleyFt: 20 };
const BASE = {
  ...defaultScope,
  areaSqFt: SURFACE,
  areaType: 'surface' as const,
  pitch: 6,
  ridgeFt: 60,
  edgeFt: 220,
  valleyFt: 20,
  stories: 1,
  layers: 1,
};

let t: TestApp;
let who: Actors;

beforeEach(async () => {
  t = await makeTestApp();
  who = new Actors(t);
  t.clock.set(NOW);
});

const A = () => t.seed.a.companyId;
const ownerCtx = (company: 'a' | 'b' = 'a'): TenantContext => ({ companyId: t.seed[company].companyId, userId: t.seed[company].owner.userId, role: 'owner', canApproveSpend: true });
const repCtx = (): TenantContext => ({ companyId: A(), userId: t.seed.a.rep.userId, role: 'rep', canApproveSpend: false });
const inTx = <T>(ctx: TenantContext, fn: Parameters<typeof withTenant<T>>[2]) => withTenant(t.deps.pools, ctx, fn);

/** A customer, a home, a job and a measurement in company `c` (default A). */
async function setup(c: 'a' | 'b' = 'a', extraJob: Record<string, unknown> = {}, n = 0, surface = SURFACE) {
  const agent = await who.as('owner', c);
  const customer = await mustCreate(agent, '/api/customers', { displayName: 'Molly Lindgren' });
  const property = await mustCreate(agent, '/api/properties', { customerId: customer.id, ...addressFor(n) });
  const job = await mustCreate(agent, '/api/jobs', { customerId: customer.id, propertyId: property.id, ...extraJob });
  const measurementId = await newMeasurement(c, property.id, surface);
  return { customer, property, job, measurementId };
}

async function newMeasurement(c: 'a' | 'b', propertyId: string, surface = SURFACE, kind: 'estimate' | 'exact' = 'estimate') {
  const [m] = await inCompany(t, t.seed[c].companyId, (tx) =>
    tx
      .insert(measurements)
      .values({ companyId: t.seed[c].companyId, propertyId, kind, method: 'outline', surfaceSqFt: surface, pitchX12: 6, edgeFt: 220, ridgeFt: 60, valleyFt: 20 })
      .returning({ id: measurements.id }),
  );
  return m!.id;
}

const setFinancing = (apr: number | null, months: number | null) =>
  inCompany(t, A(), (tx) => tx.update(companySettings).set({ financingAprBps: apr, financingTermMonths: months }).where(eq(companySettings.companyId, A())));

describe('building a proposal', () => {
  test('builds three options equal to priceTier for each default template', async () => {
    const s = await setup();
    const p = await buildProposal(t.deps, ownerCtx(), { measurementId: s.measurementId, jobId: s.job.id });
    expect(p.options.map((o) => o.tier)).toEqual(['good', 'better', 'best']);
    DEFAULT_TIER_TEMPLATES.forEach((template, i) => {
      const expected = priceTier(template, { ...BASE, markupPercent: 25 }, defaultPricebook, QUANTITIES);
      expect(p.options[i]!.totalCents).toBe(expected.totalCents);
      expect(p.options[i]!.calculation).toEqual(expected.calculation);
    });
    expect(p.status).toBe('draft');
    expect(p.canEdit).toBe(true);
    expect(p.validUntil).toBe('2026-11-11');
    expect(p.address).toBe('100 Oak St, Omaha, NE 68102');
  });

  test('a disabled template stays stored with enabled false and its tier is omitted from the enabled totals', async () => {
    await inCompany(t, A(), (tx) =>
      tx.insert(tierTemplates).values(DEFAULT_TIER_TEMPLATES.map((d) => ({ ...d, companyId: A(), enabled: d.tier !== 'better' }))),
    );
    const s = await setup();
    const p = await buildProposal(t.deps, ownerCtx(), { measurementId: s.measurementId, jobId: s.job.id });
    expect(p.options).toHaveLength(3);
    expect(p.options.map((o) => o.enabled)).toEqual([true, false, true]);
    const enabledTotals = p.options.filter((o) => o.enabled).map((o) => o.totalCents);
    expect(enabledTotals).toHaveLength(2);
    expect(enabledTotals).not.toContain(p.options[1]!.totalCents);
  });

  test('basis is the measurement kind (estimate) and number is P-0001, the second is P-0002', async () => {
    const s = await setup();
    const first = await buildProposal(t.deps, ownerCtx(), { measurementId: s.measurementId, jobId: s.job.id });
    const second = await buildProposal(t.deps, ownerCtx(), { measurementId: s.measurementId, jobId: s.job.id });
    expect(first.basis).toBe('estimate');
    expect([first.number, second.number]).toEqual(['P-0001', 'P-0002']);
    const exactId = await newMeasurement('a', s.property.id as string, SURFACE, 'exact');
    expect((await buildProposal(t.deps, ownerCtx(), { measurementId: exactId, jobId: s.job.id })).basis).toBe('exact');
  });

  test("numbering is per company (company B also starts at P-0001)", async () => {
    const a = await setup('a');
    const b = await setup('b');
    expect((await buildProposal(t.deps, ownerCtx('a'), { measurementId: a.measurementId, jobId: a.job.id })).number).toBe('P-0001');
    expect((await buildProposal(t.deps, ownerCtx('b'), { measurementId: b.measurementId, jobId: b.job.id })).number).toBe('P-0001');
  });

  test('two concurrent creates get distinct numbers', async () => {
    const s = await setup();
    const input = { measurementId: s.measurementId, jobId: s.job.id };
    const both = await Promise.all([buildProposal(t.deps, ownerCtx(), input), buildProposal(t.deps, ownerCtx(), input)]);
    expect(both.map((p) => p.number).sort()).toEqual(['P-0001', 'P-0002']);
  });

  test('monthlyEstimateCents is null without APR and term and equals monthlyPaymentCents(total, 999, 120) when set', async () => {
    const s = await setup();
    const plain = await buildProposal(t.deps, ownerCtx(), { measurementId: s.measurementId, jobId: s.job.id });
    expect(plain.options.every((o) => o.monthlyEstimateCents === null)).toBe(true);
    await setFinancing(999, null);
    expect((await buildProposal(t.deps, ownerCtx(), { measurementId: s.measurementId, jobId: s.job.id })).options.every((o) => o.monthlyEstimateCents === null)).toBe(true);
    await setFinancing(999, 120);
    const financed = await buildProposal(t.deps, ownerCtx(), { measurementId: s.measurementId, jobId: s.job.id });
    for (const o of financed.options) expect(o.monthlyEstimateCents).toBe(monthlyPaymentCents(o.totalCents, 999, 120));
  });

  test('a 0 percent APR gives total/term', async () => {
    const s = await setup();
    await setFinancing(0, 60);
    const p = await buildProposal(t.deps, ownerCtx(), { measurementId: s.measurementId, jobId: s.job.id });
    for (const o of p.options) expect(o.monthlyEstimateCents).toBe(Math.ceil(o.totalCents / 60));
  });

  test('job activity says Proposal P-0001 drafted', async () => {
    const s = await setup();
    await buildProposal(t.deps, ownerCtx(), { measurementId: s.measurementId, jobId: s.job.id });
    const rows = await dbActivities(t, A(), s.job.id);
    expect(rows.map((r) => r.summary)).toContain('Proposal P-0001 drafted');
  });

  test('without a job the home\'s open job is used', async () => {
    const s = await setup();
    const p = await buildProposal(t.deps, ownerCtx(), { measurementId: s.measurementId });
    expect(p.jobId).toBe(s.job.id);
  });

  test('a new customer asked by text is created with express consent, and without askedByText consent is none', async () => {
    const agent = await who.as('owner');
    const mk = async (n: number) => {
      const property = await mustCreate(agent, '/api/properties', addressFor(n));
      return { property, measurementId: await newMeasurement('a', property.id) };
    };
    const one = await mk(1);
    const asked = await buildProposal(t.deps, ownerCtx(), { measurementId: one.measurementId, customer: { name: 'Pat Asked', phone: '(402) 555-0111', askedByText: true } });
    const two = await mk(2);
    const notAsked = await buildProposal(t.deps, ownerCtx(), { measurementId: two.measurementId, customer: { name: 'Sam Quiet', phone: '(402) 555-0122', email: 'sam@example.com', askedByText: false } });
    const rows = await inCompany(t, A(), (tx) => tx.select().from(customers));
    expect(rows.find((c) => c.id === asked.customer.id)).toMatchObject({ displayName: 'Pat Asked', smsConsentStatus: 'express' });
    expect(rows.find((c) => c.id === notAsked.customer.id)).toMatchObject({ smsConsentStatus: 'none' });
    expect(asked.customer.phone).toBe('+14025550111');
  });

  test("a job at another home is refused (field jobId): one home's job never carries another home's roof", async () => {
    const s = await setup('a', {}, 0);
    const elsewhere = await setup('a', {}, 1);
    await expect(buildProposal(t.deps, ownerCtx(), { measurementId: s.measurementId, jobId: elsewhere.job.id })).rejects.toMatchObject({ status: 400, field: 'jobId' });
    expect((await inTx(ownerCtx(), (tx) => listProposals(tx, ownerCtx(), {}))).total).toBe(0);
  });

  test('a missing measurement is a 404 and a home with no customer or job needs one', async () => {
    await expect(buildProposal(t.deps, ownerCtx(), { measurementId: NO_UUID })).rejects.toMatchObject({ status: 404 });
    const property = await mustCreate(await who.as('owner'), '/api/properties', addressFor(5));
    const measurementId = await newMeasurement('a', property.id);
    await expect(buildProposal(t.deps, ownerCtx(), { measurementId })).rejects.toMatchObject({ status: 400, field: 'customer' });
  });
});

describe('editing a draft', () => {
  test('patch re-prices: turning off the better option and changing good wastePercent updates the good total and calculation', async () => {
    const s = await setup();
    const p = await buildProposal(t.deps, ownerCtx(), { measurementId: s.measurementId, jobId: s.job.id });
    const [good, better] = p.options;
    const updated = await inTx(ownerCtx(), (tx) =>
      updateDraftProposal(tx, ownerCtx(), p.id, { messageBody: 'Hello', options: [{ id: good!.id, wastePercent: 20 }, { id: better!.id, enabled: false }] }, NOW),
    );
    if (updated === null || updated === 'not_draft') throw new Error('expected a view');
    const expected = priceTier({ ...DEFAULT_TIER_TEMPLATES[0]!, wastePercent: 20 }, { ...BASE, markupPercent: 25 }, defaultPricebook, QUANTITIES);
    expect(updated.messageBody).toBe('Hello');
    expect(updated.options[0]!.totalCents).toBe(expected.totalCents);
    expect(updated.options[0]!.totalCents).not.toBe(good!.totalCents);
    expect(updated.options[0]!.calculation).toEqual(expected.calculation);
    expect(updated.options[0]!.scope.wastePercent).toBe(20);
    expect(updated.options[1]!.enabled).toBe(false);
    expect(updated.options[1]!.totalCents).toBe(better!.totalCents);
  });

  test("an option id that is not the proposal's (or is named twice) is refused with its index and nothing changes", async () => {
    const s = await setup();
    const p = await buildProposal(t.deps, ownerCtx(), { measurementId: s.measurementId, jobId: s.job.id });
    const other = await buildProposal(t.deps, ownerCtx(), { measurementId: s.measurementId, jobId: s.job.id });
    const [good] = p.options;
    const patch = (options: { id: string; enabled?: boolean }[]) => inTx(ownerCtx(), (tx) => updateDraftProposal(tx, ownerCtx(), p.id, { messageBody: 'Changed', options }, NOW));
    await expect(patch([{ id: good!.id, enabled: false }, { id: NO_UUID, enabled: false }])).rejects.toMatchObject({ name: 'UnknownProposalOptionError', index: 1 });
    await expect(patch([{ id: other.options[0]!.id, enabled: false }])).rejects.toBeInstanceOf(UnknownProposalOptionError);
    await expect(patch([{ id: good!.id }, { id: good!.id, enabled: false }])).rejects.toMatchObject({ index: 1 });
    const after = await inTx(ownerCtx(), (tx) => getProposal(tx, ownerCtx(), p.id));
    expect(after?.messageBody).toBe(p.messageBody);
    expect(after?.options.map((o) => o.enabled)).toEqual([true, true, true]);
  });

  test('updateDraftProposal on a sent proposal returns not_draft', async () => {
    const s = await setup();
    const p = await buildProposal(t.deps, ownerCtx(), { measurementId: s.measurementId, jobId: s.job.id });
    await inCompany(t, A(), (tx) => tx.update(proposals).set({ status: 'sent' }).where(eq(proposals.id, p.id)));
    const result = await inTx(ownerCtx(), (tx) => updateDraftProposal(tx, ownerCtx(), p.id, { messageBody: 'x' }, NOW));
    expect(result).toBe('not_draft');
  });
});

describe('repricing from a measurement', () => {
  test('repricing a draft changes it in place (same id, revised false)', async () => {
    const s = await setup();
    const p = await buildProposal(t.deps, ownerCtx(), { measurementId: s.measurementId, jobId: s.job.id });
    const bigger = await newMeasurement('a', s.property.id as string, 3600, 'exact');
    const r = await repriceFromMeasurement(t.deps, ownerCtx(), p.id, bigger);
    expect(r.revised).toBe(false);
    expect(r.proposal.id).toBe(p.id);
    expect(r.proposal.number).toBe('P-0001');
    expect(r.proposal.basis).toBe('exact');
    expect(r.proposal.measurementId).toBe(bigger);
    expect(r.proposal.options[0]!.totalCents).toBeGreaterThan(p.options[0]!.totalCents);
  });

  test('repricing a sent proposal leaves it untouched and returns a new draft with revised true and a new number', async () => {
    const s = await setup();
    const p = await buildProposal(t.deps, ownerCtx(), { measurementId: s.measurementId, jobId: s.job.id });
    await inCompany(t, A(), (tx) => tx.update(proposals).set({ status: 'sent', sentAt: NOW }).where(eq(proposals.id, p.id)));
    const before = await inTx(ownerCtx(), (tx) => getProposal(tx, ownerCtx(), p.id));
    const bigger = await newMeasurement('a', s.property.id as string, 3600, 'exact');
    const r = await repriceFromMeasurement(t.deps, ownerCtx(), p.id, bigger);
    expect(r.revised).toBe(true);
    expect(r.proposal.id).not.toBe(p.id);
    expect(r.proposal.number).toBe('P-0002');
    expect(r.proposal.status).toBe('draft');
    expect(r.proposal.jobId).toBe(p.jobId);
    expect(r.proposal.customer.id).toBe(p.customer.id);
    const after = await inTx(ownerCtx(), (tx) => getProposal(tx, ownerCtx(), p.id));
    expect(after).toEqual(before);
    const summaries = (await dbActivities(t, A(), s.job.id)).map((a) => a.summary);
    expect(summaries).toContain('Proposal P-0002 drafted (revised from P-0001)');
  });
});

describe('repricing guards', () => {
  test("another home's measurement is refused (field measurementId) and the proposal is unchanged", async () => {
    const s = await setup('a', {}, 0);
    const elsewhere = await setup('a', {}, 1, 3600);
    const p = await buildProposal(t.deps, ownerCtx(), { measurementId: s.measurementId, jobId: s.job.id });
    await expect(repriceFromMeasurement(t.deps, ownerCtx(), p.id, elsewhere.measurementId)).rejects.toMatchObject({ status: 400, field: 'measurementId' });
    const after = await inTx(ownerCtx(), (tx) => getProposal(tx, ownerCtx(), p.id));
    expect(after?.measurementId).toBe(s.measurementId);
    expect(after?.options.map((o) => o.totalCents)).toEqual(p.options.map((o) => o.totalCents));
  });
});

describe('who can see a proposal', () => {
  test("a rep cannot get or list a proposal on a job they cannot see; company B cannot see company A's proposal", async () => {
    const s = await setup('a', { assignedUserId: t.seed.a.otherRep.userId });
    const p = await buildProposal(t.deps, ownerCtx(), { measurementId: s.measurementId, jobId: s.job.id });
    expect(await inTx(repCtx(), (tx) => getProposal(tx, repCtx(), p.id))).toBeNull();
    expect((await inTx(repCtx(), (tx) => listProposals(tx, repCtx(), {}))).total).toBe(0);
    const otherCtx: TenantContext = { ...repCtx(), userId: t.seed.a.otherRep.userId! };
    expect((await inTx(otherCtx, (tx) => getProposal(tx, otherCtx, p.id)))?.id).toBe(p.id);
    expect(await inTx(ownerCtx('b'), (tx) => getProposal(tx, ownerCtx('b'), p.id))).toBeNull();
    expect((await inTx(ownerCtx('b'), (tx) => listProposals(tx, ownerCtx('b'), {}))).total).toBe(0);
  });
});

describe('listing proposals', () => {
  test('listProposals filters by status, q and signedOn and reports total', async () => {
    const s = await setup();
    const input = { measurementId: s.measurementId, jobId: s.job.id };
    const p1 = await buildProposal(t.deps, ownerCtx(), input);
    t.clock.advance(60_000);
    const p2 = await buildProposal(t.deps, ownerCtx(), input);
    // 2026-10-13T03:00Z is still Oct 12 in Chicago.
    await inCompany(t, A(), (tx) => tx.update(proposals).set({ status: 'signed', signedAt: new Date('2026-10-13T03:00:00.000Z') }).where(eq(proposals.id, p2.id)));
    const list = (q: Parameters<typeof listProposals>[2]) => inTx(ownerCtx(), (tx) => listProposals(tx, ownerCtx(), q));
    const all = await list({});
    expect(all.total).toBe(2);
    expect(all.proposals.map((p) => p.number)).toEqual(['P-0002', 'P-0001']);
    expect((await list({ status: 'draft' })).proposals.map((p) => p.id)).toEqual([p1.id]);
    expect((await list({ status: 'signed' })).total).toBe(1);
    expect((await list({ q: 'p-0001' })).proposals.map((p) => p.id)).toEqual([p1.id]);
    expect((await list({ q: 'lindgren' })).total).toBe(2);
    expect((await list({ q: 'oak st' })).total).toBe(2);
    expect((await list({ q: 'nobody' })).total).toBe(0);
    expect((await list({ signedOn: '2026-10-12' })).proposals.map((p) => p.id)).toEqual([p2.id]);
    expect((await list({ signedOn: '2026-10-13' })).total).toBe(0);
    const page = await list({ offset: 1 });
    expect(page.total).toBe(2);
    expect(page.proposals).toHaveLength(1);
    const signed = (await list({ status: 'signed' })).proposals[0]!;
    expect(signed.signed).toBeNull(); // no signature record was written
  });
});

const storedTerms = async (proposalId: string) =>
  (await inCompany(t, A(), (tx) => tx.select().from(proposalOptions).where(eq(proposalOptions.proposalId, proposalId)))).map(
    (o) => (o.prices as { terms?: unknown }).terms,
  );

describe('terms frozen with the price (Ruling ER)', () => {
  test('each option stores the financing and the estimate clause it was priced with', async () => {
    const s = await setup();
    const plain = await buildProposal(t.deps, ownerCtx(), { measurementId: s.measurementId, jobId: s.job.id });
    expect(await storedTerms(plain.id)).toEqual([0, 1, 2].map(() => ({ financing: null, estimateClause: true })));

    await setFinancing(999, 120);
    const financed = await buildProposal(t.deps, ownerCtx(), { measurementId: s.measurementId, jobId: s.job.id });
    expect(await storedTerms(financed.id)).toEqual([0, 1, 2].map(() => ({ financing: { aprBps: 999, months: 120 }, estimateClause: true })));

    // The clause is for estimates only, and only while the company keeps it on.
    const exact = await newMeasurement('a', s.property.id as string, SURFACE, 'exact');
    const fromReport = await buildProposal(t.deps, ownerCtx(), { measurementId: exact, jobId: s.job.id });
    expect((await storedTerms(fromReport.id)).every((terms) => (terms as { estimateClause: boolean }).estimateClause === false)).toBe(true);
    await inCompany(t, A(), (tx) => tx.update(companySettings).set({ estimateChangeClause: false }).where(eq(companySettings.companyId, A())));
    const off = await buildProposal(t.deps, ownerCtx(), { measurementId: s.measurementId, jobId: s.job.id });
    expect((await storedTerms(off.id)).every((terms) => (terms as { estimateClause: boolean }).estimateClause === false)).toBe(true);
  });

  test('a re-price writes the terms of that moment, and the monthly amount follows them', async () => {
    const s = await setup();
    const p = await buildProposal(t.deps, ownerCtx(), { measurementId: s.measurementId, jobId: s.job.id });
    await setFinancing(0, 60);
    const r = await repriceFromMeasurement(t.deps, ownerCtx(), p.id, await newMeasurement('a', s.property.id as string, 3600));
    expect(await storedTerms(p.id)).toEqual([0, 1, 2].map(() => ({ financing: { aprBps: 0, months: 60 }, estimateClause: true })));
    for (const o of r.proposal.options) expect(o.monthlyEstimateCents).toBe(Math.ceil(o.totalCents / 60));
  });
});

describe('roofs the pricing engine cannot price (B8)', () => {
  test('no roof (zero surface) is a plain 400 asking for the outline', async () => {
    const s = await setup('a', {}, 0, 0);
    await expect(buildProposal(t.deps, ownerCtx(), { measurementId: s.measurementId, jobId: s.job.id })).rejects.toMatchObject({ status: 400, message: NO_ROOF_MESSAGE });
    expect(NO_ROOF_MESSAGE).toBe('Draw the roof outline first.');
  });

  test('a surface over the pricing limit is a plain 400: an estimate points to an exact report', async () => {
    const s = await setup('a', {}, 0, 150_000);
    await expect(buildProposal(t.deps, ownerCtx(), { measurementId: s.measurementId, jobId: s.job.id })).rejects.toMatchObject({ status: 400, message: TOO_LARGE_ESTIMATE_MESSAGE });
    const exact = await newMeasurement('a', s.property.id as string, 150_000, 'exact');
    await expect(buildProposal(t.deps, ownerCtx(), { measurementId: exact, jobId: s.job.id })).rejects.toMatchObject({ status: 400, message: TOO_LARGE_ROOF_MESSAGE });
  });

  test('the route answers the plain sentence, with no field', async () => {
    const s = await setup('a', {}, 0, 0);
    const res = await (await who.as('owner')).post('/api/proposals').send({ measurementId: s.measurementId, jobId: s.job.id });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: NO_ROOF_MESSAGE });
  });
});

describe('repricing by status (B1, B9)', () => {
  test("a 'ready' proposal gets a revised draft and is replaced by it, so its waiting send texts nothing", async () => {
    const s = await setup();
    const p = await buildProposal(t.deps, ownerCtx(), { measurementId: s.measurementId, jobId: s.job.id });
    await inCompany(t, A(), (tx) => tx.update(proposals).set({ status: 'ready' }).where(eq(proposals.id, p.id)));
    const r = await repriceFromMeasurement(t.deps, ownerCtx(), p.id, await newMeasurement('a', s.property.id as string, 3600, 'exact'));
    expect(r.revised).toBe(true);
    const [old] = await inCompany(t, A(), (tx) => tx.select().from(proposals).where(eq(proposals.id, p.id)));
    expect(old).toMatchObject({ status: 'replaced', replacedById: r.proposal.id });
  });

  test('a signed proposal is refused inside the re-price (409), and so is a replaced one', async () => {
    const s = await setup();
    const p = await buildProposal(t.deps, ownerCtx(), { measurementId: s.measurementId, jobId: s.job.id });
    const m = await newMeasurement('a', s.property.id as string, 3600, 'exact');
    await inCompany(t, A(), (tx) => tx.update(proposals).set({ status: 'signed', signedAt: NOW }).where(eq(proposals.id, p.id)));
    await expect(repriceFromMeasurement(t.deps, ownerCtx(), p.id, m)).rejects.toMatchObject({ status: 409, message: SIGNED_PROPOSAL_MESSAGE });
    await inCompany(t, A(), (tx) => tx.update(proposals).set({ status: 'replaced', signedAt: null }).where(eq(proposals.id, p.id)));
    await expect(repriceFromMeasurement(t.deps, ownerCtx(), p.id, m)).rejects.toMatchObject({ status: 409, message: REPLACED_PROPOSAL_MESSAGE });
    expect(await inCompany(t, A(), (tx) => tx.select().from(proposals).where(eq(proposals.jobId, s.job.id)))).toHaveLength(1);
  });
});
