import type { AgentRuleFacts } from '@roofline/shared';
import type { TenantContext, Tx } from '@roofline/db';

/*
 * A1 Task 5: the facts behind each agent card's rule sentences (`rulesFor` in @roofline/shared).
 *
 * On this base the storm-settings columns (budget cents, days) and the Front Desk settings (phone,
 * transfer list, booking flags, on-call list) do not exist yet, so there is nothing to read and the
 * result is `{}`. `rulesFor` then gives the Estimator sentence, and [] for storm_scout and front_desk.
 *
 * MERGE RULE (S1 and D1): when S1 (storm settings: budget and days beside the existing
 * `company_settings.hail_threshold_in`) and D1 (Front Desk settings and the on-call list) are merged
 * into a1-agents, this function is where `stormScout: { thresholdInches, budgetCents, days }` and
 * `frontDesk: { phoneNumber, transferNames, canBook, canConfirm, canMove }` get filled. Read them
 * through the given `tx` (already company-scoped by withTenant) and filter by `ctx.companyId`.
 * Front Desk's success rate uses the task model until AX-D lands with D1.
 */
export async function gatherRuleFacts(tx: Tx, ctx: TenantContext): Promise<AgentRuleFacts> {
  // Nothing to read on this base (see MERGE RULE): the settings reads will use `tx` and `ctx.companyId`.
  void tx;
  void ctx;
  return {};
}
