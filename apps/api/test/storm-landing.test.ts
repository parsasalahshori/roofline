import { describe, expect, test } from 'vitest';
import type { AppDeps } from '../src/app.ts';
import { AppError, MESSAGES } from '../src/errors.ts';
import { StormRequestBody, submitStormRequest } from '../src/storm/landing.ts';
import { companyOriginFor } from '../src/public/storm-requests.ts';

/*
 * Pure checks for the storm landing form (S1 Task 20): the body schema, the honeypot short
 * circuit and the company origin the browser sends. Nothing here touches a database; the
 * db-backed behaviour is in storm-requests.test.ts.
 */

const NOW = new Date('2026-10-12T15:00:00Z');

/** Deps that fail loudly if anything reaches for a pool, a geocoder or the clock: validation must stop first. */
const untouchable = new Proxy({} as AppDeps, {
  get(_target, prop) {
    throw new Error(`deps.${String(prop)} must not be used here`);
  },
});

/** A lookup that fails the test if validation let a request reach the page lookup. */
const untouchableFind = async (): Promise<never> => {
  throw new Error('the page lookup must not run here');
};

const validBody = {
  name: 'Jane Doe',
  phone: '(402) 555-0100',
  address: '1200 Farnam St, Omaha, NE 68102',
  okToText: 'on',
};

describe('StormRequestBody', () => {
  test('a US phone number is normalised to E.164', () => {
    const parsed = StormRequestBody.parse(validBody);
    expect(parsed.phone).toBe('+14025550100');
  });

  test('a phone that is not a US number is refused on the phone field', () => {
    const result = StormRequestBody.safeParse({ ...validBody, phone: '123' });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues[0]?.path).toEqual(['phone']);
    expect(result.error.issues[0]?.message).toBe("That doesn't look like a US phone number.");
  });

  test('the name is trimmed', () => {
    const parsed = StormRequestBody.parse({ ...validBody, name: '  Jane Doe  ' });
    expect(parsed.name).toBe('Jane Doe');
  });

  test('a missing address is refused on the address field', () => {
    const result = StormRequestBody.safeParse({ name: validBody.name, phone: validBody.phone, okToText: validBody.okToText });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues[0]?.path).toEqual(['address']);
  });

  test.each([
    ['on', true],
    ['true', true],
    ['1', true],
    [true, true],
    [undefined, false],
    ['false', false],
    ['', false],
    ['off', false],
  ])('okToText %j reads as %s', (value, expected) => {
    const parsed = StormRequestBody.parse({ ...validBody, okToText: value });
    expect(parsed.okToText).toBe(expected);
  });
});

describe('submitStormRequest before any lookup', () => {
  test('a filled honeypot answers ok without touching the database, geocoder or clock', async () => {
    const result = await submitStormRequest(untouchable, {
      code: 'abcd2345',
      body: { ...validBody, website: 'http://spam.example' },
      ip: '203.0.113.9',
      now: NOW,
      findPage: untouchableFind,
    });
    expect(result).toEqual({ ok: true });
  });

  test('a missing name is a 422 on the name field', async () => {
    const body = { phone: validBody.phone, address: validBody.address, okToText: validBody.okToText };
    const error = await submitStormRequest(untouchable, { code: 'abcd2345', body, ip: '203.0.113.9', now: NOW, findPage: untouchableFind }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).status).toBe(422);
    expect((error as AppError).field).toBe('name');
  });

  test('a bad phone is a 422 on the phone field with the plain sentence', async () => {
    const error = await submitStormRequest(untouchable, {
      code: 'abcd2345',
      body: { ...validBody, phone: 'nope' },
      ip: '203.0.113.9',
      now: NOW,
      findPage: untouchableFind,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).status).toBe(422);
    expect((error as AppError).field).toBe('phone');
    expect((error as AppError).message).toBe("That doesn't look like a US phone number.");
  });

  test('a body that is not an object is refused with the generic field check', async () => {
    const error = await submitStormRequest(untouchable, { code: 'abcd2345', body: undefined, ip: '203.0.113.9', now: NOW, findPage: untouchableFind }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).status).toBe(422);
    expect((error as AppError).message).toBe(MESSAGES.checkField);
  });
});

describe('companyOriginFor', () => {
  const config = { PUBLIC_BASE_URL: 'https://app.roofline.test', POLICY_PAGES_DOMAIN: 'roofline.test' };

  test('the company host origin is the slug under the policy pages domain', () => {
    expect(companyOriginFor(config, 'acme')).toBe('https://acme.roofline.test');
  });

  test('a foreign origin is not the company origin', () => {
    expect(companyOriginFor(config, 'acme')).not.toBe('https://evil.example');
    expect(companyOriginFor(config, 'acme')).not.toBe('https://app.roofline.test');
    expect(companyOriginFor(config, 'acme')).not.toBe('https://bolt.roofline.test');
  });

  test('the port of PUBLIC_BASE_URL is carried over when it has one', () => {
    expect(companyOriginFor({ PUBLIC_BASE_URL: 'http://app.roofline.test:8080', POLICY_PAGES_DOMAIN: 'roofline.test' }, 'acme')).toBe(
      'http://acme.roofline.test:8080',
    );
  });

  test('no policy pages domain means no company origin at all', () => {
    expect(companyOriginFor({ PUBLIC_BASE_URL: 'https://app.roofline.test', POLICY_PAGES_DOMAIN: undefined }, 'acme')).toBeNull();
  });
});
