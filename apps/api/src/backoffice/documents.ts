import {
  chosenOption,
  describeDesign,
  floorTo,
  gridText,
  priceDesign,
  sizeText,
  totalUnits,
  unitedInches,
  type BackofficeQuote,
  type OrderStage,
  type Product,
  type ProductCatalog,
  type QuoteDocument,
  type Tier,
  type WindowDesign,
} from '@roofline/shared';
import { drawUnit } from './draw.ts';
import { COLOR, dateText, dollars, finish, FONT, hairline, newDocument, type Page, pageOf, sectionLabel, titleBlock } from './pdf-kit.ts';

/*
 * The four documents one quote makes: the quote the customer reads, the order confirmation, the factory order and the
 * install sheet. Each draws every unit as vector lines from its layout (draw.ts) and is set in the iOS-style page of
 * pdf-kit.ts. Everything is rendered before any byte is sent, so a failure is a clean error.
 */

export type DocumentInput = {
  kind: QuoteDocument;
  company: { name: string; phone: string | null; email: string | null; website: string | null; address: string | null };
  customer: { name: string; phone: string | null };
  address: string;
  /** The quote priced by the server (with the catalog the quote is priced with). */
  view: BackofficeQuote;
  catalog: ProductCatalog;
  order: { id: string; stage: OrderStage } | null;
  timeZone: string;
  generatedAt: Date;
};

const STAGE_LABEL = (s: OrderStage): string => s.split('-').map((w, i) => (i === 0 ? `${w[0]!.toUpperCase()}${w.slice(1)}` : w)).join(' ');
const present = (parts: (string | null | undefined)[], sep: string): string => parts.filter((s): s is string => typeof s === 'string' && s !== '').join(sep);
const titleCase = (s: string): string => (s === '' ? s : `${s[0]!.toUpperCase()}${s.slice(1)}`);

/** WC-1A2B3C4D: the same reference on every document of a quote and its order. */
export const referenceOf = (i: { view: { id: string }; order: { id: string } | null }): string => `WC-${(i.order?.id ?? i.view.id).replace(/-/g, '').slice(0, 8).toUpperCase()}`;

const productOf = (catalog: ProductCatalog, id: string): Product | undefined => catalog.products.find((p) => p.id === id);

/** The factory's size: the drawn size rounded down to 1/8 in (the order-size rule floors, never rounds up). */
const orderSize = (d: WindowDesign): { w: number; h: number } => ({ w: floorTo(d.widthIn, 0.125), h: floorTo(d.heightIn, 0.125) });

/** The unit as a short list of facts: color, glass, grid, screen, safety glass. */
function facts(d: WindowDesign, catalog: ProductCatalog): { exterior: string; interior: string; glass: string; grid: string; screen: string; tempered: boolean; obscure: boolean } {
  const product = productOf(catalog, d.productId);
  const pick = (group: Parameters<typeof chosenOption>[3]) => (product ? chosenOption(d, product, catalog, group) : null);
  return {
    exterior: titleCase(pick('exterior-color')?.value ?? 'white'),
    interior: titleCase(pick('interior-color')?.value ?? 'white'),
    glass: pick('glass')?.label ?? 'Dual pane',
    grid: gridText(d, catalog, product) || 'None',
    screen: titleCase(d.screen),
    tempered: pick('tempered') !== null,
    obscure: pick('obscure') !== null,
  };
}

function ensureRoom(d: PDFKit.PDFDocument, p: Page, needed: number): void {
  if (d.y + needed > p.bottom) d.addPage();
}

