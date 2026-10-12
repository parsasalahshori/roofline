import { describe, expect, test } from 'vitest';
import { mintRelayToken, RELAY_TOKEN_TTL_MS, verifyRelayToken } from '../../src/front-desk/relay-token.ts';

const SECRET = 'test-relay-secret-test-relay-secret-00';
const CALL = '00000000-0000-4000-8000-000000000001';
const CALL2 = '00000000-0000-4000-8000-000000000002';
const CO_A = '00000000-0000-4000-8000-0000000000aa';
const CO_B = '00000000-0000-4000-8000-0000000000bb';
const NOW = new Date('2026-10-12T15:00:00Z');
const claims = { callId: CALL, companyId: CO_A };

describe('relay token', () => {
  test('mint then verify is true', () => {
    expect(verifyRelayToken(SECRET, mintRelayToken(SECRET, claims, NOW), claims, NOW)).toBe(true);
  });
  test('wrong secret is false', () => {
    expect(verifyRelayToken(`${SECRET}x`, mintRelayToken(SECRET, claims, NOW), claims, NOW)).toBe(false);
  });
  test('token for company A does not verify for company B', () => {
    expect(verifyRelayToken(SECRET, mintRelayToken(SECRET, claims, NOW), { callId: CALL, companyId: CO_B }, NOW)).toBe(false);
  });
  test('token for call 1 does not verify for call 2', () => {
    expect(verifyRelayToken(SECRET, mintRelayToken(SECRET, claims, NOW), { callId: CALL2, companyId: CO_A }, NOW)).toBe(false);
  });
  test('expired token (now advanced by TTL+1ms) is false', () => {
    const t = mintRelayToken(SECRET, claims, NOW);
    expect(verifyRelayToken(SECRET, t, claims, new Date(NOW.getTime() + RELAY_TOKEN_TTL_MS + 1))).toBe(false);
  });
  test('malformed tokens (empty string, no dot, non-hex mac, short mac, extra segments) are false and do not throw', () => {
    const good = mintRelayToken(SECRET, claims, NOW);
    const [exp, mac] = good.split('.') as [string, string];
    for (const bad of ['', 'abc', `${exp}${mac}`, `${exp}.${'z'.repeat(64)}`, `${exp}.${mac.slice(2)}`, `${good}.${mac}`]) {
      expect(verifyRelayToken(SECRET, bad, claims, NOW)).toBe(false);
    }
  });
  test('a flipped last hex char is false', () => {
    const t = mintRelayToken(SECRET, claims, NOW);
    const flipped = t.slice(0, -1) + (t.endsWith('0') ? '1' : '0');
    expect(verifyRelayToken(SECRET, flipped, claims, NOW)).toBe(false);
  });
});
