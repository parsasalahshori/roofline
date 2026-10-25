import { z } from 'zod';
import {
  GRID_TYPES,
  MAX_NOTES_LENGTH,
  OPENING_KINDS,
  OPTION_GROUPS,
  ORDER_STAGES,
  PRODUCT_KINDS,
  SCREEN_TYPES,
  TIERS,
  UNIT_SHAPES,
  WINDOW_STYLES,
  type BackofficeSettings,
  type Layout,
  type ProductCatalog,
  type WindowDesign,
} from '@roofline/shared';
import { noNul, UUID } from '../validate.ts';

/*
 * Request shapes for /api/backoffice. They check the form of what a person sends (types, ranges, lengths, ids); what a
 * drawing or a price book MEANS (a unit too wide for its product, a section that does not fit) is not refused here: the
 * shared validateDesign reports it as an issue on the quote, so an unfinished drawing can still be saved.
 */

const text = (max: number) => z.string().max(max).refine(noNul);
const ID = z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/);
const inches = z.number().finite().min(0).max(1000);
const cents = z.number().int().min(0).max(100_000_000);
const byTier = <T extends z.ZodType>(t: T) => z.object({ good: t, better: t, best: t }).strict();

/* Designs ------------------------------------------------------------------------------------------------------ */

const MAX_DEPTH = 4;
const MAX_PARTS = 6;
const PATTERNS = /^[0-9x/]{0,16}$/;

const SectionSchema = z.object({ kind: z.literal('section'), id: ID, opening: z.enum(OPENING_KINDS), grid: z.string().regex(PATTERNS) }).strict();

type LayoutIn = z.infer<typeof SectionSchema> | { kind: 'split'; id: string; direction: 'columns' | 'rows'; parts: { size: number | null; layout: LayoutIn }[] };
const LayoutSchema: z.ZodType<LayoutIn> = z.lazy(() =>
  z.union([
    SectionSchema,
    z
      .object({
        kind: z.literal('split'),
        id: ID,
        direction: z.enum(['columns', 'rows']),
        parts: z.array(z.object({ size: z.number().finite().min(0).max(1000).nullable(), layout: LayoutSchema }).strict()).min(1).max(MAX_PARTS),
      })
      .strict(),
  ]),
);

function layoutDepth(l: Layout): number {
  return l.kind === 'section' ? 1 : 1 + Math.max(...l.parts.map((p) => layoutDepth(p.layout)));
}

const DesignSchema = z
  .object({
    id: ID,
    label: text(80),
    productId: text(64),
    quantity: z.number().int().min(0).max(999),
    shape: z.enum(UNIT_SHAPES),
    widthIn: inches,
    heightIn: inches,
    layout: LayoutSchema.refine((l) => layoutDepth(l as Layout) <= MAX_DEPTH),
    options: z.partialRecord(z.enum(OPTION_GROUPS), text(64)),
    gridType: z.enum(GRID_TYPES),
    screen: z.enum(SCREEN_TYPES),
    safety: z
      .object({
        besideDoor: z.boolean().nullable(),
        wetArea: z.boolean().nullable(),
        sillHeightIn: z.number().finite().min(0).max(240).nullable(),
        walkway: z.boolean().nullable(),
      })
      .strict(),
    sizeSource: z.union([
      z.object({ kind: z.literal('typed') }).strict(),
      z.object({ kind: z.literal('measured'), windowMeasurementId: z.string().regex(UUID), lineId: ID }).strict(),
    ]),
    notes: text(MAX_NOTES_LENGTH),
  })
  .strict();

export const DesignsSchema = z.array(DesignSchema).max(120);
export const parseDesigns = (raw: unknown) => DesignsSchema.safeParse(raw) as { success: true; data: WindowDesign[] } | { success: false; error: z.ZodError };

const AccessoryEntry = z.object({ accessoryId: ID, quantity: z.number().int().min(1).max(99) }).strict();

export const UpdateQuoteSchema = z
  .object({
    status: z.enum(['draft', 'presented', 'declined']).optional(),
    tier: z.enum(TIERS),
    designs: DesignsSchema,
    accessories: z.array(AccessoryEntry).max(40),
    discountPercent: z.number().finite().min(0).max(100),
  });
// Not strict: a client may send back the whole quote it read (lines, totals, issues); the server ignores everything it computes.

export const CreateQuoteSchema = z
  .object({
    jobId: z.string().regex(UUID),
    tier: z.enum(TIERS).optional(),
    importMeasured: z.boolean().optional(),
    windowMeasurementId: z.string().regex(UUID).optional(),
  })
  .strict();

/* Visual ------------------------------------------------------------------------------------------------------- */

