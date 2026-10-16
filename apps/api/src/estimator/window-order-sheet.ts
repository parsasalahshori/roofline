import PDFDocument from 'pdfkit';
import {
  fractionInches,
  smallestMeasured,
  toCsv,
  windowStyleName,
  type FrameColor,
  type GlassPackage,
  type OrderGroup,
  type ScreenType,
  type WindowGrid,
  type WindowOrderView,
} from '@roofline/shared';
import { PDF_COLORS } from '../quotes/pdf.ts';

/*
 * The factory order sheet: a CSV a factory can import, and a printable PDF. Both are built from the order's groups
 * (identical windows on one line with a quantity), with sizes in inches and eighths.
 *
 * PDF approach: pdfkit, already a dependency of the API (quotes, signed proposals, claim packets). It draws on the
 * server with no headless browser, so the sheet is the same wherever it is printed and nothing extra is installed.
 */

const COLOR: Readonly<Record<FrameColor, string>> = { white: 'White', almond: 'Almond', clay: 'Clay', bronze: 'Bronze', black: 'Black', woodgrain: 'Woodgrain' };
const GLASS: Readonly<Record<GlassPackage, string>> = { 'lowe-argon': 'Dual pane Low-E + argon', 'triple-lowe-argon': 'Triple pane Low-E + argon' };
const SCREEN: Readonly<Record<ScreenType, string>> = { none: 'None', half: 'Half', full: 'Full' };
const GRID_TYPE: Readonly<Record<WindowGrid['type'], string>> = { none: 'None', colonial: 'Colonial', prairie: 'Prairie', custom: 'Custom' };

export function gridText(g: WindowGrid): string {
  if (g.type === 'none') return 'None';
  const sashes = [g.top !== '' ? `top ${g.top}` : null, g.bottom !== '' ? `bottom ${g.bottom}` : null].filter((s) => s !== null);
  return `${GRID_TYPE[g.type]}${sashes.length > 0 ? ` (${sashes.join(', ')})` : ''}`;
}

const yesNo = (b: boolean) => (b ? 'Yes' : 'No');

export const ORDER_CSV_HEADERS = [
  'PO',
  'Line',
  'Qty',
  'Location',
  'Style',
  'Width (in)',
  'Height (in)',
  'Width',
  'Height',
  'United inches',
  'Sq ft',
  'Exterior color',
  'Interior color',
  'Grid',
  'Glass',
  'Tempered',
  'Obscure',
  'Screen',
  'Special order',
  'Notes',
] as const;

/** One CSV row per sheet line. Sizes as decimals (for import) and as fractions (for people). */
export function orderCsv(view: WindowOrderView): string {
  return toCsv(
    ORDER_CSV_HEADERS,
    view.groups.map((g) => [
      view.poNumber,
      g.lineNo,
      g.quantity,
      g.locations.join('; '),
      windowStyleName(g.style),
      g.widthIn,
      g.heightIn,
      fractionInches(g.widthIn),
      fractionInches(g.heightIn),
      g.unitedIn,
      Math.round(g.sqFt * 100) / 100,
      COLOR[g.frameExterior],
      COLOR[g.frameInterior],
      gridText(g.grid),
      GLASS[g.glass],
      yesNo(g.tempered),
      yesNo(g.obscure),
      SCREEN[g.screen],
      yesNo(g.specialOrder),
      g.notes,
    ]),
  );
}

export type OrderSheetInput = { view: WindowOrderView; companyName: string; generatedOn: string };

const LEFT = 36;
const PAGE_W = 792; // landscape letter
const CONTENT_W = PAGE_W - LEFT * 2;
const BOTTOM = 612 - 48;

type Col = { title: string; w: number; cell: (g: OrderGroup) => string };
const COLS: Col[] = [
  { title: 'LINE', w: 30, cell: (g) => String(g.lineNo) },
  { title: 'QTY', w: 28, cell: (g) => String(g.quantity) },
  { title: 'LOCATION', w: 92, cell: (g) => g.locations.join(', ') },
  { title: 'STYLE', w: 72, cell: (g) => windowStyleName(g.style) + (g.specialOrder ? '\nSPECIAL ORDER' : '') },
  { title: 'WIDTH', w: 46, cell: (g) => fractionInches(g.widthIn) },
  { title: 'HEIGHT', w: 46, cell: (g) => fractionInches(g.heightIn) },
  { title: 'UI', w: 34, cell: (g) => fractionInches(g.unitedIn) },
  { title: 'EXT / INT', w: 74, cell: (g) => `${COLOR[g.frameExterior]} / ${COLOR[g.frameInterior]}` },
  { title: 'GRID', w: 80, cell: (g) => gridText(g.grid) },
  { title: 'GLASS', w: 74, cell: (g) => GLASS[g.glass] + (g.tempered ? '\nTempered' : '') + (g.obscure ? '\nObscure' : '') },
  { title: 'SCREEN', w: 40, cell: (g) => SCREEN[g.screen] },
  { title: 'NOTES', w: CONTENT_W - 616, cell: (g) => g.notes },
];

const BOLD_COLS: ReadonlySet<string> = new Set(['QTY', 'WIDTH', 'HEIGHT']);

