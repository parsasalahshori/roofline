import { and, eq, isNull, or, type SQL, sql } from 'drizzle-orm';
import { customers, jobs, properties } from '../schema/index.ts';
import type { TenantContext } from '../tenant.ts';

/** Matches no user. A rep context always has a user id; this only keeps a malformed one from matching rows that have no creator or assignee. */
const NO_USER = '00000000-0000-0000-0000-000000000000';

const userOf = (ctx: TenantContext): string => ctx.userId ?? NO_USER;

/*
 * Who may see what (spec 3.2). Each helper returns a WHERE condition for one table, or undefined
 * for "all of the company's" (the owner, the office, and the system: the runner and the scheduler).
 *
 * Row-level security already keeps every query inside the member's company; these narrow it for
 * reps. Every repository applies its own subject's helper to every read, edit and archive, so a
 * route cannot forget it, and a record outside the scope is reported exactly like one that does
 * not exist. The three rules lean on each other, and archived records are not treated differently:
 * an archived job still shows its customer and address, like an active one.
 */

/**
 * Jobs a rep may see: assigned to them, created by them, or an unassigned lead (anyone may pick
 * one up). A lead that nobody has taken stops being visible to the other reps the moment it is
 * assigned to someone, or moves on from the lead stage.
 */
export function jobScope(ctx: TenantContext): SQL | undefined {
  if (ctx.role !== 'rep') return undefined;
  const me = userOf(ctx);
  return or(
    eq(jobs.assignedUserId, me),
    eq(jobs.createdByUserId, me),
    and(eq(jobs.stage, 'lead'), isNull(jobs.assignedUserId)),
  );
}

/** Customers a rep may see: the ones they created, and the ones a job they may see is for. */
export function customerScope(ctx: TenantContext): SQL | undefined {
  if (ctx.role !== 'rep') return undefined;
  return or(
    eq(customers.createdByUserId, userOf(ctx)),
    sql`exists (select 1 from ${jobs} where ${jobs.customerId} = ${customers.id} and ${jobScope(ctx)})`,
  );
}

/**
 * Addresses a rep may see: the ones a job they may see is at, and the ones that belong to a
 * customer they may see (so a customer's other addresses show, whether or not a job is there).
 * An address with no customer and no job they can see is out of sight, including one they just
 * saved without naming a customer.
 */
export function propertyScope(ctx: TenantContext): SQL | undefined {
  if (ctx.role !== 'rep') return undefined;
  return or(
    sql`exists (select 1 from ${jobs} where ${jobs.propertyId} = ${properties.id} and ${jobScope(ctx)})`,
    sql`${properties.customerId} in (select ${customers.id} from ${customers} where ${customerScope(ctx)})`,
  );
}

/**
 * Whether the member may see a job's value: the owner and the office always; a rep only on a job
 * assigned to them or created by them (not on an unassigned lead they can merely see).
 */
export function canSeeJobValue(
  ctx: TenantContext,
  job: { assignedUserId: string | null; createdByUserId: string | null },
): boolean {
  if (ctx.role !== 'rep') return true;
  const me = ctx.userId;
  return me !== null && (job.assignedUserId === me || job.createdByUserId === me);
}
