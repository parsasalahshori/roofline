// Making, copying and changing a WindowDesign. Pure; ids come from the caller so tests stay deterministic.
import { NO_SAFETY_ANSWERS, type GridType, type Layout, type OpeningKind, type OptionGroup, type Product, type ProductCatalog, type ScreenType, type WindowDesign } from '@roofline/shared';
import { snapEighth } from '../drawing/inches.ts';
import { newLayoutId } from '../drawing/layout.ts';
import { choicesFor } from './pricing.ts';

export const GRID_TYPE_VALUES: readonly GridType[] = ['none', 'colonial', 'prairie', 'custom'];
export const SCREEN_VALUES: readonly ScreenType[] = ['none', 'half', 'full'];

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

/** The opening a brand new unit of a product starts with. */
export function defaultOpening(product: Product): OpeningKind {
  for (const pick of ['hung-sash', 'door-slide-left', 'fixed'] as const) if (product.openings.includes(pick)) return pick;
  return product.openings[0] ?? 'fixed';
}

export const firstProduct = (catalog: ProductCatalog): Product | undefined => catalog.products.find((p) => !p.archived);

/** A new unit: the first current product, a typical size inside its limits, one section, the product's default options. */
export function newDesign(catalog: ProductCatalog, label: string, makeId: () => string = newLayoutId): WindowDesign | null {
  const product = firstProduct(catalog);
  if (!product) return null;
  const l = product.limits;
  const door = product.kind === 'patio-door';
  const draft: WindowDesign = {
    id: makeId(),
    label,
    productId: product.id,
    quantity: 1,
    shape: product.shapes.includes('rect') ? 'rect' : (product.shapes[0] ?? 'rect'),
    widthIn: snapEighth(clamp(door ? 72 : 36, l.minWidthIn, l.maxWidthIn)),
    heightIn: snapEighth(clamp(door ? 80 : 48, l.minHeightIn, l.maxHeightIn)),
    layout: { kind: 'section', id: makeId(), opening: defaultOpening(product), grid: '' },
    options: {},
    gridType: 'none',
    screen: 'none',
    safety: { ...NO_SAFETY_ANSWERS },
    sizeSource: { kind: 'typed' },
    notes: '',
  };
  const grid = choicesFor(catalog, 'grid', product.id).find((c) => c.isDefault);
  const screen = choicesFor(catalog, 'screen', product.id).find((c) => c.isDefault);
  return { ...draft, gridType: asGrid(grid?.value) ?? 'none', screen: asScreen(screen?.value) ?? 'none' };
}

export const asGrid = (v: string | undefined): GridType | null => (GRID_TYPE_VALUES as readonly string[]).includes(v ?? '') ? (v as GridType) : null;
export const asScreen = (v: string | undefined): ScreenType | null => (SCREEN_VALUES as readonly string[]).includes(v ?? '') ? (v as ScreenType) : null;

function cloneLayout(layout: Layout, makeId: () => string): Layout {
  if (layout.kind === 'section') return { ...layout, id: makeId() };
  return { ...layout, id: makeId(), parts: layout.parts.map((p) => ({ ...p, layout: cloneLayout(p.layout, makeId) })) };
}

/** A copy of a unit with its own ids (a typed size, since a measurement belongs to the original window). */
export function duplicateDesign(design: WindowDesign, label: string, makeId: () => string = newLayoutId): WindowDesign {
  return { ...design, id: makeId(), label, layout: cloneLayout(design.layout, makeId), options: { ...design.options }, safety: { ...design.safety }, sizeSource: design.sizeSource };
}

/** Choose an option; the grid and screen groups also set the design's own gridType / screen the factory reads. */
export function chooseOption(catalog: ProductCatalog, design: WindowDesign, group: OptionGroup, choiceId: string): WindowDesign {
  const choice = choicesFor(catalog, group, design.productId).find((c) => c.id === choiceId);
  // Grid and screen are the unit's own fields (the factory values); every other group is the chosen option's id
  if (group === 'grid') return { ...design, gridType: asGrid(choice?.value) ?? design.gridType };
  if (group === 'screen') return { ...design, screen: asScreen(choice?.value) ?? design.screen };
  if (choiceId === '') {
    const rest = { ...design.options };
    delete rest[group];
    return { ...design, options: rest };
  }
  return { ...design, options: { ...design.options, [group]: choiceId } };
}

/**
 * Change a unit's product: keeps what still fits (size inside the new limits, shape and openings the product allows,
 * options that apply to it).
 */
export function changeProduct(catalog: ProductCatalog, design: WindowDesign, productId: string): WindowDesign {
  const product = catalog.products.find((p) => p.id === productId);
  if (!product) return design;
  const l = product.limits;
  const fixOpening = (layout: Layout): Layout =>
    layout.kind === 'section'
      ? product.openings.includes(layout.opening)
        ? layout
        : { ...layout, opening: defaultOpening(product) }
      : { ...layout, parts: layout.parts.map((p) => ({ ...p, layout: fixOpening(p.layout) })) };
  const options: WindowDesign['options'] = {};
  for (const [group, id] of Object.entries(design.options) as [OptionGroup, string][]) {
    if (choicesFor(catalog, group, productId).some((c) => c.id === id)) options[group] = id;
  }
  return {
    ...design,
    productId,
    shape: product.shapes.includes(design.shape) ? design.shape : (product.shapes[0] ?? 'rect'),
    widthIn: design.sizeSource.kind === 'measured' ? design.widthIn : snapEighth(clamp(design.widthIn, l.minWidthIn, l.maxWidthIn)),
    heightIn: design.sizeSource.kind === 'measured' ? design.heightIn : snapEighth(clamp(design.heightIn, l.minHeightIn, l.maxHeightIn)),
    layout: fixOpening(design.layout),
    options,
  };
}

/** The grid patterns offered in the section picker: none, then every width x height up to 4 x 4. */
export const GRID_PATTERNS: readonly string[] = ['', ...[1, 2, 3, 4].flatMap((across) => [1, 2, 3, 4].filter((down) => across * down > 1).map((down) => `${across}x${down}`))];
