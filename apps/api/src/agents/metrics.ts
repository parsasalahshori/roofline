import { and, eq, inArray } from 'drizzle-orm';
import {
  agentCounts,
  agentTasks,
  agentSettingsInfo,
  breakdownByBaseline,
  companies,
  companySettings,
  countFrontDeskFollowUps,
  dailyFinished,
  frontDeskConversationCounts,
  minutesByAgent,
  recentTasks,
  type AgentCounts,
  type AgentSettingsInfo,
  type MetricsWindow,
  type RecentTaskRow,
  type TenantContext,
  type Tx,
} from '@roofline/db';
import {
  chartDates,
  G1_AGENTS_SHIPPED,
  isPaused,
  LAUNCH_AGENTS,
  metricsWindow,
  periodRange,
  rulesFor,
  SCREEN_AGENTS,
  successRate,
  type AgentCard,
  type AgentDetail,
  type AgentStatusView,
  type AgentsOverview,
  type BaselineBreakdownRow,
  type BaselineKey,
  type DayCount,
  type RecentTask,
  type RunNow,
  type ScreenAgent,
  type TimePeriod,
} from '@roofline/shared';
import { can } from '../permissions.ts';
import { canReview } from '../tasks/service.ts';
import { gatherRuleFacts } from './rule-facts.ts';

/*
 * A1 Task 5: the read models behind GET /api/agents and GET /api/agents/:agent.
 * Every minutes figure is a sum of step snapshots (agent_task_steps.minutes_saved, done steps only),
 * read by the repository functions in @roofline/db; nothing here recomputes minutes from baselines.
 * Periods and chart days are in the company's own time zone. The reader's role scope (AX-J) is
 * applied inside every repository call, so this module only passes `ctx` through.
 */

/** Used when the company row or its settings row is missing (a company always has both in practice). */
const DEFAULT_ZONE = 'America/Chicago';
const DEFAULT_HOURLY_RATE_CENTS = 2800;
/** Run now (spec 6): a second run is allowed five minutes after the last one. */
const RUN_NOW_GAP_MS = 5 * 60 * 1000;
/** The agent page lists this many recent tasks. */
const RECENT_LIMIT = 20;

const ZERO_COUNTS: AgentCounts = {
  finishedToday: 0,
  done30d: 0,
  partlyDone30d: 0,
  ran30d: 0,
  notApproved30d: 0,
  waitingCount: 0,
};

/** Shared by every read in one request: the company's zone and rate, the windows and the counts. */
type Snapshot = {
  now: Date;
  zone: string;
  hourlyRateCents: number;
  window: MetricsWindow;
  counts: Record<string, AgentCounts>;
  settings: Map<string, AgentSettingsInfo>;
  monthMinutes: Record<string, number>;
  frontDeskRate: { finished: number; succeeded: number };
};

async function companyFacts(tx: Tx, ctx: TenantContext): Promise<{ zone: string; hourlyRateCents: number }> {
  const companyRows = await tx
    .select({ timezone: companies.timezone })
    .from(companies)
    .where(eq(companies.id, ctx.companyId))
    .limit(1);
  const settingRows = await tx
    .select({ hourlyRateCents: companySettings.hourlyRateCents })
    .from(companySettings)
    .where(eq(companySettings.companyId, ctx.companyId))
    .limit(1);
  const company: { timezone: string } | undefined = companyRows[0];
  const settings: { hourlyRateCents: number } | undefined = settingRows[0];
  return {
    zone: company?.timezone ?? DEFAULT_ZONE,
    hourlyRateCents: settings?.hourlyRateCents ?? DEFAULT_HOURLY_RATE_CENTS,
  };
}

async function gather(tx: Tx, ctx: TenantContext, now: Date): Promise<Snapshot> {
  const { zone, hourlyRateCents } = await companyFacts(tx, ctx);
  const window: MetricsWindow = { ...metricsWindow(now, zone), now };
  const counts = await agentCounts(tx, ctx, window);
  const settingRows = await agentSettingsInfo(tx, ctx);
  const monthMinutes = await minutesByAgent(tx, ctx, periodRange(now, zone, 'month'));
  const frontDeskRate = await frontDeskConversationCounts(tx, ctx, window);
  return {
    now,
    zone,
    hourlyRateCents,
    window,
    counts,
    settings: new Map(settingRows.map((row) => [row.agent, row])),
    monthMinutes,
    frontDeskRate,
  };
}

