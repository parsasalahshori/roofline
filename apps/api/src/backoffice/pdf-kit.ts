import PDFDocument from 'pdfkit';

/*
 * The look of the back office documents: an iOS-style page. Helvetica stands in for the system font, text is set in a clear
 * hierarchy (large title, small gray captions), there is generous space, grays are the system grays, and WinChoice red is a
 * thin accent only (a short bar above the title, nothing filled with it).
 */

export const COLOR = {
  ink: '#1D1D1F',
  secondary: '#6E6E73',
  tertiary: '#8E8E93',
  hairline: '#D2D2D7',
  fill: '#F5F5F7',
  accent: '#ED3A2B',
  warning: '#B25000',
} as const;

export const FONT = { regular: 'Helvetica', bold: 'Helvetica-Bold' } as const;

export type Page = { w: number; h: number; left: number; right: number; contentW: number; top: number; bottom: number };

const MARGIN = 54;

export function newDocument(o: { landscape?: boolean; title: string; author: string; compress?: boolean }): PDFKit.PDFDocument {
  return new PDFDocument({
    size: 'LETTER',
    layout: o.landscape === true ? 'landscape' : 'portrait',
    margin: MARGIN,
    bufferPages: true,
    compress: o.compress ?? true,
    info: { Title: o.title, Author: o.author },
  });
}

export function pageOf(landscape: boolean): Page {
  const w = landscape ? 792 : 612;
  const h = landscape ? 612 : 792;
  return { w, h, left: MARGIN, right: w - MARGIN, contentW: w - MARGIN * 2, top: MARGIN, bottom: h - MARGIN - 8 };
}

/** The title block: the company in small gray type, a short red bar, a large title, and gray caption lines under it. */
export function titleBlock(d: PDFKit.PDFDocument, p: Page, o: { company: string; title: string; captions: string[] }): void {
  d.rect(p.left, p.top - 22, 28, 3).fill(COLOR.accent);
  d.fillColor(COLOR.secondary).font(FONT.regular).fontSize(9).text(o.company.toUpperCase(), p.left, p.top - 12, { characterSpacing: 1.2, lineBreak: false });
  d.fillColor(COLOR.ink).font(FONT.bold).fontSize(28).text(o.title, p.left, p.top + 6, { width: p.contentW });
  d.font(FONT.regular).fontSize(11).fillColor(COLOR.secondary);
  for (const c of o.captions) if (c !== '') d.text(c, p.left, d.y + 3, { width: p.contentW });
  d.y += 12;
}

export function hairline(d: PDFKit.PDFDocument, p: Page, y: number, from = p.left, to = p.right): void {
  d.moveTo(from, y).lineTo(to, y).lineWidth(0.5).strokeColor(COLOR.hairline).stroke();
}

/** A small gray uppercase caption that heads a group, with the space above it that groups need. */
export function sectionLabel(d: PDFKit.PDFDocument, p: Page, text: string): void {
  d.fillColor(COLOR.tertiary).font(FONT.bold).fontSize(8).text(text.toUpperCase(), p.left, d.y + 14, { characterSpacing: 1, width: p.contentW });
  d.y += 6;
}

/** Page numbers (and a DRAFT mark when asked) on every page. Call once, after all content. */
export function finish(d: PDFKit.PDFDocument, p: Page, o: { footer: string; draft?: string }): void {
  const range = d.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    d.switchToPage(i);
    if (o.draft !== undefined) {
      d.save().rotate(-20, { origin: [p.w / 2, p.h / 2] }).fillColor(COLOR.accent).opacity(0.07).font(FONT.bold).fontSize(p.w > p.h ? 110 : 96).text(o.draft, 0, p.h / 2 - 60, { width: p.w, align: 'center', lineBreak: false }).restore();
      d.opacity(1);
    }
    // The footer sits in the bottom margin: without this pdfkit would add a blank page for it.
    d.page.margins.bottom = 0;
    d.fillColor(COLOR.tertiary).font(FONT.regular).fontSize(8);
    d.text(o.footer, p.left, p.h - 34, { width: p.contentW / 2, align: 'left', lineBreak: false });
    d.text(`${i - range.start + 1} of ${range.count}`, p.left + p.contentW / 2, p.h - 34, { width: p.contentW / 2, align: 'right', lineBreak: false });
  }
  d.end();
}

export const dollars = (cents: number): string => {
  const neg = cents < 0;
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${neg ? '-' : ''}$${whole}.${String(abs % 100).padStart(2, '0')}`;
};

/** 'YYYY-MM-DD' or an instant, as "Nov 3, 2026" in the company's zone. */
export function dateText(value: string | Date, timeZone: string): string {
  const date = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T12:00:00Z`) : new Date(value);
  return new Intl.DateTimeFormat('en-US', { timeZone: typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? 'UTC' : timeZone, month: 'short', day: 'numeric', year: 'numeric' }).format(date);
}
