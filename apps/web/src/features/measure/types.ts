import type { Outline } from '@roofline/shared';
export type { MeasurementView } from '@roofline/shared';

/** Body of PATCH /api/measurements/:id. Every field optional. */
export type MeasurementPatch = {
  outline?: Outline;
  includedStructures?: string[];
  pitchX12?: number;
  overhangFt?: number;
  valleyFt?: number;
};

export type OutlineProblem = 'too_few_corners' | 'self_intersecting' | 'too_large';
