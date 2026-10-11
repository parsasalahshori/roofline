import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { buildDeps } from '../src/deps.ts';
import { InlineQueue } from '../src/tasks/queue.ts';
import { NwsWeatherSource } from '../src/weather/nws.ts';
import { NullWeatherSource } from '../src/weather/source.ts';

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

describe('weather settings', () => {
  test('both are optional and absent by default', () => {
    const config = loadConfig(VALID);
    expect(config.NWS_USER_AGENT).toBeUndefined();
    expect(config.WEATHER_DISABLED).toBeUndefined();
    // Blank lines in an env file count as unset.
    const blank = loadConfig({ ...VALID, NWS_USER_AGENT: ' ', WEATHER_DISABLED: '' });
    expect(blank.NWS_USER_AGENT).toBeUndefined();
    expect(blank.WEATHER_DISABLED).toBeUndefined();
  });

  test('NWS_USER_AGENT is kept as written', () => {
    expect(loadConfig({ ...VALID, NWS_USER_AGENT: 'Acme Roofing (ops@acme.test)' }).NWS_USER_AGENT).toBe(
      'Acme Roofing (ops@acme.test)',
    );
  });

  test('NWS_USER_AGENT must be plain text, since it travels as an HTTP header', () => {
    for (const value of ['Roofline \u2014 ops', 'Roofline\nops', 'Rooflin\u00e9']) {
      expect(problem({ ...VALID, NWS_USER_AGENT: value })).toContain('NWS_USER_AGENT');
    }
  });

  test.each([
    ['1', true],
    ['true', true],
    ['TRUE', true],
    ['0', false],
    ['false', false],
  ])('WEATHER_DISABLED=%s is %s', (value, expected) => {
    expect(loadConfig({ ...VALID, WEATHER_DISABLED: value }).WEATHER_DISABLED).toBe(expected);
  });

  test.each(['yes', 'on', '2', 'disabled'])('rejects WEATHER_DISABLED=%s, naming the variable', (value) => {
    const message = problem({ ...VALID, WEATHER_DISABLED: value });
    expect(message).toContain('WEATHER_DISABLED');
    expect(message).toContain('1, true, 0 or false');
  });
});

describe('buildDeps and the weather source', () => {
  const built: { pools: { end(): Promise<void> } }[] = [];

  afterEach(async () => {
    vi.unstubAllGlobals();
    await Promise.all(built.splice(0).map((deps) => deps.pools.end()));
  });

  /** buildDeps over a complete environment. The pools are lazy: nothing connects until a query runs. */
  function depsFor(extra: Record<string, string>) {
    const deps = buildDeps(loadConfig({ ...VALID, NODE_ENV: 'test', ...extra }), new InlineQueue());
    built.push(deps);
    return deps;
  }

  /** Replaces the global fetch with one that records the headers it was called with, and answers 599. */
  function recordGlobalFetch() {
    const seen: { url: string; headers: Headers }[] = [];
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      seen.push({ url, headers: new Headers(init?.headers) });
      return new Response('', { status: 599 });
    });
    return seen;
  }

  test('WEATHER_DISABLED=1 makes the weather source the null one, which asks nobody', async () => {
    const seen = recordGlobalFetch();
    for (const value of ['1', 'true']) {
      const { weather } = depsFor({ WEATHER_DISABLED: value });
      expect(weather).toBeInstanceOf(NullWeatherSource);
      expect(await weather.current(41.2565, -95.9345)).toBeNull();
    }
    expect(seen).toHaveLength(0);
  });

  test('otherwise it is the National Weather Service, introducing itself with the public address by default', async () => {
    const seen = recordGlobalFetch();
    const { weather } = depsFor({});
    expect(weather).toBeInstanceOf(NwsWeatherSource);
    expect(await weather.current(41.2565, -95.9345)).toBeNull(); // the stub answers 599
    expect(seen).toHaveLength(1);
    expect(seen[0]!.headers.get('User-Agent')).toBe('Roofline (https://app.roofline.test)');

    // WEATHER_DISABLED=0 is "not disabled".
    expect(depsFor({ WEATHER_DISABLED: '0' }).weather).toBeInstanceOf(NwsWeatherSource);
  });

  test('NWS_USER_AGENT replaces the default', async () => {
    const seen = recordGlobalFetch();
    await depsFor({ NWS_USER_AGENT: 'Acme Roofing (ops@acme.test)' }).weather.current(41.2565, -95.9345);
    expect(seen[0]!.headers.get('User-Agent')).toBe('Acme Roofing (ops@acme.test)');
  });
});
