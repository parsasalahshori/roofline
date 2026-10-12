import { decrypt, encrypt, recordUsage, withTenant } from '@roofline/db';
import {
  loadRegistration,
  saveSubaccount,
  updateRegistration,
  withRegistrationLock,
  type RegistrationRecord,
} from '@roofline/db/system';
import { BrandInfoSchema, plainRejection } from '@roofline/shared';
import type { AppDeps } from '../../app.ts';
import { billingConfig } from '../../billing/plans.ts';
import { systemContext } from '../../permissions.ts';
import { RegistrarRejectedError, type BrandProgress, type SubaccountRef } from '../../providers/registrar.ts';
import { continueRegistration } from './progress.ts';

/** The subaccount's sid and decrypted auth token, for calls made as the company's subaccount. */
export function subaccountRef(row: RegistrationRecord, encryptionKey: string): SubaccountRef {
  if (row.subaccountSid === null || row.subaccountAuthTokenEncrypted === null) throw new Error('no subaccount');
  return { accountSid: row.subaccountSid, authToken: decrypt(row.subaccountAuthTokenEncrypted, encryptionKey) };
}

/** What stage 1 did, which decides whether the later stages run. */
type StageOne = 'busy' | 'idle' | 'rejected' | 'submitted';

/**
 * Stage 1 runs only for a submitted registration whose campaign is pending and whose brand is not
 * yet with the carriers: no brand sid yet, or the brand failed review (a resubmission keeps the
 * failed sid and sends it as the previous id).
 */
function brandStageDue(row: RegistrationRecord | null): row is RegistrationRecord {
  return (
    row !== null &&
    row.submittedAt !== null &&
    row.campaignStatus === 'pending' &&
    (row.brandSid === null || row.brandStatus === 'failed')
  );
}

/**
 * Moves a company's texting registration along (the `texting-registration` job). Stage 1 submits
 * the brand to the carriers under the registration lock, and records the business-check fee once
 * per brand sid. A rejection is recorded with a plain reason and the fields to fix. Provider
 * outages are rethrown so the job retries. Later stages are carried on by `continueRegistration`.
 */
export async function advanceRegistration(deps: AppDeps, companyId: string): Promise<void> {
  // Read before anything is created at Twilio, so a config error fails first.
  const feeCents = billingConfig(deps).pass_through_cents.brand_registration;
  const outcome: StageOne | { retry: unknown } | 'busy' = await withRegistrationLock(
    deps.pools.system,
    companyId,
    async (tx): Promise<StageOne | { retry: unknown }> => {
      let row = await loadRegistration(tx, companyId);
      if (!brandStageDue(row)) return 'idle';

      if (row.subaccountSid === null || row.subaccountAuthTokenEncrypted === null) {
        const sub = await deps.registrar.ensureSubaccount(companyId);
        await saveSubaccount(tx, companyId, sub.accountSid, encrypt(sub.authToken, deps.config.ENCRYPTION_KEY));
        row = await loadRegistration(tx, companyId);
        if (!brandStageDue(row)) return 'idle';
      }

      // Ids Twilio has created so far are kept even when the flow fails part-way.
      const partial: BrandProgress = {};
      try {
        const out = await deps.registrar.submitBrand(subaccountRef(row, deps.config.ENCRYPTION_KEY), {
          companyId,
          brand: BrandInfoSchema.parse(row.brandInfo),
          statusCallback: deps.config.PUBLIC_BASE_URL + '/hooks/twilio-registration',
          previous: {
            customerProfileSid: row.customerProfileSid,
            trustProductSid: row.trustProductSid,
            brandSid: row.brandStatus === 'failed' ? row.brandSid : null,
          },
          onProgress: (p) => {
            Object.assign(partial, p);
          },
        });
        await updateRegistration(tx, companyId, {
          customerProfileSid: out.customerProfileSid,
          trustProductSid: out.trustProductSid,
          brandSid: out.brandSid,
          brandStatus: 'pending',
        });
        return 'submitted';
      } catch (err) {
        const kept = {
          ...partial,
          ...(partial.brandSid !== undefined ? { brandStatus: 'pending' as const } : {}),
        };
        if (err instanceof RegistrarRejectedError) {
          const plain = plainRejection(err.reasonText);
          await updateRegistration(tx, companyId, {
            ...kept,
            campaignStatus: 'rejected',
            rejectionReasonPlain: plain.reason,
            rejectedFields: plain.fields,
          });
          return 'rejected';
        }
        if (Object.keys(partial).length > 0) await updateRegistration(tx, companyId, kept);
        // Returned, not thrown, so the transaction commits what was kept; rethrown below.
        return { retry: err };
      }
    },
  );

  if (typeof outcome === 'object') throw outcome.retry;
  if (outcome === 'busy' || outcome === 'rejected') return;

  // The fee is recorded after the brand sid is committed, once per brand sid (a repeat is a no-op).
  const row = await loadRegistration(deps.pools.system, companyId);
  if (row?.brandSid) {
    const brandSid = row.brandSid;
    const ctx = systemContext(companyId);
    await withTenant(deps.pools, ctx, (t) =>
      recordUsage(t, ctx, {
        kind: 'texting_registration_fee',
        quantity: 1,
        unitCostCents: feeCents,
        refType: 'texting_brand',
        refId: brandSid,
        description: 'Texting registration: business check',
        at: deps.clock.now(),
      }),
    );
  }
  await continueRegistration(deps, companyId);
}
