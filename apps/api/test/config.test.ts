import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { loadConfig } from '../src/config.ts';

const KEY = Buffer.alloc(32, 9).toString('base64');

const VALID = {
  NODE_ENV: 'production',
  APP_ORIGIN: 'https://app.roofline.test',
  DATABASE_URL_TENANT: 'postgres://app_tenant:pw@localhost:5432/roofline',
  DATABASE_URL_SYSTEM: 'postgres://app_system:pw@localhost:5432/roofline',
  ENCRYPTION_KEY: KEY,
  PUBLIC_BASE_URL: 'https://app.roofline.test',
} satisfies Record<string, string>;

function problem(env: Record<string, string | undefined>): string {
  try {
    loadConfig(env);
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error('Expected loadConfig to throw');
}

describe('loadConfig', () => {
  test('parses a complete environment and fills the defaults', () => {
    expect(loadConfig(VALID)).toEqual({
      ...VALID,
      TRUST_PROXY: 0,
      API_RATE_LIMIT_PER_MIN: 600,
      PORT: 4400,
      HOST: '0.0.0.0',
    });
  });

  test('HOST defaults to every interface in production (a host health check must reach it), loopback otherwise', () => {
    expect(loadConfig(VALID).HOST).toBe('0.0.0.0');
    expect(loadConfig({ ...VALID, NODE_ENV: 'development' }).HOST).toBe('127.0.0.1');
    expect(loadConfig({ ...VALID, NODE_ENV: 'test' }).HOST).toBe('127.0.0.1');
    // A blank HOST line counts as unset, so it gets the default too.
    expect(loadConfig({ ...VALID, HOST: ' ' }).HOST).toBe('0.0.0.0');
  });

  test.each(['production', 'development', 'test'])('an explicit HOST always wins (NODE_ENV=%s)', (NODE_ENV) => {
    expect(loadConfig({ ...VALID, NODE_ENV, HOST: '127.0.0.1' }).HOST).toBe('127.0.0.1');
    expect(loadConfig({ ...VALID, NODE_ENV, HOST: '0.0.0.0' }).HOST).toBe('0.0.0.0');
    expect(loadConfig({ ...VALID, NODE_ENV, HOST: '::' }).HOST).toBe('::');
  });

  test('parses the optional values', () => {
    const config = loadConfig({
      ...VALID,
      GOOGLE_CLIENT_ID: 'client-id',
      POSTMARK_TOKEN: 'pm',
      MAIL_FROM: 'Roofline <hello@roofline.test>',
      TWILIO_AUTH_TOKEN: 'tw',
      TRUST_PROXY: '2',
      API_RATE_LIMIT_PER_MIN: '5',
      PORT: '8080',
      HOST: '0.0.0.0',
    });
    expect(config).toMatchObject({
      GOOGLE_CLIENT_ID: 'client-id',
      POSTMARK_TOKEN: 'pm',
      MAIL_FROM: 'Roofline <hello@roofline.test>',
      TWILIO_AUTH_TOKEN: 'tw',
      TRUST_PROXY: 2,
      API_RATE_LIMIT_PER_MIN: 5,
      PORT: 8080,
      HOST: '0.0.0.0',
    });
  });

  test('empty values count as unset (a blank line in an env file)', () => {
    const config = loadConfig({ ...VALID, POSTMARK_TOKEN: '', TRUST_PROXY: '', GOOGLE_CLIENT_ID: '  ' });
    expect(config.POSTMARK_TOKEN).toBeUndefined();
    expect(config.GOOGLE_CLIENT_ID).toBeUndefined();
    expect(config.TRUST_PROXY).toBe(0);
  });

  test('APP_ORIGIN is reduced to an origin, PUBLIC_BASE_URL loses its trailing slash', () => {
    const config = loadConfig({
      ...VALID,
      APP_ORIGIN: 'https://App.Roofline.test:443/',
      PUBLIC_BASE_URL: 'https://roofline.test/',
    });
    expect(config.APP_ORIGIN).toBe('https://app.roofline.test');
    expect(config.PUBLIC_BASE_URL).toBe('https://roofline.test');
  });

  test('names every missing required variable, and never prints a value', () => {
    const message = problem({ ENCRYPTION_KEY: KEY });
    for (const name of ['NODE_ENV', 'APP_ORIGIN', 'DATABASE_URL_TENANT', 'DATABASE_URL_SYSTEM', 'PUBLIC_BASE_URL']) {
      expect(message).toContain(name);
    }
    expect(message).not.toContain('ENCRYPTION_KEY');
    expect(message).not.toContain(KEY);
  });

  test.each([
    ['too short', Buffer.alloc(16, 1).toString('base64')],
    ['too long', Buffer.alloc(48, 1).toString('base64')],
    ['not base64', 'this is not base64!!'],
    ['hex instead of base64', 'ab'.repeat(32)],
  ])('ENCRYPTION_KEY must be 32 bytes of base64: %s', (_name, value) => {
    const message = problem({ ...VALID, ENCRYPTION_KEY: value });
    expect(message).toContain('ENCRYPTION_KEY');
    expect(message).not.toContain(value);
  });

  test.each([
    ['NODE_ENV', 'staging'],
    ['APP_ORIGIN', 'not a url'],
    ['APP_ORIGIN', 'javascript:alert(1)'],
    ['PUBLIC_BASE_URL', 'ftp://roofline.test'],
    ['DATABASE_URL_TENANT', 'mysql://u:p@h/db'],
    ['TRUST_PROXY', 'yes'],
    ['TRUST_PROXY', '-1'],
    ['API_RATE_LIMIT_PER_MIN', '0'],
    ['API_RATE_LIMIT_PER_MIN', 'lots'],
    ['PORT', '70000'],
    ['PORT', 'http'],
  ])('rejects %s=%s', (name, value) => {
    expect(problem({ ...VALID, [name]: value })).toContain(name);
  });

  test('POSTMARK_TOKEN needs MAIL_FROM', () => {
    expect(problem({ ...VALID, POSTMARK_TOKEN: 'pm' })).toContain('MAIL_FROM');
  });

  describe('WEB_DIST_DIR', () => {
    let built: string;
    let noIndex: string;
    const ROOT = path.resolve(import.meta.dirname, '../../..');

    beforeAll(() => {
      built = fs.mkdtempSync(path.join(os.tmpdir(), 'roofline-config-web-'));
      fs.writeFileSync(path.join(built, 'index.html'), '<!doctype html>');
      noIndex = fs.mkdtempSync(path.join(os.tmpdir(), 'roofline-config-empty-'));
    });

    afterAll(() => {
      fs.rmSync(built, { recursive: true, force: true });
      fs.rmSync(noIndex, { recursive: true, force: true });
    });

    test('is optional: unset or blank leaves it out', () => {
      expect(loadConfig(VALID).WEB_DIST_DIR).toBeUndefined();
      expect(loadConfig({ ...VALID, WEB_DIST_DIR: '  ' }).WEB_DIST_DIR).toBeUndefined();
    });

    test('a directory with an index.html is accepted', () => {
      expect(loadConfig({ ...VALID, WEB_DIST_DIR: built }).WEB_DIST_DIR).toBe(built);
    });

    test('a relative path is read from the repository root, wherever the process was started', () => {
      // `npm start -w @roofline/api` runs in apps/api, so `apps/web/dist` must not depend on the working directory.
      const relative = path.relative(ROOT, built);
      expect(path.isAbsolute(relative)).toBe(false);
      expect(loadConfig({ ...VALID, WEB_DIST_DIR: relative }).WEB_DIST_DIR).toBe(built);
    });

    test('a missing directory is a ConfigError that names WEB_DIST_DIR and prints no value', () => {
      const missing = path.join(os.tmpdir(), 'roofline-no-such-dir-4410');
      const message = problem({ ...VALID, WEB_DIST_DIR: missing });
      expect(message).toContain('WEB_DIST_DIR');
      expect(message).not.toContain(missing);
      expect(message).not.toContain(KEY);
      expect(() => loadConfig({ ...VALID, WEB_DIST_DIR: missing })).toThrow(/^Invalid environment configuration/);
    });

    test('a directory without index.html is refused', () => {
      expect(problem({ ...VALID, WEB_DIST_DIR: noIndex })).toContain('WEB_DIST_DIR');
    });

    test('a file instead of a directory is refused', () => {
      expect(problem({ ...VALID, WEB_DIST_DIR: path.join(built, 'index.html') })).toContain('WEB_DIST_DIR');
    });
  });
});
