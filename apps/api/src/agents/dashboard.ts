import { sql } from 'drizzle-orm';
import {
  agentCounts,
  listFeedPage,
  minutesByAgent,
  taskSubjectScope,
  type TenantContext,
  type Tx,
} from '@roofline/db';
import { isScreenAgent, metricsWindow, periodRange, SCREEN_AGENTS, type ScreenAgent } from '@roofline/shared';
import { can } from '../permissions.ts';
import { canReview } from '../tasks/service.ts';
import { feedSentence } from './feed-text.ts';
import { companyFacts } from './metrics.ts';

/*
 * GET /api/agents/dashboard: the numbers behind the Agents dashboard (tiles, roof diagram, card footers).
 * Everything is read from the same tables as the overview: finished tasks, done-step minute snapshots, the
 * event feed. Nothing is invented. A "handoff" is one job that two different agents worked on, one after
 * the other, today (the second agent's task starts after the first agent's). Reps see only their own jobs.
 * The web app has a matching type in features/agents/api.ts.
 */

/** Hours the sparkline covers, oldest first. */
export const HOURLY_BUCKETS = 12;
/** Handoff tags the diagram can show (the count above it covers all of them). */
const TAG_LIMIT = 6;

export type DashboardHandoff = { from: ScreenAgent; to: ScreenAgent; label: string; at: string };
export type DashboardAgent = {
  agent: ScreenAgent;
  minutesThisWeek: number;
  latest: { text: string; at: string; href: string | null } | null;
};
export type AgentsDashboard = {
  tasksToday: number;
  minutesThisWeek: number;
  /** null unless the reader has view_money_totals. */
  hourlyRateCents: number | null;
  /** Finished tasks per hour for the last 12 hours, oldest first; the last entry is the hour ending now. */
  tasksPerHour: number[];
  handoffsToday: number;
  /** Newest first. */
  handoffs: DashboardHandoff[];
  agents: DashboardAgent[];
};

async function finishedPerHour(tx: Tx, ctx: TenantContext, now: Date): Promise<number[]> {
  const scope = taskSubjectScope(ctx);
  const result = await tx.execute(sql`
    select floor(extract(epoch from (${now}::timestamptz - agent_tasks.updated_at)) / 3600)::int as hours_ago, count(*)::int as n
      from agent_tasks
     where agent_tasks.company_id = ${ctx.companyId}
       and agent_tasks.agent <> 'system'
       and agent_tasks.status in ('done', 'partly_done')
       and exists (select 1 from agent_task_steps s where s.task_id = agent_tasks.id and s.company_id = ${ctx.companyId} and s.status = 'done')
       and agent_tasks.updated_at > ${now}::timestamptz - make_interval(hours => ${HOURLY_BUCKETS})
       and agent_tasks.updated_at <= ${now}::timestamptz
       ${scope ? sql`and ${scope}` : sql``}
     group by 1`);
  const out = new Array<number>(HOURLY_BUCKETS).fill(0);
  for (const row of result.rows) {
    const ago = Number(row.hours_ago);
    if (ago >= 0 && ago < HOURLY_BUCKETS) out[HOURLY_BUCKETS - 1 - ago] = Number(row.n);
  }
  return out;
}

/** Jobs touched by two different agents today: each change of agent, in time order, is one handoff. */
async function handoffsToday(
  tx: Tx,
  ctx: TenantContext,
  window: { from: Date; to: Date },
): Promise<{ total: number; tags: DashboardHandoff[] }> {
  const scope = taskSubjectScope(ctx);
  const result = await tx.execute(sql`
    with ordered as (
      select agent_tasks.agent, agent_tasks.subject_id, agent_tasks.created_at,
             lag(agent_tasks.agent) over w as prev_agent
        from agent_tasks
       where agent_tasks.company_id = ${ctx.companyId}
         and agent_tasks.agent <> 'system'
         and agent_tasks.subject_type = 'job'
         and agent_tasks.subject_id is not null
         and agent_tasks.status not in ('declined', 'expired')
         and agent_tasks.created_at >= ${window.from}::timestamptz
         and agent_tasks.created_at < ${window.to}::timestamptz
         ${scope ? sql`and ${scope}` : sql``}
      window w as (partition by agent_tasks.subject_id order by agent_tasks.created_at, agent_tasks.id)
    )
    select o.prev_agent as from_agent, o.agent as to_agent, o.created_at as at,
           (select p.address_line from jobs j join properties p on p.company_id = j.company_id and p.id = j.property_id
             where j.company_id = ${ctx.companyId} and j.id = o.subject_id) as address,
           count(*) over ()::int as total
      from ordered o
     where o.prev_agent is not null and o.prev_agent <> o.agent
     order by o.created_at desc
     limit ${TAG_LIMIT}`);
  const tags: DashboardHandoff[] = [];
  let total = 0;
  for (const row of result.rows) {
    total = Number(row.total);
    const from = String(row.from_agent);
    const to = String(row.to_agent);
    if (!isScreenAgent(from) || !isScreenAgent(to) || row.address === null) continue;
    tags.push({ from, to, label: String(row.address), at: new Date(row.at as string | Date).toISOString() });
  }
  return { total, tags };
}

export async function buildDashboard(tx: Tx, ctx: TenantContext, now: Date): Promise<AgentsDashboard> {
  const { zone, hourlyRateCents } = await companyFacts(tx, ctx);
  const today = metricsWindow(now, zone);
  const counts = await agentCounts(tx, ctx, { ...today, now });
  const week = await minutesByAgent(tx, ctx, periodRange(now, zone, 'week'));
  const agents: DashboardAgent[] = [];
  for (const agent of SCREEN_AGENTS) {
    const [row] = await listFeedPage(tx, ctx, { agent, limit: 1 });
    agents.push({
      agent,
      minutesThisWeek: week[agent] ?? 0,
      latest: row
        ? {
            text: feedSentence(row),
            at: row.at.toISOString(),
            href:
              canReview(ctx) && (row.taskStatus === 'draft' || row.taskStatus === 'awaiting_owner')
                ? `/approvals/${row.taskId}`
                : row.subjectType === 'job' && row.subjectId !== null
                  ? `/jobs/${row.subjectId}`
                  : null,
          }
        : null,
    });
  }
  const handoffs = await handoffsToday(tx, ctx, { from: today.todayStart, to: today.tomorrowStart });
  return {
    tasksToday: SCREEN_AGENTS.reduce((sum, agent) => sum + (counts[agent]?.finishedToday ?? 0), 0),
    minutesThisWeek: agents.reduce((sum, a) => sum + a.minutesThisWeek, 0),
    hourlyRateCents: can(ctx, 'view_money_totals') ? hourlyRateCents : null,
    tasksPerHour: await finishedPerHour(tx, ctx, now),
    handoffsToday: handoffs.total,
    handoffs: handoffs.tags,
    agents,
  };
}
