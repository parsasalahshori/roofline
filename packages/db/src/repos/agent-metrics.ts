import { and, asc, desc, eq, gte, inArray, isNotNull, lt, or, sql } from 'drizzle-orm';
import type { Agent, TaskStatus } from '@roofline/shared';
import { agentSettings, agentTasks, agentTaskSteps, conversations, customers, jobs } from '../schema/index.ts';
import type { TenantContext, Tx } from '../tenant.ts';
import { waitingNow } from './agent-waiting.ts';
import { customerScope, jobScope } from './scope.ts';

/*
 * A1 Task 5 read models for the Agents screen. Reads only snapshots (agent_task_steps.minutes_saved);
 * never recomputes minutes. Every query names ctx.companyId and applies the rep scope (`taskSubjectScope`).
 */

/** Instants (UTC) that bound the windows, computed by the API in the company's time zone. */
export type MetricsWindow = {
  /** The moment of the read; waiting drafts that expired before it do not count. */
  now: Date;
  /** IANA zone, used by SQL `at time zone` for day buckets. */
  timeZone: string;
  todayStart: Date;
  tomorrowStart: Date;
  /** now minus 30 days. */
  since30: Date;
  monthStart: Date;
  /** Start of the local day 13 days before today (first of the 14 chart days). */
  chartStart: Date;
};

export type AgentCounts = {
  /** Tasks with status done or partly_done and updated_at in [todayStart, tomorrowStart). */
  finishedToday: number;
  /** Last 30 days (updated_at >= since30): */
  done30d: number;
  partlyDone30d: number;
  /** done + partly_done + needs_attention in the last 30 days. */
  ran30d: number;
  /** declined + expired in the last 30 days. */
  notApproved30d: number;
  /**
   * All-time current: status draft or awaiting_owner (drafts awaiting approval) plus needs_attention,
   * leaving out tasks whose expires_at is before `w.now` (the same rule as the waiting list).
   */
  waitingCount: number;
};

const FINISHED: TaskStatus[] = ['done', 'partly_done'];
const NOT_APPROVED: TaskStatus[] = ['declined', 'expired'];
const FINISHED_OR_HANDLED: TaskStatus[] = ['done', 'partly_done', 'needs_attention', 'declined', 'expired'];

const round2 = (x: number): number => Math.round(x * 100) / 100;

/**
 * SQL condition on agent_tasks for the reader's role scope (AX-J); undefined for owner/office/system.
 * A rep sees a job-subject task only when the job is inside `jobScope`, and a customer-subject task
 * only when the customer is inside `customerScope`. Tasks with no subject, or any other subject type,
 * are not visible to a rep. Fails closed (matches nothing) if a scope helper unexpectedly yields nothing.
 */
export function taskSubjectScope(ctx: TenantContext): import('drizzle-orm').SQL | undefined {
  if (ctx.role !== 'rep') return undefined;
  const visibleJobs = jobScope(ctx) ?? sql`false`;
  const visibleCustomers = customerScope(ctx) ?? sql`false`;
  return or(
    and(
      eq(agentTasks.subjectType, 'job'),
      sql`${agentTasks.subjectId} in (select ${jobs.id} from ${jobs} where ${visibleJobs})`,
    ),
    and(
      eq(agentTasks.subjectType, 'customer'),
      sql`${agentTasks.subjectId} in (select ${customers.id} from ${customers} where ${visibleCustomers})`,
    ),
  );
}

