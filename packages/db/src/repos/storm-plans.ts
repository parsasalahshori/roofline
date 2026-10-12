import { sql } from 'drizzle-orm';
import { hailLabel, type CampaignStatus, type TaskStatus } from '@roofline/shared';
import type { TenantContext, Tx } from '../tenant.ts';

/*
 * Data access for drafting a storm plan (S1 Task 11). The types below are the contract with
 * apps/api/src/storm/plan.ts. Everything runs inside `withTenant`; each query also names the company.
 */

/** Everything plan.ts needs about one company storm and its company, read in one transaction. */
export type StormPlanFacts = {
  companyStormId: string;
  stormId: string;
  status: 'new' | 'planned' | 'dismissed';
  maxIn: number;
  homesHit: number;
  customersHit: number;
  /** storms.place_name; null before it is reverse-geocoded. */
  placeName: string | null;
  /** storms.convective_day, 'YYYY-MM-DD'. */
  convectiveDay: string;
  /** company_storms.plan_task_id and that task's status; both null with no plan. */
  planTaskId: string | null;
  planStatus: TaskStatus | null;
  company: { name: string; timezone: string; address: string | null };
  settings: {
    smsTemplate: string | null;
    emailEnabled: boolean;
    emailSubject: string | null;
    emailTemplate: string | null;
    adBudgetCents: number;
    adDays: number;
    adGoogleSharePct: number;
  };
  /** texting_registrations.campaign_status; 'none' with no registration. */
  campaignStatus: CampaignStatus;
  /** Whether the company has an ad_accounts row with status 'active' for the platform. */
  adActive: { google: boolean; meta: boolean };
  /** The newest storm_photos id, or null. */
  newestPhotoId: string | null;
  /** Active reps (memberships.role = 'rep'), oldest membership first; the active owner when there are none. */
  repUserIds: string[];
};

export async function loadStormPlanFacts(tx: Tx, ctx: TenantContext, companyStormId: string): Promise<StormPlanFacts | null> {
  const result = await tx.execute(sql`
    select cs.id, cs.storm_id, cs.status, cs.max_in::float8 as max_in, cs.homes_hit, cs.customers_hit,
           s.place_name, s.convective_day::text as convective_day, cs.plan_task_id, t.status as plan_status,
           c.name as company_name, c.timezone, c.address_street, c.address_city, c.address_state, c.address_zip,
           st.storm_sms_template, st.storm_email_enabled, st.storm_email_subject, st.storm_email_template,
           st.storm_ad_budget_cents, st.storm_ad_days, st.storm_ad_google_share_pct,
           tr.campaign_status,
           exists (select 1 from ad_accounts a where a.company_id = cs.company_id and a.platform = 'google' and a.status = 'active') as google_active,
           exists (select 1 from ad_accounts a where a.company_id = cs.company_id and a.platform = 'meta' and a.status = 'active') as meta_active,
           (select p.id::text from storm_photos p where p.company_id = cs.company_id order by p.created_at desc, p.id desc limit 1) as newest_photo_id
    from company_storms cs
    join storms s on s.id = cs.storm_id
    join companies c on c.id = cs.company_id
    left join agent_tasks t on t.id = cs.plan_task_id and t.company_id = cs.company_id
    left join company_settings st on st.company_id = cs.company_id
    left join texting_registrations tr on tr.company_id = cs.company_id
    where cs.id = ${companyStormId}::uuid and cs.company_id = ${ctx.companyId}::uuid
  `);
  const r = result.rows[0] as
    | {
        id: string;
        storm_id: string;
        status: StormPlanFacts['status'];
        max_in: number | string;
        homes_hit: number | string;
        customers_hit: number | string;
        place_name: string | null;
        convective_day: string;
        plan_task_id: string | null;
        plan_status: TaskStatus | null;
        company_name: string;
        timezone: string;
        address_street: string | null;
        address_city: string | null;
        address_state: string | null;
        address_zip: string | null;
        storm_sms_template: string | null;
        storm_email_enabled: boolean | null;
        storm_email_subject: string | null;
        storm_email_template: string | null;
        storm_ad_budget_cents: number | null;
        storm_ad_days: number | null;
        storm_ad_google_share_pct: number | null;
        campaign_status: CampaignStatus | null;
        google_active: boolean;
        meta_active: boolean;
        newest_photo_id: string | null;
      }
    | undefined;
  if (!r) return null;

  const street = r.address_street?.trim() ?? '';
  const stateZip = [r.address_state, r.address_zip].map((p) => p?.trim() ?? '').filter((p) => p !== '').join(' ');
  const address = street === '' ? null : [street, r.address_city?.trim() ?? '', stateZip].filter((p) => p !== '').join(', ');

  // Active reps, oldest first. app_tenant reads members through the company_members view, which has no
  // created_at, so they come in user id order; with no rep the active owner takes the doors.
  const members = await tx.execute(sql`
    select user_id::text as user_id, role from company_members
    where status = 'active' and role in ('rep', 'owner')
    order by user_id
  `);
  const rows = members.rows as { user_id: string; role: string }[];
  const reps = rows.filter((m) => m.role === 'rep').map((m) => m.user_id);
  const owner = rows.find((m) => m.role === 'owner');
  const repUserIds = reps.length > 0 ? reps : owner ? [owner.user_id] : [];

  return {
    companyStormId: r.id,
    stormId: r.storm_id,
    status: r.status,
    maxIn: Number(r.max_in),
    homesHit: Number(r.homes_hit),
    customersHit: Number(r.customers_hit),
    placeName: r.place_name,
    convectiveDay: r.convective_day,
    planTaskId: r.plan_task_id,
    planStatus: r.plan_status,
    company: { name: r.company_name, timezone: r.timezone, address },
    settings: {
      smsTemplate: r.storm_sms_template,
      emailEnabled: r.storm_email_enabled ?? true,
      emailSubject: r.storm_email_subject,
      emailTemplate: r.storm_email_template,
      adBudgetCents: r.storm_ad_budget_cents ?? 27000,
      adDays: r.storm_ad_days ?? 7,
      adGoogleSharePct: r.storm_ad_google_share_pct ?? 55,
    },
    campaignStatus: r.campaign_status ?? 'none',
    adActive: { google: r.google_active, meta: r.meta_active },
    newestPhotoId: r.newest_photo_id,
    repUserIds,
  };
}

