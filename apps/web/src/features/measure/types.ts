import type { InstantEstimate, LngLat, Outline, Ring } from '@roofline/shared';

/** One building outline near the home. `included` structures count toward the numbers. */
export type Structure = { id: string; ring: Ring; areaSqFt: number; included: boolean };

/**
 * ASSUMED shape of the T7 API's MeasurementView (T7 is not built; report any difference).
 * `outline` is null in draw mode. The numbers are an Estimate until `kind` is `exact`.
 */
export type MeasurementView = {
  id: string;
  propertyId: string;
  jobId: string | null;
  kind: 'estimate' | 'exact';
  method: 'outline' | 'aerial' | 'eagleview' | 'manual';
  drawMode: boolean;
  outline: Outline | null;
  structures: Structure[];
  pitchX12: number;
  overhangFt: number;
  valleyFt: number;
  /** The map centre, [lng, lat]. */
  center: LngLat;
  estimate: InstantEstimate;
  /** True once a proposal was sent from it: edits are refused (409). */
  locked: boolean;
};

/** Body of PATCH /api/measurements/:id. Every field optional. */
export type MeasurementPatch = {
  outline?: Outline;
  includedStructures?: string[];
  pitchX12?: number;
  overhangFt?: number;
  valleyFt?: number;
};

export type OutlineProblem = 'too_few_corners' | 'self_intersecting' | 'too_large';
