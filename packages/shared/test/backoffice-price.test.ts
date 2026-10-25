import { describe, expect, test } from 'vitest';
import {
  accessoryCount,
  DEFAULT_BACKOFFICE_SETTINGS,
  DEFAULT_PRODUCT_CATALOG,
  describeDesign,
  gridLiteCount,
  hasErrors,
  layoutForStyle,
  layoutSections,
  liteCount,
  ORDER_STAGES,
  priceDesign,
  priceQuote,
  renderStageText,
  resolveBackofficeSettings,
  sizeText,
  splitExtents,
  validateDesign,
  type WindowDesign,
  NO_SAFETY_ANSWERS,
} from '../src/index.ts';

const catalog = DEFAULT_PRODUCT_CATALOG;

function design(over: Partial<WindowDesign> = {}): WindowDesign {
  return {
    id: 'd1',
    label: 'Kitchen',
    productId: 'wc-double-hung',
    quantity: 1,
    shape: 'rect',
    widthIn: 35.5,
    heightIn: 59.5,
    layout: layoutForStyle('double-hung', 35.5, { top: '3x2', bottom: '3x2' }),
    options: { 'exterior-color': 'ext-bronze' },
    gridType: 'colonial',
    screen: 'half',
    safety: { ...NO_SAFETY_ANSWERS },
    sizeSource: { kind: 'typed' },
    notes: '',
    ...over,
  };
}

const slider = (over: Partial<WindowDesign> = {}) =>
  design({ id: 'd2', label: 'Living', productId: 'wc-slider-3', widthIn: 96, heightIn: 48, layout: layoutForStyle('slider-3', 96), gridType: 'none', options: {}, ...over });

describe('layout', () => {
  test('columns: given sizes then the last takes what is left', () => {
    const sections = layoutSections(slider({ widthIn: 100 }));
    expect(sections.map((s) => s.rect)).toEqual([
      { x: 0, y: 0, w: 32, h: 48 },
      { x: 32, y: 0, w: 32, h: 48 },
      { x: 64, y: 0, w: 36, h: 48 },
    ]);
    expect(sections.map((s) => s.index)).toEqual([0, 1, 2]);
  });

  test('rows and nested splits keep order and fill the frame', () => {
    const d = design({
      widthIn: 40,
      heightIn: 60,
      layout: {
        kind: 'split',
        id: 'r',
        direction: 'rows',
        parts: [
          { size: 20, layout: { kind: 'section', id: 'a', opening: 'fixed', grid: '' } },
          {
            size: null,
            layout: {
              kind: 'split',
              id: 'c',
              direction: 'columns',
              parts: [
                { size: 10, layout: { kind: 'section', id: 'b', opening: 'fixed', grid: '' } },
                { size: null, layout: { kind: 'section', id: 'c', opening: 'fixed', grid: '' } },
              ],
            },
          },
        ],
      },
    });
    expect(layoutSections(d).map((s) => [s.section.id, s.rect])).toEqual([
      ['a', { x: 0, y: 0, w: 40, h: 20 }],
      ['b', { x: 0, y: 20, w: 10, h: 40 }],
      ['c', { x: 10, y: 20, w: 30, h: 40 }],
    ]);
  });

  test('with no open part the last part takes the remainder', () => {
    expect(splitExtents([{ size: 10 }, { size: 10 }], 30)).toEqual([10, 20]);
  });

  test('lites: a hung window counts both sashes, a plain pane is one lite', () => {
    expect(liteCount({ opening: 'hung-sash', grid: '3x2/3x2' })).toBe(12);
    expect(liteCount({ opening: 'hung-sash', grid: '/' })).toBe(2);
    expect(liteCount({ opening: 'fixed', grid: '' })).toBe(1);
    expect(liteCount({ opening: 'fixed', grid: '2x2' })).toBe(4);
    expect(gridLiteCount({ opening: 'hung-sash', grid: '3x2/' })).toBe(6);
  });
});