/** Per-customer values for a plan's texts and emails. Keys of every map are lower-case customer ids. */
export type StormPlanRecipients = {
  /** Texts: not archived, not do-not-contact, a phone, sms consent attested or written. */
  smsIds: string[];
  /** Emails: not archived, not do-not-contact, an email address that is not in email_opt_outs. */
  emailIds: string[];
  /** { hail_size: '1.75"', street: '12 Elm St', day: <filled by plan.ts> } minus day; plan.ts adds day for texts. */
  fields: Record<string, { hail_size: string; street: string }>;
};

const RECIPIENT_CAP = 5000;
const STREET_MAX = 60;

export async function listStormPlanRecipients(tx: Tx, ctx: TenantContext, companyStormId: string): Promise<StormPlanRecipients> {
  const result = await tx.execute(sql`
    with hit as (
      select distinct on (h.customer_id) h.customer_id, h.hail_in, p.address_line,
             max(h.hail_in) over (partition by h.customer_id) as max_hail
      from storm_hits h
      join properties p on p.id = h.property_id and p.company_id = h.company_id
      where h.company_id = ${ctx.companyId}::uuid and h.company_storm_id = ${companyStormId}::uuid
        and h.customer_id is not null
      order by h.customer_id, h.hail_in desc, h.property_id
    )
    select lower(c.id::text) as id, hit.max_hail::float8 as max_hail, hit.address_line,
           (c.sms_consent_status in ('attested', 'written')
            and exists (select 1 from jsonb_array_elements(c.phones) ph
                        where jsonb_typeof(ph) = 'object' and btrim(coalesce(ph ->> 'e164', '')) <> '')) as sms_ok,
           (e.email is not null
            and not exists (select 1 from email_opt_outs o where o.company_id = c.company_id and o.email = e.email::citext)) as email_ok
    from hit
    join customers c on c.id = hit.customer_id and c.company_id = ${ctx.companyId}::uuid
    left join lateral (
      select btrim(x.v #>> '{}') as email
      from jsonb_array_elements(case when jsonb_typeof(c.emails) = 'array' then c.emails else '[]'::jsonb end)
           with ordinality as x(v, n)
      where jsonb_typeof(x.v) = 'string' and btrim(x.v #>> '{}') <> ''
      order by x.n
      limit 1
    ) e on true
    where c.archived_at is null and c.do_not_contact = false
    order by c.id
  `);
  const rows = result.rows as {
    id: string;
    max_hail: number | string;
    address_line: string | null;
    sms_ok: boolean;
    email_ok: boolean;
  }[];
  const smsIds = rows.filter((r) => r.sms_ok).slice(0, RECIPIENT_CAP).map((r) => r.id);
  const emailIds = rows.filter((r) => r.email_ok).slice(0, RECIPIENT_CAP).map((r) => r.id);
  const wanted = new Set([...smsIds, ...emailIds]);
  const fields: StormPlanRecipients['fields'] = {};
  for (const r of rows) {
    if (!wanted.has(r.id)) continue;
    const street = (r.address_line ?? '').trim().slice(0, STREET_MAX).trim();
    fields[r.id] = { hail_size: hailLabel(Number(r.max_hail)), street: street === '' ? 'your street' : street };
  }
  return { smsIds, emailIds, fields };
}

