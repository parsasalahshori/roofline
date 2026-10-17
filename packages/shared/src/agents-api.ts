/*
 * Agents screen (A1) API contract: the JSON shapes of /api/agents/*, shared by the API (Tasks 5-7) and the
 * web app (Tasks 9-12). Types only. Every minutes figure is a sum of stored step snapshots
 * (agent_task_steps.minutes_saved); the web formats it with `hoursLabel` / `moneyLabel` and adds "(estimate)".
 */
import type { BaselineKey } from './agents.ts';
import type { RuleSentence } from './agent-rules.ts';
import type { Agent } from './enums.ts';

/** The agents the screen shows (every agent except `system`), in card order. */
export const SCREEN_AGENTS = ['storm_scout', 'estimator', 'front_desk', 'claims', 'scheduler', 'follow_up'] as const;
export type ScreenAgent = (typeof SCREEN_AGENTS)[number];

/** The launch agents; the other three are G1's and show "Coming soon" until `G1_AGENTS_SHIPPED`. */
export const LAUNCH_AGENTS = ['storm_scout', 'estimator', 'front_desk'] as const satisfies readonly ScreenAgent[];

export function isScreenAgent(value: unknown): value is ScreenAgent {
  return typeof value === 'string' && (SCREEN_AGENTS as readonly string[]).includes(value);
}

/** Card status (spec 4). Mirrors `AGENT_STATUSES_VIEW` in packages/db/src/schema/enums.ts. */
export type AgentStatusView = 'on' | 'paused' | 'waiting' | 'coming_soon';

/** The periods time saved is shown for (spec 3.3), in the company's time zone. */
export const TIME_PERIODS = ['today', 'week', 'month', 'last90'] as const;
export type TimePeriod = (typeof TIME_PERIODS)[number];

/** One day of the 14-day mini chart: `date` is YYYY-MM-DD in the company's time zone; oldest first. */
export type DayCount = { date: string; finished: number };

/** GET /api/agents: one card. Coming-soon cards carry zeros, an empty series and `successRate: null`. */
export type AgentCard = {
  agent: ScreenAgent;
  status: AgentStatusView;
  /** Tasks that reached done or partly_done today. */
  finishedToday: number;
  /** `successRate` over the last 30 days; null below 5 finished runs ("Not enough runs yet"). 0-1. */
  successRate: number | null;
  /** Declined and expired drafts over the last 30 days, shown apart as "Not approved". */
  notApproved30d: number;
  /** Sum of step snapshots this month. */
  minutesThisMonth: number;
  /** 14 entries, oldest first, ending today. */
  last14Days: DayCount[];
  /** Drafts waiting for approval plus needs_attention tasks (role-scoped). */
  waitingCount: number;
};

/** GET /api/agents: the window. Totals are role-scoped: reps see only their jobs' work. */
export type AgentsOverview = {
  cards: AgentCard[];
  /** All agents together, this month. */
  minutesThisMonth: number;
  /** company_settings.hourly_rate_cents (default 2800); null unless the reader has view_money_totals (the web hides money then). */
  hourlyRateCents: number | null;
};

/** "Run now" (spec 6): only Storm Scout (and G1's agents later) can run on request. */
export type RunNow =
  | { kind: 'available'; nextAllowedAt: string | null }
  | { kind: 'works_when_asked' }
  | { kind: 'answers_calls' }
  | { kind: 'coming_soon' };

/** One row of the time breakdown by baseline: sums of done-step snapshots with that baseline_key. */
export type BaselineBreakdownRow = { baseline: BaselineKey; units: number; minutes: number };

/** One recent task on the agent page; `href` opens it (F2 review for drafts, else the approvals view). */
export type RecentTask = {
  id: string;
  kind: string;
  /** What the task is about, in words ("Booked an inspection at 1105 Main St"), so rows of one kind can be told apart. */
  title: string;
  status: string;
  mode: 'needs_approval' | 'live';
  createdAt: string;
  finishedAt: string | null;
  minutesSaved: number | null;
  /** Server-built like the feed's href: /approvals/<id> for reviewers, else the job, else null (plain row). */
  href: string | null;
};

/** GET /api/agents/:agent?period=today|week|month|last90 (default month). */
export type AgentDetail = {
  card: AgentCard;
  period: TimePeriod;
  /** Sum of step snapshots in the period. */
  minutesInPeriod: number;
  breakdown: BaselineBreakdownRow[];
  rules: RuleSentence[];
  paused: { at: string; byName: string | null } | null;
  runNow: RunNow;
  recentTasks: RecentTask[];
  /** null unless the reader has view_money_totals (the web hides money then). */
  hourlyRateCents: number | null;
};

/** PUT /api/agents/:agent/paused (owner). */
export type PauseBody = { paused: boolean };

/** Response of PUT /api/agents/:agent/paused. */
export type PauseResult = { paused: boolean; pausedAt: string | null };

/** POST /api/agents/:agent/run: 202 with the next allowed time; 409 with a plain sentence otherwise. */
export type RunNowResult = { started: true; nextAllowedAt: string };

/** One feed row (GET /api/agents/feed?agent=&cursor=). `text` is the plain sentence built server-side. */
export type FeedItem = {
  id: string;
  agent: Agent;
  kind: string;
  text: string;
  at: string;
  /** Where the row links: the task review, a job, or null. */
  href: string | null;
};

export type FeedPage = { items: FeedItem[]; nextCursor: string | null };

/** Who a waiting row is waiting on (spec 7). `you` = the reader. */
export type WaitingOn = { kind: 'you' } | { kind: 'office' } | { kind: 'person'; name: string };

/** GET /api/agents/waiting: one row. */
export type WaitingItem = {
  id: string;
  agent: Agent;
  kind: 'draft' | 'attention' | 'front_desk_follow_up';
  text: string;
  since: string;
  waitingOn: WaitingOn;
  href: string | null;
};

export type WaitingList = { items: WaitingItem[] };

/** GET /api/agents/time-baselines: one visible baseline row. */
export type TimeBaselineRow = {
  key: BaselineKey;
  unit: string;
  basis: string;
  defaultMinutes: number;
  /** The company's number (its override, else the default). */
  minutes: number;
  capMinutes: number | null;
  perCallLength: boolean;
};

export type TimeBaselines = { rows: TimeBaselineRow[]; canEdit: boolean; hourlyRateCents: number };

/** PUT /api/agents/time-baselines (owner): minutes 0-600 in 0.5 steps; null resets a key to its default. */
export type TimeBaselinesBody = { minutes: Partial<Record<BaselineKey, number | null>> };

/** POST /api/agents/time-baselines/recount[?dryRun=1] (owner): the last 90 days, before and after. */
export type RecountResult = { dryRun: boolean; from: string; to: string; beforeMinutes: number; afterMinutes: number; steps: number };