function totalsBlock(d: PDFKit.PDFDocument, p: Page, view: BackofficeQuote, tier: Tier): void {
  const t = view.totals[tier];
  ensureRoom(d, p, 110);
  const w = 230;
  const x = p.right - w;
  const row = (label: string, value: string, strong = false) => {
    const y = d.y;
    d.font(strong ? FONT.bold : FONT.regular).fontSize(strong ? 15 : 10).fillColor(strong ? COLOR.ink : COLOR.secondary).text(label, x, y, { width: w / 2, lineBreak: false });
    d.fillColor(COLOR.ink).text(value, x + w / 2, y, { width: w / 2, align: 'right', lineBreak: false });
    d.y = y + (strong ? 24 : 17);
  };
  d.y += 10;
  row('Subtotal', dollars(t.subtotalCents));
  if (t.markupCents > 0) row('Adjustment', dollars(t.markupCents));
  if (t.discountCents > 0) row(`Discount (${view.discountPercent}%)`, dollars(-t.discountCents));
  hairline(d, p, d.y + 2, x, p.right);
  d.y += 10;
  row('Total', dollars(t.totalCents), true);
}

function signature(d: PDFKit.PDFDocument, p: Page, left: string, right: string): void {
  ensureRoom(d, p, 70);
  d.y += 34;
  const y = d.y;
  const half = (p.contentW - 30) / 2;
  hairline(d, p, y, p.left, p.left + half);
  hairline(d, p, y, p.left + half + 30, p.right);
  d.font(FONT.regular).fontSize(8).fillColor(COLOR.tertiary);
  d.text(left, p.left, y + 5, { width: half, lineBreak: false });
  d.text(right, p.left + half + 30, y + 5, { width: half, lineBreak: false });
  d.y = y + 22;
}

/* The quote and the order confirmation: the customer-facing pages ------------------------------------------------------------ */

function unitRows(d: PDFKit.PDFDocument, p: Page, i: DocumentInput, tier: Tier, drawingH: number): void {
  const { catalog, view } = i;
  const cardH = drawingH + 14;
  for (const design of view.designs) {
    ensureRoom(d, p, cardH);
    const top = d.y;
    const price = priceDesign(design, catalog, tier);
    const dw = drawingH * 1.1;
    drawUnit(d, design, { x: p.left, y: top, w: dw, h: drawingH });
    const textX = p.left + dw + 18;
    const amountW = 92;
    const textW = p.right - textX - amountW - 10;
    d.font(FONT.bold).fontSize(12).fillColor(COLOR.ink).text(design.label || 'Unit', textX, top + 4, { width: textW });
    d.font(FONT.regular).fontSize(9.5).fillColor(COLOR.secondary).text(describeDesign(design, catalog).replace(/^[^:]*:\s*/, ''), textX, d.y + 2, { width: textW });
    if (design.notes.trim() !== '') d.fillColor(COLOR.tertiary).text(design.notes.trim(), textX, d.y + 2, { width: textW });
    d.font(FONT.bold).fontSize(12).fillColor(COLOR.ink).text(dollars(price.amountCents), p.right - amountW, top + 4, { width: amountW, align: 'right', lineBreak: false });
    if (price.quantity !== 1) d.font(FONT.regular).fontSize(8.5).fillColor(COLOR.tertiary).text(`${price.quantity} x ${dollars(price.unitCents)}`, p.right - amountW, top + 21, { width: amountW, align: 'right', lineBreak: false });
    d.y = top + cardH;
    hairline(d, p, d.y - 6);
  }
}

function extrasRows(d: PDFKit.PDFDocument, p: Page, view: BackofficeQuote, tier: Tier): void {
  const extras = view.lines[tier].filter((l) => l.accessoryId !== null);
  if (extras.length === 0) return;
  sectionLabel(d, p, 'Included with your order');
  d.y += 6;
  for (const l of extras) {
    ensureRoom(d, p, 22);
    const y = d.y;
    d.font(FONT.regular).fontSize(10).fillColor(COLOR.ink).text(l.description, p.left, y, { width: p.contentW - 110, lineBreak: false });
    d.text(dollars(l.amountCents), p.right - 100, y, { width: 100, align: 'right', lineBreak: false });
    d.y = y + 20;
    hairline(d, p, d.y - 5);
  }
}