/** Claims, Scheduler and Follow-up show "Coming soon" only while G1_AGENTS_SHIPPED is false (Ruling AX-B). */
function isComingSoon(agent: ScreenAgent): boolean {
  return !(LAUNCH_AGENTS as readonly string[]).includes(agent) && !G1_AGENTS_SHIPPED;
}

function emptyCard(agent: ScreenAgent): AgentCard {
  return {
    agent,
    status: 'coming_soon',
    finishedToday: 0,
    successRate: null,
    notApproved30d: 0,
    minutesThisMonth: 0,
    last14Days: [],
    waitingCount: 0,
  };
}

/** Paused wins over waiting; waiting means drafts or needs_attention tasks are waiting for a person. */
function statusOf(agent: ScreenAgent, settings: AgentSettingsInfo | undefined, waitingCount: number): AgentStatusView {
  if (isPaused(agent, settings === undefined ? null : { pausedAt: settings.pausedAt })) return 'paused';
  if (waitingCount > 0) return 'waiting';
  return 'on';
}

/**
 * One agent's card. `successRate` uses the task model, except Front Desk (Ruling AX-D): finished conversations
 * in the last 30 days that were not abandoned and had no model-failure hand-off, null below 5 conversations.
 * Front Desk's waitingCount also counts open follow-ups (customers it handed a message or a transfer for).
 */
async function buildCard(tx: Tx, ctx: TenantContext, snap: Snapshot, agent: ScreenAgent): Promise<AgentCard> {
  if (isComingSoon(agent)) return emptyCard(agent);
  const counts: AgentCounts = snap.counts[agent] ?? ZERO_COUNTS;
  const daily = await dailyFinished(tx, ctx, agent, snap.window);
  const finishedByDate = new Map(daily.map((day) => [day.date, day.finished]));
  const last14Days: DayCount[] = chartDates(snap.now, snap.zone).map((date) => ({
    date,
    finished: finishedByDate.get(date) ?? 0,
  }));
  const waitingCount =
    agent === 'front_desk' ? counts.waitingCount + (await countFrontDeskFollowUps(tx, ctx, snap.now)) : counts.waitingCount;
  let rate = successRate({ done: counts.done30d, partlyDone: counts.partlyDone30d, ran: counts.ran30d });
  if (agent === 'front_desk') {
    const { finished, succeeded } = snap.frontDeskRate;
    rate = finished < 5 ? null : Math.round((succeeded / finished) * 100) / 100;
  }
  return {
    agent,
    status: statusOf(agent, snap.settings.get(agent), waitingCount),
    finishedToday: counts.finishedToday,
    successRate: rate,
    notApproved30d: counts.notApproved30d,
    minutesThisMonth: snap.monthMinutes[agent] ?? 0,
    last14Days,
    waitingCount,
  };
}

/** GET /api/agents: the six cards in SCREEN_AGENTS order, the month's total and the hourly rate. */
export async function buildOverview(tx: Tx, ctx: TenantContext, now: Date): Promise<AgentsOverview> {
  const snap = await gather(tx, ctx, now);
  const cards: AgentCard[] = [];
  for (const agent of SCREEN_AGENTS) cards.push(await buildCard(tx, ctx, snap, agent));
  return {
    cards,
    minutesThisMonth: cards.reduce((sum, card) => sum + card.minutesThisMonth, 0),
    hourlyRateCents: rateFor(ctx, snap),
  };
}

function runNowOf(agent: ScreenAgent, lastRunNowAt: Date | null): RunNow {
  switch (agent) {
    case 'storm_scout':
    case 'claims':
    case 'scheduler':
    case 'follow_up':
      // The POST that starts a run is Task 7's; this only says whether one can be asked for, and when.
      return {
        kind: 'available',
        nextAllowedAt: lastRunNowAt === null ? null : new Date(lastRunNowAt.getTime() + RUN_NOW_GAP_MS).toISOString(),
      };
    case 'estimator':
      return { kind: 'works_when_asked' };
    case 'front_desk':
      return { kind: 'answers_calls' };
    default:
      return { kind: 'coming_soon' };
  }
}

