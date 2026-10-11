import { describe, expect, test } from 'vitest';
import { ROLES } from '@roofline/shared';
import { type Capability, CAPABILITIES, can } from '../src/permissions.ts';

/** Spec 3.2, written out by hand so a change to the matrix has to change this table too. */
const OWNER: readonly Capability[] = CAPABILITIES;
const OFFICE: readonly Capability[] = ['approve_message', 'approve_internal', 'view_money_totals'];
const OFFICE_WITH_SPEND: readonly Capability[] = [...OFFICE, 'approve_spend'];
const REP: readonly Capability[] = [];

type Row = { who: string; member: Parameters<typeof can>[0]; allowed: readonly Capability[] };

const ROWS: Row[] = [
  { who: 'owner', member: { role: 'owner', canApproveSpend: false }, allowed: OWNER },
  { who: 'owner with the spend flag set (it changes nothing)', member: { role: 'owner', canApproveSpend: true }, allowed: OWNER },
  { who: 'office without delegated spend', member: { role: 'office', canApproveSpend: false }, allowed: OFFICE },
  { who: 'office with delegated spend', member: { role: 'office', canApproveSpend: true }, allowed: OFFICE_WITH_SPEND },
  { who: 'rep', member: { role: 'rep', canApproveSpend: false }, allowed: REP },
  { who: 'rep with the spend flag set (it changes nothing)', member: { role: 'rep', canApproveSpend: true }, allowed: REP },
  { who: 'the system (runner and scheduler)', member: { role: 'system', canApproveSpend: false }, allowed: [] },
  { who: 'the system with the spend flag set', member: { role: 'system', canApproveSpend: true }, allowed: [] },
];

describe('can(): every role against every capability', () => {
  for (const row of ROWS) {
    describe(row.who, () => {
      test.each(CAPABILITIES)('%s', (cap) => {
        expect(can(row.member, cap)).toBe(row.allowed.includes(cap));
      });
    });
  }

  test('the table covers every role', () => {
    const covered = new Set(ROWS.map((r) => r.member.role));
    for (const role of [...ROLES, 'system']) expect(covered.has(role as (typeof ROLES)[number] | 'system')).toBe(true);
  });

  test('there are exactly the seven capabilities the spec names', () => {
    expect([...CAPABILITIES].sort()).toEqual(
      [
        'approve_internal',
        'approve_message',
        'approve_spend',
        'billing',
        'company_admin',
        'import',
        'view_money_totals',
      ].sort(),
    );
  });
});
