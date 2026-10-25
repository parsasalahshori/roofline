// WinChoice back office: the pure logic behind the designer and the quote. No database, no network: the API runs it to
// recompute every quote (the browser's numbers are never trusted) and the web app runs the same code to preview.
//
// - Layout: a unit's sections in order, each section's rectangle (inches, origin top-left of the outer frame), lites.
// - validateDesign: product limits, openings and shape allowed, section count, split sizes that fit, grid patterns,
//   options that exist, and safety-glass suggestions (temperedSuggestions).
// - priceDesign: the product's price rule + per-extra-section and option adders, for a tier.
// - priceQuote: lines and totals for all three tiers, with accessories, markup, discount and the approval flag.
//
// Money is in whole cents; sizes in inches. Every rounding is to the nearest cent, half up.
import type {
  Accessory,
  BackofficeQuoteLine,
  DesignIssue,
  Layout,
  OpeningKind,
  OptionChoice,
  OptionGroup,
  Product,
  ProductCatalog,
  QuoteTotals,
  Section,
  WindowDesign,
} from './backoffice.ts';
import { OPTION_GROUPS } from './backoffice.ts';
import { inchesInEighths } from './homeowner.ts';
import { TIERS, type Tier } from './proposals.ts';
import { GRID_PATTERN, MAX_ORDER_QUANTITY, temperedSuggestions, type WindowStyle } from './window-order.ts';

/* ------------------------------------------------------------------------------------------------------------------ */
/* Layout                                                                                                              */
/* ------------------------------------------------------------------------------------------------------------------ */

/** A rectangle in inches; the origin is the top-left of the unit's outer frame, y grows downward. */
export type RectIn = { x: number; y: number; w: number; h: number };

export type PlacedSection = { section: Section; /** 0-based, left to right and top to bottom. */ index: number; rect: RectIn };

/** The smallest a section may be along a split, inches (a sash narrower than this cannot be built). */
export const MIN_SECTION_IN = 4;

/** Every part of a split's size along the split, inches: numbers as given, null parts share what is left. */
export function splitExtents(parts: readonly { size: number | null }[], extent: number): number[] {
  const given = parts.reduce((sum, p) => sum + (p.size ?? 0), 0);
  const open = parts.filter((p) => p.size === null).length;
  const left = Math.max(0, extent - given);
  const sizes = parts.map((p) => (p.size === null ? left / open : p.size));
  // No open part: the last one takes what is left, so the sections always fill the frame.
  if (open === 0 && sizes.length > 0 && given < extent) sizes[sizes.length - 1] = sizes[sizes.length - 1]! + (extent - given);
  return sizes;
}

function place(layout: Layout, rect: RectIn, out: PlacedSection[]): void {
  if (layout.kind === 'section') {
    out.push({ section: layout, index: out.length, rect });
    return;
  }
  const columns = layout.direction === 'columns';
  const sizes = splitExtents(layout.parts, columns ? rect.w : rect.h);
  let at = 0;
  layout.parts.forEach((part, i) => {
    const size = sizes[i]!;
    place(part.layout, columns ? { x: rect.x + at, y: rect.y, w: size, h: rect.h } : { x: rect.x, y: rect.y + at, w: rect.w, h: size }, out);
    at += size;
  });
}

/** The unit's sections in order (columns left to right, rows top to bottom), each with its rectangle in inches. */
export function layoutSections(design: Pick<WindowDesign, 'widthIn' | 'heightIn' | 'layout'>): PlacedSection[] {
  const out: PlacedSection[] = [];
  place(design.layout, { x: 0, y: 0, w: design.widthIn, h: design.heightIn }, out);
  return out;
}

/** The sections of a layout in order, without sizes. */
export function sectionsOf(layout: Layout): Section[] {
  if (layout.kind === 'section') return [layout];
  return layout.parts.flatMap((p) => sectionsOf(p.layout));
}

/** A grid pattern's lites: "3x2" is 6; '' (or anything else) is 0. */
export function patternLites(pattern: string): number {
  const m = /^([1-9])x([1-9])$/.exec(pattern);
  return m ? Number(m[1]) * Number(m[2]) : 0;
}

/** The grid patterns of a section's sashes: a hung window is "top/bottom" (two); every other opening has one. */
export function sashPatterns(section: Pick<Section, 'opening' | 'grid'>): string[] {
  if (section.opening !== 'hung-sash') return [section.grid];
  const [top = '', bottom = ''] = section.grid.split('/');
  return [top, bottom];
}

