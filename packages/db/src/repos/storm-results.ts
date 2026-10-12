import { sql } from 'drizzle-orm';
import type { TenantContext, Tx } from '../tenant.ts';

/** Raw counts for one company storm's plan. `replyBodies` lets the caller decide which replies are YES. */
export type StormResultCounts = {
  textsSent: number;
  textsDelivered: number;
  replyBodies: string[];
  emailsSent: number;
  unsubscribes: number;
  doorsKnocked: number;
  wantsCheck: number;
  adSpendCents: number;
  adMaxCents: number;
  adClicks: number;
  landingRequests: number;
  inspectionsBooked: number;
};

const ZERO: StormResultCounts = {
  textsSent: 0,
  textsDelivered: 0,
  replyBodies: [],
  emailsSent: 0,
  unsubscribes: 0,
  doorsKnocked: 0,
  wantsCheck: 0,
  adSpendCents: 0,
  adMaxCents: 0,
  adClicks: 0,
  landingRequests: 0,
  inspectionsBooked: 0,
};

type Row = Record<string, unknown>;
const rowsOf = (r: unknown): Row[] => ((r as { rows?: Row[] }).rows ?? (r as Row[])) as Row[];
const num = (v: unknown): number => Number(v ?? 0);

/**
 * What a storm's plan did, counted from the company's own rows. Every query filters on the company id as
 * well as relying on row-level security. All zeros (and no replies) when the storm has no plan.
 *
 * Replies: an inbound text counts when it came within 14 days after the customer's first plan text and before
 * the customer's next storm text from a different plan.
 *
 * Unsubscribes: email_opt_outs rows carry no message id, so an opt-out counts when its address is one a
 * plan email went to and it was recorded at or after that email was sent.
 */
export async function stormResultCounts(tx: Tx, ctx: TenantContext, companyStormId: string): Promise<StormResultCounts> {
  const cid = ctx.companyId;
  const plan = rowsOf(
    await tx.execute(sql`
      select cs.storm_id::text as storm_id, cs.plan_task_id::text as task_id, t.created_at as task_created_at
      from company_storms cs
      join agent_tasks t on t.company_id = cs.company_id and t.id = cs.plan_task_id
      where cs.company_id = ${cid}::uuid and cs.id = ${companyStormId}::uuid
    `),
  )[0];
  if (plan === undefined) return { ...ZERO, replyBodies: [] };
  const taskId = String(plan.task_id);
  const stormId = String(plan.storm_id);

  const texts = rowsOf(
    await tx.execute(sql`
      select
        count(*) filter (where m.status in ('sent','delivered'))::int as sent,
        count(*) filter (where m.status = 'delivered')::int as delivered
      from messages m
      join agent_task_steps s on s.company_id = m.company_id and s.id = m.step_id
      where m.company_id = ${cid}::uuid and s.task_id = ${taskId}::uuid and s.type = 'send_sms_batch'
        and m.channel = 'sms' and m.direction = 'out'
    `),
  )[0]!;

  const replies = rowsOf(
    await tx.execute(sql`
      with plan_texts as (
        select m.customer_id, min(coalesce(m.sent_at, m.created_at)) as first_at
        from messages m
        join agent_task_steps s on s.company_id = m.company_id and s.id = m.step_id
        where m.company_id = ${cid}::uuid and s.task_id = ${taskId}::uuid and s.type = 'send_sms_batch'
          and m.channel = 'sms' and m.direction = 'out' and m.status in ('sent','delivered')
          and m.customer_id is not null
        group by m.customer_id
      )
      select r.body
      from messages r
      join plan_texts p on p.customer_id = r.customer_id
      where r.company_id = ${cid}::uuid and r.channel = 'sms' and r.direction = 'in' and r.created_at > p.first_at
        and r.created_at <= p.first_at + interval '14 days'
        and not exists (
          select 1
          from messages n
          join agent_task_steps ns on ns.company_id = n.company_id and ns.id = n.step_id
          join agent_tasks nt on nt.company_id = ns.company_id and nt.id = ns.task_id
          where n.company_id = ${cid}::uuid and n.customer_id = r.customer_id
            and n.channel = 'sms' and n.direction = 'out' and n.status in ('sent','delivered')
            and ns.type = 'send_sms_batch' and nt.kind = 'storm_plan' and ns.task_id <> ${taskId}::uuid
            and coalesce(n.sent_at, n.created_at) > p.first_at
            and coalesce(n.sent_at, n.created_at) < r.created_at
        )
    `),
  );

  const emails = rowsOf(
    await tx.execute(sql`
      with plan_emails as (
        select m.to_email, min(coalesce(m.sent_at, m.created_at)) as first_at
        from messages m
        join agent_task_steps s on s.company_id = m.company_id and s.id = m.step_id
        where m.company_id = ${cid}::uuid and s.task_id = ${taskId}::uuid and s.type = 'send_email_batch'
          and m.channel = 'email' and m.direction = 'out' and m.status in ('sent','delivered')
        group by m.to_email
      )
      select
        (select coalesce(sum(1), 0) from messages m join agent_task_steps s on s.company_id = m.company_id and s.id = m.step_id
          where m.company_id = ${cid}::uuid and s.task_id = ${taskId}::uuid and s.type = 'send_email_batch'
            and m.channel = 'email' and m.direction = 'out' and m.status in ('sent','delivered'))::int as sent,
        (select count(*) from email_opt_outs o join plan_emails e on e.to_email = o.email
          where o.company_id = ${cid}::uuid and o.at >= e.first_at)::int as unsubs
    `),
  )[0]!;

  const doors = rowsOf(
    await tx.execute(sql`
      select
        count(*) filter (where d.outcome is not null)::int as knocked,
        count(*) filter (where d.outcome = 'wants_check')::int as wants
      from door_stops d
      join door_routes r on r.company_id = d.company_id and r.id = d.route_id
      where d.company_id = ${cid}::uuid and r.company_storm_id = ${companyStormId}::uuid
    `),
  )[0]!;

  const ads = rowsOf(
    await tx.execute(sql`
      select coalesce(sum(spend_cents), 0)::int as spend, coalesce(sum(max_spend_cents), 0)::int as max_spend,
             coalesce(sum(clicks), 0)::int as clicks
      from ad_campaigns
      where company_id = ${cid}::uuid and company_storm_id = ${companyStormId}::uuid
    `),
  )[0]!;

  const landing = rowsOf(
    await tx.execute(sql`
      select count(*)::int as n
      from storm_requests q
      join storm_pages p on p.company_id = q.company_id and p.id = q.storm_page_id
      where q.company_id = ${cid}::uuid and p.company_storm_id = ${companyStormId}::uuid
    `),
  )[0]!;

  const inspections = rowsOf(
    await tx.execute(sql`
      select count(*)::int as n
      from appointments a
      join jobs j on j.company_id = a.company_id and j.id = a.job_id
      where a.company_id = ${cid}::uuid and a.kind = 'inspection' and j.storm_id = ${stormId}::uuid
        and a.created_at >= ${plan.task_created_at as Date}
    `),
  )[0]!;

  return {
    textsSent: num(texts.sent),
    textsDelivered: num(texts.delivered),
    replyBodies: replies.map((r) => String(r.body)),
    emailsSent: num(emails.sent),
    unsubscribes: num(emails.unsubs),
    doorsKnocked: num(doors.knocked),
    wantsCheck: num(doors.wants),
    adSpendCents: num(ads.spend),
    adMaxCents: num(ads.max_spend),
    adClicks: num(ads.clicks),
    landingRequests: num(landing.n),
    inspectionsBooked: num(inspections.n),
  };
}