function renderQuote(i: DocumentInput, confirmation: boolean, compress?: boolean): PDFKit.PDFDocument {
  const p = pageOf(false);
  const { view, catalog, company } = i;
  const tier = view.tier;
  const ref = referenceOf(i);
  const d = newDocument({ title: `${confirmation ? 'Order confirmation' : 'Quote'} ${ref}`, author: company.name, ...(compress !== undefined && { compress }) });
  const date = dateText(i.generatedAt, i.timeZone);
  titleBlock(d, p, {
    company: company.name,
    title: confirmation ? 'Order confirmation' : 'Quote',
    captions: [
      `Prepared for ${i.customer.name}`,
      i.address,
      `${date}   ·   ${confirmation ? 'Order' : 'Quote'} ${ref}   ·   ${catalog.tiers[tier].label} option`,
      confirmation && i.order !== null ? `Status: ${STAGE_LABEL(i.order.stage)}` : '',
    ],
  });
  sectionLabel(d, p, 'Windows and doors');
  d.y += 8;
  if (view.designs.length === 0) d.font(FONT.regular).fontSize(10).fillColor(COLOR.secondary).text('No windows or doors on this quote yet.', p.left, d.y, { width: p.contentW });
  unitRows(d, p, i, tier, confirmation ? 64 : 92);
  extrasRows(d, p, view, tier);
  totalsBlock(d, p, view, tier);

  if (!confirmation) {
    sectionLabel(d, p, 'Compare options');
    d.y += 8;
    ensureRoom(d, p, 90);
    const top = d.y;
    const colW = p.contentW / 3;
    (['good', 'better', 'best'] as const).forEach((t, k) => {
      const x = p.left + k * colW;
      const chosen = t === tier;
      d.font(FONT.bold).fontSize(10).fillColor(chosen ? COLOR.ink : COLOR.secondary).text(catalog.tiers[t].label, x, top, { width: colW - 12, lineBreak: false });
      d.font(FONT.regular).fontSize(8).fillColor(COLOR.tertiary).text(catalog.tiers[t].note, x, top + 15, { width: colW - 16 });
      d.font(FONT.bold).fontSize(16).fillColor(chosen ? COLOR.ink : COLOR.secondary).text(dollars(view.totals[t].totalCents), x, top + 44, { width: colW - 12, lineBreak: false });
      if (chosen) d.rect(x, top + 68, 24, 2).fill(COLOR.accent);
    });
    d.y = top + 82;
    d.font(FONT.regular).fontSize(8.5).fillColor(COLOR.tertiary).text('This quote is good for 30 days. Final sizes are confirmed at the measure visit; the price changes only if a size does.', p.left, d.y, { width: p.contentW });
    signature(d, p, 'Accepted by', 'Date');
  } else {
    sectionLabel(d, p, 'What happens next');
    d.y += 6;
    const steps = ['A final measure visit, so every window is built to fit', 'Your order goes to the factory and is built', 'Your windows are delivered', 'Installation by our crew', 'A walkthrough with you to make sure you love them'];
    steps.forEach((s, k) => {
      ensureRoom(d, p, 20);
      const y = d.y;
      d.font(FONT.bold).fontSize(10).fillColor(COLOR.accent).text(String(k + 1), p.left, y, { width: 18, lineBreak: false });
      d.font(FONT.regular).fontSize(10).fillColor(COLOR.ink).text(s, p.left + 22, y, { width: p.contentW - 22 });
      d.y += 6;
    });
    d.y += 4;
    d.font(FONT.regular).fontSize(9).fillColor(COLOR.secondary).text(`We will text you at each step${company.phone ? `. Questions? Call ${company.phone}` : ''}.`, p.left, d.y, { width: p.contentW });
    signature(d, p, 'Customer signature', 'Date');
  }
  const accepted = i.order !== null;
  finish(d, p, { footer: present([company.name, company.phone, company.website], '   ·   '), ...(!accepted && confirmation && { draft: 'DRAFT' }) });
  return d;
}

