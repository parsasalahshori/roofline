import { describe, expect, test } from 'vitest';
import type { ProposalOptionView, ProposalView, SignatureRecord } from '@roofline/shared';
import { calculateQuote, defaultPricebook, defaultScope, money } from '@roofline/shared';
import { pdfToBuffer, renderProposalPdf, type ProposalPdfInput } from '../src/proposals/pdf.ts';

const calculation = calculateQuote({ ...defaultScope, areaSqFt: 2400, areaType: 'surface', pitch: 6 }, defaultPricebook);

function option(tier: 'good' | 'better' | 'best', name: string, extra: Partial<ProposalOptionView> = {}): ProposalOptionView {
  return {
    id: `opt-${tier}`, tier, name, highlights: [`${name} highlight`], scope: { ...defaultScope }, addOns: [],
    calculation, addOnLines: [{ code: 'addon', name: 'Ice shield', quantity: 220, unit: 'ft', unitCents: 250, totalCents: 55000, taxable: true }],
    totalCents: 1_234_500, monthlyEstimateCents: 21_200, enabled: true, ...extra,
  };
}

function proposal(basis: 'estimate' | 'exact' = 'estimate'): ProposalView {
  return {
    id: 'p1', number: 'P-0001', status: 'draft', jobId: 'j1', customer: { id: 'c1', name: 'Molly Lindgren', phone: null },
    address: '100 Oak St, Omaha, NE', measurementId: 'm1', basis,
    options: [option('good', 'Alpha Shingles'), option('better', 'Bravo Shingles'), option('best', 'Charlie Metal')],
    messageBody: 'Hi', validUntil: '2026-11-11', sentAt: null, views: { count: 0, first: null, last: null },
    signed: null, declined: null, taskId: null, replacedById: null, canEdit: true,
  };
}

async function render(i: ProposalPdfInput): Promise<string> {
  const doc = renderProposalPdf(i, { compress: false });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  await new Promise<void>((r) => {
    doc.on('end', () => r());
    doc.end();
  });
  const raw = Buffer.concat(chunks).toString('latin1');
  return `${decodeText(raw)}\n${raw}`;
}

/** PDFKit writes Helvetica text as hex strings inside TJ arrays, split by kerning; join the pieces of each array. */
function decodeText(raw: string): string {
  const lines: string[] = [];
  for (const m of raw.matchAll(/\[([^\]]*)\] TJ/g)) {
    const hex = [...m[1]!.matchAll(/<([0-9a-f]*)>/g)].map((h) => h[1]).join('');
    lines.push(Buffer.from(hex, 'hex').toString('latin1'));
  }
  return lines.join('\n');
}

const base = (extra: Partial<ProposalPdfInput> = {}): ProposalPdfInput => ({
  audience: 'homeowner', company: { name: 'Acme Roofing', phone: '(402) 555-0199' }, proposal: proposal(), estimateClause: null, ...extra,
});
const pages = (s: string): number => (s.match(/\/Type \/Page\n/g) ?? []).length;

const signature: { record: SignatureRecord; image: null; timeZone: string } = {
  image: null,
  timeZone: 'America/Chicago',
  record: {
    optionId: 'opt-better', signerName: 'Molly Q. Lindgren', typedSignature: 'Molly Q. Lindgren', drawnSignaturePngSha256: null,
    consentText: 'I agree to sign electronically.', consentVersion: 'v1', documentSha256: 'ab12'.repeat(16), totalCents: 1_234_500,
    ip: '1.1.1.1', userAgent: 'x', signedAt: '2026-10-12T15:00:00.000Z', viewedFirstAt: null,
  },
};

describe('proposal pdf', () => {
  test('is a PDF with the number and the estimate wording', async () => {
    const s = await render(base());
    expect(s.includes('%PDF-')).toBe(true);
    expect(s).toContain('P-0001');
    expect(s).toContain('Estimate');
    expect(s).toContain('Estimate based on the roof outline.');
    expect(s).not.toContain('Based on an exact roof report.');
  });

  test('exact basis', async () => {
    const s = await render(base({ proposal: proposal('exact') }));
    expect(s).toContain('Based on an exact roof report.');
    expect(s).not.toContain('Estimate based');
  });

  test('homeowner sees no unit prices, internal does', async () => {
    const home = await render(base());
    const internal = await render(base({ audience: 'internal' }));
    expect(home).not.toContain('$2.50');
    expect(internal).toContain('$2.50');
    expect(internal).toContain('Subtotal');
  });

  test('disabled options are omitted', async () => {
    const p = proposal();
    p.options[2] = option('best', 'Charlie Metal', { enabled: false });
    const s = await render(base({ proposal: p }));
    expect(s).toContain('Alpha Shingles');
    expect(s).not.toContain('Charlie Metal');
  });

  test('financing line only with terms and a monthly estimate', async () => {
    expect(await render(base())).not.toContain('estimate, subject to approval');
    const withFin = await render(base({ financing: { aprBps: 999, months: 120 } }));
    expect(withFin).toContain('About $212/mo');
    expect(withFin).toContain('9.99% for 120 months');
    expect(withFin).toContain('estimate, subject to approval');
    const p = proposal();
    p.options.forEach((o) => { o.monthlyEstimateCents = null; });
    expect(await render(base({ proposal: p, financing: { aprBps: 999, months: 120 } }))).not.toContain('estimate, subject to approval');
  });

  test('signature page', async () => {
    const plain = await render(base());
    const signed = await render(base({ signature }));
    expect(signed).toContain('Molly Q. Lindgren');
    expect(signed).toContain(signature.record.documentSha256);
    expect(pages(signed)).toBeGreaterThan(pages(plain));
    expect(plain).not.toContain(signature.record.documentSha256);
  });

  test('every total says Estimate when basis is estimate', async () => {
    const count = (s: string): number => s.split('Estimate total').length - 1;
    const internal = await render(base({ audience: 'internal' }));
    // summary header + one sums row per enabled option (3), each appears in the decoded text
    expect(count(internal)).toBeGreaterThanOrEqual(4);
    const signed = await render(base({ signature }));
    expect(signed).toContain(`Estimate total: ${money(signature.record.totalCents)}`);
    const exactInternal = await render(base({ audience: 'internal', proposal: proposal('exact'), signature }));
    expect(exactInternal).not.toContain('Estimate total');
    expect(exactInternal).toContain(`Total: ${money(signature.record.totalCents)}`);
  });
});

describe('pdfToBuffer', () => {
  test('collects the whole document', async () => {
    const buf = await pdfToBuffer(renderProposalPdf(base()));
    expect(buf.subarray(0, 4).toString('latin1')).toBe('%PDF');
    expect(buf.subarray(-6).toString('latin1')).toContain('%%EOF');
  });

  test('rejects when the document fails while it is written', async () => {
    const doc = renderProposalPdf(base());
    doc.once('data', () => doc.emit('error', new Error('disk on fire')));
    await expect(pdfToBuffer(doc)).rejects.toThrow('disk on fire');
  });
});