describe('descriptions', () => {
  test('fractions to 1/8 in', () => {
    expect(sizeText(35.5)).toBe('35 1/2');
    expect(sizeText(59.625)).toBe('59 5/8');
    expect(sizeText(36)).toBe('36');
  });
  test('names the room, product, size, color and grid', () => {
    expect(describeDesign(design(), catalog)).toBe('Kitchen: WinChoice Double Hung 35 1/2 x 59 1/2, Bronze exterior, Colonial grids 3x2');
  });
});

describe('validateDesign', () => {
  test('a good unit has no issues', () => {
    expect(validateDesign(design(), catalog)).toEqual([]);
  });
  test('size limits, united inches and the opening/shape the product allows', () => {
    const issues = validateDesign(design({ widthIn: 60, heightIn: 90, shape: 'arch-top' }), catalog);
    const msgs = issues.map((i) => i.message).join('|');
    expect(msgs).toContain('Too wide for this product: 48 in max');
    expect(msgs).toContain('Too tall');
    expect(msgs).toContain('united inches');
    expect(msgs).toContain('arch top');
    expect(hasErrors(issues)).toBe(true);
  });
  test('too many sections and an opening the product lacks', () => {
    const issues = validateDesign(design({ layout: layoutForStyle('slider-3', 35.5) }), catalog);
    expect(issues.some((i) => i.field === 'layout' && i.message.includes('one section'))).toBe(true);
    expect(issues.some((i) => i.message.includes('slide right opening'))).toBe(true);
  });
  test('split sizes that do not fit', () => {
    const d = slider({
      layout: { kind: 'split', id: 'x', direction: 'columns', parts: [{ size: 60, layout: { kind: 'section', id: 'a', opening: 'fixed', grid: '' } }, { size: 40, layout: { kind: 'section', id: 'b', opening: 'fixed', grid: '' } }, { size: null, layout: { kind: 'section', id: 'c', opening: 'fixed', grid: '' } }] },
    });
    expect(validateDesign(d, catalog).some((i) => i.message.includes('do not fit'))).toBe(true);
  });
  test('a bad grid pattern, unknown option and unknown product', () => {
    expect(validateDesign(design({ layout: layoutForStyle('double-hung', 36, { top: '33', bottom: '' }) }), catalog).some((i) => i.field === 'grid' && i.level === 'error')).toBe(true);
    expect(validateDesign(design({ options: { glass: 'nope' } }), catalog).some((i) => i.field === 'options')).toBe(true);
    expect(validateDesign(design({ productId: 'nope' }), catalog)[0]?.field).toBe('productId');
  });
  test('safety glass is suggested beside a door unless tempered is chosen', () => {
    const d = design({ safety: { besideDoor: true, wetArea: null, sillHeightIn: 20, walkway: null } });
    const w = validateDesign(d, catalog).filter((i) => i.field === 'safety');
    expect(w).toHaveLength(1);
    expect(w[0]!.level).toBe('warning');
    expect(validateDesign({ ...d, options: { tempered: 'tempered' } }, catalog).filter((i) => i.field === 'safety')).toEqual([]);
  });
});

