import {
  getLatestWindowMeasurementForProperty,
  getWindowMeasurement,
  getWindowOrderForMeasurement,
  getWindowOrderSettings,
  type TenantContext,
  type Tx,
} from '@roofline/db';
import {
  checkLine,
  layoutForStyle,
  linesFromPhotoWindows,
  type OptionGroup,
  type Product,
  type ProductCatalog,
  type WindowDesign,
  type WindowOrderLine,
  type WindowStyle,
} from '@roofline/shared';
import { toWindowView } from '../estimator/windows-view.ts';

/*
 * Designs from what was measured on site: the factory order lines of an address's window measurement (when it has an
 * order, whose sizes may be locked), else its photo windows. Each becomes a design with sizeSource 'measured'. The size is
 * the order size (the smallest on-site measurement less the company's deduction, rounded down), the same number the
 * factory order uses, so the quote and the factory agree.
 */

const productForStyle = (catalog: ProductCatalog, style: WindowStyle | null): Product | undefined => {
  const windows = catalog.products.filter((p) => p.kind === 'window' && !p.archived);
  return windows.find((p) => p.factoryStyle === (style ?? 'double-hung')) ?? windows.find((p) => p.factoryStyle === 'double-hung') ?? windows[0];
};

const optionId = (catalog: ProductCatalog, product: Product, group: OptionGroup, value: string): string | undefined =>
  catalog.options.find((o) => o.group === group && o.value === value && !o.archived && (o.productIds.length === 0 || o.productIds.includes(product.id)))?.id;

/** A short, id-safe name for a design made from an order line. */
const designId = (lineId: string): string => `m-${lineId.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 60)}`;

export function designFromLine(line: WindowOrderLine, size: { widthIn: number; heightIn: number }, catalog: ProductCatalog, windowMeasurementId: string): WindowDesign | null {
  const product = productForStyle(catalog, line.style);
  if (!product) return null;
  const shape = line.style === 'arch' && product.shapes.includes('arch-top') ? 'arch-top' : line.style === 'circle' ? 'circle' : 'rect';
  const options: WindowDesign['options'] = {};
  const set = (group: OptionGroup, value: string) => {
    const id = optionId(catalog, product, group, value);
    if (id !== undefined) options[group] = id;
  };
  set('exterior-color', line.frameExterior);
  set('interior-color', line.frameInterior);
  set('glass', line.glass);
  if (line.tempered) set('tempered', 'tempered');
  if (line.obscure) set('obscure', 'obscure');
  return {
    id: designId(line.id),
    label: line.location,
    productId: product.id,
    quantity: line.quantity,
    shape,
    widthIn: size.widthIn,
    heightIn: size.heightIn,
    layout: layoutForStyle(line.style, size.widthIn, line.grid),
    options,
    gridType: line.grid.type,
    screen: line.screen,
    safety: line.safety,
    sizeSource: { kind: 'measured', windowMeasurementId, lineId: line.id },
    notes: line.style === null ? 'Style not chosen on the measuring sheet.' : line.notes,
  };
}

export type ImportResult = { windowMeasurementId: string; designs: WindowDesign[] } | { problem: 'no-measurement' | 'wrong-address' };

/** The designs for a job's address. `measurementId` picks one measurement (it must be of that address); else the newest. */
export async function importMeasuredDesigns(tx: Tx, ctx: TenantContext, propertyId: string, measurementId: string | undefined, catalog: ProductCatalog, now: Date): Promise<ImportResult> {
  const measurement = measurementId !== undefined ? await getWindowMeasurement(tx, ctx, measurementId) : await getLatestWindowMeasurementForProperty(tx, ctx, propertyId);
  if (!measurement) return { problem: 'no-measurement' };
  if (measurement.propertyId !== propertyId) return { problem: 'wrong-address' };
  const order = await getWindowOrderForMeasurement(tx, ctx, measurement.id);
  const settings = order?.settings ?? (await getWindowOrderSettings(tx, ctx));
  let lines: WindowOrderLine[];
  if (order !== null) lines = order.lines;
  else {
    const view = toWindowView(measurement, now);
    lines = linesFromPhotoWindows(view.photoWindows ?? [], new Set(view.adjustments.excludedWindowIds));
  }
  const designs: WindowDesign[] = [];
  const used = new Set<string>();
  for (const line of lines) {
    const size = checkLine(line, settings).order;
    if (size === null || size.widthIn <= 0 || size.heightIn <= 0) continue;
    const design = designFromLine(line, size, catalog, measurement.id);
    if (design === null || used.has(design.id)) continue;
    used.add(design.id);
    designs.push(design);
  }
  return { windowMeasurementId: measurement.id, designs };
}