/** The panes (lites) of a section, a sash with no grid being one pane: a 3x2 grid on a single sash is 6. */
export function liteCount(section: Pick<Section, 'opening' | 'grid'>): number {
  return sashPatterns(section).reduce((sum, p) => sum + Math.max(1, patternLites(p)), 0);
}

/** The lites a grid divides: the ones in sashes that have a pattern (0 for a section with no grid). */
export function gridLiteCount(section: Pick<Section, 'opening' | 'grid'>): number {
  return sashPatterns(section).reduce((sum, p) => sum + patternLites(p), 0);
}

/** The unit's outer frame area, square feet (a shaped unit is priced by its bounding rectangle). */
export const designSqFt = (d: Pick<WindowDesign, 'widthIn' | 'heightIn'>): number => (d.widthIn * d.heightIn) / 144;

/** Width + height, rounded up to a whole united inch. */
export const unitedInches = (d: Pick<WindowDesign, 'widthIn' | 'heightIn'>): number => Math.ceil(d.widthIn + d.heightIn - 1e-9);

/** The distance round the outer frame, feet (trim goes round it). */
export const unitPerimeterFt = (d: Pick<WindowDesign, 'widthIn' | 'heightIn'>): number => (2 * (d.widthIn + d.heightIn)) / 12;

