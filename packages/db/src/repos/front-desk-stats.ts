import { eq, sql } from 'drizzle-orm';
import type { FrontDeskDayStats, FrontDeskWeekStats } from '@roofline/shared';
import { companies } from '../schema/index.ts';
import type { TenantContext, Tx } from '../tenant.ts';

/*
 * The Front Desk window's weekly numbers (D1 Task 18). A week is Monday 00:00 to the next Monday
 * 00:00 in the company's time zone. Forwarding-test calls (the test caller number) count nowhere.
 * Every query filters by the context's company on top of RLS.
 */

/** The company's time zone and plan key, for the stats route. */
export async function frontDeskStatsCompany(tx: Tx, ctx: TenantContext): Promise<{ timeZone: string; planKey: string | null }> {
  const [row] = await tx
    .select({ timeZone: companies.timezone, planKey: companies.planKey })
    .from(companies)
    .where(eq(companies.id, ctx.companyId))
    .limit(1);
  if (!row) throw new Error(`frontDeskStatsCompany: no company row for ${ctx.companyId}`);
  return row;
}

type StatsRow = {
  answered: number;
  booked: number;
  transferred: number;
  messages: number;
  spam: number;
  first_reply_ms_p50: number | null;
  guard_blocks: number;
  ai_seconds: number;
};

/**
 * The week's numbers. `aiMinutesIncluded` is always null here: the plan's allowance lives in the
 * billing config, so the route fills it in. `testCallerE164` marks the forwarding-test calls to leave out.
 */
export async function frontDeskWeekStats(
  tx: Tx,
  ctx: TenantContext,
  weekStart: string,
  timeZone: string,
  testCallerE164: string | null = null,
): Promise<FrontDeskWeekStats> {
  const company = ctx.companyId;
  // Local midnight of the Monday, and of the next Monday, as instants.
  const start = sql`((${weekStart}::date)::timestamp at time zone ${timeZone})`;
  const end = sql`(((${weekStart}::date + 7))::timestamp at time zone ${timeZone})`;
  const notTest = testCallerE164 === null ? sql`true` : sql`c.from_e164 <> ${testCallerE164}`;

  const result = await tx.execute(sql`
    with
    week_calls as (
      select c.* from calls c
      where c.company_id = ${company} and c.started_at >= ${start} and c.started_at < ${end} and ${notTest}
    ),
    week_convs as (
      select v.* from conversations v
      where v.company_id = ${company} and v.created_at >= ${start} and v.created_at < ${end}
    ),
    first_in as (
      select m.conversation_id, min(m.created_at) as at
      from messages m
      where m.company_id = ${company} and m.direction = 'in' and m.channel in ('sms', 'mms')
        and m.conversation_id is not null and m.created_at >= ${start} and m.created_at < ${end}
      group by m.conversation_id
    ),
    reply_gap as (
      select extract(epoch from (
        (select min(o.created_at) from messages o
          where o.company_id = ${company} and o.conversation_id = f.conversation_id
            and o.direction = 'out' and o.created_at > f.at) - f.at
      )) * 1000 as ms
      from first_in f
    )
    select
      (select count(*)::int from week_calls
        where status not in ('rejected', 'failed', 'ringing') and spam_reason is null) as answered,
      (select count(*)::int from week_convs where outcome = 'booked') as booked,
      (select count(*)::int from week_calls where transfer_result = 'answered') as transferred,
      (select count(*)::int from first_in f join conversations v on v.company_id = ${company} and v.id = f.conversation_id
        where v.channel = 'sms') as messages,
      (select count(*)::int from week_calls where spam_reason is not null)
        + (select count(*)::int from week_convs v
            where v.outcome = 'spam'
              and not exists (select 1 from calls k where k.company_id = ${company} and k.conversation_id = v.id and k.spam_reason is not null)) as spam,
      (select round(percentile_cont(0.5) within group (order by ms))::int from reply_gap where ms is not null) as first_reply_ms_p50,
      (select count(*)::int from conversation_turns t
        where t.company_id = ${company} and t.at >= ${start} and t.at < ${end} and cardinality(t.guard_hits) > 0) as guard_blocks,
      (select coalesce(sum(ai_seconds), 0)::int from week_calls) as ai_seconds
  `);
  const row = result.rows[0] as StatsRow | undefined;
  if (!row) throw new Error('frontDeskWeekStats: the stats query returned no row.');
  return {
    weekStart,
    answered: row.answered,
    booked: row.booked,
    transferred: row.transferred,
    messages: row.messages,
    spam: row.spam,
    firstReplyMsP50: row.first_reply_ms_p50 === null ? null : Number(row.first_reply_ms_p50),
    guardBlocks: row.guard_blocks,
    aiMinutesUsed: Math.round((row.ai_seconds / 60) * 10) / 10,
    aiMinutesIncluded: null,
  };
}

