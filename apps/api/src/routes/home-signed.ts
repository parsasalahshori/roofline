import { eq, sql } from 'drizzle-orm';
import { Router } from 'express';
import { companies, withTenant, type TenantContext, type Tx } from '@roofline/db';
import { localDate } from '@roofline/shared';
import type { AppDeps } from '../app.ts';

/** Used only when the company has no row to read (a company is always created with one, so this is a guard). */
const DEFAULT_TIME_ZONE = 'America/Chicago';
const WEEKS = 12;

export type SignedWeek = { weekStart: string; totalCents: number };
export type HomeSigned = {
  monthTotalCents: number;
  /** The company's monthly signing goal. Company settings have no goal yet, so this is null until they do. */
  goalCents: number | null;
  weekly: SignedWeek[];
  openPipelineCents: number;
};

const DAY_MS = 86_400_000;

/** `YYYY-MM-DD` plus `days`, with no time zone shifting. */
function addDays(date: string, days: number): string {
  return new Date(new Date(`${date}T00:00:00Z`).getTime() + days * DAY_MS).toISOString().slice(0, 10);
}

/** The Monday on or before a `YYYY-MM-DD` date. */
function mondayOf(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  return addDays(date, -((d.getUTCDay() + 6) % 7));
}

async function companyZone(tx: Tx, ctx: TenantContext): Promise<string> {
  const [row] = await tx.select({ timezone: companies.timezone }).from(companies).where(eq(companies.id, ctx.companyId)).limit(1);
  return row?.timezone ?? DEFAULT_TIME_ZONE;
}

/**
 * The home page's "Signed this month" card. Signed money is the total of the option the homeowner signed
 * (`proposal_signatures.total_cents`), counted on the company-zone calendar day it was signed. Weeks run
 * Monday to Sunday and the last of the twelve is this week. The open pipeline is every sent or viewed,
 * unsigned proposal at its lowest enabled option (the same figure the follow-up agent quotes).
 */
async function homeSigned(tx: Tx, ctx: TenantContext, now: Date): Promise<HomeSigned> {
  const zone = await companyZone(tx, ctx);
  const company = ctx.companyId;
  const today = localDate(now, zone);
  const monthStart = `${today.slice(0, 7)}-01`;
  const thisWeek = mondayOf(today);
  const weekStarts = Array.from({ length: WEEKS }, (_, i) => addDays(thisWeek, (i - (WEEKS - 1)) * 7));
  const first = weekStarts[0]!;
  const windowEnd = addDays(thisWeek, 7);

  // One row per company-zone day. The window starts on the first week's Monday, which is always before the month start.
  const days = await tx.execute(sql`
    select (s.signed_at at time zone ${zone})::date::text as day, sum(s.total_cents)::bigint as cents
    from proposal_signatures s
    join proposals p on p.company_id = s.company_id and p.id = s.proposal_id
    where s.company_id = ${company} and p.status = 'signed'
      and s.signed_at >= ((${first}::date)::timestamp at time zone ${zone})
      and s.signed_at < ((${windowEnd}::date)::timestamp at time zone ${zone})
    group by 1
  `);
  const byDay = new Map<string, number>();
  for (const row of days.rows as { day: string; cents: string | number }[]) byDay.set(row.day, Number(row.cents));

  let monthTotalCents = 0;
  const totals = new Map(weekStarts.map((w) => [w, 0]));
  for (const [day, cents] of byDay) {
    if (day >= monthStart && day <= today) monthTotalCents += cents;
    const week = mondayOf(day);
    if (totals.has(week)) totals.set(week, (totals.get(week) ?? 0) + cents);
  }

  const open = await tx.execute(sql`
    select coalesce(sum(lowest), 0)::bigint as cents from (
      select min(o.total_cents) as lowest
      from proposals p
      join proposal_options o on o.company_id = p.company_id and o.proposal_id = p.id and o.enabled
      where p.company_id = ${company} and p.status in ('sent', 'viewed') and p.signed_at is null
      group by p.id
    ) x
  `);
  const openRow = open.rows[0] as { cents: string | number } | undefined;

  return {
    monthTotalCents,
    goalCents: null,
    weekly: weekStarts.map((weekStart) => ({ weekStart, totalCents: totals.get(weekStart) ?? 0 })),
    openPipelineCents: Number(openRow?.cents ?? 0),
  };
}

/** `GET /api/home/signed`: the numbers behind the home page's "Signed this month" card. Every member may read it. */
export function homeSignedRoutes(deps: AppDeps): Router {
  const router = Router();

  router.get('/', async (req, res) => {
    const { ctx } = req;
    const body = await withTenant(deps.pools, ctx, (tx) => homeSigned(tx, ctx, deps.clock.now()));
    res.json(body);
  });

  return router;
}
