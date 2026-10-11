import type { ConsentStatus } from './enums.ts';

export type ExistingConsent = { status: ConsentStatus; doNotContact: boolean; optedOut: boolean };

export function consentAttestationText(companyName: string): string {
  return `These customers agreed to receive text messages from ${companyName}. I understand ${companyName} is responsible for having their consent.`;
}

// Import consent rules (spec 5.4). New customers: no phone -> none; box checked -> attested; else express.
// Existing customers: opted-out, revoked and written/attested are never changed; none and express move up only.
export function importConsent(existing: ExistingConsent | null, hasPhone: boolean, attested: boolean): ConsentStatus {
  if (existing === null) {
    if (!hasPhone) return 'none';
    return attested ? 'attested' : 'express';
  }
  if (existing.status === 'revoked' || existing.doNotContact || existing.optedOut) return existing.status;
  if (existing.status === 'written' || existing.status === 'attested') return existing.status;
  return attested ? 'attested' : 'express';
}
