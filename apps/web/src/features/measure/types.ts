import type { Calculation, FinancingTerms, Outline, QuoteLine, Scope, Tier } from '@roofline/shared';
export type { MeasurementView } from '@roofline/shared';

/** Body of PATCH /api/measurements/:id. Every field optional. */
export type MeasurementPatch = {
  outline?: Outline;
  includedStructures?: string[];
  pitchX12?: number;
  overhangFt?: number;
  valleyFt?: number;
  /** The facets to price (part of the roof); null prices the whole roof. */
  selectedFacets?: string[] | null;
};

export type OutlineProblem = 'too_few_corners' | 'self_intersecting' | 'too_large';

/** One tier priced as Make proposal would price it now (apps/api/src/estimator/preview.ts). */
export type PreviewOption = {
  tier: Tier;
  name: string;
  highlights: string[];
  material: Scope['material'];
  wastePercent: number;
  enabled: boolean;
  calculation: Calculation;
  addOnLines: QuoteLine[];
  totalCents: number;
  monthlyEstimateCents: number | null;
};

/** GET /api/measurements/:id/preview. `options` is null for a rep, or for a roof with nothing to price yet. */
export type MeasurementPreview = {
  addressLine: string;
  city: string;
  state: string;
  customerName: string | null;
  hailIn: number | null;
  options: PreviewOption[] | null;
  financing: FinancingTerms | null;
};
