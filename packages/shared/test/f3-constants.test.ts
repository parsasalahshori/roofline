import { describe, expect, test } from 'vitest';
import * as shared from '../src/index.ts';

describe('F3 shared constants', () => {
  test('setup checklist items are in the order the checklist shows them', () => {
    expect(shared.SETUP_ITEM_KEYS).toEqual([
      'company_basics',
      'import_customers',
      'texting_registration',
      'invite_team',
      'payment_method',
      'prices_and_tiers',
      'connect_calendar',
      'phone_number',
      'connect_ads',
    ]);
  });

  test('setup statuses', () => {
    expect(shared.SETUP_STATUSES).toEqual(['todo', 'in_progress', 'waiting', 'done', 'skipped']);
  });

  test('import statuses', () => {
    expect(shared.IMPORT_STATUSES).toEqual(['uploaded', 'queued', 'processing', 'done', 'failed']);
  });

  test('import row outcomes', () => {
    expect(shared.IMPORT_ROW_OUTCOMES).toEqual(['created', 'updated', 'skipped']);
  });

  test('the package barrel exports all four lists', () => {
    expect(Object.keys(shared)).toEqual(
      expect.arrayContaining(['SETUP_ITEM_KEYS', 'SETUP_STATUSES', 'IMPORT_STATUSES', 'IMPORT_ROW_OUTCOMES']),
    );
  });
});