/** Counts per agent (only agents that have rows appear; callers default to zeros). */
export async function agentCounts(tx: Tx, ctx: TenantContext, w: MetricsWindow): Promise<Record<string, AgentCounts>> {
  // A done or partly_done task only counts as finished work when one of its steps really finished (N-1, N-6):
  // a fully failed partly_done counts in ran30d only; an approved task with every step switched off is "not approved".
  const hasDoneStep = sql`exists (select 1 from agent_task_steps s where s.task_id = ${agentTasks.id}
    and s.company_id = ${ctx.companyId} and s.status = 'done')`;
  const finishedStatus = sql`(${inArray(agentTasks.status, FINISHED)} and ${hasDoneStep})`;
  const since = sql`${agentTasks.updatedAt} >= ${w.since30}`;
  const rows = await tx
    .select({
      agent: agentTasks.agent,
      finishedToday: sql<number>`(count(*) filter (where ${finishedStatus}
        and ${agentTasks.updatedAt} >= ${w.todayStart} and ${agentTasks.updatedAt} < ${w.tomorrowStart}))::int`,
      done30d: sql<number>`(count(*) filter (where ${agentTasks.status} = 'done' and ${hasDoneStep} and ${since}))::int`,
      partlyDone30d: sql<number>`(count(*) filter (where ${agentTasks.status} = 'partly_done' and ${hasDoneStep} and ${since}))::int`,
      ran30d: sql<number>`(count(*) filter (where (${agentTasks.status} in ('partly_done', 'needs_attention')
        or (${agentTasks.status} = 'done' and ${hasDoneStep})) and ${since}))::int`,
      notApproved30d: sql<number>`(count(*) filter (where (${inArray(agentTasks.status, NOT_APPROVED)}
        or (${agentTasks.status} = 'done' and not ${hasDoneStep})) and ${since}))::int`,
      waitingCount: sql<number>`(count(*) filter (where ${waitingNow(w.now)}))::int`,
    })
    .from(agentTasks)
    .where(and(eq(agentTasks.companyId, ctx.companyId), taskSubjectScope(ctx)))
    .groupBy(agentTasks.agent);

  const out: Record<string, AgentCounts> = {};
  for (const r of rows) {
    out[r.agent] = {
      finishedToday: Number(r.finishedToday),
      done30d: Number(r.done30d),
      partlyDone30d: Number(r.partlyDone30d),
      ran30d: Number(r.ran30d),
      notApproved30d: Number(r.notApproved30d),
      waitingCount: Number(r.waitingCount),
    };
  }
  return out;
}

/** Done/partly_done tasks per local day for one agent from w.chartStart to now; days with none are omitted. date = YYYY-MM-DD. */
export async function dailyFinished(
  tx: Tx,
  ctx: TenantContext,
  agent: Agent,
  w: MetricsWindow,
): Promise<{ date: string; finished: number }[]> {
  const day = sql<string>`to_char(${agentTasks.updatedAt} at time zone ${w.timeZone}::text, 'YYYY-MM-DD')`;
  const rows = await tx
    .select({ date: day, finished: sql<number>`count(*)::int` })
    .from(agentTasks)
    .where(
      and(
        eq(agentTasks.companyId, ctx.companyId),
        eq(agentTasks.agent, agent),
        inArray(agentTasks.status, FINISHED),
        gte(agentTasks.updatedAt, w.chartStart),
        lt(agentTasks.updatedAt, w.tomorrowStart),
        taskSubjectScope(ctx),
      ),
    )
    // Positional, so the select's and the group's day expression are the same text (one parameter).
    .groupBy(sql`1`)
    .orderBy(sql`1`);
  return rows.map((r) => ({ date: r.date, finished: Number(r.finished) }));
}

/** The done steps of the company's tasks (scope applied) whose step updated_at is in [from, to). */
function doneStepsInRange(ctx: TenantContext, range: { from: Date; to: Date }) {
  return and(
    eq(agentTaskSteps.companyId, ctx.companyId),
    eq(agentTasks.companyId, ctx.companyId),
    eq(agentTaskSteps.status, 'done'),
    gte(agentTaskSteps.updatedAt, range.from),
    lt(agentTaskSteps.updatedAt, range.to),
    taskSubjectScope(ctx),
  );
}

/** Sum of done-step minutes_saved snapshots with step updated_at in [from, to), per agent (all agents with rows). */
export async function minutesByAgent(
  tx: Tx,
  ctx: TenantContext,
  range: { from: Date; to: Date },
): Promise<Record<string, number>> {
  const rows = await tx
    .select({ agent: agentTasks.agent, minutes: sql<string | null>`sum(${agentTaskSteps.minutesSaved})` })
    .from(agentTaskSteps)
    .innerJoin(agentTasks, and(eq(agentTaskSteps.companyId, agentTasks.companyId), eq(agentTaskSteps.taskId, agentTasks.id)))
    .where(doneStepsInRange(ctx, range))
    .groupBy(agentTasks.agent);

  const out: Record<string, number> = {};
  for (const r of rows) out[r.agent] = round2(Number(r.minutes ?? 0));
  return out;
}

/** Done steps in [from, to) for one agent grouped by baseline_key: units and minutes sums, minutes descending. */
export async function breakdownByBaseline(
  tx: Tx,
  ctx: TenantContext,
  agent: Agent,
  range: { from: Date; to: Date },
): Promise<{ baseline: string; units: number; minutes: number }[]> {
  const rows = await tx
    .select({
      baseline: agentTaskSteps.baselineKey,
      units: sql<string | null>`sum(${agentTaskSteps.units})`,
      minutes: sql<string | null>`sum(${agentTaskSteps.minutesSaved})`,
    })
    .from(agentTaskSteps)
    .innerJoin(agentTasks, and(eq(agentTaskSteps.companyId, agentTasks.companyId), eq(agentTaskSteps.taskId, agentTasks.id)))
    .where(and(doneStepsInRange(ctx, range), eq(agentTasks.agent, agent), isNotNull(agentTaskSteps.baselineKey)))
    .groupBy(agentTaskSteps.baselineKey)
    .orderBy(sql`sum(${agentTaskSteps.minutesSaved}) desc nulls last`, asc(agentTaskSteps.baselineKey));

  return rows.map((r) => ({
    baseline: r.baseline ?? '',
    units: round2(Number(r.units ?? 0)),
    minutes: round2(Number(r.minutes ?? 0)),
  }));
}

