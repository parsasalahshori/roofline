import PDFDocument from 'pdfkit';
import type { ClaimPacketFacts } from '@roofline/shared';
import { PDF_COLORS } from '../quotes/pdf.ts';

export type ClaimPacketPdfInput = {
  facts: ClaimPacketFacts;
  /** PNG bytes from `StaticMap.image`; null prints no image. */
  mapImage: Uint8Array | null;
};

const MARGIN = 48;
const FONT = 'Helvetica';
const BOLD = 'Helvetica-Bold';

const S = {
  title: 'Claim packet',
  storm: 'Storm evidence',
  measurements: 'Measurements',
  inspection: 'Inspection',
  notes: 'Notes',
  noRadarHail: 'No radar hail found at this address on',
  noDate: 'No date of loss is on file, so no radar check was made.',
  noSpotters: 'No spotter reports within 10 miles.',
  spotterSize: 'Size (inches)',
  spotterTime: 'Time (UTC)',
  spotterPlace: 'Place',
  mapCaption: 'Map of the property',
  noMeasurement: 'No roof measurement on file.',
  noInspection: 'No completed inspection on file.',
  noNotes: 'No notes.',
  notGiven: 'Not given',
  footer: (company: string): string => `Prepared by ${company} for the homeowner. Roofline does not contact insurers.`,
  hail: (x: string, date: string): string => `Radar-estimated hail up to ${x} inches (NOAA MRMS) on ${date}`,
} as const;

/** Every fixed sentence the PDF prints (a test runs `claimsGuard` over them). */
export const CLAIM_PACKET_FIXED_STRINGS: readonly string[] = [
  S.title,
  S.storm,
  S.measurements,
  S.inspection,
  S.notes,
  `${S.noRadarHail} June 14, 2026`,
  S.hail('1.5', 'June 14, 2026'),
  S.noDate,
  S.noSpotters,
  S.mapCaption,
  S.noMeasurement,
  S.noInspection,
  S.noNotes,
  S.footer('Example Roofing'),
];

type Doc = PDFKit.PDFDocument;
const contentWidth = (doc: Doc): number => doc.page.width - MARGIN * 2;
const bottom = (doc: Doc): number => doc.page.height - MARGIN;

function ensure(doc: Doc, needed: number): void {
  if (doc.y + needed > bottom(doc)) doc.addPage();
}

/** A date in `zone`, e.g. "October 12, 2026". A date-only string is not shifted by the zone. */
export function formatPacketDate(iso: string, zone: string): string {
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(iso);
  const d = new Date(dateOnly ? `${iso}T12:00:00Z` : iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: dateOnly ? 'UTC' : zone }).format(d);
}

const trim = (n: number): string => String(Math.round(n * 100) / 100);

function heading(doc: Doc, text: string): void {
  ensure(doc, 50);
  doc.moveDown(0.8);
  doc.fillColor(PDF_COLORS.ink).font(BOLD).fontSize(14).text(text, MARGIN, doc.y, { width: contentWidth(doc) });
  doc.moveDown(0.3);
}

function line(doc: Doc, text: string, o: { bold?: boolean; size?: number; muted?: boolean } = {}): void {
  ensure(doc, 16);
  doc
    .fillColor(o.muted ? PDF_COLORS.muted : PDF_COLORS.ink)
    .font(o.bold ? BOLD : FONT)
    .fontSize(o.size ?? 11)
    .text(text, MARGIN, doc.y, { width: contentWidth(doc) });
}

function cells(doc: Doc, cols: { x: number; w: number; text: string; bold?: boolean }[]): void {
  ensure(doc, 24);
  const y = doc.y;
  doc.fillColor(PDF_COLORS.ink).fontSize(10);
  for (const c of cols) doc.font(c.bold ? BOLD : FONT).text(c.text, MARGIN + c.x, y, { width: c.w, lineBreak: false, ellipsis: true });
  const lineY = y + 16;
  doc.moveTo(MARGIN, lineY).lineTo(MARGIN + contentWidth(doc), lineY).lineWidth(0.5).strokeColor(PDF_COLORS.line).stroke();
  doc.y = lineY + 6;
  doc.x = MARGIN;
}

