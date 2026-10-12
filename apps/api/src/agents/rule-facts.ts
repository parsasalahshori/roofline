import { eq } from 'drizzle-orm';
import type { AgentRuleFacts } from '@roofline/shared';
import { companySettings, type TenantContext, type Tx } from '@roofline/db';

/*
 * A1 Task 5 / G1 Task 15: the facts behind each agent card's rule sentences (`rulesFor` in @roofline/shared).
 *
 * G1 (Claims, Scheduler, Follow-up) reads its numbers from `company_settings` (the same columns the
 * Settings -> Agents tab edits, see routes/agent-values.ts). A company without a settings row gets the
 * column defaults. Read through the given `tx` (already company-scoped by withTenant), filtered by `ctx.companyId`.
 *
 * MERGE RULE (S1 and D1): the Storm Scout facts `stormScout: { thresholdInches, budgetCents, days }` and the
 * Front Desk facts `frontDesk: { phoneNumber, transferNames, canBook, canConfirm, canMove }` are still filled
 * where their settings land; until then they are left out and `rulesFor` gives [] for those two agents.
 */

/** The company_settings column defaults (packages/db/src/schema/tenant.ts), used when there is no row. */
const DEFAULTS = {
  claimsNudgeDays: [3, 5, 7],
  weatherRainPct: 60,
  weatherGustMph: 25,
  reminderHour: 15,
  followupDays: [3, 4],
  leadFollowupDays: 2,
  reviewDelayDays: 3,
  followupReviews: true,
  followupLeads: true,
  followupProposals: true,
  reviewLink: null as string | null,
};

export async function gatherRuleFacts(tx: Tx, ctx: TenantContext): Promise<AgentRuleFacts> {
  const [row] = await tx
    .select({
      claimsNudgeDays: companySettings.claimsNudgeDays,
      reminderHour: companySettings.reminderHour,
      weatherRainPct: companySettings.weatherRainPct,
      weatherGustMph: companySettings.weatherGustMph,
      followupDays: companySettings.followupDays,
      leadFollowupDays: companySettings.leadFollowupDays,
      reviewDelayDays: companySettings.reviewDelayDays,
      followupReviews: companySettings.followupReviews,
      followupLeads: companySettings.followupLeads,
      followupProposals: companySettings.followupProposals,
      reviewLink: companySettings.reviewLink,
    })
    .from(companySettings)
    .where(eq(companySettings.companyId, ctx.companyId))
    .limit(1);
  const s = row ?? DEFAULTS;
  const [n0, n1, n2] = s.claimsNudgeDays;
  const [f0, f1] = s.followupDays;
  const link = s.reviewLink;
  return {
    claims: { nudgeDays: [n0!, n1!, n2!] },
    scheduler: { reminderHour: s.reminderHour, rainPct: s.weatherRainPct, gustMph: s.weatherGustMph },
    followUp: {
      proposalDays: [f0!, f1!],
      leadDays: s.leadFollowupDays,
      reviewDelayDays: s.reviewDelayDays,
      reviewsOn: s.followupReviews && link !== null && link.trim() !== '',
      leadsOn: s.followupLeads,
      proposalsOn: s.followupProposals,
    },
  };
}
