import { describe, expect, test } from 'vitest';
import type { MeasurementView, ProposalOptionView, ProposalView, RoofModel, SignatureRecord } from '@roofline/shared';
import { calculateQuote, defaultPricebook, defaultScope, money } from '@roofline/shared';
import { pdfToBuffer, renderProposalPdf, roofSectionsLine, roofSectionsOf, type ProposalPdfInput } from '../src/proposals/pdf.ts';

const calculation = calculateQuote({ ...defaultScope, areaSqFt: 2400, areaType: 'surface', pitch: 6 }, defaultPricebook);

const ICE_SHIELD = { code: 'addon', name: 'Ice shield', quantity: 220, unit: 'ft', unitCents: 250, totalCents: 55000, taxable: true };

function option(tier: 'good' | 'better' | 'best', name: string, extra: Partial<ProposalOptionView> = {}): ProposalOptionView {
  return {
    id: `opt-${tier}`, tier, name, highlights: [`${name} highlight`], scope: { ...defaultScope }, addOns: [],
    // As withAddOns makes them: the add-on lines are at the end of calculation.lines, and addOnLines repeats them.
    calculation: { ...calculation, lines: [...calculation.lines, ICE_SHIELD] }, addOnLines: [ICE_SHIELD],
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

  test('the internal PDF lists each add-on line once (calculation.lines already carries them)', async () => {
    const addOn = { code: 'ridge-vent', name: 'Ridge vent upgrade', quantity: 60, unit: 'ft', unitCents: 900, totalCents: 54_000, taxable: true };
    const p = proposal();
    p.options = [option('better', 'Bravo Shingles', { calculation: { ...calculation, lines: [...calculation.lines, addOn] }, addOnLines: [addOn] })];
    const internal = await render(base({ audience: 'internal', proposal: p }));
    expect(internal.split('Ridge vent upgrade').length - 1).toBe(1);
  });

  test('per-option financing terms: each option shows its own frozen terms, and null hides the line', async () => {
    const s = await render(
      base({
        financing: { aprBps: 1, months: 1 },
        optionFinancing: { 'opt-good': { aprBps: 799, months: 60 }, 'opt-better': null, 'opt-best': { aprBps: 999, months: 120 } },
      }),
    );
    expect(s).toContain('7.99% for 60 months');
    expect(s).toContain('9.99% for 120 months');
    expect(s.split('subject to approval').length - 1).toBe(2);
    expect(s).not.toContain('0.01% for 1 months');
  });

  test('the signature page repeats the chosen option\'s financing line', async () => {
    const signed = await render(base({ signature, optionFinancing: { 'opt-better': { aprBps: 999, months: 120 } } }));
    const page = signed.slice(signed.indexOf('Signed by'));
    expect(page).toContain('9.99% for 120 months');
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

describe('roof sections (only some of the roof quoted)', () => {
  test('the line follows the basis line when given, and is absent otherwise', async () => {
    const s = await render(base({ roofSections: { quoted: ['A', 'C', 'D'], total: 7 } }));
    expect(s).toContain('Covers roof sections A, C and D only (3 of 7).');
    expect(s.indexOf('Covers roof sections')).toBeGreaterThan(s.indexOf('Estimate based on the roof outline.'));
    for (const none of [base(), base({ roofSections: null }), base({ roofSections: { quoted: [], total: 4 } })]) {
      expect(await render(none)).not.toContain('Covers roof section');
    }
  });

  test('one section and two sections', () => {
    expect(roofSectionsLine({ quoted: ['C'], total: 7 })).toBe('Covers roof section C only (1 of 7).');
    expect(roofSectionsLine({ quoted: ['A', 'C'], total: 4 })).toBe('Covers roof sections A and C only (2 of 4).');
    expect(roofSectionsLine({ quoted: ['A', 'B2', 'C', 'D'], total: 30 })).toBe('Covers roof sections A, B2, C and D only (4 of 30).');
  });

  test('roofSectionsOf: the quoted facets in order, only when some are left out', () => {
    const facet = (id: string) => ({ id, ring: [], planSqFt: 1, areaSqFt: 1, pitch: '5/12', labelAt: [0, 0] as [number, number] });
    const roof = (excluded?: string[]): RoofModel => ({
      facets: ['A', 'B', 'C', 'D'].map(facet), lines: [], outline: [], pitch: '5/12',
      totals: { squares: 1, slopedSqFt: 1, planSqFt: 1, facetCount: 4, wastePct: 10, ridgeFt: 0, hipFt: 0, valleyFt: 0, eaveFt: 0, rakeFt: 0 },
      ...(excluded ? { excluded } : {}),
    });
    const view = (r: RoofModel | null) => ({ roof: r }) as MeasurementView;
    expect(roofSectionsOf(view(roof(['B'])))).toEqual({ quoted: ['A', 'C', 'D'], total: 4 });
    expect(roofSectionsOf(view(roof([])))).toBeNull();
    expect(roofSectionsOf(view(roof()))).toBeNull();
    expect(roofSectionsOf(view(null))).toBeNull();
    expect(roofSectionsOf(null)).toBeNull();
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
