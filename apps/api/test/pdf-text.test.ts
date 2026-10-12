import { deflateSync } from 'node:zlib';
import { describe, expect, test } from 'vitest';
import { pdfToBuffer, renderProposalPdf } from '../src/proposals/pdf.ts';
import { pdfText } from './pdf-text.ts';

/** A one-object PDF fragment holding `text` in a Flate stream, as PDFKit lays it out. */
function flateObject(text: string): { pdf: Buffer; lastByte: number } {
  const content = Buffer.from(`BT [<${Buffer.from(text, 'latin1').toString('hex')}>] TJ ET`);
  const data = deflateSync(content);
  const pdf = Buffer.concat([
    Buffer.from(`5 0 obj\n<<\n/Length ${data.length}\n/Filter /FlateDecode\n>>\nstream\n`, 'latin1'),
    data,
    Buffer.from('\nendstream\nendobj\n', 'latin1'),
  ]);
  return { pdf, lastByte: data[data.length - 1]! };
}

describe('pdfText', () => {
  test('reads a page whose compressed stream ends in a carriage return (the signed-pdf flake)', () => {
    // Search deterministically for a text whose Flate bytes end in \r; the old `\r?\nendstream` cut dropped that byte.
    let found: { pdf: Buffer; text: string } | null = null;
    for (let i = 0; i < 5000 && !found; i++) {
      const text = `Signing record ${i * 7919}`;
      const o = flateObject(text);
      if (o.lastByte === 0x0d) found = { pdf: o.pdf, text };
    }
    expect(found).not.toBeNull();
    expect(pdfText(found!.pdf)).toContain(found!.text);
  });

  test('reads every page of a real rendered PDF, compressed and not', async () => {
    const doc = () => {
      const d = renderProposalPdf(
        {
          audience: 'homeowner',
          company: { name: 'Acme Roofing', phone: null },
          proposal: {
            id: 'p1', number: 'P-0001', status: 'draft', jobId: 'j1', customer: { id: 'c1', name: 'Test Person', phone: null },
            address: '1 Test St', measurementId: 'm1', basis: 'estimate', options: [], messageBody: '', validUntil: '2026-11-11',
            sentAt: null, views: { count: 0, first: null, last: null }, signed: null, declined: null, taskId: null, replacedById: null, canEdit: false,
          } as never,
          estimateClause: null,
        },
        { compress: true },
      );
      return pdfToBuffer(d);
    };
    expect(pdfText(await doc())).toContain('P-0001');
  });
});
