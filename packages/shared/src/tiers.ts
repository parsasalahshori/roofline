// E1 Task 3: tiers and financing. This file owns the shared types, the template schema and the defaults.
// priceTier / withAddOns / addOnQuantity live in tiers-price.ts; monthlyPaymentCents in tiers-finance.ts. Both are re-exported below.
import { z } from 'zod';
import { TIERS, ADD_ON_UNITS } from './proposals.ts';
import type { Tier, AddOnUnit } from './proposals.ts';
import type { Scope } from './pricing.ts';

export type AddOn = { name: string; unit: AddOnUnit; rateCents: number; taxable: boolean };
export type TierTemplate = { tier: Tier; name: string; material: Scope['material']; wastePercent: number; markupPercent: number | null; addOns: AddOn[]; highlights: string[]; enabled: boolean };
export type MeasuredQuantities = { squares: number; edgeFt: number; ridgeFt: number; valleyFt: number };

export const AddOnSchema = z.object({
  name: z.string().min(1).max(60),
  unit: z.enum(ADD_ON_UNITS),
  rateCents: z.number().int().min(0).max(1_000_000),
  taxable: z.boolean(),
});

export const TierTemplateSchema: z.ZodType<TierTemplate> = z.object({
  tier: z.enum(TIERS),
  name: z.string().min(1).max(60),
  material: z.enum(['architectural', 'premium', 'metal']),
  wastePercent: z.number().finite().min(0).max(50),
  markupPercent: z.number().finite().min(0).max(100).nullable(),
  addOns: z.array(AddOnSchema).max(8),
  highlights: z.array(z.string().min(1).max(60)).max(4),
  enabled: z.boolean(),
});

const STANDARD_ADD_ONS: AddOn[] = [
  { name: 'Ice & water shield', unit: 'per_edge_ft', rateCents: 250, taxable: true },
  { name: 'Ridge vent', unit: 'per_ridge_ft', rateCents: 600, taxable: true },
];

export const DEFAULT_TIER_TEMPLATES: readonly TierTemplate[] = [
  {
    tier: 'good',
    name: 'Architectural shingles',
    material: 'architectural',
    wastePercent: 12,
    markupPercent: null,
    addOns: [],
    highlights: ['Architectural shingles', 'Synthetic underlayment', 'Tear-off and cleanup'],
    enabled: true,
  },
  {
    tier: 'better',
    name: 'Architectural + protection',
    material: 'architectural',
    wastePercent: 12,
    markupPercent: null,
    addOns: STANDARD_ADD_ONS.map((a) => ({ ...a })),
    highlights: ['Architectural shingles', 'Synthetic underlayment', 'Ice & water shield at the edges', 'Ridge ventilation'],
    enabled: true,
  },
  {
    tier: 'best',
    name: 'Designer shingles',
    material: 'premium',
    wastePercent: 12,
    markupPercent: null,
    addOns: [
      ...STANDARD_ADD_ONS.map((a) => ({ ...a })),
      { name: 'Extended workmanship warranty', unit: 'per_job', rateCents: 45000, taxable: false },
    ],
    highlights: ['Designer shingles', 'Ice & water shield at the edges', 'Ridge ventilation', 'Extended warranty'],
    enabled: true,
  },
];

export * from './tiers-price.ts';
export * from './tiers-finance.ts';
