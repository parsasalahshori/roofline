import PDFDocument from 'pdfkit';
import { money, materialNames, type QuoteView } from '@roofline/shared';

export type QuotePdfInput = {
  quote: QuoteView;
  company: { name: string; phone: string | null; email: string | null; website: string | null; address: string | null };
  customer: { name: string; phone: string | null; email: string | null };
  address: string;
  timeZone: string;
};

export const PDF_COLORS = { ink: '#2b2620', muted: '#6b6257', accent: '#f5b324', band: '#f6f1e6', line: '#eee5cf' };

const PAGE_WIDTH = 612;
const CONTENT_WIDTH = 516;
const LEFT = 48;
const FOOTER_Y = 745;

const present = (parts: Array<string | null | undefined>, sep: string): string =>
  parts.filter((s): s is string => typeof s === 'string' && s.length > 0).join(sep);

/** Company-zone calendar date for an ISO instant, e.g. "Oct 12, 2026". */
const instantDate = (iso: string, timeZone: string): string =>
  new Intl.DateTimeFormat('en-US', { timeZone, month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(iso));

/** A plain 'YYYY-MM-DD' calendar date, formatted without any timezone shift, e.g. "Nov 11, 2026". */
const calendarDate = (ymd: string): string => {
  const [y = 1970, m = 1, d = 1] = ymd.split('-').map(Number);
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' }).format(
    new Date(Date.UTC(y, m - 1, d)),
  );
};

export function renderQuotePdf(i: QuotePdfInput, opts?: { compress?: boolean }): PDFKit.PDFDocument {
  const { quote: q, company, customer, address, timeZone } = i;
  const { ink, muted, accent, band, line } = PDF_COLORS;
  const d = new PDFDocument({
    size: 'LETTER',
    margin: LEFT,
    bufferPages: true,
    compress: opts?.compress ?? true,
    info: { Title: `${q.number} Roofing estimate`, Author: company.name },
  });

  // Top bar and company block.
  d.rect(0, 0, PAGE_WIDTH, 10).fill(accent);
  d.fillColor(ink).font('Helvetica-Bold').fontSize(24).text(company.name, LEFT, 42);
  const contact = present([company.address, company.phone, company.email, company.website], '  |  ');
  d.fillColor(muted).font('Helvetica').fontSize(9).text(contact, LEFT, d.y + 8, { width: CONTENT_WIDTH });

  // Heading and status.
  d.moveDown(2).fillColor(ink).font('Helvetica-Bold').fontSize(26).text('Roofing estimate');
  const statusLine =
    q.status === 'draft' ? `${q.number} · Draft — not final` : `${q.number} · Final`;
  d.font('Helvetica').fontSize(10).fillColor(muted).text(statusLine);
  d.text(`Created ${instantDate(q.createdAt, timeZone)} · Valid through ${calendarDate(q.validUntil)}`);

  // Customer.
  d.moveDown(1.5).fillColor(ink).font('Helvetica-Bold').fontSize(13).text(customer.name);
  d.font('Helvetica').fontSize(11).text(address);
  d.fontSize(9).text(present([customer.email, customer.phone], ' | '));

  // Scope.
  const { scope, calculation } = q;
  d.moveDown().fontSize(11).text(
    `${materialNames[scope.material]} | ${Math.round(calculation.surfaceAreaSqFt)} sq ft roof surface | ${scope.pitch}/12 pitch | ${scope.wastePercent}% material waste`,
  );
  d.fontSize(9).fillColor(muted).text('Measurement: entered by hand');
  d.moveDown(1.5);

  // Line table.
  const header = (): void => {
    const y = d.y;
    d.rect(LEFT, y, CONTENT_WIDTH, 25).fill(band);
    d.fillColor(ink).font('Helvetica-Bold').fontSize(9)
      .text('DESCRIPTION', 58, y + 8)
      .text('QTY', 338, y + 8)
      .text('RATE', 410, y + 8)
      .text('AMOUNT', 491, y + 8);
    d.y = y + 34;
  };
  header();
  for (const row of calculation.lines) {
    if (d.y > 660) {
      d.addPage();
      header();
    }
    const y = d.y;
    d.fillColor(ink).font('Helvetica').fontSize(10);
    const nameHeight = d.heightOfString(row.name, { width: 266 });
    d.text(row.name, 58, y, { width: 266 })
      .text(`${Number(row.quantity.toFixed(2))} ${row.unit}`, 328, y, { width: 78 })
      .text(money(row.unitCents), 408, y, { width: 78 })
      .text(money(row.totalCents), 486, y, { width: 68, align: 'right' });
    const rule = y + Math.max(nameHeight, 12) + 10;
    d.moveTo(LEFT, rule).lineTo(LEFT + CONTENT_WIDTH, rule).strokeColor(line).stroke();
    d.y = rule + 10;
  }

  // Summary and total band.
  if (d.y > 570) d.addPage();
  const summary: ReadonlyArray<readonly [string, number]> = [
    ['Direct cost', calculation.subtotalCents],
    [`Overhead & profit (${scope.markupPercent}% markup)`, calculation.markupCents],
    [`Materials tax (${scope.taxPercent}%)`, calculation.taxCents],
  ];
  for (const [label, value] of summary) {
    const y = d.y;
    d.fillColor(ink).font('Helvetica').fontSize(10)
      .text(label, 275, y, { width: 200 })
      .text(money(value), 480, y, { width: 74, align: 'right' });
    d.y = y + 20;
  }
  const bandY = d.y + 4;
  d.rect(275, bandY, 289, 40).fill(accent);
  d.fillColor(ink).font('Helvetica-Bold').fontSize(12)
    .text('Estimate total', 287, bandY + 13)
    .text(money(calculation.totalCents), 433, bandY + 13, { width: 118, align: 'right' });
  d.y = bandY + 60;

  // Scope & assumptions.
  d.fillColor(ink).font('Helvetica-Bold').fontSize(11).text('Scope & assumptions', LEFT, d.y);
  d.font('Helvetica').fontSize(9).text(
    'Budget estimate for the stated roof replacement scope. Concealed damage, structural repairs, asbestos, specialty flashing, ventilation changes, gutters and solar removal/reinstallation are excluded unless expressly included. Decking is an allowance only. Verify measurements, local requirements, material specifications and final scope on site. Default rates are examples; the contractor must approve pricing and applicable taxes.',
    { width: CONTENT_WIDTH },
  );
  if (q.notes) d.moveDown().font('Helvetica').fontSize(9).text(q.notes, { width: CONTENT_WIDTH });
  if (q.measurement.notes) {
    d.moveDown().font('Helvetica').fontSize(9).text(`Measurement notes: ${q.measurement.notes}`, { width: CONTENT_WIDTH });
  }

  // Footer on every page.
  const range = d.bufferedPageRange();
  for (let p = 0; p < range.count; p++) {
    d.switchToPage(range.start + p);
    // The footer sits inside the bottom margin; lift the margin so pdfkit does not break onto a blank page.
    const bottomMargin = d.page.margins.bottom;
    d.page.margins.bottom = 0;
    d.font('Helvetica').fontSize(9).fillColor(muted)
      .text(`${q.number} · Prepared with Roofline`, LEFT, FOOTER_Y, { lineBreak: false })
      .text(`${p + 1} / ${range.count}`, 520, FOOTER_Y, { width: 44, align: 'right', lineBreak: false });
    d.page.margins.bottom = bottomMargin;
  }

  d.end();
  return d;
}
