import { and, eq, isNotNull } from 'drizzle-orm';
import { companies, companyPhoneNumbers, recordUsage, textingRegistrations, withTenant } from '@roofline/db';
import { companiesWithTextingFees } from '@roofline/db/system';
import type { AppDeps } from '../../app.ts';
import { monthKey, monthLabel, numberFeeDescription } from '../../account/texting/progress.ts';
import { billingConfig } from '../../billing/plans.ts';
import { systemContext } from '../../permissions.ts';
import { reportJobError } from './report.ts';

/**
 * Scheduled job: bills the monthly texting fees (on the 1st, in the worker, with the clock's time).
 * Each company with an active main number gets one `phone_number_month` row, and each company with
 * an approved campaign gets one `texting_registration_fee` row, both for the month of `now` in the
 * company's time zone. The unique ref makes a rerun in the same month a no-op.
 *
 * One company failing is logged and does not stop the others.
 */
export async function billMonthlyFees(deps: AppDeps, now: Date): Promise<void> {
  const companyIds = await companiesWithTextingFees(deps.pools.system);
  for (const companyId of companyIds) {
    try {
      await billCompany(deps, companyId, now);
    } catch (err) {
      reportJobError(deps, err, 'bill-monthly-fees');
    }
  }
}

/** Records one company's monthly fees in its own tenant transaction, under RLS. */
async function billCompany(deps: AppDeps, companyId: string, now: Date): Promise<void> {
  const ctx = systemContext(companyId);
  await withTenant(deps.pools, ctx, async (t) => {
    const [company] = await t
      .select({ timezone: companies.timezone })
      .from(companies)
      .where(eq(companies.id, companyId))
      .limit(1);
    if (company === undefined) return;
    const zone = company.timezone;
    const month = monthKey(now, zone);
    const { pass_through_cents: fees } = billingConfig(deps);

    const numbers = await t
      .select({ e164: companyPhoneNumbers.e164, providerSid: companyPhoneNumbers.providerSid })
      .from(companyPhoneNumbers)
      .where(
        and(
          eq(companyPhoneNumbers.companyId, companyId),
          eq(companyPhoneNumbers.purpose, 'main'),
          eq(companyPhoneNumbers.status, 'active'),
        ),
      );
    for (const number of numbers) {
      if (number.providerSid === null) continue;
      await recordUsage(t, ctx, {
        kind: 'phone_number_month',
        quantity: 1,
        unitCostCents: fees.phone_number_monthly,
        refType: 'phone_number',
        refId: `${number.providerSid}:${month}`,
        description: numberFeeDescription(number.e164, now, zone),
        at: now,
      });
    }

    const [campaign] = await t
      .select({ campaignSid: textingRegistrations.campaignSid })
      .from(textingRegistrations)
      .where(
        and(
          eq(textingRegistrations.companyId, companyId),
          eq(textingRegistrations.campaignStatus, 'approved'),
          isNotNull(textingRegistrations.campaignSid),
        ),
      )
      .limit(1);
    if (campaign?.campaignSid) {
      await recordUsage(t, ctx, {
        kind: 'texting_registration_fee',
        quantity: 1,
        unitCostCents: fees.campaign_monthly,
        refType: 'texting_campaign_month',
        refId: `${campaign.campaignSid}:${month}`,
        description: `Texting registration: monthly carrier fee — ${monthLabel(now, zone)}`,
        at: now,
      });
    }
  });
}
