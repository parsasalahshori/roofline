import { and, eq } from 'drizzle-orm';
import {
  companies,
  companyPhoneNumbers,
  type Pools,
  type TenantContext,
  withTenant,
} from '@roofline/db';
import { findUserById, loadRegistration, type RegistrationRecord } from '@roofline/db/system';
import {
  BRAND_FIELDS,
  type BrandField,
  type BrandInfo,
  BrandInfoSchema,
  type TextingState,
  type TextingView,
} from '@roofline/shared';
import type { AppDeps } from '../../app.ts';
import type { SessionInfo } from '../../auth/sessions.ts';
import { AppError, MESSAGES } from '../../errors.ts';
import { hasPaymentMethod } from '../../billing/guards.ts';
import { policyUrls } from '../../public/policy-urls.ts';

/** The company's row as texting needs it, and its active main number (e164, or null). */
export async function loadTextingCompany(pools: Pools, ctx: TenantContext) {
  return withTenant(pools, ctx, async (tx) => {
    const [row] = await tx
      .select({
        name: companies.name,
        legalName: companies.legalName,
        slug: companies.slug,
        phoneE164: companies.phoneE164,
        website: companies.website,
        addressStreet: companies.addressStreet,
        addressCity: companies.addressCity,
        addressState: companies.addressState,
        addressZip: companies.addressZip,
        stripeSubscriptionId: companies.stripeSubscriptionId,
        status: companies.status,
      })
      .from(companies)
      .where(eq(companies.id, ctx.companyId))
      .limit(1);
    if (!row) throw new AppError(404, MESSAGES.notFound);
    const [main] = await tx
      .select({ e164: companyPhoneNumbers.e164 })
      .from(companyPhoneNumbers)
      .where(
        and(
          eq(companyPhoneNumbers.companyId, ctx.companyId),
          eq(companyPhoneNumbers.purpose, 'main'),
          eq(companyPhoneNumbers.status, 'active'),
        ),
      )
      .limit(1);
    return { ...row, mainNumber: main?.e164 ?? null };
  });
}

/** The brand fields the form pre-fills from the company (every text field of BrandInfo). */
type DefaultKey = 'legalName' | 'street' | 'city' | 'state' | 'zip' | 'website' | 'contactEmail' | 'contactPhone';

const isBrandField =(value: string): value is BrandField => (BRAND_FIELDS as readonly string[]).includes(value);

/** The registration's campaign status, as the screen names it. */
function stateOf(row: RegistrationRecord | null): TextingState {
  switch (row?.campaignStatus ?? 'none') {
    case 'none':
      return 'not_started';
    case 'pending':
      return 'waiting';
    case 'approved':
      return 'approved';
    case 'rejected':
      return 'needs_fix';
  }
}

/**
 * What the texting screen shows: where the registration stands, what was sent, the form's
 * defaults from the company, and whether a card or a confirmed email is still needed. Any member
 * may read it. The subaccount token is never read here: the registration comes from `loadRegistration`,
 * which is on the system pool, and only the fields below leave this function.
 */
export async function textingView(deps: AppDeps, ctx: TenantContext, session: SessionInfo): Promise<TextingView> {
  const [company, row, user] = await Promise.all([
    loadTextingCompany(deps.pools, ctx),
    loadRegistration(deps.pools.system, ctx.companyId),
    findUserById(deps.pools.system, session.userId),
  ]);

  const brandParsed = row?.brandInfo == null ? null : BrandInfoSchema.safeParse(row.brandInfo);
  const brand: BrandInfo | null = brandParsed?.success ? brandParsed.data : null;

  const defaults: Partial<BrandInfo> = {};
  const set = (key: DefaultKey, value: string | null | undefined) => {
    if (value) defaults[key] = value;
  };
  set('legalName', company.legalName ?? company.name);
  set('street', company.addressStreet);
  set('city', company.addressCity);
  set('state', company.addressState);
  set('zip', company.addressZip);
  set('website', company.website);
  set('contactEmail', user?.email);
  set('contactPhone', company.phoneE164);

  return {
    state: stateOf(row),
    reason: row?.rejectionReasonPlain ?? null,
    rejectedFields: (row?.rejectedFields ?? []).filter(isBrandField),
    brand,
    defaults,
    submittedAt: row?.submittedAt?.toISOString() ?? null,
    approvedAt: row?.approvedAt?.toISOString() ?? null,
    number: company.mainNumber,
    needsPaymentMethod: !hasPaymentMethod({ stripeSubscriptionId: company.stripeSubscriptionId, status: company.status }),
    needsVerifiedEmail: !session.emailVerified,
    hostedPolicyUrls: policyUrls(deps.config, company.slug),
  };
}