describe('priceDesign', () => {
  test('united-inch break + options per unit / lite / sq ft, for each tier', () => {
    // 35.5 + 59.5 = 95 UI -> the 100 break (44500 good). Bronze exterior +6500. Colonial: 12 lites x 350 = 4200.
    const good = priceDesign(design(), catalog, 'good');
    expect(good.parts.map((p) => [p.label, p.cents])).toEqual([
      ['WinChoice Double Hung', 44500],
      ['Bronze exterior', 6500],
      ['Colonial grids', 4200],
    ]);
    expect(good.unitCents).toBe(55200);
    expect(priceDesign(design({ quantity: 3 }), catalog, 'good').amountCents).toBe(165600);
    expect(priceDesign(design(), catalog, 'best').parts[0]!.cents).toBe(57900);
  });
  test('sq-ft rule with a minimum, tempered and triple pane by sq ft, extra sections', () => {
    const picture = design({ id: 'p', productId: 'wc-picture', widthIn: 12, heightIn: 12, layout: layoutForStyle('picture', 12), gridType: 'none', options: {} });
    expect(priceDesign(picture, catalog, 'good').unitCents).toBe(17500); // minimum
    const big = { ...picture, widthIn: 72, heightIn: 60, options: { tempered: 'tempered', glass: 'glass-triple' } };
    // 30 sq ft x 1650 = 49500 + tempered 30 x 450 + triple 30 x 350
    expect(priceDesign(big, catalog, 'good').unitCents).toBe(49500 + 13500 + 10500);
    const pair = design({ id: 'c', productId: 'wc-casement', widthIn: 48, heightIn: 48, gridType: 'none', options: {}, layout: { kind: 'split', id: 'r', direction: 'columns', parts: [{ size: 24, layout: { kind: 'section', id: 'a', opening: 'casement-left', grid: '' } }, { size: null, layout: { kind: 'section', id: 'b', opening: 'casement-right', grid: '' } }] } });
    expect(priceDesign(pair, catalog, 'good').parts.find((p) => p.kind === 'sections')?.cents).toBe(4500);
  });
  test('over the last break prices at the last break', () => {
    expect(priceDesign(design({ widthIn: 48, heightIn: 84 }), catalog, 'good').parts[0]!.cents).toBe(53000);
  });
});

describe('priceQuote', () => {
  const parts = { designs: [design(), slider()], accessories: [{ accessoryId: 'acc-capping', quantity: 1 }, { accessoryId: 'acc-permit', quantity: 1 }, { accessoryId: 'acc-trim', quantity: 1 }], discountPercent: 0 };

  test('lines and totals for all three tiers', () => {
    const q = priceQuote(parts, catalog);
    expect(q.units).toBe(2);
    expect(q.issues.filter((i) => i.level === 'error')).toEqual([]);
    const good = q.lines.good;
    expect(good).toHaveLength(5);
    expect(good[2]).toMatchObject({ accessoryId: 'acc-capping', quantity: 2, unitCents: 18500, amountCents: 37000 });
    expect(good[3]).toMatchObject({ accessoryId: 'acc-permit', quantity: 1, amountCents: 25000 });
    // perimeters: 2(35.5+59.5)=190 in + 2(96+48)=288 in = 478 in = 39.83 ft -> 40
    expect(good[4]).toMatchObject({ accessoryId: 'acc-trim', quantity: 40, amountCents: 18000 });
    const sum = good.reduce((s, l) => s + l.amountCents, 0);
    expect(q.totals.good).toEqual({ subtotalCents: sum, markupCents: 0, discountCents: 0, totalCents: sum });
    expect(q.totals.better.totalCents).toBeGreaterThan(q.totals.good.totalCents);
    expect(q.totals.best.totalCents).toBeGreaterThan(q.totals.better.totalCents);
  });

  test('markup, then discount on the marked-up subtotal, and the approval flag', () => {
    const withMarkup = { ...catalog, markupPercent: 10, maxRepDiscountPercent: 8 };
    const q = priceQuote({ ...parts, discountPercent: 8 }, withMarkup);
    const t = q.totals.good;
    expect(t.markupCents).toBe(Math.round(t.subtotalCents * 0.1));
    expect(t.discountCents).toBe(Math.round((t.subtotalCents + t.markupCents) * 0.08));
    expect(t.totalCents).toBe(t.subtotalCents + t.markupCents - t.discountCents);
    expect(q.discountNeedsApproval).toBe(false);
    expect(priceQuote({ ...parts, discountPercent: 8.5 }, withMarkup).discountNeedsApproval).toBe(true);
  });

  test('unknown or doubled accessory, duplicate unit ids and a bad discount are errors', () => {
    const q = priceQuote({ designs: [design(), design()], accessories: [{ accessoryId: 'zzz', quantity: 1 }, { accessoryId: 'acc-permit', quantity: 1 }, { accessoryId: 'acc-permit', quantity: 1 }], discountPercent: 150 }, catalog);
    const fields = q.issues.filter((i) => i.level === 'error').map((i) => i.field);
    expect(fields).toEqual(expect.arrayContaining(['designs', 'accessories', 'discountPercent']));
  });

  test('accessory counts', () => {
    expect(accessoryCount({ per: 'job' }, parts.designs)).toBe(1);
    expect(accessoryCount({ per: 'unit' }, [design({ quantity: 4 })])).toBe(4);
  });
});

