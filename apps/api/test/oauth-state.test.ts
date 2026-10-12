import { createHmac } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { makeOAuthState, readOAuthState } from '../src/calendar/oauth-state.ts';

const KEY = Buffer.alloc(32, 7).toString('base64');
const OTHER_KEY = Buffer.alloc(32, 9).toString('base64');
const NOW = new Date('2030-01-01T00:00:00Z');
const TEN_MINUTES = 10 * 60 * 1000;
const INPUT = { companyId: '11111111-1111-4111-8111-111111111111', userId: '22222222-2222-4222-8222-222222222222', provider: 'google' as const, now: NOW };

/** Builds a state by hand with the same algorithm, so a provider outside the list can be signed. */
function signedBy(payload: object, key: string): string {
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const derived = createHmac('sha256', Buffer.from(key, 'base64')).update('calendar-oauth-state').digest();
  const sig = createHmac('sha256', derived).update(payloadB64).digest('base64url');
  return `${payloadB64}.${sig}`;
}

function flipFirstChar(text: string): string {
  return (text[0] === 'A' ? 'B' : 'A') + text.slice(1);
}

describe('calendar OAuth state', () => {
  test('a round trip returns the company, user and provider', () => {
    const state = makeOAuthState(INPUT, KEY);
    expect(readOAuthState(state, KEY, NOW)).toEqual({ companyId: INPUT.companyId, userId: INPUT.userId, provider: 'google' });
  });

  test('two states for the same input differ (each carries a fresh nonce)', () => {
    expect(makeOAuthState(INPUT, KEY)).not.toBe(makeOAuthState(INPUT, KEY));
  });

  test('flipping one character of the signature returns null', () => {
    const state = makeOAuthState(INPUT, KEY);
    const dot = state.indexOf('.');
    const tampered = `${state.slice(0, dot + 1)}${flipFirstChar(state.slice(dot + 1))}`;
    expect(readOAuthState(tampered, KEY, NOW)).toBeNull();
  });

  test('flipping one character of the payload returns null', () => {
    const state = makeOAuthState(INPUT, KEY);
    const dot = state.indexOf('.');
    const tampered = `${flipFirstChar(state.slice(0, dot))}${state.slice(dot)}`;
    expect(readOAuthState(tampered, KEY, NOW)).toBeNull();
  });

  test('a state signed with another key returns null', () => {
    const state = makeOAuthState(INPUT, OTHER_KEY);
    expect(readOAuthState(state, KEY, NOW)).toBeNull();
  });

  test('a state is valid up to exactly ten minutes and expired one millisecond later', () => {
    const state = makeOAuthState(INPUT, KEY);
    expect(readOAuthState(state, KEY, new Date(NOW.getTime() + TEN_MINUTES))).not.toBeNull();
    expect(readOAuthState(state, KEY, new Date(NOW.getTime() + TEN_MINUTES + 1))).toBeNull();
  });

  test('garbage strings return null without throwing', () => {
    for (const garbage of ['', 'abc', 'a.b.c', 'x.y']) {
      expect(() => readOAuthState(garbage, KEY, NOW)).not.toThrow();
      expect(readOAuthState(garbage, KEY, NOW)).toBeNull();
    }
  });

  test('a provider outside the list returns null even when it is signed with the right key', () => {
    const state = signedBy(
      { c: INPUT.companyId, u: INPUT.userId, p: 'yahoo', n: 'nonce', exp: NOW.getTime() + TEN_MINUTES },
      KEY,
    );
    expect(readOAuthState(state, KEY, NOW)).toBeNull();
  });

  test('a correctly signed state with the right provider is accepted when built by hand', () => {
    const state = signedBy(
      { c: INPUT.companyId, u: INPUT.userId, p: 'microsoft', n: 'nonce', exp: NOW.getTime() + TEN_MINUTES },
      KEY,
    );
    expect(readOAuthState(state, KEY, NOW)).toEqual({ companyId: INPUT.companyId, userId: INPUT.userId, provider: 'microsoft' });
  });
});