const corner = z.tuple([z.number().finite().min(-1).max(2), z.number().finite().min(-1).max(2)]);
export const VisualSchema = z
  .object({
    quoteId: z.string().optional(),
    photoUploadId: z.string().regex(UUID).nullable(),
    placements: z.array(z.object({ id: ID, designId: ID, corners: z.tuple([corner, corner, corner, corner]) }).strict()).max(120),
    updatedAt: z.string().optional(),
  });

/* Catalog ------------------------------------------------------------------------------------------------------ */

const PriceRuleSchema = z.union([
  z
    .object({
      kind: z.literal('united-inch'),
      breaks: z.array(z.object({ maxUi: z.number().finite().min(1).max(1000), cents: byTier(cents) }).strict()).min(1).max(40),
    })
    .strict(),
  z.object({ kind: z.literal('sq-ft'), centsPerSqFt: byTier(cents), minimumCents: byTier(cents) }).strict(),
]);

const ProductSchema = z
  .object({
    id: ID,
    kind: z.enum(PRODUCT_KINDS),
    name: text(80).refine((s) => s.trim() !== ''),
    description: text(300),
    openings: z.array(z.enum(OPENING_KINDS)).min(1).max(OPENING_KINDS.length),
    shapes: z.array(z.enum(UNIT_SHAPES)).min(1).max(UNIT_SHAPES.length),
    limits: z
      .object({
        minWidthIn: z.number().finite().min(1).max(1000),
        maxWidthIn: z.number().finite().min(1).max(1000),
        minHeightIn: z.number().finite().min(1).max(1000),
        maxHeightIn: z.number().finite().min(1).max(1000),
        maxUnitedIn: z.number().finite().min(1).max(2000),
      })
      .strict()
      .refine((l) => l.minWidthIn <= l.maxWidthIn && l.minHeightIn <= l.maxHeightIn),
    maxSections: z.number().int().min(1).max(8),
    price: PriceRuleSchema,
    factoryStyle: z.enum(WINDOW_STYLES).optional(),
    perExtraSectionCents: byTier(cents),
    archived: z.boolean(),
  })
  .strict();

const OptionSchema = z
  .object({
    id: ID,
    group: z.enum(OPTION_GROUPS),
    label: text(80).refine((s) => s.trim() !== ''),
    value: text(64),
    adder: z.object({ per: z.enum(['unit', 'section', 'lite', 'sq-ft']), cents }).strict(),
    productIds: z.array(ID).max(60),
    isDefault: z.boolean(),
    archived: z.boolean(),
  })
  .strict();

const AccessorySchema = z
  .object({ id: ID, label: text(80).refine((s) => s.trim() !== ''), per: z.enum(['job', 'unit', 'linear-ft']), cents, autoAdd: z.boolean(), archived: z.boolean() })
  .strict();

const tierLabel = z.object({ label: text(40).refine((s) => s.trim() !== ''), note: text(200) }).strict();

const unique = (ids: string[]): boolean => new Set(ids).size === ids.length;

export const CatalogSchema = z
  .object({
    version: z.number().int().optional(),
    products: z.array(ProductSchema).max(60),
    options: z.array(OptionSchema).max(300),
    accessories: z.array(AccessorySchema).max(60),
    tiers: byTier(tierLabel),
    markupPercent: z.number().finite().min(0).max(300),
    maxRepDiscountPercent: z.number().finite().min(0).max(100),
  })
  .strict()
  .refine((c) => unique(c.products.map((p) => p.id)) && unique(c.options.map((o) => o.id)) && unique(c.accessories.map((a) => a.id)));

export const parseCatalog = (raw: unknown) => CatalogSchema.safeParse(raw) as { success: true; data: Omit<ProductCatalog, 'version'> } | { success: false; error: z.ZodError };

/* Settings ----------------------------------------------------------------------------------------------------- */

export const SettingsSchema = z
  .object({
    templates: z
      .array(z.object({ stage: z.enum(ORDER_STAGES), enabled: z.boolean(), sms: text(320), emailSubject: text(200), emailBody: text(4000) }).strict())
      .max(ORDER_STAGES.length)
      .refine((l) => unique(l.map((t) => t.stage))),
    stuckDays: z.partialRecord(z.enum(ORDER_STAGES), z.number().int().min(1).max(365)),
  })
  .strict();

export const parseSettings = (raw: unknown) => SettingsSchema.safeParse(raw) as { success: true; data: BackofficeSettings } | { success: false; error: z.ZodError };

/* Orders ------------------------------------------------------------------------------------------------------- */

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s));

export const StageMoveSchema = z.object({ stage: z.enum(ORDER_STAGES), note: text(500), plannedFor: ymd.nullable(), notify: z.boolean() }).strict();