/* The factory order --------------------------------------------------------------------------------------------------------- */

type FactoryLine = { no: number; designs: WindowDesign[]; qty: number; w: number; h: number; key: string };

function factoryLines(i: DocumentInput): FactoryLine[] {
  const map = new Map<string, FactoryLine>();
  for (const design of i.view.designs) {
    const f = facts(design, i.catalog);
    const { w, h } = orderSize(design);
    const key = JSON.stringify([design.productId, design.shape, w, h, f, design.layout, design.notes.trim()]);
    const found = map.get(key);
    if (found) {
      found.designs.push(design);
      found.qty += design.quantity;
    } else map.set(key, { no: map.size + 1, designs: [design], qty: design.quantity, w, h, key });
  }
  return [...map.values()];
}

type Col = { title: string; w: number; cell: (l: FactoryLine) => string };

function renderFactoryOrder(i: DocumentInput, compress?: boolean): PDFKit.PDFDocument {
  const p = pageOf(true);
  const { company, catalog, view } = i;
  const ref = referenceOf(i);
  const d = newDocument({ landscape: true, title: `Factory order ${ref}`, author: company.name, ...(compress !== undefined && { compress }) });
  const lines = factoryLines(i);
  const units = totalUnits(view.designs);
  const typed = view.designs.filter((x) => x.sizeSource.kind === 'typed');
  titleBlock(d, p, {
    company: company.name,
    title: 'Factory order',
    captions: [`PO ${ref}   ·   ${dateText(i.generatedAt, i.timeZone)}   ·   ${units} unit${units === 1 ? '' : 's'} on ${lines.length} line${lines.length === 1 ? '' : 's'}`, `${i.customer.name}   ·   ${i.address}`],
  });
  if (typed.length > 0) {
    d.font(FONT.bold).fontSize(9).fillColor(COLOR.warning).text(`${typed.length} unit${typed.length === 1 ? ' has a typed size' : 's have typed sizes'}, not measured on site. Confirm the size before this goes to the factory.`, p.left, d.y, { width: p.contentW });
    d.y += 4;
  }
  d.y += 6;

  const cols: Col[] = [
    { title: 'LN', w: 24, cell: (l) => String(l.no) },
    { title: 'QTY', w: 26, cell: (l) => String(l.qty) },
    { title: 'LOCATION', w: 78, cell: (l) => [...new Set(l.designs.map((x) => x.label))].join(', ') },
    { title: 'PRODUCT', w: 98, cell: (l) => productOf(catalog, l.designs[0]!.productId)?.name ?? 'Unknown product' },
    { title: 'WIDTH', w: 40, cell: (l) => sizeText(l.w) },
    { title: 'HEIGHT', w: 40, cell: (l) => sizeText(l.h) },
    { title: 'UI', w: 24, cell: (l) => String(unitedInches({ widthIn: l.w, heightIn: l.h })) },
    { title: 'EXT / INT', w: 64, cell: (l) => `${facts(l.designs[0]!, catalog).exterior} / ${facts(l.designs[0]!, catalog).interior}` },
    { title: 'GRID', w: 66, cell: (l) => facts(l.designs[0]!, catalog).grid },
    { title: 'GLASS', w: 76, cell: (l) => { const f = facts(l.designs[0]!, catalog); return f.glass + (f.tempered ? '\nTempered' : '') + (f.obscure ? '\nObscure' : ''); } },
    { title: 'SCR', w: 36, cell: (l) => facts(l.designs[0]!, catalog).screen },
    { title: 'SIZE', w: 44, cell: (l) => (l.designs.every((x) => x.sizeSource.kind === 'measured') ? 'On site' : 'Typed') },
  ];
  // pdfkit loops for ever on a negative text width, so the notes column never gets less than this.
  const notesW = Math.max(60, p.contentW - cols.reduce((s, c) => s + c.w, 0));
  cols.push({ title: 'NOTES', w: notesW, cell: (l) => [l.designs[0]!.shape !== 'rect' ? 'SPECIAL ORDER' : '', l.designs[0]!.notes.trim()].filter(Boolean).join('\n') });

  const header = () => {
    const y = d.y;
    let x = p.left;
    d.font(FONT.bold).fontSize(7).fillColor(COLOR.tertiary);
    for (const c of cols) {
      d.text(c.title, x, y, { width: c.w - 6, lineBreak: false, characterSpacing: 0.6 });
      x += c.w;
    }
    hairline(d, p, y + 12);
    d.y = y + 18;
  };
  header();
  for (const l of lines) {
    d.font(FONT.regular).fontSize(8.5);
    const cells = cols.map((c) => c.cell(l));
    const h = Math.max(...cols.map((c, k) => d.heightOfString(cells[k]!, { width: c.w - 6 }))) + 10;
    if (d.y + h > p.bottom) {
      d.addPage();
      header();
    }
    const y = d.y;
    let x = p.left;
    cols.forEach((c, k) => {
      d.font(['QTY', 'WIDTH', 'HEIGHT'].includes(c.title) ? FONT.bold : FONT.regular).fontSize(8.5).fillColor(c.title === 'SIZE' && cells[k] === 'Typed' ? COLOR.warning : COLOR.ink).text(cells[k]!, x, y + 3, { width: c.w - 6 });
      x += c.w;
    });
    hairline(d, p, y + h - 2);
    d.y = y + h;
  }
  d.font(FONT.regular).fontSize(8).fillColor(COLOR.tertiary).text('Sizes are the order (rough unit) size in inches and eighths, rounded down. Openings are seen from outside.', p.left, d.y + 8, { width: p.contentW });

  // The drawings: one card per line.
  d.addPage();
  sectionLabel(d, p, 'Drawings (seen from outside)');
  d.y += 10;
  const gap = 18;
  const cardW = (p.contentW - gap * 2) / 3;
  const cardH = 190;
  let col = 0;
  let rowTop = d.y;
  for (const l of lines) {
    if (col === 0 && rowTop + cardH > p.bottom) {
      d.addPage();
      rowTop = p.top;
    }
    const x = p.left + col * (cardW + gap);
    const design = { ...l.designs[0]!, widthIn: l.w, heightIn: l.h };
    drawUnit(d, design, { x, y: rowTop, w: cardW, h: cardH - 44 }, { dimensions: true });
    d.font(FONT.bold).fontSize(9).fillColor(COLOR.ink).text(`Line ${l.no}  ·  Qty ${l.qty}`, x, rowTop + cardH - 36, { width: cardW, lineBreak: false });
    d.font(FONT.regular).fontSize(8).fillColor(COLOR.secondary).text(`${[...new Set(l.designs.map((x2) => x2.label))].join(', ')}   ·   ${sizeText(l.w)} x ${sizeText(l.h)}`, x, d.y + 2, { width: cardW, lineBreak: false });
    col += 1;
    if (col === 3) {
      col = 0;
      rowTop += cardH + 10;
    }
  }
  const draft = i.order === null ? 'DRAFT' : undefined;
  finish(d, p, { footer: `${company.name}   ·   PO ${ref}${draft ? '   ·   Not for ordering until the quote is accepted' : ''}`, ...(draft !== undefined && { draft }) });
  return d;
}