/** A layout for a factory style at a width: a hung window is one section, a slider is its sashes side by side. */
export function layoutForStyle(style: WindowStyle | null, widthIn: number, grid: { top: string; bottom: string } = { top: '', bottom: '' }): Layout {
  const one = (id: string, opening: OpeningKind, g: string): Section => ({ kind: 'section', id, opening, grid: g });
  switch (style) {
    case 'double-hung':
    case 'single-hung':
      return one('s1', 'hung-sash', `${grid.top}/${grid.bottom}`);
    case 'slider-2':
      return {
        kind: 'split',
        id: 'root',
        direction: 'columns',
        parts: [
          { size: Math.round((widthIn / 2) * 8) / 8, layout: one('s1', 'slide-right', grid.top) },
          { size: null, layout: one('s2', 'slide-left', grid.bottom) },
        ],
      };
    case 'slider-3': {
      const third = Math.round((widthIn / 3) * 8) / 8;
      return {
        kind: 'split',
        id: 'root',
        direction: 'columns',
        parts: [
          { size: third, layout: one('s1', 'slide-right', grid.top) },
          { size: third, layout: one('s2', 'fixed', '') },
          { size: null, layout: one('s3', 'slide-left', grid.bottom) },
        ],
      };
    }
    case 'casement':
      return one('s1', 'casement-left', grid.top);
    case 'awning':
      return one('s1', 'awning', grid.top);
    default:
      return one('s1', 'fixed', grid.top);
  }
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Descriptions                                                                                                        */
/* ------------------------------------------------------------------------------------------------------------------ */

/** Inches with a fraction to 1/8 in: 35.5 is "35 1/2". */
export const sizeText = (inches: number): string => inchesInEighths(inches);

/** "35 1/2 x 59 1/2" */
export const sizeLine = (d: Pick<WindowDesign, 'widthIn' | 'heightIn'>): string => `${sizeText(d.widthIn)} x ${sizeText(d.heightIn)}`;

const productOf = (catalog: ProductCatalog, id: string): Product | undefined => catalog.products.find((p) => p.id === id);

const appliesTo = (o: OptionChoice, product: Product): boolean => o.productIds.length === 0 || o.productIds.includes(product.id);

/**
 * The option a group stands at for a design. 'grid' and 'screen' follow the design's own gridType and screen (the
 * factory values); every other group is the design's chosen option, else the group's default for the product. An
 * unknown option id answers null (validateDesign reports it).
 */
export function chosenOption(design: WindowDesign, product: Product, catalog: ProductCatalog, group: OptionGroup): OptionChoice | null {
  const inGroup = catalog.options.filter((o) => o.group === group);
  if (group === 'grid' || group === 'screen') {
    const wanted = group === 'grid' ? design.gridType : design.screen;
    const fits = inGroup.filter((o) => o.value === wanted && appliesTo(o, product));
    return fits.find((o) => !o.archived) ?? fits[0] ?? null;
  }
  const id = design.options[group];
  if (id !== undefined && id !== '') return inGroup.find((o) => o.id === id) ?? null;
  return inGroup.find((o) => o.isDefault && !o.archived && appliesTo(o, product)) ?? null;
}

/** The chosen options of every group, in OPTION_GROUPS order, leaving out groups with none. */
export function chosenOptions(design: WindowDesign, product: Product, catalog: ProductCatalog): OptionChoice[] {
  return OPTION_GROUPS.flatMap((g) => chosenOption(design, product, catalog, g) ?? []);
}

/** The grid in words: "Colonial grids 3x2/3x2", "" when the unit has none. */
export function gridText(design: WindowDesign, catalog: ProductCatalog, product: Product | undefined): string {
  if (design.gridType === 'none') return '';
  const patterns = [...new Set(sectionsOf(design.layout).flatMap((s) => sashPatterns(s)).filter((p) => p !== ''))];
  const option = product ? chosenOption(design, product, catalog, 'grid') : null;
  const name = option?.label ?? `${design.gridType[0]!.toUpperCase()}${design.gridType.slice(1)} grids`;
  return patterns.length > 0 ? `${name} ${patterns.join(', ')}` : name;
}

/**
 * The line a unit makes on a quote: "Kitchen: WinChoice 5000 Double Hung 35 1/2 x 59 1/2, Bronze exterior, Colonial
 * grids 3x2". The exterior color is always named; other options when they are not the product's default.
 */
export function describeDesign(design: WindowDesign, catalog: ProductCatalog): string {
  const product = productOf(catalog, design.productId);
  if (!product) return `${design.label}: unknown product ${sizeLine(design)}`;
  const parts: string[] = [];
  const exterior = chosenOption(design, product, catalog, 'exterior-color');
  if (exterior) parts.push(exterior.label);
  for (const group of OPTION_GROUPS) {
    if (group === 'exterior-color' || group === 'grid' || group === 'screen') continue;
    const o = chosenOption(design, product, catalog, group);
    if (o && !o.isDefault) parts.push(o.label);
  }
  const grid = gridText(design, catalog, product);
  if (grid !== '') parts.push(grid);
  const shape = design.shape === 'rect' ? '' : design.shape === 'arch-top' ? ' (arch top)' : ' (round)';
  return `${design.label}: ${product.name}${shape} ${sizeLine(design)}${parts.length > 0 ? `, ${parts.join(', ')}` : ''}`;
}

/** The factory style of a unit: the product's, else read from its shape and sections. */
export function styleOfDesign(design: WindowDesign, product: Product | undefined): WindowStyle {
  if (product?.factoryStyle) return product.factoryStyle;
  if (design.shape === 'arch-top') return 'arch';
  if (design.shape === 'circle') return 'circle';
  const sections = sectionsOf(design.layout);
  if (sections.some((s) => s.opening === 'hung-sash')) return 'double-hung';
  if (sections.some((s) => s.opening.startsWith('slide') || s.opening === 'door-slide-left' || s.opening === 'door-slide-right')) return sections.length >= 3 ? 'slider-3' : 'slider-2';
  if (sections.some((s) => s.opening.startsWith('casement'))) return 'casement';
  if (sections.some((s) => s.opening === 'awning' || s.opening === 'hopper')) return 'awning';
  return 'picture';
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Validation                                                                                                          */
/* ------------------------------------------------------------------------------------------------------------------ */

function checkSplits(layout: Layout, w: number, h: number, issue: (message: string) => void): void {
  if (layout.kind === 'section') return;
  const columns = layout.direction === 'columns';
  const extent = columns ? w : h;
  const along = columns ? 'wide' : 'high';
  const sizes = layout.parts.map((p) => p.size);
  if (sizes.some((s) => s !== null && !(Number.isFinite(s) && s > 0))) {
    issue('A split size must be more than 0 inches.');
    return;
  }
  const given = sizes.reduce<number>((sum, s) => sum + (s ?? 0), 0);
  const open = sizes.filter((s) => s === null).length;
  if (given + open * MIN_SECTION_IN > extent + 1e-9) {
    issue(`The split sizes (${sizeText(given)} in) do not fit a unit ${sizeText(extent)} in ${along}.`);
    return;
  }
  const extents = splitExtents(layout.parts, extent);
  if (extents.some((e) => e < MIN_SECTION_IN - 1e-9)) issue(`A section would be under ${MIN_SECTION_IN} in ${along}.`);
  layout.parts.forEach((part, i) => checkSplits(part.layout, columns ? extents[i]! : w, columns ? h : extents[i]!, issue));
}

const SAFETY_NOTE = ' Pick tempered glass on the unit, or answer the safety questions again.';

/**
 * What is wrong with a drawn unit, for the designer to show beside it. 'error' blocks accepting the quote; 'warning'
 * (a safety-glass suggestion, a grid that will be ignored) does not.
 */
export function validateDesign(design: WindowDesign, catalog: ProductCatalog): DesignIssue[] {
  const out: DesignIssue[] = [];
  const add = (level: DesignIssue['level'], field: string, message: string) => out.push({ designId: design.id, level, field, message });
  const product = productOf(catalog, design.productId);
  if (!product) {
    add('error', 'productId', 'Pick a product for this unit.');
    return out;
  }
  if (product.archived) add('warning', 'productId', `${product.name} is no longer on the price sheet.`);
  if (design.label.trim() === '') add('warning', 'label', 'Name the room or location.');
  if (!Number.isInteger(design.quantity) || design.quantity < 1 || design.quantity > MAX_ORDER_QUANTITY) add('error', 'quantity', `Quantity must be 1 to ${MAX_ORDER_QUANTITY}.`);
  if (!product.shapes.includes(design.shape)) add('error', 'shape', `${product.name} cannot be built as ${design.shape === 'rect' ? 'a rectangle' : design.shape === 'arch-top' ? 'an arch top' : 'a circle'}.`);

  const { limits } = product;
  const w = design.widthIn;
  const h = design.heightIn;
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
    add('error', 'widthIn', 'Enter the width and height in inches.');
  } else {
    if (w < limits.minWidthIn) add('error', 'widthIn', `Too narrow for this product: ${sizeText(limits.minWidthIn)} in minimum.`);
    if (w > limits.maxWidthIn) add('error', 'widthIn', `Too wide for this product: ${sizeText(limits.maxWidthIn)} in max.`);
    if (h < limits.minHeightIn) add('error', 'heightIn', `Too short for this product: ${sizeText(limits.minHeightIn)} in minimum.`);
    if (h > limits.maxHeightIn) add('error', 'heightIn', `Too tall for this product: ${sizeText(limits.maxHeightIn)} in max.`);
    if (unitedInches(design) > limits.maxUnitedIn) add('error', 'widthIn', `${unitedInches(design)} united inches is over the ${limits.maxUnitedIn} largest for this product.`);
    if (design.shape === 'circle' && Math.abs(w - h) > 1 / 16) add('error', 'heightIn', 'A round unit has the same width and height.');
  }

  const sections = sectionsOf(design.layout);
  if (sections.length > product.maxSections) add('error', 'layout', `This product has ${product.maxSections === 1 ? 'one section' : `at most ${product.maxSections} sections`}: ${sections.length} are drawn.`);
  for (const s of sections) {
    if (!product.openings.includes(s.opening)) add('error', 'layout', `This product does not have a ${s.opening.replace(/-/g, ' ')} opening.`);
  }
  if (w > 0 && h > 0) checkSplits(design.layout, w, h, (m) => add('error', 'layout', m));

  const patterns = sections.flatMap((s) => sashPatterns(s));
  if (!patterns.every((p) => GRID_PATTERN.test(p))) add('error', 'grid', 'Grid patterns look like 3x2 (lites wide x high).');
  else if (design.gridType !== 'none' && patterns.every((p) => p === '')) add('warning', 'grid', 'Give a grid pattern for at least one sash, or pick no grid.');
  else if (design.gridType === 'none' && patterns.some((p) => p !== '')) add('warning', 'grid', 'A grid pattern is drawn but the grid type is none: no grid will be built.');

  for (const group of OPTION_GROUPS) {
    if (group === 'grid' || group === 'screen') continue;
    const id = design.options[group];
    if (id === undefined || id === '') continue;
    const option = catalog.options.find((o) => o.id === id && o.group === group);
    if (!option) add('error', 'options', `Option "${id}" is not on the price sheet for ${group.replace('-', ' ')}.`);
    else if (!appliesTo(option, product)) add('error', 'options', `${option.label} is not offered on ${product.name}.`);
  }
  for (const group of ['grid', 'screen'] as const) {
    const wanted = group === 'grid' ? design.gridType : design.screen;
    if (wanted !== 'none' && chosenOption(design, product, catalog, group) === null) add('warning', group, `No price for ${wanted} ${group === 'grid' ? 'grids' : 'screens'} on ${product.name}: nothing is added.`);
  }

  const tempered = chosenOption(design, product, catalog, 'tempered') !== null;
  if (!tempered && w > 0 && h > 0) {
    for (const s of temperedSuggestions({ safety: design.safety, style: styleOfDesign(design, product) }, { widthIn: w, heightIn: h })) {
      add('warning', 'safety', `${s.message}${SAFETY_NOTE}`);
    }
  }
  return out;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Pricing a unit                                                                                                      */
/* ------------------------------------------------------------------------------------------------------------------ */

const round = (n: number): number => Math.round(n);

/** The product's price for a size and tier before section and option adders, cents. */
export function baseCents(product: Product, tier: Tier, design: Pick<WindowDesign, 'widthIn' | 'heightIn'>): number {
  const rule = product.price;
  if (rule.kind === 'sq-ft') return Math.max(rule.minimumCents[tier], round(rule.centsPerSqFt[tier] * designSqFt(design)));
  const ui = unitedInches(design);
  const breaks = [...rule.breaks].sort((a, b) => a.maxUi - b.maxUi);
  const found = breaks.find((b) => ui <= b.maxUi) ?? breaks[breaks.length - 1];
  return found?.cents[tier] ?? 0;
}

/** One adder on a priced unit, per unit (not yet multiplied by the quantity). */
export type PricePart = { kind: 'base' | 'sections' | 'option'; label: string; cents: number; optionId?: string };

export type DesignPrice = {
  designId: string;
  tier: Tier;
  quantity: number;
  /** What one unit costs, all adders in. */
  unitCents: number;
  /** unitCents x quantity */
  amountCents: number;
  parts: PricePart[];
  /** The quote line (one per unit): same as lines[0]. */
  line: BackofficeQuoteLine;
  lines: BackofficeQuoteLine[];
};

function adderCents(o: OptionChoice, design: WindowDesign): number {
  switch (o.adder.per) {
    case 'unit':
      return o.adder.cents;
    case 'section':
      return o.adder.cents * sectionsOf(design.layout).length;
    case 'lite':
      return design.gridType === 'none' ? 0 : o.adder.cents * sectionsOf(design.layout).reduce((sum, s) => sum + gridLiteCount(s), 0);
    case 'sq-ft':
      return round(o.adder.cents * designSqFt(design));
  }
}

/** A unit's price for a tier: the product's rule, the extra sections, and every chosen option's adder. */
export function priceDesign(design: WindowDesign, catalog: ProductCatalog, tier: Tier): DesignPrice {
  const product = productOf(catalog, design.productId);
  const quantity = Number.isInteger(design.quantity) && design.quantity > 0 ? design.quantity : 0;
  const parts: PricePart[] = [];
  if (product) {
    parts.push({ kind: 'base', label: product.name, cents: baseCents(product, tier, design) });
    const extra = Math.max(0, sectionsOf(design.layout).length - 1);
    if (extra > 0 && product.perExtraSectionCents[tier] > 0) parts.push({ kind: 'sections', label: `${extra} extra section${extra === 1 ? '' : 's'}`, cents: extra * product.perExtraSectionCents[tier] });
    for (const o of chosenOptions(design, product, catalog)) {
      const cents = adderCents(o, design);
      if (cents !== 0) parts.push({ kind: 'option', label: o.label, cents, optionId: o.id });
    }
  }
  const unitCents = parts.reduce((sum, p) => sum + p.cents, 0);
  const line: BackofficeQuoteLine = {
    designId: design.id,
    accessoryId: null,
    description: describeDesign(design, catalog),
    quantity,
    unitCents,
    amountCents: unitCents * quantity,
  };
  return { designId: design.id, tier, quantity, unitCents, amountCents: line.amountCents, parts, line, lines: [line] };
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Pricing a quote                                                                                                     */
/* ------------------------------------------------------------------------------------------------------------------ */

/** The units a quote's drawings add up to. */
export const totalUnits = (designs: readonly WindowDesign[]): number => designs.reduce((sum, d) => sum + (Number.isInteger(d.quantity) && d.quantity > 0 ? d.quantity : 0), 0);

/**
 * How many of an accessory one quote needs before the person's own multiplier: 1 for a job-level item, one per unit,
 * or the linear feet of the units' perimeters (rounded up to a whole foot).
 */
export function accessoryCount(accessory: Pick<Accessory, 'per'>, designs: readonly WindowDesign[]): number {
  switch (accessory.per) {
    case 'job':
      return 1;
    case 'unit':
      return totalUnits(designs);
    case 'linear-ft':
      return Math.ceil(designs.reduce((sum, d) => sum + unitPerimeterFt(d) * (d.quantity > 0 ? d.quantity : 0), 0) - 1e-9);
  }
}

/** The accessories a new quote starts with (the ones marked autoAdd). */
export function autoAccessories(catalog: ProductCatalog): { accessoryId: string; quantity: number }[] {
  return catalog.accessories.filter((a) => a.autoAdd && !a.archived).map((a) => ({ accessoryId: a.id, quantity: 1 }));
}

/** The quote line of an accessory: `quantity` (normally 1) multiplies the count of units / linear feet. */
export function priceAccessory(accessory: Accessory, quantity: number, designs: readonly WindowDesign[]): BackofficeQuoteLine {
  const count = accessoryCount(accessory, designs) * quantity;
  const suffix = accessory.per === 'linear-ft' ? ` (${count} ft)` : '';
  return { designId: null, accessoryId: accessory.id, description: `${accessory.label}${suffix}`, quantity: count, unitCents: accessory.cents, amountCents: count * accessory.cents };
}

export type QuoteParts = {
  designs: readonly WindowDesign[];
  accessories: readonly { accessoryId: string; quantity: number }[];
  discountPercent: number;
};

export type QuotePrice = {
  lines: Record<Tier, BackofficeQuoteLine[]>;
  totals: Record<Tier, QuoteTotals>;
  issues: DesignIssue[];
  discountNeedsApproval: boolean;
  units: number;
};

/** Totals from lines: the markup goes on the subtotal, the discount on the subtotal with markup. */
export function totalsOf(lines: readonly BackofficeQuoteLine[], markupPercent: number, discountPercent: number): QuoteTotals {
  const subtotalCents = lines.reduce((sum, l) => sum + l.amountCents, 0);
  const markupCents = round((subtotalCents * markupPercent) / 100);
  const discountCents = round(((subtotalCents + markupCents) * discountPercent) / 100);
  return { subtotalCents, markupCents, discountCents, totalCents: subtotalCents + markupCents - discountCents };
}

/**
 * The whole quote: lines and totals for all three tiers, every problem found, and whether the discount is over what a rep
 * may give without the office. The price of an unknown product or accessory is 0 and the issue says so.
 */
export function priceQuote(parts: QuoteParts, catalog: ProductCatalog): QuotePrice {
  const issues: DesignIssue[] = [];
  const quoteIssue = (field: string, message: string) => issues.push({ designId: '', level: 'error', field, message });
  if (parts.designs.length === 0) issues.push({ designId: '', level: 'warning', field: 'designs', message: 'Draw at least one window or door.' });
  const seen = new Set<string>();
  for (const d of parts.designs) {
    if (seen.has(d.id)) quoteIssue('designs', `Two units share the id ${d.id}.`);
    seen.add(d.id);
    issues.push(...validateDesign(d, catalog));
  }
  const accessoryLines: { accessory: Accessory; quantity: number }[] = [];
  const takenAccessories = new Set<string>();
  for (const entry of parts.accessories) {
    const accessory = catalog.accessories.find((a) => a.id === entry.accessoryId);
    if (!accessory) quoteIssue('accessories', `Extra "${entry.accessoryId}" is not on the price sheet.`);
    else if (takenAccessories.has(accessory.id)) quoteIssue('accessories', `${accessory.label} is on the quote twice.`);
    else if (!Number.isInteger(entry.quantity) || entry.quantity < 1 || entry.quantity > 99) quoteIssue('accessories', `${accessory.label}: the quantity must be 1 to 99.`);
    else {
      takenAccessories.add(accessory.id);
      accessoryLines.push({ accessory, quantity: entry.quantity });
    }
  }
  if (!(parts.discountPercent >= 0 && parts.discountPercent <= 100)) quoteIssue('discountPercent', 'The discount must be 0 to 100 percent.');

  const discount = parts.discountPercent >= 0 && parts.discountPercent <= 100 ? parts.discountPercent : 0;
  const lines = {} as Record<Tier, BackofficeQuoteLine[]>;
  const totals = {} as Record<Tier, QuoteTotals>;
  for (const tier of TIERS) {
    const list = [...parts.designs.map((d) => priceDesign(d, catalog, tier).line), ...accessoryLines.map((a) => priceAccessory(a.accessory, a.quantity, parts.designs))];
    lines[tier] = list;
    totals[tier] = totalsOf(list, catalog.markupPercent, discount);
  }
  return { lines, totals, issues, discountNeedsApproval: discount > catalog.maxRepDiscountPercent, units: totalUnits(parts.designs) };
}

/** True when any issue blocks accepting the quote. */
export const hasErrors = (issues: readonly DesignIssue[]): boolean => issues.some((i) => i.level === 'error');
