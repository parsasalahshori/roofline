import { and, eq } from 'drizzle-orm';
import { companies, companyPhoneNumbers, recordUsage, withTenant, type Db } from '@roofline/db';
import { addMainNumber, loadRegistration, updateRegistration, withRegistrationLock } from '@roofline/db/system';
import { buildCampaign, displayUsPhone, plainRejection } from '@roofline/shared';
import type { AppDeps } from '../../app.ts';
import { billingConfig } from '../../billing/plans.ts';
import { systemContext } from '../../permissions.ts';
import { RegistrarRejectedError } from '../../providers/registrar.ts';
import { policyUrls } from '../../public/policy-urls.ts';
import { subaccountRef } from './advance.ts';

/** The year and month (YYYY-MM) of `now` in the given time zone. */
export function monthKey(now: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit' }).formatToParts(now);
  const year = parts.find((p) => p.type === 'year')?.value ?? '';
  const month = parts.find((p) => p.type === 'month')?.value ?? '';
  return `${year}-${month}`;
}

/** The month and year of `now` in the given time zone, such as 'October 2026'. */
export function monthLabel(now: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone, month: 'long', year: 'numeric' }).format(now);
}

/** The line a texting number's monthly fee carries, such as 'Texting number (402) 555-0100 — October 2026'. */
export function numberFeeDescription(e164: string, now: Date, timeZone: string): string {
  return `Texting number ${displayUsPhone(e164)} — ${monthLabel(now, timeZone)}`;
}

/** The area code (NPA) of a US number in E.164 form, or null when it is not one. */
function areaCodeOf(e164: string | null): string | null {
  const match = /^\+1(\d{3})/.exec(e164 ?? '');
  return match ? match[1]! : null;
}

/**
 * Records a provider rejection with its plain reason and the fields to fix. The provider's own
 * text is never stored: only what plainRejection makes of it.
 */
async function recordRejection(
  system: Db,
  companyId: string,
  brandStatus: 'failed' | 'campaign_failed' | null,
  providerText: string | null,
): Promise<void> {
  const plain = plainRejection(providerText);
  await updateRegistration(system, companyId, {
    ...(brandStatus === null ? {} : { brandStatus }),
    campaignStatus: 'rejected',
    rejectionReasonPlain: plain.reason,
    rejectedFields: plain.fields,
  });
}

/**
 * Carries a company's texting registration on from where it stopped. Runs under the registration
 * lock; every pass records `last_checked_at`. The steps fall through within one pass: the brand
 * review, the campaign submission, the campaign review, then the main number once the campaign is
 * approved and the company has a working card. Provider outages are rethrown so the job retries.
 */