/** The printable order sheet (landscape letter). A draft is marked DRAFT on every page: not for ordering. */
export function renderOrderPdf(i: OrderSheetInput, opts?: { compress?: boolean }): PDFKit.PDFDocument {
  const { view: v } = i;
  const { ink, muted, accent, band, line } = PDF_COLORS;
  const d = new PDFDocument({ size: 'LETTER', layout: 'landscape', margin: LEFT, bufferPages: true, compress: opts?.compress ?? true, info: { Title: `Window order ${v.poNumber}`.trim(), Author: i.companyName } });

  d.rect(0, 0, PAGE_W, 8).fill(accent);
  d.fillColor(ink).font('Helvetica-Bold').fontSize(18).text(`${i.companyName}: window order`, LEFT, 26);
  const status = v.status === 'draft' ? 'DRAFT: not for ordering. Mark the order ready first.' : v.status === 'ready' ? 'Ready: sizes locked' : 'Sent to the factory';
  d.font('Helvetica').fontSize(10).fillColor(muted).text(`${v.address}  |  PO ${v.poNumber !== '' ? v.poNumber : '(none)'}  |  ${status}  |  ${i.generatedOn}`);
  d.fontSize(8).text(
    'Sizes are the order (rough unit) size in inches: the smallest on-site measurement less the company deduction, rounded down to 1/8 in. Only windows measured from on-site photos are on this sheet.',
    { width: CONTENT_W },
  );
  d.moveDown(0.8);

  const header = () => {
    const y = d.y;
    d.rect(LEFT, y, CONTENT_W, 18).fill(band);
    let x = LEFT + 4;
    d.fillColor(ink).font('Helvetica-Bold').fontSize(7.5);
    for (const c of COLS) {
      d.text(c.title, x, y + 6, { width: c.w - 6 });
      x += c.w;
    }
    d.y = y + 22;
  };
  header();
  d.font('Helvetica').fontSize(8.5);
  for (const g of v.groups) {
    const cells = COLS.map((c) => c.cell(g));
    const h = Math.max(...COLS.map((c, k) => d.heightOfString(cells[k]!, { width: c.w - 6 }))) + 8;
    if (d.y + h > BOTTOM) {
      d.addPage();
      header();
      d.font('Helvetica').fontSize(8.5);
    }
    const y = d.y;
    let x = LEFT + 4;
    COLS.forEach((c, k) => {
      d.fillColor(ink).font(BOLD_COLS.has(c.title) ? 'Helvetica-Bold' : 'Helvetica');
      d.text(cells[k]!, x, y + 4, { width: c.w - 6 });
      x += c.w;
    });
    d.moveTo(LEFT, y + h).lineTo(LEFT + CONTENT_W, y + h).strokeColor(line).lineWidth(0.5).stroke();
    d.y = y + h;
  }

  const t = v.totals;
  d.moveDown(0.6).font('Helvetica-Bold').fontSize(10).fillColor(ink);
  d.text(`${t.windows} windows on ${t.lines} lines  |  ${fractionInches(t.unitedIn)} united inches  |  ${t.sqFt.toFixed(2)} sq ft${t.specialOrders > 0 ? `  |  ${t.specialOrders} special order` : ''}`, LEFT, d.y, { width: CONTENT_W });

  // Each window as measured on site, for checking the order against the photos.
  if (d.y + 60 > BOTTOM) d.addPage();
  d.moveDown(1).font('Helvetica-Bold').fontSize(10).text('Windows as measured on site', LEFT, d.y);
  d.font('Helvetica').fontSize(8).fillColor(muted);
  const onSheet = new Set(v.groups.flatMap((g) => g.lineIds));
  v.lines.forEach((l, k) => {
    const s = smallestMeasured(l.measured);
    const c = v.checked[k];
    const measured = s === null ? 'not measured' : `${fractionInches(s.widthIn)} x ${fractionInches(s.heightIn)}${s.uncertaintyIn !== null ? ` (+/- ${fractionInches(s.uncertaintyIn)})` : ''}`;
    const order = c?.order ? `${fractionInches(c.order.widthIn)} x ${fractionInches(c.order.heightIn)}` : '-';
    const photos = l.measured.length > 1 ? `, smallest of ${l.measured.length} photos` : '';
    // A window that is not on a sheet line yet (a draft with no style, say) says why, so nothing goes missing silently.
    const missing = onSheet.has(l.id) ? '' : `  [NOT ON THE SHEET: ${c?.reasons.find((r) => r.level === 'error')?.message ?? 'not ready'}]`;
    if (d.y + 12 > BOTTOM) d.addPage();
    d.fillColor(missing === '' ? muted : '#c0392b').text(`${l.location || '(no location)'}: measured ${measured}${photos}  ->  order ${order}${l.tempered ? ', tempered' : ''}${missing}`, LEFT, d.y, { width: CONTENT_W });
  });

  // Footer and the DRAFT mark on every page.
  const range = d.bufferedPageRange();
  for (let p = range.start; p < range.start + range.count; p++) {
    d.switchToPage(p);
    if (v.status === 'draft') {
      d.save().rotate(-20, { origin: [PAGE_W / 2, 306] }).fillColor('#c0392b').opacity(0.12).font('Helvetica-Bold').fontSize(120).text('DRAFT', 0, 250, { width: PAGE_W, align: 'center', lineBreak: false }).restore();
      d.opacity(1);
    }
    // The footer sits in the bottom margin: without this pdfkit would start a new (blank) page for it.
    d.page.margins.bottom = 0;
    d.fillColor(muted).font('Helvetica').fontSize(7.5).text(`Page ${p - range.start + 1} of ${range.count}`, LEFT, 612 - 30, { width: CONTENT_W, align: 'right', lineBreak: false });
  }
  d.end();
  return d;
}
