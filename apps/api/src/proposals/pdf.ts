import PDFDocument from 'pdfkit';
import { money, TIERS, type ProposalOptionView, type ProposalView, type SignatureRecord } from '@roofline/shared';
import { PDF_COLORS } from '../quotes/pdf.ts';

export type ProposalPdfInput = {
  audience: 'homeowner' | 'internal';
  company: { name: string; phone: string | null };
  proposal: ProposalView;
  /** Per-option inclusions lines, keyed by option id (homeowner-safe text; no unit prices). */
  inclusions?: Record<string, string[]>;
  /** Present for a signed proposal: adds the signature page. */
  signature?: { record: SignatureRecord; image: Buffer | null };
  /** Financing terms for the "About $X/mo" line; null/absent hides it. */
  financing?: { aprBps: number; months: number } | null;
};

const MARGIN = 48;
const FONT = 'Helvetica';
const BOLD = 'Helvetica-Bold';

type Doc = PDFKit.PDFDocument;

const contentWidth = (doc: Doc): number => doc.page.width - MARGIN * 2;
const bottom = (doc: Doc): number => doc.page.height - MARGIN;

/** Starts a new page when fewer than `needed` points remain. */
function ensure(doc: Doc, needed: number): void {
  if (doc.y + needed > bottom(doc)) doc.addPage();
}

/** A shaded header band with column titles; `cols` are x offsets (from the left margin) and widths. */
function headerBand(doc: Doc, cols: { x: number; w: number; text: string; right?: boolean }[]): void {
  ensure(doc, 40);
  const y = doc.y;
  doc.rect(MARGIN, y, contentWidth(doc), 20).fill(PDF_COLORS.band);
  doc.fillColor(PDF_COLORS.muted).font(BOLD).fontSize(9);
  for (const c of cols) doc.text(c.text, MARGIN + c.x, y + 6, { width: c.w, align: c.right ? 'right' : 'left', lineBreak: false });
  doc.y = y + 26;
  doc.x = MARGIN;
}

/** One table row of single-line cells, then a thin line under it. */
function row(doc: Doc, cols: { x: number; w: number; text: string; right?: boolean; bold?: boolean }[]): void {
  ensure(doc, 24);
  const y = doc.y;
  doc.fillColor(PDF_COLORS.ink).fontSize(10);
  for (const c of cols) {
    doc.font(c.bold ? BOLD : FONT).text(c.text, MARGIN + c.x, y, { width: c.w, align: c.right ? 'right' : 'left', lineBreak: false, ellipsis: true });
  }
  const lineY = y + 16;
  doc.moveTo(MARGIN, lineY).lineTo(MARGIN + contentWidth(doc), lineY).lineWidth(0.5).strokeColor(PDF_COLORS.line).stroke();
  doc.y = lineY + 6;
  doc.x = MARGIN;
}

function heading(doc: Doc, text: string): void {
  ensure(doc, 40);
  doc.moveDown(0.6);
  doc.fillColor(PDF_COLORS.ink).font(BOLD).fontSize(13).text(text, MARGIN, doc.y, { width: contentWidth(doc) });
  doc.moveDown(0.3);
}

function line(doc: Doc, text: string, o: { bold?: boolean; size?: number; muted?: boolean } = {}): void {
  ensure(doc, 16);
  doc
    .fillColor(o.muted ? PDF_COLORS.muted : PDF_COLORS.ink)
    .font(o.bold ? BOLD : FONT)
    .fontSize(o.size ?? 10)
    .text(text, MARGIN, doc.y, { width: contentWidth(doc) });
}

const trimNumber = (n: number): string => String(Math.round(n * 100) / 100);

function financingLine(option: ProposalOptionView, f: { aprBps: number; months: number }): string | null {
  if (option.monthlyEstimateCents === null) return null;
  const apr = f.aprBps / 100;
  return `About $${Math.round(option.monthlyEstimateCents / 100)}/mo · ${trimNumber(apr)}% for ${f.months} months · estimate, subject to approval`;
}

