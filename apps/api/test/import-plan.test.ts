import { describe, expect, it } from 'vitest';
import { parseUpload } from '../src/imports/parse.ts';
import { autoMap } from '../src/imports/mapping.ts';
import { normalizeRow, normalizeStage } from '../src/imports/normalize.ts';
import type { NormalizedRow } from '../src/imports/normalize.ts';
import { planImport, previewRows } from '../src/imports/plan.ts';
import type { ExistingCustomer, ExistingIndex } from '../src/imports/plan.ts';
import { buildImportFixture } from './fixtures/import-1000.ts';

function indexFrom(existing: ReturnType<typeof buildImportFixture>['existing']): ExistingIndex {
  const byPhone = new Map<string, ExistingCustomer>();
  existing.forEach((e, k) => {
    byPhone.set(e.phone, { id: `ex-${k}`, status: e.consent, doNotContact: e.doNotContact, optedOut: e.optedOut });
  });
  return { byPhone, byEmail: new Map<string, ExistingCustomer>() };
}

async function planFixture(attested: boolean) {
  const fixture = buildImportFixture();
  const parsed = await parseUpload(Buffer.from(fixture.csv), 'f.csv');
  const mapping = autoMap(parsed.headers);
  const rows = parsed.rows.map((r) => normalizeRow(r, mapping));
  return planImport(rows, indexFrom(fixture.existing), attested);
}

describe('import plan on the 1,000-row fixture', () => {
  it('the 1,000-row fixture plans exactly', async () => {
    const attestedPlan = await planFixture(true);
    expect(attestedPlan.counts.total).toBe(1000);
    expect(attestedPlan.counts.new).toBe(850);
    expect(attestedPlan.counts.updated).toBe(50);
    expect(attestedPlan.counts.skipped).toBe(100);
    expect(attestedPlan.counts.skippedBy).toEqual({ noName: 15, noContact: 15, badPhone: 30, duplicate: 40 });
    expect(attestedPlan.counts.consent).toEqual({ attested: 870, express: 0, unchanged: 10, optedOutKept: 20 });

    const row902 = attestedPlan.rows.find((p) => p.row === 902);
    expect(row902?.skipKey).toBe('duplicate');
    expect(row902?.reason).toBe('Duplicate of row 2');

    const uncheckedPlan = await planFixture(false);
    expect(uncheckedPlan.counts.consent).toEqual({ attested: 0, express: 860, unchanged: 20, optedOutKept: 20 });
  });

  it('fills names and phones from Excel quirks', async () => {
    const fixture = buildImportFixture();
    const parsed = await parseUpload(Buffer.from(fixture.csv), 'f.csv');
    const mapping = { ...autoMap(parsed.headers), stage: 8 };
    const cells = ['Ann Lee', '4025550144', '', '12 Elm St', 'Boston', 'Massachusetts', '2134', '', ''];

    const result = normalizeRow(cells, mapping);
    expect(result).not.toHaveProperty('skip');
    const row = result as NormalizedRow;
    expect(row.phones).toEqual(['+14025550144']);
    expect(row.address?.state).toBe('MA');
    expect(row.address?.zip).toBe('02134');
    expect(row.firstName).toBe('Ann');
    expect(row.lastName).toBe('Lee');
  });

  it('maps stage words', () => {
    expect(normalizeStage('Sold')).toBe('won');
    expect(normalizeStage('weird')).toBe('lead');
    expect(normalizeStage('')).toBeNull();
  });

  it('matches by email when no phone matches, and a phone match beats an email match', () => {
    const emailIndex: ExistingIndex = {
      byPhone: new Map<string, ExistingCustomer>(),
      byEmail: new Map<string, ExistingCustomer>([
        ['ann@example.com', { id: 'e1', status: 'none', doNotContact: false, optedOut: false }],
      ]),
    };
    const annRow = normalizeRow(['Ann Lee', 'Ann@Example.com'], { name: 0, email: 1 });
    expect(annRow).not.toHaveProperty('skip');
    const emailPlan = planImport([annRow], emailIndex, false);
    expect(emailPlan.rows[0]?.outcome).toBe('update');
    expect(emailPlan.rows[0]?.matchId).toBe('e1');

    const bothIndex: ExistingIndex = {
      byPhone: new Map<string, ExistingCustomer>([
        ['+14025550101', { id: 'x', status: 'express', doNotContact: false, optedOut: false }],
      ]),
      byEmail: new Map<string, ExistingCustomer>([
        ['y@example.com', { id: 'y', status: 'express', doNotContact: false, optedOut: false }],
      ]),
    };
    const bothRow = normalizeRow(['Y Person', '4025550101', 'y@example.com'], { name: 0, phone: 1, email: 2 });
    expect(bothRow).not.toHaveProperty('skip');
    const bothPlan = planImport([bothRow], bothIndex, false);
    expect(bothPlan.rows[0]?.matchId).toBe('x');
  });

  it('preview is the first 20 rows as saved', async () => {
    const plan = await planFixture(true);
    const preview = previewRows(plan);
    expect(preview).toHaveLength(20);
    expect(preview[0]?.row).toBe(2);
    expect(preview[0]?.name).toBe('Customer 1');
    expect(preview[0]?.consent).toBe('attested');
  });
});