/* The install sheet --------------------------------------------------------------------------------------------------------- */

function renderInstallSheet(i: DocumentInput, compress?: boolean): PDFKit.PDFDocument {
  const p = pageOf(false);
  const { company, catalog, view } = i;
  const ref = referenceOf(i);
  const d = newDocument({ title: `Install sheet ${ref}`, author: company.name, ...(compress !== undefined && { compress }) });
  titleBlock(d, p, {
    company: company.name,
    title: 'Install sheet',
    captions: [present([i.customer.name, i.customer.phone], '   ·   '), i.address, `Order ${ref}   ·   ${totalUnits(view.designs)} units`],
  });
  const extras = view.lines[view.tier].filter((l) => l.accessoryId !== null);
  if (extras.length > 0) {
    sectionLabel(d, p, 'Also on this job');
    d.font(FONT.regular).fontSize(10).fillColor(COLOR.ink).text(extras.map((l) => l.description).join('   ·   '), p.left, d.y + 8, { width: p.contentW });
  }
  sectionLabel(d, p, 'Units');
  d.y += 8;
  const cardH = 168;
  for (const design of view.designs) {
    ensureRoom(d, p, cardH + 6);
    const top = d.y;
    const f = facts(design, catalog);
    drawUnit(d, design, { x: p.left, y: top, w: 190, h: cardH - 12 }, { dimensions: true });
    const x = p.left + 210;
    const w = p.right - x;
    d.font(FONT.bold).fontSize(13).fillColor(COLOR.ink).text(design.label || 'Unit', x, top + 4, { width: w - 60 });
    d.font(FONT.bold).fontSize(13).text(`x ${design.quantity}`, p.right - 60, top + 4, { width: 60, align: 'right', lineBreak: false });
    d.font(FONT.regular).fontSize(10).fillColor(COLOR.secondary);
    const size = orderSize(design);
    d.text(`${productOf(catalog, design.productId)?.name ?? 'Unknown product'}`, x, d.y + 2, { width: w });
    d.fillColor(COLOR.ink).font(FONT.bold).text(`${sizeText(size.w)} x ${sizeText(size.h)} in`, x, d.y + 2, { width: w });
    d.font(FONT.regular).fillColor(COLOR.secondary).text(`${f.exterior} outside, ${f.interior} inside   ·   ${f.glass}`, x, d.y + 2, { width: w });
    d.text(`Grids: ${f.grid}   ·   Screen: ${f.screen}`, x, d.y + 2, { width: w });
    if (f.tempered) d.fillColor(COLOR.warning).font(FONT.bold).text('Tempered safety glass: check the etched label before setting.', x, d.y + 4, { width: w });
    if (f.obscure) d.fillColor(COLOR.secondary).font(FONT.regular).text('Obscure glass: frosted side faces in.', x, d.y + 2, { width: w });
    if (design.notes.trim() !== '') d.fillColor(COLOR.secondary).font(FONT.regular).text(design.notes.trim(), x, d.y + 4, { width: w });
    // Check boxes along the bottom of the card.
    const boxY = top + cardH - 26;
    ['Opening checked', 'Set and level', 'Sealed and trimmed'].forEach((label, k) => {
      const bx = x + k * (w / 3);
      d.lineWidth(0.7).strokeColor(COLOR.tertiary).roundedRect(bx, boxY, 10, 10, 2).stroke();
      d.font(FONT.regular).fontSize(8).fillColor(COLOR.secondary).text(label, bx + 15, boxY + 1.5, { width: w / 3 - 18, lineBreak: false });
    });
    d.y = top + cardH;
    hairline(d, p, d.y - 4);
  }
  signature(d, p, 'Crew lead', 'Customer walkthrough signature');
  finish(d, p, { footer: `${company.name}   ·   Install ${ref}`, ...(i.order === null && { draft: 'DRAFT' }) });
  return d;
}

/** The document as a pdfkit stream, already fully drawn (pipe it to the response). */
export function renderDocument(i: DocumentInput, opts?: { compress?: boolean }): PDFKit.PDFDocument {
  switch (i.kind) {
    case 'quote':
      return renderQuote(i, false, opts?.compress);
    case 'order-confirmation':
      return renderQuote(i, true, opts?.compress);
    case 'factory-order':
      return renderFactoryOrder(i, opts?.compress);
    case 'install-sheet':
      return renderInstallSheet(i, opts?.compress);
  }
}