export type RecentTaskRow = {
  id: string;
  kind: string;
  status: string;
  mode: 'needs_approval' | 'live';
  createdAt: Date;
  /** updated_at when status is done / partly_done / needs_attention / declined / expired, else null. */
  finishedAt: Date | null;
  minutesSaved: number | null;
};

/** The agent's newest tasks (created_at desc, id desc), role-scoped. `limit` is clamped to 1..100. */
export async function recentTasks(tx: Tx, ctx: TenantContext, agent: Agent, limit: number): Promise<RecentTaskRow[]> {
  const clamped = Math.min(100, Math.max(1, Math.floor(limit)));
  const rows = await tx
    .select({
      id: agentTasks.id,
      kind: agentTasks.kind,
      status: agentTasks.status,
      mode: agentTasks.mode,
      createdAt: agentTasks.createdAt,
      updatedAt: agentTasks.updatedAt,
      minutesSaved: agentTasks.minutesSaved,
    })
    .from(agentTasks)
    .where(and(eq(agentTasks.companyId, ctx.companyId), eq(agentTasks.agent, agent), taskSubjectScope(ctx)))
    .orderBy(desc(agentTasks.createdAt), desc(agentTasks.id))
    .limit(clamped);

  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    status: r.status,
    mode: r.mode,
    createdAt: r.createdAt,
    finishedAt: FINISHED_OR_HANDLED.includes(r.status) ? r.updatedAt : null,
    minutesSaved: r.minutesSaved === null ? null : Number(r.minutesSaved),
  }));
}

export type AgentSettingsInfo = { agent: string; pausedAt: Date | null; pausedByName: string | null; lastRunNowAt: Date | null };

/**
 * All agent_settings rows of the company with the pausing user's name (users.name via paused_by), if any.
 * The tenant role cannot read `users`, so the name comes from `company_members` (the view it can read).
 */
export async function agentSettingsInfo(tx: Tx, ctx: TenantContext): Promise<AgentSettingsInfo[]> {
  return tx
    .select({
      agent: agentSettings.agent,
      pausedAt: agentSettings.pausedAt,
      pausedByName: sql<string | null>`(select cm.name from company_members cm where cm.user_id = ${agentSettings.pausedBy} limit 1)`,
      lastRunNowAt: agentSettings.lastRunNowAt,
    })
    .from(agentSettings)
    .where(eq(agentSettings.companyId, ctx.companyId));
}

/*
 * A1 Task 21 SHELL (package B fills the body; keep name and signature).
 * Front Desk success (Ruling AX-D): finished conversations in the last 30 days and how many succeeded.
 */
export async function frontDeskConversationCounts(
  tx: Tx,
  ctx: TenantContext,
  w: MetricsWindow,
): Promise<{ finished: number; succeeded: number }> {
  let repScope = sql`true`;
  if (ctx.role === 'rep') {
    // AX-J: a rep sees conversations whose customer has a job in the rep's scope; no customer, no rep.
    const scope = jobScope(ctx);
    repScope = scope
      ? sql`${conversations.customerId} in (select ${jobs.customerId} from ${jobs}
          where ${jobs.companyId} = ${ctx.companyId} and ${scope})`
      : sql`false`;
  }
  const marker = sql`exists (select 1 from conversation_turns t where t.company_id = ${conversations.companyId}
    and t.conversation_id = ${conversations.id} and t.route = 'transfer' and 'model_failure' = any(t.guard_hits))`;
  const finishedWhere = sql`${conversations.status} <> 'active' and ${conversations.outcome} is not null
    and ${conversations.updatedAt} >= ${w.since30} and ${repScope}`;
  const rows = await tx
    .select({
      finished: sql<number>`(count(*))::int`,
      succeeded: sql<number>`(count(*) filter (where ${conversations.outcome} <> 'abandoned' and not ${marker}))::int`,
    })
    .from(conversations)
    .where(and(eq(conversations.companyId, ctx.companyId), finishedWhere));
  return { finished: Number(rows[0]?.finished ?? 0), succeeded: Number(rows[0]?.succeeded ?? 0) };
}