/** The office is open Monday to Friday, 08:00 to 17:00 company time. A call outside that is after hours. */
export const OFFICE_OPENS_HOUR = 8;
export const OFFICE_CLOSES_HOUR = 17;

type DayRow = {
  calls_today: number;
  picked_up: number;
  booked: number;
  escalated: number;
  avg_answer_ms: number | null;
  after_hours: number;
};

/**
 * Today's numbers, from the calls and conversations tables, for the company's local calendar day `day` (YYYY-MM-DD).
 * `answeredPct` is the share of the day's calls that were not rejected, failed or still ringing; spam counts as
 * picked up (the assistant answers it, then blocks it). Forwarding-test calls count nowhere.
 * The answer time is each call's start to when the assistant came on the line: the call's own `ai_started_at`, else the
 * time of its first assistant turn, so a call recorded without the first still counts. `tabCounts` is filled by the caller.
 */
export async function frontDeskDayStats(
  tx: Tx,
  ctx: TenantContext,
  day: string,
  timeZone: string,
  testCallerE164: string | null = null,
): Promise<Omit<FrontDeskDayStats, 'tabCounts'>> {
  const company = ctx.companyId;
  const start = sql`((${day}::date)::timestamp at time zone ${timeZone})`;
  const end = sql`(((${day}::date + 1))::timestamp at time zone ${timeZone})`;
  const notTest = testCallerE164 === null ? sql`true` : sql`c.from_e164 <> ${testCallerE164}`;
  const result = await tx.execute(sql`
    with
    day_calls as (
      select c.* from calls c
      where c.company_id = ${company} and c.started_at >= ${start} and c.started_at < ${end} and ${notTest}
    ),
    day_convs as (
      select v.* from conversations v
      where v.company_id = ${company} and v.created_at >= ${start} and v.created_at < ${end}
    )
    select
      (select count(*)::int from day_calls) as calls_today,
      (select count(*)::int from day_calls where status not in ('rejected', 'failed', 'ringing')) as picked_up,
      (select count(*)::int from day_convs where outcome = 'booked') as booked,
      (select count(*)::int from day_calls where transfer_result in ('answered', 'no_answer') or status = 'transferred') as escalated,
      (select round(avg(g.ms))::int from (
          select greatest(0, extract(epoch from (
            coalesce(k.ai_started_at, (select min(t.at) from conversation_turns t
              where t.company_id = ${company} and t.call_id = k.id and t.speaker = 'assistant')) - k.started_at
          )) * 1000) as ms
          from day_calls k
        ) g where g.ms is not null) as avg_answer_ms,
      (select count(*)::int from day_calls k
        where extract(isodow from (k.started_at at time zone ${timeZone})) > 5
           or extract(hour from (k.started_at at time zone ${timeZone})) < ${OFFICE_OPENS_HOUR}
           or extract(hour from (k.started_at at time zone ${timeZone})) >= ${OFFICE_CLOSES_HOUR}) as after_hours
  `);
  const row = result.rows[0] as DayRow | undefined;
  if (!row) throw new Error('frontDeskDayStats: the stats query returned no row.');
  return {
    day,
    callsToday: row.calls_today,
    answeredPct: row.calls_today === 0 ? null : Math.round((row.picked_up / row.calls_today) * 100),
    booked: row.booked,
    escalated: row.escalated,
    avgAnswerMs: row.avg_answer_ms === null ? null : Number(row.avg_answer_ms),
    inspectionsBooked: row.booked,
    afterHours: row.after_hours,
  };
}