/** Money figures (S-M4): only readers with view_money_totals get the hourly rate; everyone else gets null. */
function rateFor(ctx: TenantContext, snap: Snapshot): number | null {
  return can(ctx, 'view_money_totals') ? snap.hourlyRateCents : null;
}

/** Where a recent task opens: reviewers open drafts in approvals, anyone else the job, else nowhere. */
async function recentHrefs(tx: Tx, ctx: TenantContext, rows: RecentTaskRow[]): Promise<Map<string, string | null>> {
  const hrefs = new Map<string, string | null>();
  if (rows.length === 0) return hrefs;
  const subjects = await tx
    .select({ id: agentTasks.id, subjectType: agentTasks.subjectType, subjectId: agentTasks.subjectId })
    .from(agentTasks)
    .where(and(eq(agentTasks.companyId, ctx.companyId), inArray(agentTasks.id, rows.map((row) => row.id))));
  const subjectOf = new Map(subjects.map((row) => [row.id, row]));
  for (const row of rows) {
    const subject = subjectOf.get(row.id);
    const waiting = row.status === 'draft' || row.status === 'awaiting_owner';
    hrefs.set(
      row.id,
      canReview(ctx) && waiting
        ? `/approvals/${row.id}`
        : subject?.subjectType === 'job' && subject.subjectId
          ? `/jobs/${subject.subjectId}`
          : null,
    );
  }
  return hrefs;
}

function recentTaskOf(row: RecentTaskRow, href: string | null): RecentTask {
  return {
    href,
    id: row.id,
    kind: row.kind,
    status: row.status,
    mode: row.mode,
    createdAt: row.createdAt.toISOString(),
    finishedAt: row.finishedAt === null ? null : row.finishedAt.toISOString(),
    minutesSaved: row.minutesSaved,
  };
}

/** GET /api/agents/:agent?period=: the card plus the period's minutes, breakdown, rules, pause and recent tasks. */
export async function buildDetail(
  tx: Tx,
  ctx: TenantContext,
  now: Date,
  agent: ScreenAgent,
  period: TimePeriod,
): Promise<AgentDetail> {
  const snap = await gather(tx, ctx, now);
  const card = await buildCard(tx, ctx, snap, agent);
  const settings = snap.settings.get(agent);
  const paused = isPaused(agent, settings === undefined ? null : { pausedAt: settings.pausedAt });

  if (isComingSoon(agent)) {
    return {
      card,
      period,
      minutesInPeriod: 0,
      breakdown: [],
      rules: [],
      paused: null,
      runNow: { kind: 'coming_soon' },
      recentTasks: [],
      hourlyRateCents: rateFor(ctx, snap),
    };
  }

  const range = periodRange(now, snap.zone, period);
  const minutesInPeriod = (await minutesByAgent(tx, ctx, range))[agent] ?? 0;
  const breakdown: BaselineBreakdownRow[] = (await breakdownByBaseline(tx, ctx, agent, range)).map((row) => ({
    baseline: row.baseline as BaselineKey,
    units: row.units,
    minutes: row.minutes,
  }));
  const rules = rulesFor(agent, await gatherRuleFacts(tx, ctx));
  const tasks = await recentTasks(tx, ctx, agent, RECENT_LIMIT);
  const hrefs = await recentHrefs(tx, ctx, tasks);

  return {
    card,
    period,
    minutesInPeriod,
    breakdown,
    rules,
    paused: !paused ? null : { at: (settings?.pausedAt ?? now).toISOString(), byName: settings?.pausedByName ?? null },
    runNow: runNowOf(agent, settings?.lastRunNowAt ?? null),
    recentTasks: tasks.map((row) => recentTaskOf(row, hrefs.get(row.id) ?? null)),
    hourlyRateCents: rateFor(ctx, snap),
  };
}