export type StormPlanLock = { ok: false } | { ok: true; oldDraftId: string | null };

/**
 * Locks the company_storms row (for update of cs) and checks it. ok:false when the storm is missing or
 * its plan is not replaceable (S1 CHANGED path). By default only a 'draft' plan is replaceable; with
 * opts.replaceFinished an 'expired' or 'declined' plan is too (never running, approved, done...).
 * oldDraftId is the existing DRAFT plan task id, or null when there was no plan or the old plan is
 * already finished (nothing to supersede; linkStormPlan just repoints). Superseding the old draft is
 * the task service's job (supersedeDraft).
 */
export async function lockStormPlan(
  tx: Tx,
  ctx: TenantContext,
  companyStormId: string,
  opts: { replaceFinished?: boolean } = {},
): Promise<StormPlanLock> {
  const locked = await tx.execute(sql`
    select cs.plan_task_id, t.status as plan_status
    from company_storms cs
    left join agent_tasks t on t.id = cs.plan_task_id and t.company_id = cs.company_id
    where cs.id = ${companyStormId}::uuid and cs.company_id = ${ctx.companyId}::uuid
    for update of cs
  `);
  const row = locked.rows[0] as { plan_task_id: string | null; plan_status: TaskStatus | null } | undefined;
  if (!row) return { ok: false };
  const oldId = row.plan_task_id;
  if (oldId !== null && row.plan_status !== null && row.plan_status !== 'draft') {
    const finished = row.plan_status === 'expired' || row.plan_status === 'declined';
    if (!(opts.replaceFinished === true && finished)) return { ok: false };
  }
  return { ok: true, oldDraftId: oldId !== null && row.plan_status === 'draft' ? oldId : null };
}

/** Points the storm at the new plan task and flips status 'new' to 'planned'. */
export async function linkStormPlan(
  tx: Tx,
  ctx: TenantContext,
  companyStormId: string,
  newTaskId: string,
  now: Date,
): Promise<void> {
  await tx.execute(sql`
    update company_storms
    set plan_task_id = ${newTaskId}::uuid,
        status = case when status = 'new' then 'planned' else status end,
        updated_at = ${now}
    where id = ${companyStormId}::uuid and company_id = ${ctx.companyId}::uuid
  `);
}

/** The company_storms id whose plan_task_id is this task, or null. */
export async function findStormByPlanTask(tx: Tx, ctx: TenantContext, taskId: string): Promise<string | null> {
  const result = await tx.execute(sql`
    select id from company_storms
    where plan_task_id = ${taskId}::uuid and company_id = ${ctx.companyId}::uuid
    limit 1
  `);
  const row = result.rows[0] as { id: string } | undefined;
  return row ? row.id : null;
}
