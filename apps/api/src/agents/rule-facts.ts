import type { AgentRuleFacts } from '@roofline/shared';
import { readAgentValues, type TenantContext, type Tx } from '@roofline/db';

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

export async function gatherRuleFacts(tx: Tx, ctx: TenantContext): Promise<AgentRuleFacts> {
  const s = await readAgentValues(tx, ctx);
  const link = s.reviewLink;
  return {
    claims: { nudgeDays: s.claimsNudgeDays },
    scheduler: { reminderHour: s.reminderHour, rainPct: s.weatherRainPct, gustMph: s.weatherGustMph },
    followUp: {
      proposalDays: s.followupDays,
      leadDays: s.leadFollowupDays,
      reviewDelayDays: s.reviewDelayDays,
      reviewsOn: s.followupReviews && link !== null && link.trim() !== '',
      leadsOn: s.followupLeads,
      proposalsOn: s.followupProposals,
    },
  };
}
