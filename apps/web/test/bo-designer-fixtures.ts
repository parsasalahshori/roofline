// A small price book and quote for the designer and visualizer tests (and the screenshot pass).
import { NO_SAFETY_ANSWERS, type BackofficeQuote, type OptionChoice, type Product, type ProductCatalog, type WindowDesign } from '@roofline/shared';
import { previewQuote } from '../src/features/backoffice/designer/pricing.ts';

const tiers3 = (good: number, better: number, best: number) => ({ good, better, best });

const product = (p: Partial<Product> & Pick<Product, 'id' | 'name' | 'openings'>): Product => ({
  kind: 'window',
  description: '',
  shapes: ['rect'],
  limits: { minWidthIn: 12, maxWidthIn: 72, minHeightIn: 12, maxHeightIn: 96, maxUnitedIn: 150 },
  maxSections: 3,
  price: { kind: 'united-inch', breaks: [{ maxUi: 60, cents: tiers3(30000, 36000, 44000) }, { maxUi: 100, cents: tiers3(42000, 50000, 60000) }, { maxUi: 150, cents: tiers3(60000, 72000, 86000) }] },
  perExtraSectionCents: tiers3(8000, 9000, 10000),
  archived: false,
  ...p,
});

const opt = (id: string, group: OptionChoice['group'], label: string, value: string, adder: OptionChoice['adder'], isDefault = false): OptionChoice => ({ id, group, label, value, adder, productIds: [], isDefault, archived: false });

export const catalogFixture: ProductCatalog = {
  version: 3,
  products: [
    product({ id: 'p-dh', name: 'WinChoice 5000 Double Hung', openings: ['hung-sash', 'fixed'], shapes: ['rect', 'arch-top'] }),
    product({ id: 'p-sl', name: 'WinChoice 3000 Slider', openings: ['slide-left', 'slide-right', 'fixed'], limits: { minWidthIn: 24, maxWidthIn: 144, minHeightIn: 12, maxHeightIn: 72, maxUnitedIn: 200 }, price: { kind: 'sq-ft', centsPerSqFt: tiers3(2400, 2900, 3400), minimumCents: tiers3(30000, 36000, 42000) } }),
    product({ id: 'p-cs', name: 'WinChoice 7000 Casement', openings: ['casement-left', 'casement-right', 'awning', 'hopper', 'fixed'], shapes: ['rect', 'arch-top', 'circle'] }),
    product({ id: 'p-old', name: 'Retired Single Hung', openings: ['hung-sash'], archived: true }),
  ],
  options: [
    opt('c-ext-white', 'exterior-color', 'White', 'white', { per: 'unit', cents: 0 }, true),
    opt('c-ext-bronze', 'exterior-color', 'Bronze', 'bronze', { per: 'unit', cents: 4500 }),
    opt('c-int-white', 'interior-color', 'White', 'white', { per: 'unit', cents: 0 }, true),
    opt('g-lowe', 'glass', 'Low-E with argon', 'lowe-argon', { per: 'unit', cents: 0 }, true),
    opt('g-triple', 'glass', 'Triple-pane Low-E', 'triple-lowe-argon', { per: 'sq-ft', cents: 600 }),
    opt('gr-none', 'grid', 'No grids', 'none', { per: 'lite', cents: 0 }, true),
    opt('gr-col', 'grid', 'Colonial grids', 'colonial', { per: 'lite', cents: 350 }),
    opt('s-half', 'screen', 'Half screen', 'half', { per: 'unit', cents: 0 }, true),
    opt('s-full', 'screen', 'Full screen', 'full', { per: 'unit', cents: 1800 }),
    opt('t-temp', 'tempered', 'Tempered glass', 'tempered', { per: 'sq-ft', cents: 500 }),
  ],
  accessories: [
    { id: 'a-dispose', label: 'Disposal of old windows', per: 'job', cents: 25000, autoAdd: true, archived: false },
    { id: 'a-cap', label: 'Exterior capping', per: 'linear-ft', cents: 600, autoAdd: false, archived: false },
    { id: 'a-permit', label: 'Permit', per: 'job', cents: 15000, autoAdd: false, archived: false },
  ],
  tiers: { good: { label: 'Good', note: 'Low-E glass, standard hardware' }, better: { label: 'Better', note: 'Argon fill and warm-edge spacers' }, best: { label: 'Best', note: 'Triple-pane comfort and the longest warranty' } },
  markupPercent: 10,
  maxRepDiscountPercent: 8,
};

export const design = (d: Partial<WindowDesign> & Pick<WindowDesign, 'id' | 'label' | 'productId' | 'layout'>): WindowDesign => ({
  quantity: 1,
  shape: 'rect',
  widthIn: 36,
  heightIn: 60,
  options: {},
  gridType: 'none',
  screen: 'half',
  safety: { ...NO_SAFETY_ANSWERS },
  sizeSource: { kind: 'typed' },
  notes: '',
  ...d,
});

export const designsFixture: WindowDesign[] = [
  design({
    id: 'd-great',
    label: 'Great room',
    productId: 'p-sl',
    widthIn: 108,
    heightIn: 54,
    gridType: 'colonial',
    options: { 'exterior-color': 'c-ext-bronze' },
    layout: {
      kind: 'split',
      id: 'split-great',
      direction: 'columns',
      parts: [
        { size: 36, layout: { kind: 'section', id: 'gs1', opening: 'slide-left', grid: '3x2' } },
        { size: 36, layout: { kind: 'section', id: 'gs2', opening: 'fixed', grid: '3x2' } },
        { size: null, layout: { kind: 'section', id: 'gs3', opening: 'slide-right', grid: '3x2' } },
      ],
    },
  }),
  design({ id: 'd-kitchen', label: 'Kitchen', productId: 'p-dh', widthIn: 35.5, heightIn: 59.5, gridType: 'colonial', layout: { kind: 'section', id: 'ks', opening: 'hung-sash', grid: '3x2/3x2' } }),
  design({ id: 'd-bath', label: 'Bath', productId: 'p-cs', widthIn: 24, heightIn: 36, layout: { kind: 'section', id: 'bs', opening: 'casement-left', grid: '' } }),
];

export function makeQuote(designs: WindowDesign[] = designsFixture, o: Partial<BackofficeQuote> = {}): BackofficeQuote {
  const base = { designs, accessories: [{ accessoryId: 'a-dispose', quantity: 1 }], discountPercent: 0 };
  return {
    id: 'q1',
    jobId: 'j1',
    customerName: 'Dana Whitfield',
    address: '4417 Larkspur Lane, Little Rock, AR',
    status: 'draft',
    tier: 'better',
    catalogVersion: 3,
    ...base,
    ...previewQuote(base, catalogFixture),
    createdAt: '2026-10-20T10:00:00.000Z',
    updatedAt: '2026-10-20T10:00:00.000Z',
    ...o,
  };
}
