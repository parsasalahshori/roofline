import { describe, expect, test } from 'vitest';
import { CONSENT_STATUSES, MARKETING_CONSENT_STATUSES } from '../src/enums.ts';

describe('MARKETING_CONSENT_STATUSES', () => {
  test('is attested and written', () => {
    expect([...MARKETING_CONSENT_STATUSES]).toEqual(['attested', 'written']);
  });

  test('every entry is a consent status', () => {
    for (const status of MARKETING_CONSENT_STATUSES) expect(CONSENT_STATUSES).toContain(status);
  });
});
