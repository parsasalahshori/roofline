import { and, asc, eq, sql } from 'drizzle-orm';
import { companyPhoneNumbers, companySettings } from '@roofline/db';
import type { TenantContext, Tx } from '@roofline/db';
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
 * Front Desk facts (`frontDesk: { phoneNumber, transferNames, canBook, canConfirm, canMove }`) are filled
 * only when front_desk_enabled is true; otherwise the key is omitted. The
 * phone number is the company's first active voice number, formatted '(949) 555-0100'. Booking and
 * confirming are always allowed; moving follows `front_desk_can_move`. `transferNames` is [] today: the
 * tenant-readable `company_members` view does not expose transfer_phone_e164 / on_call_order (memberships
 * are app_system only), and no migration is added for this; filling it needs the view extended.
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
      hailThresholdIn: companySettings.hailThresholdIn,
      stormAdBudgetCents: companySettings.stormAdBudgetCents,
      stormAdDays: companySettings.stormAdDays,
      frontDeskEnabled: companySettings.frontDeskEnabled,
      frontDeskCanMove: companySettings.frontDeskCanMove,
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
            transferNames: [] as string[],
            canBook: true,
            canConfirm: true,
            canMove: row ? row.frontDeskCanMove : true,
          },
        }
      : {};
  const s = row ?? DEFAULTS;
  const [n0, n1, n2] = s.claimsNudgeDays;
  const [f0, f1] = s.followupDays;
  const link = s.reviewLink;
  return {
    ...frontDesk,
    stormScout: {
      thresholdInches: row ? Number(row.hailThresholdIn) : 1,
      budgetCents: money ? budgetCents : null,
      days: row ? row.stormAdDays : 7,
    },
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
    ...(money ? {} : { noLinks: true }),
  };
}
