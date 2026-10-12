import { describe, expect, test } from 'vitest';
import {
  checkSnapshotChain,
  checkUpdatedAtGrants,
  type Journal,
  normalizeJournal,
  ROOT_SNAPSHOT_PREV_ID,
  sqlStatements,
  WHEN_STEP_MS,
} from '../scripts/launch-normalize-lib.ts';

/*
 * The launch-merge normalizer's pure checks (ops/bin/launch-normalize). No database is used.
 */

const entry = (idx: number, when: number, name = 'x') => ({
  idx,
  version: '7',
  when,
  tag: `${String(idx).padStart(4, '0')}_${name}`,
  breakpoints: true,
});
const journal = (entries: Journal['entries']): Journal => ({ version: '7', dialect: 'postgresql', entries });

describe('normalizeJournal', () => {
  test('a strictly increasing journal is left exactly as it is', () => {
    const j = journal([entry(0, 100), entry(1, 200), entry(2, 300)]);
    const { journal: out, findings } = normalizeJournal(j);
    expect(findings).toEqual([]);
    expect(out).toEqual(j);
  });

  test('an entry not after the one before moves to it + WHEN_STEP_MS, and later ones follow only when needed', () => {
    const { journal: out, findings } = normalizeJournal(
      journal([entry(0, 5000), entry(1, 9000), entry(2, 9000), entry(3, 1000), entry(4, 99_000)]),
    );
    expect(out.entries.map((e) => e.when)).toEqual([5000, 9000, 9000 + WHEN_STEP_MS, 9000 + 2 * WHEN_STEP_MS, 99_000]);
    expect(findings.map((f) => f.kind)).toEqual(['fixed', 'fixed']);
    expect(findings[0]!.message).toContain('0002_x');
  });

  test('it is idempotent: normalizing the output finds nothing', () => {
    const once = normalizeJournal(journal([entry(0, 300), entry(1, 200), entry(2, 100)])).journal;
    const twice = normalizeJournal(once);
    expect(twice.findings).toEqual([]);
    expect(twice.journal).toEqual(once);
  });

  test('entries out of idx order are sorted (fixed); a gap, a duplicate or a mismatched tag is a problem', () => {
    const sorted = normalizeJournal(journal([entry(1, 200), entry(0, 100)]));
    expect(sorted.journal.entries.map((e) => e.idx)).toEqual([0, 1]);
    expect(sorted.findings).toEqual([{ kind: 'fixed', message: 'journal entries sorted by idx' }]);

    const gap = normalizeJournal(journal([entry(0, 100), entry(2, 200)]));
    expect(gap.findings.some((f) => f.kind === 'problem' && f.message.includes('idx 2 is at position 1'))).toBe(true);

    const badTag = normalizeJournal(journal([{ ...entry(0, 100), tag: '0007_wrong' }]));
    expect(badTag.findings).toEqual([
      { kind: 'problem', message: 'journal idx 0 has tag 0007_wrong, which does not start with 0000_' },
    ]);
  });
});

describe('checkSnapshotChain', () => {
  const tags = ['0000_a', '0001_b', '0002_c'];

  test('a good chain has no findings', () => {
    const snaps = new Map([
      ['0000_a', { id: 'A', prevId: ROOT_SNAPSHOT_PREV_ID }],
      ['0001_b', { id: 'B', prevId: 'A' }],
      ['0002_c', { id: 'C', prevId: 'B' }],
    ]);
    expect(checkSnapshotChain(tags, snaps)).toEqual([]);
  });

  test('a wrong prevId, a duplicate id and a missing snapshot are problems', () => {
    const snaps = new Map([
      ['0000_a', { id: 'A', prevId: ROOT_SNAPSHOT_PREV_ID }],
      ['0001_b', { id: 'A', prevId: 'Z' }],
    ]);
    const messages = checkSnapshotChain(tags, snaps).map((f) => f.message);
    expect(messages).toEqual([
      '0001_b: prevId Z is not the id of 0000_a (A)',
      '0001_b: id A is also the id of 0000_a',
      '0002_c: no meta/0002_snapshot.json',
    ]);
  });
});

describe('sqlStatements', () => {
  test('drops comments and dollar-quoted bodies, and splits on semicolons', () => {
    const sql = `-- GRANT UPDATE (a) ON t TO r;\nGRANT SELECT ON t TO r;--> statement-breakpoint\nDO $$ BEGIN GRANT UPDATE (b) ON t TO r; END $$;\n/* GRANT x; */ REVOKE ALL ON t FROM r;`;
    expect(sqlStatements(sql)).toEqual(['GRANT SELECT ON t TO r', 'DO $$', 'REVOKE ALL ON t FROM r']);
  });
});

describe('checkUpdatedAtGrants', () => {
  const auto = new Set(['calls', 'company_storms', 'proposal_signatures']);

  test('a column grant without updated_at on an auto-updated table is a problem', () => {
    const findings = checkUpdatedAtGrants(
      ['GRANT UPDATE (recording_key, recording_status) ON calls TO app_system;'],
      auto,
    );
    expect(findings).toEqual([
      {
        kind: 'problem',
        message:
          'app_system: GRANT UPDATE (recording_key, recording_status) ON calls lacks updated_at, which Drizzle sets on every update',
      },
    ]);
  });

  test('updated_at in the list, a table-wide grant, ALL, or a table without the helper are all fine', () => {
    expect(
      checkUpdatedAtGrants(
        [
          'GRANT SELECT (id), UPDATE (pdf_file_id, pdf_sha256, updated_at) ON proposal_signatures TO app_tenant;',
          'GRANT SELECT, INSERT, UPDATE ON company_storms TO app_tenant;',
          'GRANT ALL ON calls TO app_owner;',
          'GRANT UPDATE (place_name) ON storms TO app_system;',
          'GRANT UPDATE ON SEQUENCE calls_id_seq TO app_system;',
        ],
        auto,
      ),
    ).toEqual([]);
  });

  test('grants add up across migrations, and revokes take columns or the table away', () => {
    const later = checkUpdatedAtGrants(
      ['GRANT UPDATE (status) ON calls TO app_system;', 'GRANT UPDATE (updated_at) ON public.calls TO app_system;'],
      auto,
    );
    expect(later).toEqual([]);

    const revoked = checkUpdatedAtGrants(
      ['GRANT UPDATE (status, updated_at) ON calls TO app_system;', 'REVOKE UPDATE (updated_at) ON calls FROM app_system;'],
      auto,
    );
    expect(revoked.map((f) => f.message)).toEqual([
      'app_system: GRANT UPDATE (status) ON calls lacks updated_at, which Drizzle sets on every update',
    ]);

    const tableWideThenRevoked = checkUpdatedAtGrants(
      ['GRANT UPDATE ON calls TO app_system;', 'REVOKE UPDATE ON calls FROM app_system;', 'GRANT UPDATE (status) ON calls TO app_system;'],
      auto,
    );
    expect(tableWideThenRevoked).toHaveLength(1);
  });

  test('one statement may name several tables and roles', () => {
    const findings = checkUpdatedAtGrants(['GRANT UPDATE (status) ON calls, company_storms TO app_system, app_hail;'], auto);
    expect(findings.map((f) => f.message.split(':')[0] + ' ' + f.message.split(' ON ')[1]!.split(' ')[0])).toEqual([
      'app_hail calls',
      'app_hail company_storms',
      'app_system calls',
      'app_system company_storms',
    ]);
  });
});
