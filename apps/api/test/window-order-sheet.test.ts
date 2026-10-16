import { describe, expect, it } from 'vitest';
import { checkLine, DEFAULT_WINDOW_ORDER_SETTINGS as S, defaultLineOptions, deriveOrder, type WindowOrderLine, type WindowOrderView } from '@roofline/shared';
import { gridText, ORDER_CSV_HEADERS, orderCsv, renderOrderPdf } from '../src/estimator/window-order-sheet.ts';

const line = (id: string, location: string, over: Partial<WindowOrderLine> = {}): WindowOrderLine => ({
  id,
  photoWindowIds: [id],
  uploadId: 'u',
  location,
  measured: [{ widthIn: 36.3, heightIn: 60.2, uncertaintyIn: null, quality: 'good' }],
  ...defaultLineOptions(),
  style: 'double-hung',
  ...over,
});
function view(lines: WindowOrderLine[], status: WindowOrderView['status']): WindowOrderView {
  const locked = status === 'draft' ? lines : lines.map((l) => ({ ...l, lockedSize: checkLine(l, S).order }));
  return { id: 'o1', windowMeasurementId: 'm1', address: '1 Elm St', status, poNumber: 'PO-1', lines: locked, settings: S, ...deriveOrder(locked, S), mayMarkReady: true, readyAt: null, sentAt: null, sentBy: null, createdAt: '', updatedAt: '' };
}
function pdfText(v: WindowOrderView): Promise<string> {
  return new Promise((resolve) => {
    const d = renderOrderPdf({ view: v, companyName: 'Co', generatedOn: '2026-10-15' }, { compress: false });
    const parts: Buffer[] = [];
    d.on('data', (b: Buffer) => parts.push(b));
    d.on('end', () => resolve(Buffer.concat(parts).toString('latin1')));
  });
}
const pages = (pdf: string) => (pdf.match(/\/Type \/Page\b(?!s)/g) ?? []).length;

describe('the order sheet', () => {
  it('CSV: header, decimals and fractions, formula-guarded notes', () => {
    const csv = orderCsv(view([line('a', 'Den', { notes: '=x', grid: { type: 'prairie', top: '2x2', bottom: '' } })], 'ready'));
    const [head, row] = csv.trim().split('\r\n');
    expect(head).toBe(ORDER_CSV_HEADERS.join(','));
    expect(row).toBe("PO-1,1,1,Den,Double-hung,36,59.875,36,59 7/8,95.875,14.97,White,White,Prairie (top 2x2),Dual pane Low-E + argon,No,No,Full,No,'=x");
    expect(gridText({ type: 'none', top: '3x2', bottom: '' })).toBe('None');
  });

  it('PDF: one landscape page for a small order; a long order flows onto more pages', async () => {
    const small = await pdfText(view([line('a', 'Den')], 'ready'));
    expect(small.startsWith('%PDF-')).toBe(true);
    expect(pages(small)).toBe(1);
    const many = Array.from({ length: 40 }, (_, i) => line(`w${i}`, `Room ${i}`, { measured: [{ widthIn: 20 + i, heightIn: 40, uncertaintyIn: null, quality: 'good' }] }));
    expect(pages(await pdfText(view(many, 'ready')))).toBeGreaterThan(1);
  });
});
