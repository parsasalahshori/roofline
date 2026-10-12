import { describe, expect, test } from 'vitest';
import { claimsGuard, type ClaimPacketFacts } from '@roofline/shared';
import { CLAIM_PACKET_FIXED_STRINGS, formatPacketDate, renderClaimPacketPdf } from '../src/claims/packet-pdf.ts';
import { TINY_PNG } from '../src/providers/fakes/static-map.ts';

function facts(extra: Partial<ClaimPacketFacts> = {}): ClaimPacketFacts {
  return {
    claimId: 'cl1', jobId: 'j1', company: { name: 'Acme Roofing', phone: null }, timeZone: 'America/Chicago',
    customerName: 'Pat Example', address: '100 Test Lane, Dallas, TX 75201', propertyCenter: [-96.8, 32.78],
    insurer: 'Example Mutual', claimNumber: 'CLM-1', dateOfLoss: '2026-06-14',
    hail: { thresholdIn: 1.5, convectiveDay: '2026-06-14' },
    spotterReports: [{ sizeIn: 1.75, reportDate: '2026-06-14', timeUtc: '22:10:00', location: 'Plano', county: 'Collin', state: 'TX' }],
    measurement: { kind: 'exact', label: 'Exact report', roofSquares: 28.5, roofAreaSqFt: 2850, pitchX12: 6, measuredAt: '2026-06-20T15:00:00.000Z' },
    inspection: { date: '2026-06-21T15:00:00.000Z', notes: 'Cracked shingles on the south slope.' },
    intakeNotes: 'Hail hit on Sunday evening.',
    ...extra,
  };
}

async function render(f: ClaimPacketFacts, mapImage: Uint8Array | null = null): Promise<string> {
  const doc = renderClaimPacketPdf({ facts: f, mapImage }, { compress: false });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  await new Promise<void>((r) => {
    doc.on('end', () => r());
    doc.end();
  });
  const raw = Buffer.concat(chunks).toString('latin1');
  return `${decodeText(raw)}\n${raw}`;
}
function decodeText(raw: string): string {
  const lines: string[] = [];
  for (const m of raw.matchAll(/\[([^\]]*)\] TJ/g)) {
    const hex = [...m[1]!.matchAll(/<([0-9a-f]*)>/g)].map((h) => h[1]).join('');
    lines.push(Buffer.from(hex, 'hex').toString('latin1'));
  }
  return lines.join('\n');
}

describe('claim packet pdf', () => {
  test('formats dates without shifting', () => {
    expect(formatPacketDate('2026-10-12', 'America/Chicago')).toBe('October 12, 2026');
  });
  test('hail found: the line reads Radar-estimated hail up to 1.5 inches (NOAA MRMS) on June 14, 2026', async () => {
    expect(await render(facts())).toContain('Radar-estimated hail up to 1.5 inches (NOAA MRMS) on June 14, 2026');
  });
  test('every hail line says Radar-estimated', async () => {
    for (const t of [0.75, 1.5, 2]) {
      const text = await render(facts({ hail: { thresholdIn: t, convectiveDay: '2026-06-14' } }));
      const hailLines = text.split('\n').filter((l) => l.includes('hail up to'));
      expect(hailLines.length).toBeGreaterThan(0);
      for (const l of hailLines) expect(l).toContain('Radar-estimated');
    }
    expect(await render(facts({ hail: { thresholdIn: 2, convectiveDay: '2026-06-14' } }))).toContain('hail up to 2 inches');
  });
  test('no hail: No radar hail found at this address on June 14, 2026', async () => {
    const text = await render(facts({ hail: null }));
    expect(text).toContain('No radar hail found at this address on June 14, 2026');
    expect(text).not.toContain('hail up to');
  });
  test('no date of loss: no radar line and the no-date sentence', async () => {
    const text = await render(facts({ hail: null, dateOfLoss: null }));
    expect(text).toContain('No date of loss is on file, so no radar check was made.');
    expect(text).not.toContain('No radar hail found');
    expect(text).not.toContain('hail up to');
  });
  test('spotter table lists sizes and the empty line when none', async () => {
    const withRows = await render(facts());
    expect(withRows).toContain('Size (inches)');
    expect(withRows).toContain('1.75');
    expect(withRows).toContain('22:10:00');
    expect(withRows).toContain('Plano');
    expect(withRows).not.toContain('No spotter reports within 10 miles.');
    expect(await render(facts({ spotterReports: [] }))).toContain('No spotter reports within 10 miles.');
  });
  test('measurement label: Exact report and Estimate (aerial/footprint) appear, with squares and pitch', async () => {
    const exact = await render(facts());
    expect(exact).toContain('Exact report');
    expect(exact).toContain('28.5 squares');
    expect(exact).toContain('6/12');
    expect(exact).toContain('2850 sq ft');
    const est = await render(facts({ measurement: { kind: 'estimate', label: 'Estimate (aerial/footprint)', roofSquares: 30, roofAreaSqFt: null, pitchX12: null, measuredAt: '2026-06-20T15:00:00.000Z' } }));
    expect(est).toContain('Estimate (aerial/footprint)');
    expect(est).not.toContain('sq ft');
  });
  test('no measurement line', async () => {
    expect(await render(facts({ measurement: null }))).toContain('No roof measurement on file.');
  });
  test('inspection and notes appear', async () => {
    const text = await render(facts());
    expect(text).toContain('Cracked shingles on the south slope.');
    expect(text).toContain('Hail hit on Sunday evening.');
    const none = await render(facts({ inspection: null, intakeNotes: null }));
    expect(none).toContain('No completed inspection on file.');
    expect(none).toContain('No notes.');
  });
  test('footer', async () => {
    expect(await render(facts())).toContain('Prepared by Acme Roofing for the homeowner. Roofline does not contact insurers.');
  });
  test('map image: only with bytes', async () => {
    const withMap = await render(facts(), TINY_PNG);
    expect(withMap).toContain('/Subtype /Image');
    expect(withMap).toContain('Map of the property');
    const without = await render(facts(), null);
    expect(without).not.toContain('/Subtype /Image');
    expect(without).not.toContain('Map of the property');
  });
  test('fixed strings pass claimsGuard, and so does a full packet', async () => {
    expect(CLAIM_PACKET_FIXED_STRINGS.length).toBeGreaterThan(5);
    for (const s of CLAIM_PACKET_FIXED_STRINGS) expect(claimsGuard(s).ok, s).toBe(true);
    const text = decodeText(await render(facts(), TINY_PNG));
    expect(claimsGuard(text).ok).toBe(true);
  });
  test('never mentions deductible or adjuster', async () => {
    const text = (await render(facts(), TINY_PNG)).toLowerCase();
    expect(text).not.toContain('deductible');
    expect(text).not.toContain('adjuster');
  });
});
