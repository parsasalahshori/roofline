import { and, asc, eq, sql } from 'drizzle-orm';
import { companyPhoneNumbers, companySettings, readAgentValues, type TenantContext, type Tx } from '@roofline/db';
import type { AgentRuleFacts } from '@roofline/shared';
import { can } from '../permissions.ts';

/*
 * A1 Task 5 and Task 14, G1 Task 15: the facts behind each agent card's rule sentences (`rulesFor` in @roofline/shared).
 *
 * Storm Scout facts are filled from `company_settings` (hail threshold, ad budget cents, ad days). When the
 * company has no settings row yet, the column defaults (1 inch, 27000 cents, 7 days) are returned so Storm
 * Scout always has its sentences.
 *
 * Readers without `view_money_totals` (reps) get `budgetCents: null` (no ad-budget clause) and
 * `noLinks: true` (every rule without settings links), because they cannot open the settings pages.
 *
 * Front Desk facts (`frontDesk: { phoneNumber, transferNames, canBook, canConfirm, canMove, canCancel }`) are filled
 * only when front_desk_enabled is true; otherwise the key is omitted. The
 * phone number is the company's first active voice number, formatted '(949) 555-0100'. Booking,
 * confirming and cancelling are always allowed (company_settings has no cancel flag); moving follows
 * `front_desk_can_move`. `transferNames` is passed in by the caller: memberships are app_system only, so the API
 * reads the on-call first names with `onCallFirstNames` (@roofline/db/system) and hands them in ([] by default).
 * G1 (Claims, Scheduler, Follow-up) reads its numbers from `company_settings` (the same columns the
 * Settings -> Agents tab edits, see routes/agent-values.ts); a company without a settings row gets the
 * column defaults.
 * Everything is read through the given `tx` (company-scoped by withTenant) and filtered by `ctx.companyId`.
 */

/** '+19495550100' -> '(949) 555-0100'; anything else is returned as is. */
function formatPhone(e164: string): string {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164;
}

export async function gatherRuleFacts(tx: Tx, ctx: TenantContext, transferNames: string[] = []): Promise<AgentRuleFacts> {
  const [row] = await tx
    .select({
      hailThresholdIn: companySettings.hailThresholdIn,
      stormAdBudgetCents: companySettings.stormAdBudgetCents,
      stormAdDays: companySettings.stormAdDays,
      frontDeskEnabled: companySettings.frontDeskEnabled,
      frontDeskCanMove: companySettings.frontDeskCanMove,
    })
    .from(companySettings)
    .where(eq(companySettings.companyId, ctx.companyId))
    .limit(1);
  const money = can(ctx, 'view_money_totals');
  const budgetCents = row ? row.stormAdBudgetCents : 27000;
  const [number] = await tx
    .select({ e164: companyPhoneNumbers.e164 })
    .from(companyPhoneNumbers)
    .where(
      and(
        eq(companyPhoneNumbers.companyId, ctx.companyId),
        eq(companyPhoneNumbers.status, 'active'),
        sql`'voice' = any(${companyPhoneNumbers.capabilities})`,
      ),
    )
    .orderBy(asc(companyPhoneNumbers.createdAt))
    .limit(1);
  const frontDesk =
    row?.frontDeskEnabled === true
      ? {
          frontDesk: {
            phoneNumber: number ? formatPhone(number.e164) : 'your business number',
            transferNames,
            canBook: true,
            canConfirm: true,
            canCancel: true,
            canMove: row ? row.frontDeskCanMove : true,
          },
        }
      : {};
  const s = await readAgentValues(tx, ctx);
  const link = s.reviewLink;
  return {
    ...frontDesk,
    stormScout: {
      thresholdInches: row ? Number(row.hailThresholdIn) : 1,
      budgetCents: money ? budgetCents : null,
      days: row ? row.stormAdDays : 7,
    },
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
    ...(money ? {} : { noLinks: true }),
  };
}
