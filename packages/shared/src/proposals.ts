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

/** The states (and DC) with a building footprint file: the only codes a footprint load is queued for. Territories are not in the set. */
export const US_STATE_CODES = [
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS',
  'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC',
  'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY',
] as const;
export type UsStateCode = (typeof US_STATE_CODES)[number];

/** True for a two-letter code in US_STATE_CODES (any case, surrounding spaces ignored). */
export function isUsStateCode(code: string): boolean {
  return (US_STATE_CODES as readonly string[]).includes(code.trim().toUpperCase());
}

export const STORED_FILE_KINDS = ['signed_proposal_pdf', 'storm_photo', 'ad_image', 'claim_packet'] as const;
export type StoredFileKind = (typeof STORED_FILE_KINDS)[number];

// ---------------------------------------------------------------------------------------------
// T4: proposal views, the signature record, canonical JSON.
import { z } from 'zod';
import type { Outline, InstantEstimate, LngLat, Ring } from './roof.ts';
import type { RoofModel, RoofPlane } from './roof-model.ts';
import type { PitchSource } from './solar.ts';
import type { Roof3d, Roof3dNoneReason, RoofQualityReason } from './roof-3d.ts';
import type { AddOn } from './tiers.ts';
import type { Scope, Calculation, QuoteLine } from './pricing.ts';

export type MeasurementView = {
  id: string; propertyId: string; jobId: string | null; kind: MeasurementKind; method: MeasurementMethod;
  outline: Outline | null;
  /** Every footprint near the home, in order. `main` marks the building the home was measured on (absent on older rows: the first). */
  structures: { footprintId: string; included: boolean; areaSqFt: number; ring: Ring; main?: boolean }[]; estimate: InstantEstimate; facets: number | null;
  overhangFt: number; /** The map centre, [lng, lat]. */ center: LngLat;
  locked: boolean; providerRef: string | null; notes: string | null; createdAt: string; drawMode: boolean;
  /** Whether a proposal from it already has a customer: its job's, or its home's. When false, Make proposal needs one. */ hasCustomer: boolean;
  /** The roof drawn over the outline (facets and lines), worked out on read; null with no outline. */ roof: RoofModel | null;
  /** Where the pitch came from: Google Solar, the default, or a person (null or absent: not recorded). */ pitchSource?: PitchSource | null;
  /** Measured roof planes (Google Solar) the facets take their own pitch from; null when the pitch is one for the whole roof. */
  pitchPlanes?: RoofPlane[] | null;
  /**
   * Roof facets (by id) left out of the quote; empty when the whole roof is quoted. The estimate (and every price made
   * from it) is then the other facets' only, and `roof` carries `excluded` and `quoted` (see quoteFacets).
   */
  excludedFacets?: string[];
  /**
   * The roof reconstructed in 3D from Google Solar's height map, when this measurement was made from one: `roof` is
   * then its faces and lines while the outline is still the reconstruction's own (see measureRoof).
   */
  roof3d?: Roof3d | null;
  /**
   * Google's true-ortho photo the 3D roof was measured on, for the roof view (owner and office only): `url` serves the
   * PNG, `corners` are its top-left, top-right, bottom-right and bottom-left [lng, lat]. Null or absent otherwise.
   */
  roofPhoto?: { url: string; corners: [LngLat, LngLat, LngLat, LngLat] } | null;
  /**
   * The 3D roof had Google's photo, but it is past the days Google's terms let it be kept (and is deleted, or about to
   * be): the roof view says so instead of showing it. The measured roof itself is kept. Absent or false otherwise.
   */
  roofPhotoExpired?: boolean;
  /**
   * The 3D roof falls short of the quality targets (see RoofQuality): a person should check it before pricing it.
   * Null or absent when it does not (or the roof is not a 3D one).
   */
  needsReview?: { reasons: RoofQualityReason[] } | null;
  /**
   * Why this measurement has no 3D roof when Google's height map was asked about it (Roof3dSnapshot.none: no imagery,
   * no building, clipped, unusable, timeout, shadow, or an older row's no-roof), so the screen can say why the roof is
   * the outline's instead of falling back silently. Null or absent otherwise.
   */
  roof3dMissing?: Roof3dNoneReason | null;
  /**
   * The 3D roof shown was made by an older reconstruction than the server's (ROOF_3D_ALGORITHM_VERSION; rows without a
   * version are older): it is what was priced, but measuring again may draw it differently. Absent when current.
   */
  roof3dOutdated?: boolean;
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
    financingTerms: FinancingTerms | null }[];
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

/** Financing terms frozen on an option when it was priced (Ruling ER). */
export type FinancingTerms = { aprBps: number; months: number };

/**
 * What document_sha256 covers, exactly as hashed (canonicalJson) and as stored on the 'signed'
 * proposal_events row (`data.document`, Ruling ER). The signed PDF prints its signed facts from it.
 */
export type SignedDocument = {
  company: { name: string; phone: string | null };
  address: string;
  validUntil: string;
  basis: MeasurementKind;
  option: {
    id: string; tier: Tier; name: string; highlights: string[]; inclusions: string[]; totalCents: number;
    monthlyEstimateCents: number | null; financingTerms: FinancingTerms | null;
  };
  clause: string | null;
};

const signedDocumentSchema = z.object({
  company: z.object({ name: z.string(), phone: z.string().nullable() }),
  address: z.string(),
  validUntil: z.string(),
  basis: z.enum(MEASUREMENT_KINDS),
  option: z.object({
    id: z.string(),
    tier: z.enum(TIERS),
    name: z.string(),
    highlights: z.array(z.string()),
    inclusions: z.array(z.string()),
    totalCents: z.number().int(),
    monthlyEstimateCents: z.number().int().nullable(),
    financingTerms: z.object({ aprBps: z.number().int(), months: z.number().int() }).nullable(),
  }),
  clause: z.string().nullable(),
});

/** A stored signed document read back, or null when the value is not one (older signatures have none). */
export function parseSignedDocument(value: unknown): SignedDocument | null {
  const parsed = signedDocumentSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** What document_sha256 covers: company, address, the chosen option as shown, valid until, clause text when on. */
export function signedDocument(p: PublicProposalView, optionId: string, clause: boolean): SignedDocument {
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
