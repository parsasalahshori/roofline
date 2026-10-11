import { z } from 'zod';
import { scopeSchema, pricebookSchema, type Pricebook, type Calculation } from './pricing.ts';

export const measurementSchema = z.object({
  address: z.string().trim().min(5).max(300),
  areaSqFt: z.number().finite().positive().max(100000),
  areaType: z.enum(['surface', 'footprint']).default('surface'),
  pitch: z.number().finite().min(0).max(24),
  ridgeFt: z.number().finite().min(0).max(10000).default(0),
  edgeFt: z.number().finite().min(0).max(10000).default(0),
  valleyFt: z.number().finite().min(0).max(10000).default(0),
  facets: z.number().int().min(1).max(1000).optional(),
  reference: z.string().max(200).default(''),
  notes: z.string().max(2000).default(''),
});
export type Measurement = z.infer<typeof measurementSchema> & { id: string; source: 'demo' | 'manual' | 'import' | 'eagleview' | 'eagleview-sandbox'; createdAt: string };
export const customerSchema = z.object({ name: z.string().trim().min(1).max(150), email: z.union([z.email(), z.literal('')]).default(''), phone: z.string().max(40).default('') });
export const reviewSchema = z.object({ property: z.boolean(), measurements: z.boolean(), scope: z.boolean() });
export const quoteInputSchema = z.object({
  measurementId: z.string().min(1), scope: scopeSchema, customer: customerSchema,
  notes: z.string().max(3000).default(''), review: reviewSchema,
  previewPricebook: pricebookSchema.optional(),
});
export type QuoteInput = z.infer<typeof quoteInputSchema>;
export type Status = 'draft' | 'ready' | 'sent' | 'accepted' | 'declined';
export type Company = { name: string; email: string; phone: string; address: string; license: string; proposalDays: number };
export const companySchema = z.object({name:z.string().trim().min(1).max(150),email:z.union([z.email(),z.literal('')]),phone:z.string().max(40),address:z.string().max(300),license:z.string().max(100),proposalDays:z.number().int().min(1).max(180)});
export type Quote = QuoteInput & { id: string; number: string; createdAt: string; updatedAt: string; status: Status; measurement: Measurement; calculation: Calculation; pricebook: Pricebook; company: Company; validUntil: string };
export type Connector = { id: string; name: string; description: string; configured: boolean; setup: string; docs: string };
export type FollowUp = {id:string;quoteId:string;dueDate:string;note:string;done:boolean;createdAt:string;updatedAt:string};