export function renderClaimPacketPdf(i: ClaimPacketPdfInput, o?: { compress?: boolean }): PDFKit.PDFDocument {
  const { facts } = i;
  const zone = facts.timeZone;
  const doc = new PDFDocument({
    size: 'LETTER',
    margin: MARGIN,
    compress: o?.compress ?? true,
    info: { Title: S.title, Author: facts.company.name, Subject: S.title },
  });
  const w = contentWidth(doc);
  const lossDate = facts.dateOfLoss === null ? null : formatPacketDate(facts.dateOfLoss, zone);

  // 1. Cover.
  doc.rect(0, 0, doc.page.width, 8).fill(PDF_COLORS.accent);
  doc.fillColor(PDF_COLORS.ink).font(BOLD).fontSize(18).text(facts.company.name, MARGIN, MARGIN, { width: w });
  doc.moveDown(0.8);
  doc.fillColor(PDF_COLORS.ink).font(BOLD).fontSize(24).text(S.title, MARGIN, doc.y, { width: w });
  doc.moveDown(0.5);
  line(doc, facts.customerName, { bold: true, size: 13 });
  line(doc, facts.address);
  doc.moveDown(0.4);
  line(doc, `Insurer: ${facts.insurer ?? S.notGiven}`);
  line(doc, `Claim number: ${facts.claimNumber ?? S.notGiven}`);
  line(doc, `Date of loss: ${lossDate ?? S.notGiven}`);

  // 2. Storm evidence.
  heading(doc, S.storm);
  if (lossDate === null) {
    line(doc, S.noDate);
  } else if (facts.hail !== null) {
    // The radar row's own storm day, which can be the day before the date of loss.
    line(doc, S.hail(trim(facts.hail.thresholdIn), formatPacketDate(facts.hail.convectiveDay, zone)), { bold: true });
  } else {
    line(doc, `${S.noRadarHail} ${lossDate}`);
  }
  doc.moveDown(0.6);
  if (facts.spotterReports.length === 0) {
    line(doc, S.noSpotters);
  } else {
    const cols = { size: 0, time: w * 0.2, place: w * 0.4 };
    const widths = { size: w * 0.18, time: w * 0.18, place: w * 0.6 };
    doc.rect(MARGIN, doc.y, w, 20).fill(PDF_COLORS.band);
    const y = doc.y;
    doc.fillColor(PDF_COLORS.muted).font(BOLD).fontSize(9);
    doc.text(S.spotterSize, MARGIN + cols.size, y + 6, { width: widths.size, lineBreak: false });
    doc.text(S.spotterTime, MARGIN + cols.time, y + 6, { width: widths.time, lineBreak: false });
    doc.text(S.spotterPlace, MARGIN + cols.place, y + 6, { width: widths.place, lineBreak: false });
    doc.y = y + 26;
    doc.x = MARGIN;
    for (const r of facts.spotterReports) {
      const place = [r.location, r.county === null ? null : `${r.county} County`, r.state].filter((p): p is string => p !== null && p !== '').join(', ');
      cells(doc, [
        { x: cols.size, w: widths.size, text: trim(r.sizeIn) },
        { x: cols.time, w: widths.time, text: r.timeUtc },
        { x: cols.place, w: widths.place, text: place },
      ]);
    }
  }
  if (i.mapImage !== null) {
    doc.moveDown(0.6);
    ensure(doc, 290);
    const y = doc.y;
    doc.image(Buffer.from(i.mapImage), MARGIN, y, { fit: [w, 260] });
    doc.y = y + 266;
    doc.x = MARGIN;
    line(doc, S.mapCaption, { muted: true, size: 9 });
  }

  // 3. Measurements.
  heading(doc, S.measurements);
  const m = facts.measurement;
  if (m === null) {
    line(doc, S.noMeasurement);
  } else {
    line(doc, m.label, { bold: true });
    if (m.roofSquares !== null) line(doc, `${trim(m.roofSquares)} squares`);
    if (m.roofAreaSqFt !== null) line(doc, `${trim(m.roofAreaSqFt)} sq ft`);
    if (m.pitchX12 !== null) line(doc, `${trim(m.pitchX12)}/12`);
    line(doc, `Measured ${formatPacketDate(m.measuredAt, zone)}`);
  }

  // 4. Inspection.
  heading(doc, S.inspection);
  if (facts.inspection === null) {
    line(doc, S.noInspection);
  } else {
    line(doc, formatPacketDate(facts.inspection.date, zone));
    if (facts.inspection.notes !== null && facts.inspection.notes !== '') line(doc, facts.inspection.notes);
  }

  // 5. Notes.
  heading(doc, S.notes);
  line(doc, facts.intakeNotes !== null && facts.intakeNotes !== '' ? facts.intakeNotes : S.noNotes);

  // 6. Footer.
  doc.moveDown(1.5);
  line(doc, S.footer(facts.company.name), { muted: true, size: 9 });

  return doc;
}
