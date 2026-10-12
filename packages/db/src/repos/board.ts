import { and, asc, count, desc, eq, gte, ilike, isNull, ne, or, type SQL, sql } from 'drizzle-orm';
import {
  BOARD_INSTALLED_DAYS,
  BOARD_STAGES,
  type BoardColumn,
  type BoardStage,
  type BoardView,
  daysInStage,
  type HomeSummary,
  isStuck,
  type JobCard,
  type JobSource,
  type JobStage,
  type JobView,
  type MemberRef,
} from '@roofline/shared';
import { agentTasks, companies, companySettings, customers, jobs, properties } from '../schema/index.ts';
import type { TenantContext, Tx } from '../tenant.ts';
import { listAppointmentsForJob } from './appointments.ts';
import { clampPage } from './paging.ts';
import { listQuoteSummaries } from './quotes.ts';
import { customerMatch, escapeLike } from './search.ts';
import { canSeeJobValue, jobScope } from './scope.ts';

export type BoardFilter = {
  assigned?: 'me' | 'unassigned' | { userId: string };
  source?: JobSource;
  q?: string;
  archived?: boolean;
};

export type BoardOptions = {
  now: Date;
  timeZone: string;
  stuckAfterDays: number;
  perColumn: number;
  showTotals: boolean;
};

const DAY_MS = 86_400_000;
const DEFAULT_TIME_ZONE = 'America/Chicago';
const DEFAULT_STUCK_AFTER_DAYS = 14;

/** The zone and threshold that turn a stage date into "days in stage" and "stuck". */
type TimeSettings = { now: Date; timeZone: string; stuckAfterDays: number };

/** One job row with its customer's name and its address line, as the board and the job view read it. */
type JobRecord = {
  id: string;
  customerId: string;
  customerName: string;
  propertyId: string;
  addressLine: string;
  stage: JobStage;
  source: JobSource;
  valueCents: number | null;
  assignedUserId: string | null;
  createdByUserId: string | null;
  lostReason: string | null;
  stageChangedAt: Date;
  nextStep: string | null;
  nextStepOn: string | null;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

type ColumnTotals = { count: number; totalCents: number };

const jobColumns = {
  id: jobs.id,
  customerId: jobs.customerId,
  customerName: customers.displayName,
  propertyId: jobs.propertyId,
  addressLine: properties.addressLine,
  stage: jobs.stage,
  source: jobs.source,
  valueCents: jobs.valueCents,
  assignedUserId: jobs.assignedUserId,
  createdByUserId: jobs.createdByUserId,
  lostReason: jobs.lostReason,
  stageChangedAt: jobs.stageChangedAt,
  nextStep: jobs.nextStep,
  nextStepOn: jobs.nextStepOn,
  archivedAt: jobs.archivedAt,
  createdAt: jobs.createdAt,
  updatedAt: jobs.updatedAt,
};

/** The conditions every board read shares: the member's scope, archived or not, and the filters. */
function boardConditions(ctx: TenantContext, f: BoardFilter): (SQL | undefined)[] {
  const conditions: (SQL | undefined)[] = [jobScope(ctx), f.archived === true ? undefined : isNull(jobs.archivedAt)];
  if (f.assigned === 'me') conditions.push(ctx.userId === null ? sql`false` : eq(jobs.assignedUserId, ctx.userId));
  else if (f.assigned === 'unassigned') conditions.push(isNull(jobs.assignedUserId));
  else if (f.assigned !== undefined) conditions.push(eq(jobs.assignedUserId, f.assigned.userId));
  if (f.source !== undefined) conditions.push(eq(jobs.source, f.source));
  const q = f.q?.trim();
  if (q) conditions.push(or(customerMatch(q), ilike(properties.addressLine, `%${escapeLike(q)}%`)));
  return conditions;
}

function installedCutoff(now: Date): Date {
  return new Date(now.getTime() - BOARD_INSTALLED_DAYS * DAY_MS);
}

/** The jobs of one board column. Installed jobs are limited to the last 30 days by when they were installed. */
function stageCondition(stage: BoardStage, now: Date): SQL | undefined {
  if (stage !== 'installed') return eq(jobs.stage, stage);
  return and(eq(jobs.stage, 'installed'), gte(jobs.stageChangedAt, installedCutoff(now)));
}

/** Count and value total of every column (and the lost drawer), over the whole filtered set. */
async function columnTotals(tx: Tx, conditions: (SQL | undefined)[], now: Date): Promise<Map<JobStage, ColumnTotals>> {
  const rows = await tx
    .select({
      stage: jobs.stage,
      n: count(),
      total: sql<string>`coalesce(sum(${jobs.valueCents}), 0)`,
    })
    .from(jobs)
    .innerJoin(customers, and(eq(customers.companyId, jobs.companyId), eq(customers.id, jobs.customerId)))
    .innerJoin(properties, and(eq(properties.companyId, jobs.companyId), eq(properties.id, jobs.propertyId)))
    .where(and(...conditions, or(ne(jobs.stage, 'installed'), gte(jobs.stageChangedAt, installedCutoff(now)))))
    .groupBy(jobs.stage);
  return new Map(rows.map((row) => [row.stage, { count: row.n, totalCents: Number(row.total) }]));
}

/** One page of a column's jobs, newest stage change first. */
async function columnRows(
  tx: Tx,
  conditions: (SQL | undefined)[],
  stage: BoardStage,
  now: Date,
  offset: number,
  limit: number,
): Promise<JobRecord[]> {
  return tx
    .select(jobColumns)
    .from(jobs)
    .innerJoin(customers, and(eq(customers.companyId, jobs.companyId), eq(customers.id, jobs.customerId)))
    .innerJoin(properties, and(eq(properties.companyId, jobs.companyId), eq(properties.id, jobs.propertyId)))
    .where(and(...conditions, stageCondition(stage, now)))
    .orderBy(desc(jobs.stageChangedAt), asc(jobs.id))
    .limit(limit)
    .offset(offset);
}

/** Member names for the given assignees, from the company_members view, in one read. */
async function memberNames(tx: Tx, userIds: readonly (string | null)[]): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const ids = [...new Set(userIds.filter((id): id is string => id !== null))];
  if (ids.length === 0) return names;
  // The view is the only way the tenant role sees names; it is already filtered to this company.
  const result = await tx.execute(
    sql`select user_id, name from company_members where user_id in (${sql.join(
      ids.map((id) => sql`${id}`),
      sql`, `,
    )})`,
  );
  for (const row of result.rows) names.set(row.user_id as string, row.name as string);
  return names;
}

