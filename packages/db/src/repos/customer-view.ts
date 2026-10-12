import { and, asc, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import {
  type CustomerView,
  type HomeSummary,
  isTimeZone,
  type JobCard,
  type JobStage,
  localDate,
  type MemberRef,
} from '@roofline/shared';
import { companies, companySettings, jobs, properties, type CustomerPhone } from '../schema/index.ts';
import type { TenantContext, Tx } from '../tenant.ts';
import { listAppointmentsForCustomer } from './appointments.ts';
import { getCustomer, type CustomerRow } from './customers.ts';
import { canSeeJobValue, jobScope, propertyScope } from './scope.ts';

/** The zone a company's day is counted in when its row cannot be read or holds a zone this build does not know. */
const FALLBACK_ZONE = 'America/Chicago';
/** Days in stage before a Lead, Inspection or Proposal counts as stuck, when the company has no settings row. */
const DEFAULT_STUCK_AFTER_DAYS = 14;
/** How many scheduled appointments the customer screen lists. */
const UPCOMING_LIMIT = 5;
/** The stages that can be stuck (spec Decision 4). */
const STUCK_STAGES: readonly JobStage[] = ['lead', 'inspection', 'proposal'];
const DAY_MS = 86_400_000;

/** Whole calendar days from `from` to `to` (both `YYYY-MM-DD` in the company zone). */
function wholeDays(from: string, to: string): number {
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  return Math.round((Date.UTC(ty!, tm! - 1, td!) - Date.UTC(fy!, fm! - 1, fd!)) / DAY_MS);
}

/** The company's zone and stuck threshold, read once per view. */
async function companyFacts(tx: Tx, ctx: TenantContext): Promise<{ zone: string; stuckAfterDays: number }> {
  const [company] = await tx.select({ timezone: companies.timezone }).from(companies).where(eq(companies.id, ctx.companyId)).limit(1);
  const [settings] = await tx
    .select({ stuckAfterDays: companySettings.stuckAfterDays })
    .from(companySettings)
    .where(eq(companySettings.companyId, ctx.companyId))
    .limit(1);
  const zone = company && isTimeZone(company.timezone) ? company.timezone : FALLBACK_ZONE;
  return { zone, stuckAfterDays: settings?.stuckAfterDays ?? DEFAULT_STUCK_AFTER_DAYS };
}

/** A job row joined to its address line, as the customer screen reads it. */
type JobWithAddress = { job: typeof jobs.$inferSelect; addressLine: string };

/** The customer screen's job card for one job. The customer's display name and the member names are passed in. */
function jobCardOf(
  ctx: TenantContext,
  row: JobWithAddress,
  facts: { zone: string; stuckAfterDays: number; now: Date },
  customerName: string,
  members: ReadonlyMap<string, string>,
): JobCard {
  const { job } = row;
  const daysInStage = wholeDays(localDate(job.stageChangedAt, facts.zone), localDate(facts.now, facts.zone));
  const assignedName = job.assignedUserId === null ? undefined : members.get(job.assignedUserId);
  const assigned: MemberRef | null =
    job.assignedUserId !== null && assignedName !== undefined ? { userId: job.assignedUserId, name: assignedName } : null;
  return {
    id: job.id,
    customerId: job.customerId,
    customerName,
    propertyId: job.propertyId,
    addressLine: row.addressLine,
    stage: job.stage,
    valueCents: canSeeJobValue(ctx, job) ? job.valueCents : null,
    assigned,
    daysInStage,
    stuck: STUCK_STAGES.includes(job.stage) && daysInStage > facts.stuckAfterDays,
    nextStep: job.nextStep,
    nextStepOn: job.nextStepOn,
    updatedAt: job.updatedAt.toISOString(),
  };
}

/** The customer's phones as the screen shows them. */
function phonesOf(list: CustomerPhone[]): CustomerView['customer']['phones'] {
  return list.map((phone) => ({ e164: phone.e164, label: phone.label ?? null, primary: phone.primary === true }));
}

/** The customer as the screen shows it. */
function customerOf(row: CustomerRow): CustomerView['customer'] {
  return {
    id: row.id,
    displayName: row.displayName,
    firstName: row.firstName,
    lastName: row.lastName,
    phones: phonesOf(row.phones),
    emails: row.emails,
    tags: row.tags,
    consent: row.smsConsentStatus,
    doNotContact: row.doNotContact,
    source: row.source,
    archived: row.archivedAt !== null,
    createdAt: row.createdAt.toISOString(),
  };
}

/** The customer screen's data (C1 Task 7), or null when the member may not see the customer. */
export async function getCustomerView(tx: Tx, ctx: TenantContext, customerId: string, now: Date): Promise<CustomerView | null> {
  const customer = await getCustomer(tx, ctx, customerId);
  if (!customer) return null;

  const facts = { ...(await companyFacts(tx, ctx)), now };

  // The customer's addresses the member may see (archived ones left out).
  const addressRows = await tx
    .select()
    .from(properties)
    .where(and(eq(properties.customerId, customerId), isNull(properties.archivedAt), propertyScope(ctx)))
    .orderBy(asc(properties.createdAt), asc(properties.id));
  const homeIds = addressRows.map((row) => row.id);

  // Jobs the member may see that are for this customer, or at one of its addresses (archived ones left out).
  const atHomes = homeIds.length > 0 ? inArray(jobs.propertyId, homeIds) : undefined;
  const jobRows: JobWithAddress[] = await tx
    .select({ job: jobs, addressLine: properties.addressLine })
    .from(jobs)
    .innerJoin(properties, eq(properties.id, jobs.propertyId))
    .where(and(isNull(jobs.archivedAt), jobScope(ctx), or(eq(jobs.customerId, customerId), atHomes)))
    .orderBy(desc(jobs.updatedAt), desc(jobs.id));

  // Member names for everyone assigned to one of these jobs (company_members is the only way to read them).
  const assignedIds = [...new Set(jobRows.map((row) => row.job.assignedUserId).filter((id): id is string => id !== null))];
  const members = new Map<string, string>();
  if (assignedIds.length > 0) {
    const result = await tx.execute(sql`select user_id, name from company_members`);
    for (const row of result.rows) {
      if (assignedIds.includes(row.user_id as string)) members.set(row.user_id as string, row.name as string);
    }
  }

  const homes: HomeSummary[] = addressRows.map((row) => ({
    id: row.id,
    addressLine: row.addressLine,
    city: row.city,
    state: row.state,
    zip: row.zip,
    located: row.geom !== null,
    jobs: jobRows
      .filter((jobRow) => jobRow.job.propertyId === row.id)
      .map((jobRow) => ({ id: jobRow.job.id, stage: jobRow.job.stage })),
  }));

  const customerJobs: JobCard[] = jobRows
    .filter((jobRow) => jobRow.job.customerId === customerId)
    .map((jobRow) => jobCardOf(ctx, jobRow, facts, customer.displayName, members));

  const upcoming = await listAppointmentsForCustomer(tx, ctx, customerId, UPCOMING_LIMIT, now);

  return {
    customer: customerOf(customer),
    homes,
    jobs: customerJobs,
    upcoming,
    can: {
      edit: true,
      changeConsent: ctx.role === 'owner' || ctx.role === 'office',
      archive: true,
    },
  };
}