export async function continueRegistration(deps: AppDeps, companyId: string): Promise<void> {
  const key = deps.config.ENCRYPTION_KEY;
  await withRegistrationLock(deps.pools.system, companyId, async (tx) => {
    const row = await loadRegistration(tx, companyId);
    if (row === null || row.submittedAt === null || row.campaignStatus !== 'pending') return;
    await updateRegistration(tx, companyId, { lastCheckedAt: deps.clock.now() });
    const sub = subaccountRef(row, key);

    // Step 1: the brand review.
    let brandStatus = row.brandStatus;
    if (brandStatus === 'pending') {
      if (row.brandSid === null) return;
      const review = await deps.registrar.brandStatus(sub, row.brandSid);
      if (review.status === 'failed') {
        await recordRejection(tx, companyId, 'failed', review.failureReason);
        return;
      }
      if (review.status === 'pending') return;
      await updateRegistration(tx, companyId, { brandStatus: 'approved' });
      brandStatus = 'approved';
    }

    const [company] = await tx
      .select({
        name: companies.name,
        slug: companies.slug,
        phoneE164: companies.phoneE164,
        addressState: companies.addressState,
        stripeSubscriptionId: companies.stripeSubscriptionId,
        status: companies.status,
        timezone: companies.timezone,
      })
      .from(companies)
      .where(eq(companies.id, companyId))
      .limit(1);
    if (!company) throw new Error('The company for this registration could not be found.');

    let messagingServiceSid = row.messagingServiceSid;
    let campaignSid = row.campaignSid;

    // Step 2: submit the campaign, first time or again after a campaign failure.
    if ((brandStatus === 'approved' && campaignSid === null) || brandStatus === 'campaign_failed') {
      if (row.brandSid === null) return;
      const service = await deps.registrar.ensureMessagingService(sub, companyId, {
        inbound: deps.config.PUBLIC_BASE_URL + '/hooks/twilio/sms',
        status: deps.config.PUBLIC_BASE_URL + '/hooks/twilio/status',
      });
      const policy = policyUrls(deps.config, company.slug);
      let submittedSid: string;
      try {
        const submitted = await deps.registrar.submitCampaign(sub, {
          brandSid: row.brandSid,
          messagingServiceSid: service.messagingServiceSid,
          campaign: buildCampaign({
            companyName: company.name,
            companyPhone: company.phoneE164,
            privacyUrl: policy.privacy,
            termsUrl: policy.terms,
          }),
          previousCampaignSid: brandStatus === 'campaign_failed' ? campaignSid : null,
        });
        submittedSid = submitted.campaignSid;
      } catch (err) {
        if (!(err instanceof RegistrarRejectedError)) throw err;
        await recordRejection(tx, companyId, 'campaign_failed', err.reasonText);
        return;
      }
      messagingServiceSid = service.messagingServiceSid;
      campaignSid = submittedSid;
      await updateRegistration(tx, companyId, { messagingServiceSid, campaignSid, brandStatus: 'approved' });
      const ctx = systemContext(companyId);
      await withTenant(deps.pools, ctx, (t) =>
        recordUsage(t, ctx, {
          kind: 'texting_registration_fee',
          quantity: 1,
          unitCostCents: billingConfig(deps).pass_through_cents.campaign_vetting,
          refType: 'texting_campaign',
          refId: submittedSid,
          description: 'Texting registration: carrier review',
          at: deps.clock.now(),
        }),
      );
      brandStatus = 'approved';
    }

    // Step 3: the campaign review.
    if (brandStatus !== 'approved' || campaignSid === null || messagingServiceSid === null) return;
    const review = await deps.registrar.campaignStatus(sub, messagingServiceSid, campaignSid);
    if (review.status === 'failed') {
      await recordRejection(tx, companyId, 'campaign_failed', review.failureReason);
      return;
    }
    if (review.status === 'pending') return;

    // Step 4: the main number, once the campaign is approved and the company has a working card.
    const [main] = await tx
      .select({ e164: companyPhoneNumbers.e164 })
      .from(companyPhoneNumbers)
      .where(
        and(
          eq(companyPhoneNumbers.companyId, companyId),
          eq(companyPhoneNumbers.purpose, 'main'),
          eq(companyPhoneNumbers.status, 'active'),
        ),
      )
      .limit(1);
    if (main === undefined) {
      // A card is a subscription with the company status exactly `active` (past_due does not buy).
      const hasWorkingCard = company.stripeSubscriptionId !== null && company.status === 'active';
      if (!hasWorkingCard) return;
      const number = await deps.registrar.ensureNumber(sub, {
        messagingServiceSid,
        areaCode: areaCodeOf(company.phoneE164),
        state: company.addressState ?? null,
      });
      await addMainNumber(tx, companyId, {
        e164: number.e164,
        providerSid: number.phoneNumberSid,
        capabilities: number.capabilities,
      });
      const now = deps.clock.now();
      const ctx = systemContext(companyId);
      await withTenant(deps.pools, ctx, (t) =>
        recordUsage(t, ctx, {
          kind: 'phone_number_month',
          quantity: 1,
          unitCostCents: billingConfig(deps).pass_through_cents.phone_number_monthly,
          refType: 'phone_number',
          refId: `${number.phoneNumberSid}:${monthKey(now, company.timezone)}`,
          description: numberFeeDescription(number.e164, now, company.timezone),
          at: now,
        }),
      );
    }
    await updateRegistration(tx, companyId, { campaignStatus: 'approved', approvedAt: deps.clock.now() });
  });
}