function cardFor(ctx: TenantContext, row: JobRecord, names: Map<string, string>, settings: TimeSettings): JobCard {
  const days = daysInStage(row.stageChangedAt, settings.now, settings.timeZone);
  const assignedName = row.assignedUserId === null ? undefined : names.get(row.assignedUserId);
  const assigned: MemberRef | null =
    row.assignedUserId !== null && assignedName !== undefined ? { userId: row.assignedUserId, name: assignedName } : null;
  return {
    id: row.id,
    customerId: row.customerId,
    customerName: row.customerName,
    propertyId: row.propertyId,
    addressLine: row.addressLine,
    stage: row.stage,
    valueCents: canSeeJobValue(ctx, row) ? row.valueCents : null,
    assigned,
    daysInStage: days,
    stuck: isStuck(row.stage, days, settings.stuckAfterDays),
    nextStep: row.nextStep,
    nextStepOn: row.nextStepOn,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function columnOf(stage: BoardStage, totals: Map<JobStage, ColumnTotals>, cards: JobCard[], showTotals: boolean): BoardColumn {
  const column = totals.get(stage);
  return {
    stage,
    count: column?.count ?? 0,
    totalCents: showTotals ? (column?.totalCents ?? 0) : null,
    jobs: cards,
  };
}

/** The company zone and the stuck threshold the board and the job view need. */
export async function boardSettings(tx: Tx, ctx: TenantContext): Promise<{ timeZone: string; stuckAfterDays: number }> {
  const [row] = await tx
    .select({
      timeZone: companies.timezone,
      stuckAfterDays: companySettings.stuckAfterDays,
    })
    .from(companies)
    .leftJoin(companySettings, eq(companySettings.companyId, companies.id))
    .where(eq(companies.id, ctx.companyId))
    .limit(1);
  return {
    timeZone: row?.timeZone ?? DEFAULT_TIME_ZONE,
    stuckAfterDays: row?.stuckAfterDays ?? DEFAULT_STUCK_AFTER_DAYS,
  };
}

/** Every board column (in stage order, empty ones included), each with its first `perColumn` jobs, and the lost count. */
export async function boardColumns(tx: Tx, ctx: TenantContext, f: BoardFilter, opts: BoardOptions): Promise<BoardView> {
  const conditions = boardConditions(ctx, f);
  const totals = await columnTotals(tx, conditions, opts.now);
  const { limit } = clampPage({ limit: opts.perColumn });
  const pages = new Map<BoardStage, JobRecord[]>();
  for (const stage of BOARD_STAGES) {
    pages.set(stage, await columnRows(tx, conditions, stage, opts.now, 0, limit));
  }
  const allRows = [...pages.values()].flat();
  const names = await memberNames(
    tx,
    allRows.map((row) => row.assignedUserId),
  );
  const columns = BOARD_STAGES.map((stage) =>
    columnOf(
      stage,
      totals,
      (pages.get(stage) ?? []).map((row) => cardFor(ctx, row, names, opts)),
      opts.showTotals,
    ),
  );
  return { columns, lost: { count: totals.get('lost')?.count ?? 0 } };
}

/** One column, from `offset`, `perColumn` jobs at a time. The count and total still describe the whole column. */
export async function boardColumnPage(
  tx: Tx,
  ctx: TenantContext,
  f: BoardFilter,
  stage: BoardStage,
  offset: number,
  opts: BoardOptions,
): Promise<BoardColumn> {
  const conditions = boardConditions(ctx, f);
  const totals = await columnTotals(tx, conditions, opts.now);
  const page = clampPage({ limit: opts.perColumn, offset });
  const rows = await columnRows(tx, conditions, stage, opts.now, page.offset, page.limit);
  const names = await memberNames(
    tx,
    rows.map((row) => row.assignedUserId),
  );
  return columnOf(
    stage,
    totals,
    rows.map((row) => cardFor(ctx, row, names, opts)),
    opts.showTotals,
  );
}

/** The job view for one job in the member's scope, or null. */
export async function jobViewFor(
  tx: Tx,
  ctx: TenantContext,
  id: string,
  opts: { now: Date; timeZone: string; stuckAfterDays: number },
): Promise<JobView | null> {
  const [row] = await tx
    .select({
      ...jobColumns,
      customerPhones: customers.phones,
      customerEmails: customers.emails,
      city: properties.city,
      state: properties.state,
      zip: properties.zip,
      located: sql<boolean>`${properties.geom} is not null`,
    })
    .from(jobs)
    .innerJoin(customers, and(eq(customers.companyId, jobs.companyId), eq(customers.id, jobs.customerId)))
    .innerJoin(properties, and(eq(properties.companyId, jobs.companyId), eq(properties.id, jobs.propertyId)))
    .where(and(eq(jobs.id, id), jobScope(ctx)))
    .limit(1);
  if (!row) return null;

  const names = await memberNames(tx, [row.assignedUserId]);
  const card = cardFor(ctx, row, names, opts);

  const homeJobs = await tx
    .select({ id: jobs.id, stage: jobs.stage })
    .from(jobs)
    .where(and(eq(jobs.propertyId, row.propertyId), isNull(jobs.archivedAt), jobScope(ctx)))
    .orderBy(desc(jobs.createdAt), asc(jobs.id));

  const home: HomeSummary = {
    id: row.propertyId,
    addressLine: row.addressLine,
    city: row.city,
    state: row.state,
    zip: row.zip,
    located: row.located,
    jobs: homeJobs,
  };

  const appointments = await listAppointmentsForJob(tx, ctx, id);
  const quotes = await listQuoteSummaries(tx, ctx, id);

  const taskRows = await tx
    .select({
      id: agentTasks.id,
      title: agentTasks.title,
      status: agentTasks.status,
    })
    .from(agentTasks)
    .where(and(eq(agentTasks.subjectType, 'job'), eq(agentTasks.subjectId, id)))
    .orderBy(desc(agentTasks.createdAt), asc(agentTasks.id))
    .limit(10);

  const primaryPhone = row.customerPhones.find((phone) => phone.primary === true) ?? row.customerPhones[0];

  return {
    job: {
      ...card,
      source: row.source,
      lostReason: row.lostReason,
      stageChangedAt: row.stageChangedAt.toISOString(),
      archived: row.archivedAt !== null,
      createdAt: row.createdAt.toISOString(),
    },
    customer: {
      id: row.customerId,
      displayName: row.customerName,
      phone: primaryPhone?.e164 ?? null,
      email: row.customerEmails[0] ?? null,
    },
    home,
    appointments,
    quotes,
    tasks: taskRows.map((task) => ({
      id: task.id,
      title: task.title,
      status: task.status,
    })),
    can: {
      edit: true,
      seeValue: canSeeJobValue(ctx, row),
      archive: ctx.role !== 'rep' || row.assignedUserId === ctx.userId || row.createdByUserId === ctx.userId,
    },
  };
}
