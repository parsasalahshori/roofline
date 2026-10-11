import { importConsent } from '@roofline/shared';
import type { ConsentStatus, ExistingCustomer, ExistingIndex, ImportCounts, ImportPreviewRow, NormalizedRow, RowSkip, SkipKey } from '@roofline/shared';

export type { ExistingCustomer, ExistingIndex } from '@roofline/shared';
export type PlannedRow = {
  row: number;
  outcome: 'create' | 'update' | 'skip';
  skipKey: SkipKey | null;
  reason: string | null;
  matchId: string | null;
  consent: ConsentStatus | null;
  consentChanged: boolean;
  normalized: NormalizedRow | null;
};
export type ImportPlan = { rows: PlannedRow[]; counts: ImportCounts };

const SKIP_REASONS: Record<Exclude<SkipKey, 'duplicate'>, string> = {
  noName: 'No name',
  noContact: 'No phone and no email',
  badPhone: 'Bad phone number',
};

function isOptedOut(c: ExistingCustomer): boolean {
  return c.status === 'revoked' || c.doNotContact || c.optedOut;
}

export function planImport(rows: readonly (NormalizedRow | RowSkip)[], existing: ExistingIndex, attested: boolean): ImportPlan {
  const planned: PlannedRow[] = [];
  const seenPhone = new Map<string, number>();
  const seenEmail = new Map<string, number>();
  const counts: ImportCounts = {
    total: rows.length,
    new: 0,
    updated: 0,
    skipped: 0,
    skippedBy: { noName: 0, noContact: 0, badPhone: 0, duplicate: 0 },
    consent: { attested: 0, express: 0, unchanged: 0, optedOutKept: 0 },
    jobs: 0,
    processed: 0,
    located: 0,
    notLocated: 0,
  };

  rows.forEach((r, index) => {
    const row = index + 2;

    if ('skip' in r) {
      planned.push({
        row,
        outcome: 'skip',
        skipKey: r.skip,
        reason: SKIP_REASONS[r.skip],
        matchId: null,
        consent: null,
        consentChanged: false,
        normalized: null,
      });
      counts.skipped += 1;
      counts.skippedBy[r.skip] += 1;
      return;
    }

    const dupPhone = r.phones.find((p) => seenPhone.has(p));
    const dupEmail = dupPhone === undefined ? r.emails.find((e) => seenEmail.has(e)) : undefined;
    const dupOf = dupPhone !== undefined ? seenPhone.get(dupPhone) : dupEmail !== undefined ? seenEmail.get(dupEmail) : undefined;
    if (dupOf !== undefined) {
      planned.push({
        row,
        outcome: 'skip',
        skipKey: 'duplicate',
        reason: `Duplicate of row ${dupOf}`,
        matchId: null,
        consent: null,
        consentChanged: false,
        normalized: null,
      });
      counts.skipped += 1;
      counts.skippedBy.duplicate += 1;
      return;
    }

    for (const p of r.phones) seenPhone.set(p, row);
    for (const e of r.emails) seenEmail.set(e, row);

    const phoneMatch = r.phones.map((p) => existing.byPhone.get(p)).find((m) => m !== undefined);
    const match = phoneMatch ?? r.emails.map((e) => existing.byEmail.get(e)).find((m) => m !== undefined);
    const hasPhone = r.phones.length > 0;
    const consent = importConsent(match ?? null, hasPhone, attested);
    const consentChanged = match ? consent !== match.status : consent !== 'none';

    planned.push({
      row,
      outcome: match ? 'update' : 'create',
      skipKey: null,
      reason: null,
      matchId: match ? match.id : null,
      consent,
      consentChanged,
      normalized: r,
    });

    if (match) {
      counts.updated += 1;
      if (isOptedOut(match)) {
        counts.consent.optedOutKept += 1;
      } else if (!consentChanged) {
        counts.consent.unchanged += 1;
      }
    } else {
      counts.new += 1;
    }
    if ((!match || consentChanged) && consent === 'attested') counts.consent.attested += 1;
    if ((!match || consentChanged) && consent === 'express') counts.consent.express += 1;
    if (r.stage !== null) counts.jobs += 1;
  });

  return { rows: planned, counts };
}

export function previewRows(plan: ImportPlan, limit = 20): ImportPreviewRow[] {
  return plan.rows.slice(0, limit).map((p) => {
    const n = p.normalized;
    return {
      row: p.row,
      outcome: p.outcome,
      reason: p.reason,
      name: n?.displayName ?? null,
      phone: n?.phones[0] ?? null,
      email: n?.emails[0] ?? null,
      address: n?.address ? `${n.address.addressLine}, ${n.address.city}, ${n.address.state} ${n.address.zip}` : null,
      stage: n?.stage ?? null,
      consent: p.consent,
    };
  });
}
