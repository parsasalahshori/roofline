import { and, desc, eq, isNull, notInArray } from 'drizzle-orm';
import {
  addActivity,
  companies,
  companySettings,
  createCustomer,
  createJob,
  createProposal,
  DuplicatePhoneError,
  getJob,
  getMeasurementBasics,
  getPricebook,
  getProperty,
  jobScope,
  jobs,
  linkPropertyToCustomer,
  tierTemplates,
  withTenant,
  type MeasurementBasics,
  type NewProposalOption,
  type TenantContext,
  type Tx,
} from '@roofline/db';
import {
  DEFAULT_TIER_TEMPLATES,
  defaultScope,
  localDate,
  monthlyPaymentCents,
  priceTier,
  TIERS,
  toE164,
  type MeasuredQuantities,
  type ProposalView,
  type TierTemplate,
} from '@roofline/shared';
import type { AppDeps } from '../app.ts';
import { AppError, MESSAGES } from '../errors.ts';

/** The text a new proposal starts with. {first_name} and {company} are filled when drafted; {address} and {link} stay until it is sent (Task 11). */
export const DEFAULT_PROPOSAL_MESSAGE =
  "Hi {first_name}, it's {company}. Here's your roof proposal for {address}: {link} Reply STOP to opt out.";

const DEFAULT_TIME_ZONE = 'America/Chicago';
const DEFAULT_VALID_DAYS = 30;

type BuildInput = { measurementId: string; jobId?: string; customer?: { name: string; phone: string; email?: string; askedByText: boolean } };

function addDays(day: string, days: number): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** The company's tier templates in TIERS order; the defaults when it never saved any. */
async function loadTemplates(tx: Tx, ctx: TenantContext): Promise<TierTemplate[]> {
  const rows = await tx.select().from(tierTemplates).where(eq(tierTemplates.companyId, ctx.companyId));
  if (rows.length === 0) return DEFAULT_TIER_TEMPLATES.map((t) => ({ ...t, addOns: t.addOns.map((a) => ({ ...a })), highlights: [...t.highlights] }));
  return TIERS.map((tier) => {
    const row = rows.find((r) => r.tier === tier);
    const fallback = DEFAULT_TIER_TEMPLATES.find((t) => t.tier === tier)!;
    if (!row) return { ...fallback, enabled: false };
    return {
      tier,
      name: row.name,
      material: row.material,
      wastePercent: row.wastePercent,
      markupPercent: row.markupPercent,
      addOns: row.addOns,
      highlights: row.highlights,
      enabled: row.enabled,
    };
  });
}

async function financingSettings(tx: Tx, ctx: TenantContext): Promise<{ aprBps: number; months: number } | null> {
  const [s] = await tx
    .select({ apr: companySettings.financingAprBps, months: companySettings.financingTermMonths })
    .from(companySettings)
    .where(eq(companySettings.companyId, ctx.companyId))
    .limit(1);
  return s && s.apr !== null && s.months !== null ? { aprBps: s.apr, months: s.months } : null;
}

/** The three options (good, better, best, disabled ones too) for a measurement, priced with the current templates and pricebook. */
export async function priceOptions(tx: Tx, ctx: TenantContext, m: MeasurementBasics): Promise<NewProposalOption[]> {
  const templates = await loadTemplates(tx, ctx);
  const view = await getPricebook(tx, ctx);
  const fin = await financingSettings(tx, ctx);
  const base = {
    ...defaultScope,
    areaSqFt: m.surfaceSqFt,
    areaType: 'surface' as const,
    pitch: m.pitchX12,
    ridgeFt: m.ridgeFt,
    edgeFt: m.edgeFt,
    valleyFt: m.valleyFt,
    stories: 1,
    layers: 1,
    taxPercent: view.defaults.taxPercent,
    markupPercent: view.defaults.markupPercent,
  };
  const quantities: MeasuredQuantities = { squares: m.surfaceSqFt / 100, edgeFt: m.edgeFt, ridgeFt: m.ridgeFt, valleyFt: m.valleyFt };
  return TIERS.map((tier, position) => {
    const template = templates.find((t) => t.tier === tier)!;
    const priced = priceTier(template, { ...base, markupPercent: template.markupPercent ?? view.defaults.markupPercent }, view.prices, quantities);
    return {
      tier,
      position,
      name: template.name,
      highlights: template.highlights,
      scope: priced.scope,
      addOns: template.addOns,
      calculation: priced.calculation,
      addOnLines: priced.addOnLines,
      pricebook: view.prices,
      quantities,
      totalCents: priced.totalCents,
      monthlyEstimateCents: fin ? monthlyPaymentCents(priced.totalCents, fin.aprBps, fin.months) : null,
      enabled: template.enabled,
    };
  });
}

