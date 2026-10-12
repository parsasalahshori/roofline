/** E1 enum value lists (spec 3.4, 4.1, 4.3, 5.3, 8). Task 4 adds the rest of this file. */
export const MEASUREMENT_KINDS = ['estimate', 'exact'] as const;
export type MeasurementKind = (typeof MEASUREMENT_KINDS)[number];

export const MEASUREMENT_METHODS = ['outline', 'aerial', 'eagleview', 'manual'] as const;
export type MeasurementMethod = (typeof MEASUREMENT_METHODS)[number];

export const TIERS = ['good', 'better', 'best'] as const;
export type Tier = (typeof TIERS)[number];

export const ADD_ON_UNITS = ['per_square', 'per_edge_ft', 'per_ridge_ft', 'per_valley_ft', 'per_job'] as const;
export type AddOnUnit = (typeof ADD_ON_UNITS)[number];

export const PROPOSAL_STATUSES = ['draft', 'ready', 'sent', 'viewed', 'signed', 'declined', 'expired', 'replaced'] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

export const PROPOSAL_EVENT_KINDS = ['sent', 'viewed', 'option_viewed', 'signed', 'declined', 'link_resent', 'link_copied'] as const;
export type ProposalEventKind = (typeof PROPOSAL_EVENT_KINDS)[number];

export const EXACT_ORDER_STATUSES = ['priced', 'ordering', 'waiting', 'complete', 'attention', 'canceled'] as const;
export type ExactOrderStatus = (typeof EXACT_ORDER_STATUSES)[number];

export const FOOTPRINT_STATE_STATUSES = ['loading', 'ready', 'failed'] as const;
export type FootprintStateStatus = (typeof FOOTPRINT_STATE_STATUSES)[number];

export const STORED_FILE_KINDS = ['signed_proposal_pdf', 'storm_photo', 'ad_image', 'claim_packet'] as const;
export type StoredFileKind = (typeof STORED_FILE_KINDS)[number];

// ---------------------------------------------------------------------------------------------
// T4: proposal views, the signature record, canonical JSON.
import type { Outline, InstantEstimate, LngLat, Ring } from './roof.ts';
import type { AddOn } from './tiers.ts';
import type { Scope, Calculation, QuoteLine } from './pricing.ts';

export type MeasurementView = {
  id: string; propertyId: string; jobId: string | null; kind: MeasurementKind; method: MeasurementMethod;
  outline: Outline | null; structures: { footprintId: string; included: boolean; areaSqFt: number; ring: Ring }[]; estimate: InstantEstimate; facets: number | null;
  overhangFt: number; /** The map centre, [lng, lat]. */ center: LngLat;
  locked: boolean; providerRef: string | null; notes: string | null; createdAt: string; drawMode: boolean;
};
export type ProposalOptionView = {
  id: string; tier: Tier; name: string; highlights: string[]; scope: Scope; addOns: AddOn[]; calculation: Calculation;
  addOnLines: QuoteLine[]; totalCents: number; monthlyEstimateCents: number | null; enabled: boolean;
};
export type ProposalView = {
  id: string; number: string; status: ProposalStatus; jobId: string; customer: { id: string; name: string; phone: string | null };
  address: string; measurementId: string; basis: MeasurementKind; options: ProposalOptionView[]; messageBody: string; validUntil: string;
  sentAt: string | null; views: { count: number; first: string | null; last: string | null }; signed: { optionId: string; name: string; at: string } | null;
  declined: { reason: string | null; at: string } | null; taskId: string | null; replacedById: string | null; canEdit: boolean;
};
export type PublicProposalView = {
  companyName: string; companyPhone: string | null; firstName: string | null; address: string; validUntil: string;
  status: 'open' | 'signed' | 'declined' | 'expired'; basis: MeasurementKind;
  options: { id: string; tier: Tier; name: string; highlights: string[]; inclusions: string[]; totalCents: number; monthlyEstimateCents: number | null;
    financingTerms: { aprBps: number; months: number } | null }[];
  signed: { optionId: string; name: string; at: string; pdfReady: boolean } | null; estimateClause: boolean;
};
export const CONSENT_TEXT_V1 = 'I agree to sign electronically and to receive this agreement electronically. I can ask for a paper copy.';
export const ESTIMATE_CLAUSE_V1 = "This price is based on an estimate of your roof's size. If the measured size differs, we'll show you the updated price and ask you to confirm before work starts.";
export type SignatureRecord = {
  optionId: string; signerName: string; typedSignature: string; drawnSignaturePngSha256: string | null; consentText: string;
  consentVersion: 'v1'; documentSha256: string; totalCents: number; ip: string; userAgent: string; signedAt: string; viewedFirstAt: string | null;
};

/** Sorted keys, no whitespace, numbers as JSON, arrays keep order, undefined dropped. */
export function canonicalJson(value: unknown): string {
  if (value === undefined) return 'null';
  return serializeCanonical(value);
}

function serializeCanonical(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    if (value === undefined || typeof value === 'function' || typeof value === 'symbol') return 'null';
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => serializeCanonical(item)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => {
      const item = record[key];
      return item !== undefined && typeof item !== 'function' && typeof item !== 'symbol';
    })
    .sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${serializeCanonical(record[key])}`).join(',')}}`;
}

/** What document_sha256 covers: company, address, the chosen option as shown, valid until, clause text when on. */
export function signedDocument(p: PublicProposalView, optionId: string, clause: boolean): unknown {
  const option = p.options.find((candidate) => candidate.id === optionId);
  if (!option) throw new Error('Unknown option.');
  return {
    company: { name: p.companyName, phone: p.companyPhone },
    address: p.address,
    validUntil: p.validUntil,
    basis: p.basis,
    option: {
      id: option.id,
      tier: option.tier,
      name: option.name,
      highlights: option.highlights,
      inclusions: option.inclusions,
      totalCents: option.totalCents,
      monthlyEstimateCents: option.monthlyEstimateCents,
      financingTerms: option.financingTerms,
    },
    clause: clause ? ESTIMATE_CLAUSE_V1 : null,
  };
}

/** The estimator settings as the API answers. `aerialConfigured` is false when no aerial provider is set up (the switch is then hidden). */
export type EstimatorSettings = {
  defaultPitchX12: number;
  overhangFt: number;
  proposalValidDays: number;
  aerialMeasure: boolean;
  aerialConfigured: boolean;
  estimateChangeClause: boolean;
  /** Basis points: 999 means 9.99%; 0 means no interest; null means financing is not set. */
  financingAprBps: number | null;
  financingTermMonths: number | null;
};

/** What PUT /api/estimator/settings takes: the same fields without the read-only `aerialConfigured`. Send only what the section edits. */
export type EstimatorSettingsPatch = Partial<Omit<EstimatorSettings, 'aerialConfigured'>>;
