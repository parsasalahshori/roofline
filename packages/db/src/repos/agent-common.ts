import { and, eq, gte, lt } from 'drizzle-orm';
import type { Agent, AgentValues } from '@roofline/shared';
import { agentTasks, companies, companySettings } from '../schema/index.ts';
import type { TenantContext, Tx } from '../tenant.ts';
import { insertDefaultSettings } from './companies.ts';

/*
 * G1 Task 19: the one set of db helpers the Claims, Scheduler and Follow-up agents share.
 */

/** True when an agent task of this agent and kind was created in [from, to). */
export async function hasAgentTaskBetween(
  tx: Tx,
  ctx: TenantContext,
  q: { agent: Agent; kind: string; from: Date; to: Date },
): Promise<boolean> {
  const rows = await tx
    .select({ id: agentTasks.id })
    .from(agentTasks)
    .where(
      and(
        eq(agentTasks.companyId, ctx.companyId),
        eq(agentTasks.agent, q.agent),
        eq(agentTasks.kind, q.kind),
        gte(agentTasks.createdAt, q.from),
        lt(agentTasks.createdAt, q.to),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/** The company's status, name and time zone, or null when the company cannot be seen. */
export async function agentCompanyFacts(
  tx: Tx,
  ctx: TenantContext,
): Promise<{ status: string; name: string; timeZone: string } | null> {
  const [row] = await tx
    .select({
      status: companies.status,
      name: companies.name,
      timeZone: companies.timezone,
    })
    .from(companies)
    .where(eq(companies.id, ctx.companyId))
    .limit(1);
  return row ?? null;
}

/** The number the send gate texts: primary, else first, e164 trimmed and non-empty; null when none or when that number is labelled landline. */
export function primaryTextingPhone(
  phones: readonly {
    e164?: unknown;
    primary?: boolean;
    label?: string | null;
  }[],
): string | null {
  const usable = phones.filter(
    (p) => typeof p?.e164 === 'string' && p.e164.trim() !== '',
  );
  const chosen = usable.find((p) => p.primary === true) ?? usable[0];
  if (chosen && (chosen.label ?? '').trim().toLowerCase() === 'landline') return null;
  return typeof chosen?.e164 === 'string' ? chosen.e164.trim() : null;
}

/** The first whitespace-separated word of a name, or null when there is none. */
export function firstWord(name: string | null | undefined): string | null {
  const word = name?.trim().split(/\s+/)[0];
  return word ? word : null;
}

/** The company_settings column defaults (packages/db/src/schema/tenant.ts), used when there is no row. */
export const AGENT_VALUE_DEFAULTS: AgentValues = {
  claimsNudgeDays: [3, 5, 7],
  weatherRainPct: 60,
  weatherGustMph: 25,
  reminderHour: 15,
  followupDays: [3, 4],
  leadFollowupDays: 2,
  reviewLink: null,
  reviewDelayDays: 3,
  followupReviews: true,
  followupLeads: true,
  followupProposals: true,
};

/** The company's G1 agent values with the company_settings column defaults when there is no row. */
export async function readAgentValues(
  tx: Tx,
  ctx: TenantContext,
  opts?: { lock?: boolean },
): Promise<AgentValues> {
  const query = tx
    .select({
      claimsNudgeDays: companySettings.claimsNudgeDays,
      weatherRainPct: companySettings.weatherRainPct,
      weatherGustMph: companySettings.weatherGustMph,
      reminderHour: companySettings.reminderHour,
      followupDays: companySettings.followupDays,
      leadFollowupDays: companySettings.leadFollowupDays,
      reviewLink: companySettings.reviewLink,
      reviewDelayDays: companySettings.reviewDelayDays,
      followupReviews: companySettings.followupReviews,
      followupLeads: companySettings.followupLeads,
      followupProposals: companySettings.followupProposals,
    })
    .from(companySettings)
    .where(eq(companySettings.companyId, ctx.companyId))
    .limit(1);
  const [row] = await (opts?.lock ? query.for('update') : query);
  if (!row)
    return {
      ...AGENT_VALUE_DEFAULTS,
      claimsNudgeDays: [...AGENT_VALUE_DEFAULTS.claimsNudgeDays],
      followupDays: [...AGENT_VALUE_DEFAULTS.followupDays],
    };
  const d = AGENT_VALUE_DEFAULTS;
  return {
    ...row,
    claimsNudgeDays: [
      row.claimsNudgeDays[0] ?? d.claimsNudgeDays[0],
      row.claimsNudgeDays[1] ?? d.claimsNudgeDays[1],
      row.claimsNudgeDays[2] ?? d.claimsNudgeDays[2],
    ],
    followupDays: [
      row.followupDays[0] ?? d.followupDays[0],
      row.followupDays[1] ?? d.followupDays[1],
    ],
  };
}

/** The company_settings row id, making the default row first when it is somehow missing. */
export async function settingsRowId(
  tx: Tx,
  ctx: TenantContext,
): Promise<string> {
  const find = () =>
    tx
      .select({ id: companySettings.id })
      .from(companySettings)
      .where(eq(companySettings.companyId, ctx.companyId))
      .limit(1);
  let [row] = await find();
  if (!row) {
    await insertDefaultSettings(tx, ctx.companyId);
    [row] = await find();
  }
  return row!.id;
}