/** Today in the company's zone plus its proposal validity, as yyyy-mm-dd. */
export async function validUntilFor(tx: Tx, ctx: TenantContext, now: Date): Promise<string> {
  const [row] = await tx
    .select({ zone: companies.timezone, days: companySettings.proposalValidDays })
    .from(companies)
    .leftJoin(companySettings, eq(companySettings.companyId, companies.id))
    .where(eq(companies.id, ctx.companyId))
    .limit(1);
  return addDays(localDate(now, row?.zone ?? DEFAULT_TIME_ZONE), row?.days ?? DEFAULT_VALID_DAYS);
}

/** Records that a draft was made on the job's timeline. */
export async function noteDrafted(tx: Tx, ctx: TenantContext, jobId: string, summary: string, now: Date): Promise<void> {
  await addActivity(tx, ctx, { subjectType: 'job', subjectId: jobId, kind: 'proposal.drafted', summary, at: now });
}

export async function buildProposal(deps: AppDeps, ctx: TenantContext, i: BuildInput): Promise<ProposalView> {
  const now = deps.clock.now();
  return withTenant(deps.pools, ctx, async (tx) => {
    const m = await getMeasurementBasics(tx, ctx, i.measurementId);
    if (!m) throw new AppError(404, MESSAGES.notFound);

    let jobId: string;
    let customerId: string;
    let propertyId: string;
    if (i.jobId) {
      const job = await getJob(tx, ctx, i.jobId);
      if (!job) throw new AppError(404, MESSAGES.notFound);
      // The job must be at the measured home: one home's job never carries another home's roof.
      if (job.propertyId !== m.propertyId) throw new AppError(400, MESSAGES.checkField, 'jobId');
      ({ id: jobId, customerId, propertyId } = job);
    } else {
      const [open] = await tx
        .select()
        .from(jobs)
        .where(and(eq(jobs.propertyId, m.propertyId), notInArray(jobs.stage, ['won', 'lost', 'installed']), isNull(jobs.archivedAt), jobScope(ctx)))
        .orderBy(desc(jobs.createdAt))
        .limit(1);
      if (open) {
        ({ id: jobId, customerId, propertyId } = open);
      } else {
        const property = await getProperty(tx, ctx, m.propertyId);
        if (!property) throw new AppError(404, MESSAGES.notFound);
        if (i.customer) {
          const phone = toE164(i.customer.phone);
          if (!phone) throw new AppError(400, MESSAGES.checkField, 'customer.phone');
          try {
            const created = await createCustomer(
              tx,
              ctx,
              {
                displayName: i.customer.name.trim(),
                phones: [{ e164: phone, primary: true }],
                emails: i.customer.email ? [i.customer.email] : [],
                smsConsentStatus: i.customer.askedByText ? 'express' : 'none',
              },
              { now },
            );
            customerId = created.id;
            if (property.customerId === null) await linkPropertyToCustomer(tx, ctx, property.id, { id: created.id, displayName: created.displayName }, { now });
          } catch (err) {
            if (err instanceof DuplicatePhoneError) throw new AppError(400, MESSAGES.checkField, 'customer.phone');
            throw err;
          }
        } else if (property.customerId) {
          customerId = property.customerId;
        } else {
          throw new AppError(400, MESSAGES.checkField, 'customer');
        }
        const job = await createJob(tx, ctx, { customerId, propertyId: property.id }, { now });
        ({ id: jobId, customerId, propertyId } = job);
      }
    }

    const options = await priceOptions(tx, ctx, m);
    const validUntil = await validUntilFor(tx, ctx, now);
    const proposal = await createProposal(
      tx,
      ctx,
      { jobId, customerId, propertyId, measurementId: m.id, basis: m.kind, validUntil, messageBody: DEFAULT_PROPOSAL_MESSAGE, options },
      now,
    );
    await noteDrafted(tx, ctx, jobId, `Proposal ${proposal.number} drafted`, now);
    return proposal;
  });
}