function formatDate(iso: string): string {
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso}T12:00:00Z` : iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

function inclusionsFor(i: ProposalPdfInput, o: ProposalOptionView): string[] {
  const given = i.inclusions?.[o.id];
  if (given) return given;
  return [...o.highlights, ...o.addOns.map((a) => a.name)];
}

function internalTables(doc: Doc, o: ProposalOptionView, isEstimate: boolean): void {
  const w = contentWidth(doc);
  const cols = { name: 0, qty: w * 0.46, unit: w * 0.58, price: w * 0.7, total: w * 0.85 };
  const widths = { name: w * 0.45, qty: w * 0.11, unit: w * 0.11, price: w * 0.14, total: w * 0.15 };
  headerBand(doc, [
    { x: cols.name, w: widths.name, text: 'Item' },
    { x: cols.qty, w: widths.qty, text: 'Qty', right: true },
    { x: cols.unit, w: widths.unit, text: 'Unit' },
    { x: cols.price, w: widths.price, text: 'Unit price', right: true },
    { x: cols.total, w: widths.total, text: 'Line total', right: true },
  ]);
  const lines = [...o.calculation.lines, ...o.addOnLines];
  for (const l of lines) {
    row(doc, [
      { x: cols.name, w: widths.name, text: l.name },
      { x: cols.qty, w: widths.qty, text: String(l.quantity), right: true },
      { x: cols.unit, w: widths.unit, text: l.unit },
      { x: cols.price, w: widths.price, text: money(l.unitCents), right: true },
      { x: cols.total, w: widths.total, text: money(l.totalCents), right: true },
    ]);
  }
  const c = o.calculation;
  const sums: [string, number][] = [
    ['Subtotal', c.subtotalCents],
    ['Markup', c.markupCents],
    ['Tax', c.taxCents],
    [isEstimate ? 'Estimate total' : 'Total', o.totalCents],
  ];
  sums.forEach(([label, cents], idx) => {
    const bold = idx === sums.length - 1;
    row(doc, [
      { x: cols.price - 40, w: widths.price + 40, text: label, right: true, bold },
      { x: cols.total, w: widths.total, text: money(cents), right: true, bold },
    ]);
  });
}

export function renderProposalPdf(i: ProposalPdfInput, o?: { compress?: boolean }): PDFKit.PDFDocument {
  const { proposal, company } = i;
  const doc = new PDFDocument({
    size: 'LETTER',
    margin: MARGIN,
    compress: o?.compress ?? true,
    info: { Title: `Roof proposal ${proposal.number}`, Author: company.name, Subject: 'Roof proposal' },
  });
  const w = contentWidth(doc);
  const isEstimate = proposal.basis === 'estimate';
  const enabled = TIERS.flatMap((t) => proposal.options.filter((x) => x.tier === t && x.enabled));
  // Options of an unknown order still show: keep any enabled option the tier sort missed.
  for (const x of proposal.options) if (x.enabled && !enabled.includes(x)) enabled.push(x);

  // Page 1: header.
  doc.rect(0, 0, doc.page.width, 8).fill(PDF_COLORS.accent);
  doc.fillColor(PDF_COLORS.ink).font(BOLD).fontSize(18).text(company.name, MARGIN, MARGIN, { width: w });
  if (company.phone) doc.font(FONT).fontSize(10).fillColor(PDF_COLORS.muted).text(company.phone, MARGIN, doc.y, { width: w });
  doc.moveDown(1);
  doc.fillColor(PDF_COLORS.ink).font(BOLD).fontSize(24).text('Roof proposal', MARGIN, doc.y, { width: w });
  doc.moveDown(0.3);
  line(doc, proposal.number, { bold: true, size: 12 });
  line(doc, `Valid until ${formatDate(proposal.validUntil)}`, { muted: true });
  doc.moveDown(0.6);
  line(doc, proposal.address, { size: 11 });
  line(doc, `Prepared for ${proposal.customer.name}`, { size: 11 });
  doc.moveDown(0.8);

  // Summary table.
  const totalLabel = isEstimate ? 'Estimate total' : 'Total';
  const cols = { name: 0, hl: w * 0.24, total: w * 0.8 };
  const widths = { name: w * 0.22, hl: w * 0.54, total: w * 0.2 };
  headerBand(doc, [
    { x: cols.name, w: widths.name, text: 'Option' },
    { x: cols.hl, w: widths.hl, text: 'Highlights' },
    { x: cols.total, w: widths.total, text: totalLabel, right: true },
  ]);
  for (const opt of enabled) {
    const bullets = opt.highlights.map((h) => `• ${h}`).join('\n');
    const fin = i.financing ? financingLine(opt, i.financing) : null;
    const text = bullets === '' ? ' ' : bullets;
    const h = doc.font(FONT).fontSize(10).heightOfString(text, { width: widths.hl });
    ensure(doc, h + 40);
    const y = doc.y;
    doc.fillColor(PDF_COLORS.ink).font(BOLD).fontSize(11).text(opt.name, MARGIN + cols.name, y, { width: widths.name });
    doc.font(FONT).fontSize(10).text(text, MARGIN + cols.hl, y, { width: widths.hl });
    doc.font(BOLD).fontSize(11).text(money(opt.totalCents), MARGIN + cols.total, y, { width: widths.total, align: 'right' });
    let endY = Math.max(doc.y, y + h);
    if (fin) {
      doc.font(FONT).fontSize(9).fillColor(PDF_COLORS.muted).text(fin, MARGIN + cols.hl, endY + 2, { width: widths.hl + widths.total });
      endY = doc.y;
    }
    const lineY = endY + 6;
    doc.moveTo(MARGIN, lineY).lineTo(MARGIN + w, lineY).lineWidth(0.5).strokeColor(PDF_COLORS.line).stroke();
    doc.y = lineY + 8;
    doc.x = MARGIN;
  }
  doc.moveDown(0.3);
  line(doc, isEstimate ? 'Estimate based on the roof outline.' : 'Based on an exact roof report.', { muted: true, size: 9 });

  // One section per enabled option.
  for (const opt of enabled) {
    heading(doc, opt.name);
    for (const item of inclusionsFor(i, opt)) line(doc, `• ${item}`);
    if (i.audience === 'internal') {
      doc.moveDown(0.5);
      internalTables(doc, opt, isEstimate);
    }
  }

  // Signature page.
  if (i.signature) {
    const { record, image } = i.signature;
    const chosen = proposal.options.find((x) => x.id === record.optionId);
    doc.addPage();
    doc.fillColor(PDF_COLORS.ink).font(BOLD).fontSize(20).text('Signature', MARGIN, MARGIN, { width: w });
    doc.moveDown(0.8);
    line(doc, `Signed by ${record.signerName}`, { bold: true, size: 12 });
    line(doc, `Typed signature: ${record.typedSignature}`);
    line(doc, `Signed at: ${record.signedAt}`);
    if (chosen) line(doc, `Option: ${chosen.name}`);
    line(doc, `${totalLabel}: ${money(record.totalCents)}`);
    doc.moveDown(0.6);
    line(doc, record.consentText, { muted: true });
    doc.moveDown(0.6);
    line(doc, 'Document SHA-256', { bold: true, size: 9 });
    line(doc, record.documentSha256, { size: 9 });
    if (image) {
      doc.moveDown(0.8);
      ensure(doc, 100);
      doc.image(image, MARGIN, doc.y, { fit: [220, 90] });
    }
  }

  return doc;
}
