import { sql } from 'drizzle-orm';
import type { Tx } from '../tenant.ts';

/*
 * Storm alerts and the settle trigger (S1 Task 10). SHELL: the bodies arrive in Package 1; other
 * packages import these names and types. Every function runs inside `withTenant`.
 */

/** A member who gets the storm alert email. */
export type AlertRecipient = { email: string; name: string };

/** What the alert emails say about one company storm. */
export type AlertFacts = {
  id: string;
  stormId: string;
  maxIn: number;
  customersHit: number;
  homesHit: number;
  planTaskId: string | null;
  /** storms.place_name, like 'Omaha, NE'; null before it is reverse-geocoded. */
  placeName: string | null;
};

/** One company storm with what shouldDraft needs. */
export type SettleCandidate = {
  companyStormId: string;
  status: 'new' | 'planned' | 'dismissed';
  planTaskId: string | null;
  /** 'draft' when the plan task's status is 'draft', 'other' for any other status, null with no plan. */
  planStatus: 'draft' | 'other' | null;
  stormStatus: 'provisional' | 'final';
  lastGrewAt: Date;
};

/** Claims the one "now" alert: sets alerted_at = now where it is null. True only for the call that set it. */
export async function claimNowAlert(tx: Tx, companyStormId: string, now: Date): Promise<boolean> {
  const result = await tx.execute(sql`
    update company_storms set alerted_at = ${now}, updated_at = ${now}
    where id = ${companyStormId}::uuid and alerted_at is null
    returning id
  `);
  return result.rows.length > 0;
}

/** Active owner and office members whose storm_alert_email is true, ordered by email. */
export async function listAlertRecipients(tx: Tx): Promise<AlertRecipient[]> {
  const result = await tx.execute(sql`
    select email, name from company_members
    where status = 'active' and role in ('owner', 'office') and storm_alert_email = true
    order by email
  `);
  return (result.rows as { email: string; name: string }[]).map((r) => ({ email: r.email, name: r.name }));
}

/** The company storm joined to its storm, or null when it is not the company's. */
export async function getAlertFacts(tx: Tx, companyStormId: string): Promise<AlertFacts | null> {
  const result = await tx.execute(sql`
    select cs.id, cs.storm_id, cs.max_in::float8 as max_in, cs.customers_hit, cs.homes_hit,
           cs.plan_task_id, s.place_name
    from company_storms cs
    join storms s on s.id = cs.storm_id
    where cs.id = ${companyStormId}::uuid
  `);
  const r = result.rows[0] as
    | {
        id: string;
        storm_id: string;
        max_in: number | string;
        customers_hit: number | string;
        homes_hit: number | string;
        plan_task_id: string | null;
        place_name: string | null;
      }
    | undefined;
  if (!r) return null;
  return {
    id: r.id,
    stormId: r.storm_id,
    maxIn: Number(r.max_in),
    customersHit: Number(r.customers_hit),
    homesHit: Number(r.homes_hit),
    planTaskId: r.plan_task_id,
    placeName: r.place_name,
  };
}

/** The company's storms whose convective day is one of `days` ('YYYY-MM-DD'), not dismissed, with the plan's status. */
export async function listSettleCandidates(tx: Tx, days: string[]): Promise<SettleCandidate[]> {
  if (days.length === 0) return [];
  const dayList = sql.join(
    days.map((d) => sql`${d}::date`),
    sql`, `,
  );
  const result = await tx.execute(sql`
    select cs.id as company_storm_id, cs.status, cs.plan_task_id,
           case when t.id is null then null when t.status = 'draft' then 'draft' else 'other' end as plan_status,
           s.status as storm_status, s.last_grew_at
    from company_storms cs
    join storms s on s.id = cs.storm_id
    left join agent_tasks t on t.id = cs.plan_task_id and t.company_id = cs.company_id
    where s.convective_day in (${dayList})
      and cs.status <> 'dismissed'
    order by s.convective_day desc, cs.id
  `);
  return (
    result.rows as {
      company_storm_id: string;
      status: SettleCandidate['status'];
      plan_task_id: string | null;
      plan_status: SettleCandidate['planStatus'];
      storm_status: SettleCandidate['stormStatus'];
      last_grew_at: Date | string;
    }[]
  ).map((r) => ({
    companyStormId: r.company_storm_id,
    status: r.status,
    planTaskId: r.plan_task_id,
    planStatus: r.plan_status,
    stormStatus: r.storm_status,
    lastGrewAt: new Date(r.last_grew_at),
  }));
}