describe('defaults', () => {
  test('the catalog covers the WinChoice products, colors, glass, grids, screens and accessories', () => {
    expect(catalog.products.map((p) => p.factoryStyle)).toEqual(['double-hung', 'single-hung', 'slider-2', 'slider-3', 'picture', 'casement', 'awning', 'arch', undefined]);
    expect(catalog.products.some((p) => p.kind === 'patio-door')).toBe(true);
    for (const c of ['white', 'almond', 'clay', 'bronze', 'black', 'woodgrain']) {
      expect(catalog.options.some((o) => o.group === 'exterior-color' && o.value === c)).toBe(true);
      expect(catalog.options.some((o) => o.group === 'interior-color' && o.value === c)).toBe(true);
    }
    expect(catalog.options.filter((o) => o.group === 'glass').map((o) => o.value)).toEqual(['lowe-argon', 'triple-lowe-argon']);
    expect(catalog.accessories.map((a) => [a.label, a.per])).toEqual(expect.arrayContaining([['Exterior capping', 'unit'], ['Disposal of old windows', 'unit'], ['Permit', 'job']]));
    expect(new Set(catalog.options.map((o) => o.id)).size).toBe(catalog.options.length);
  });
  test('every default product accepts a unit drawn inside its limits', () => {
    for (const p of catalog.products) {
      const w = p.limits.minWidthIn + 2;
      const h = p.limits.minHeightIn + 2;
      const style = p.factoryStyle ?? 'slider-2';
      const d = design({ id: p.id, productId: p.id, widthIn: w, heightIn: h, shape: p.shapes[0]!, gridType: 'none', options: {}, layout: p.kind === 'patio-door' ? { kind: 'split', id: 'r', direction: 'columns', parts: [{ size: null, layout: { kind: 'section', id: 'a', opening: 'door-fixed', grid: '' } }, { size: 30, layout: { kind: 'section', id: 'b', opening: 'door-slide-left', grid: '' } }] } : layoutForStyle(style, w) });
      expect(validateDesign(d, catalog).filter((i) => i.level === 'error'), p.name).toEqual([]);
      expect(priceDesign(d, catalog, 'good').unitCents, p.name).toBeGreaterThan(0);
    }
  });
  test('a message for every stage, and rendering fills the blanks', () => {
    expect(DEFAULT_BACKOFFICE_SETTINGS.templates.map((t) => t.stage)).toEqual([...ORDER_STAGES]);
    for (const t of DEFAULT_BACKOFFICE_SETTINGS.templates) expect(t.sms.length).toBeLessThanOrEqual(200);
    const t = DEFAULT_BACKOFFICE_SETTINGS.templates.find((x) => x.stage === 'install-scheduled')!;
    expect(renderStageText(t.sms, { first: 'Dana', date: 'Tue, Nov 3', company: 'WinChoice' })).toContain('Hi Dana, your install is scheduled: Tue, Nov 3.');
    expect(renderStageText('on {date}', { first: 'a', date: null, company: 'b' })).toBe('on still being set');
    expect(resolveBackofficeSettings({ stuckDays: { sold: 9 } }).stuckDays.sold).toBe(9);
  });
});
