import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { proposalIpHashFor } from '../src/public/proposal-common.ts';

// Security finding 8: the hash stored in proposal_events.ip_hash is a keyed HMAC, so it cannot be reversed
// by hashing every IPv4 address. Pure: no database.

const KEY = { ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64') };
const OTHER_KEY = { ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64') };
const COMPANY = '11111111-1111-4111-8111-111111111111';
const OTHER_COMPANY = '22222222-2222-4222-8222-222222222222';
const IP = '203.0.113.7';

describe('proposalIpHashFor', () => {
  test('is 64 hex characters and stable for the same address, company and key', () => {
    const hash = proposalIpHashFor(KEY, IP, COMPANY);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(proposalIpHashFor(KEY, IP, COMPANY)).toBe(hash);
  });

  test('differs by key, by company and by address', () => {
    const hash = proposalIpHashFor(KEY, IP, COMPANY);
    expect(proposalIpHashFor(OTHER_KEY, IP, COMPANY)).not.toBe(hash);
    expect(proposalIpHashFor(KEY, IP, OTHER_COMPANY)).not.toBe(hash);
    expect(proposalIpHashFor(KEY, '203.0.113.8', COMPANY)).not.toBe(hash);
  });

  test('is not the unkeyed sha256(ip + companyId) that could be brute-forced', () => {
    const unkeyed = createHash('sha256').update(`${IP}${COMPANY}`).digest('hex');
    expect(proposalIpHashFor(KEY, IP, COMPANY)).not.toBe(unkeyed);
  });
});
