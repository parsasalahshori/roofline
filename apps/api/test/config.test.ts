import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { DisabledSmsAdapter, FakeSmsAdapter } from '@roofline/send-gate';
import { loadConfig } from '../src/config.ts';
import { buildDeps } from '../src/deps.ts';
import { InlineJobs } from '../src/jobs/queue.ts';
import { FakeBillingProvider } from '../src/providers/fakes/billing.ts';
import { FakeGeocoder } from '../src/providers/fakes/geocoder.ts';
import { FakeTextingRegistrar } from '../src/providers/fakes/registrar.ts';
import { InlineQueue } from '../src/tasks/queue.ts';
import { NwsWeatherSource } from '../src/weather/nws.ts';
import { NullWeatherSource } from '../src/weather/source.ts';

const KEY = Buffer.alloc(32, 9).toString('base64');

/** A production environment without R2 (which production requires: Ruling ET). */
const BASE = {
  NODE_ENV: 'production',
  APP_ORIGIN: 'https://app.roofline.test',
  DATABASE_URL_TENANT: 'postgres://app_tenant:pw@localhost:5432/roofline',
  DATABASE_URL_SYSTEM: 'postgres://app_system:pw@localhost:5432/roofline',
  ENCRYPTION_KEY: KEY,
  PUBLIC_BASE_URL: 'https://app.roofline.test',
  // Required in production: Render puts one proxy in front of the API.
  TRUST_PROXY: '1',
} satisfies Record<string, string>;

const R2_SETTINGS = {
  R2_ACCOUNT_ID: 'acct',
  R2_ACCESS_KEY_ID: 'key-id',
  R2_SECRET_ACCESS_KEY: 'key-secret',
  R2_BUCKET: 'proposals',
} satisfies Record<string, string>;

const VALID = { ...BASE, ...R2_SETTINGS } satisfies Record<string, string>;

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
      FRONT_DESK_ROUTER_MODEL: 'claude-haiku-5-5',
      FRONT_DESK_ANSWER_MODEL: 'claude-opus-5-5',
      AGENT_DRAFT_MODEL: 'claude-opus-5-5',
      AGENT_EXTRACT_MODEL: 'claude-haiku-5-5',
      FRONT_DESK_OPUS_FAST: false,
      FRONT_DESK_MAX_CALLS: 40,
      RELAY_PUBLIC_URL: 'wss://app.roofline.test/relay',
      RELAY_TOKEN_SECRET: loadConfig(VALID).RELAY_TOKEN_SECRET,
      TRUST_PROXY: 1,
      API_RATE_LIMIT_PER_MIN: 600,
      PORT: 4400,
      HOST: '0.0.0.0',
      EAGLEVIEW_ENV: 'sandbox',
      EAGLEVIEW_PRODUCT_ID: 0,
      PROPOSAL_LINK_BASE_URL: 'https://app.roofline.test',
      FOOTPRINTS_BASE_URL: 'https://usbuildingdata.blob.core.windows.net/usbuildings-v2/',
      GOOGLE_ADS_API_VERSION: 'v21',
      META_GRAPH_VERSION: 'v24.0',
      POSTMARK_BROADCAST_STREAM: 'broadcast',
      HAIL_STALE_MINUTES: 90,
      HAIL_ALERT_STALE_MINUTES_SEASON: 180,
      HAIL_ALERT_STALE_MINUTES_OFFSEASON: 720,
      STORM_MAIL_FROM: 'storms@app.roofline.test',
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
    const config = loadConfig({ ...VALID, NODE_ENV: 'development', POSTMARK_TOKEN: '', TRUST_PROXY: '', GOOGLE_CLIENT_ID: '  ' });
    expect(config.POSTMARK_TOKEN).toBeUndefined();
    expect(config.GOOGLE_CLIENT_ID).toBeUndefined();
    expect(config.TRUST_PROXY).toBe(0);
  });

  test('TRUST_PROXY is required in production and must be at least 1; development and tests default to 0', () => {
    for (const value of [undefined, '', '0']) {
      const message = problem({ ...VALID, TRUST_PROXY: value });
      expect(message, String(value)).toContain('TRUST_PROXY');
      expect(message).toContain('is required in production');
      // The message names the variable, never the values of the others.
      expect(message).not.toContain(KEY);
    }
    expect(loadConfig({ ...VALID, TRUST_PROXY: '1' }).TRUST_PROXY).toBe(1);
    expect(loadConfig({ ...VALID, TRUST_PROXY: '2' }).TRUST_PROXY).toBe(2);
    for (const NODE_ENV of ['development', 'test']) {
      expect(loadConfig({ ...VALID, NODE_ENV, TRUST_PROXY: undefined }).TRUST_PROXY, NODE_ENV).toBe(0);
      expect(loadConfig({ ...VALID, NODE_ENV, TRUST_PROXY: '0' }).TRUST_PROXY, NODE_ENV).toBe(0);
    }
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
    const deps = buildDeps(loadConfig({ ...VALID, NODE_ENV: 'test', ...extra }), new InlineQueue(), new InlineJobs());
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

describe('F3 settings', () => {
  const STRIPE_KEY = 'sk_test_x';
  const WHSEC = 'whsec_test_roofline';
  const AC_SID = 'AC' + 'a'.repeat(32);
  const BU_SID = 'BU' + 'b'.repeat(32);

  test('the new keys are optional and absent by default', () => {
    const config = loadConfig(VALID);
    expect(config.STRIPE_SECRET_KEY).toBeUndefined();
    expect(config.STRIPE_WEBHOOK_SECRET).toBeUndefined();
    expect(config.GEOCODIO_API_KEY).toBeUndefined();
    expect(config.TWILIO_ACCOUNT_SID).toBeUndefined();
    expect(config.TWILIO_PRIMARY_PROFILE_SID).toBeUndefined();
    expect(config.POLICY_PAGES_DOMAIN).toBeUndefined();
    expect(config.FAKE_PROVIDERS).toBeUndefined();
    // Outside production the example plans file is the default; in production without Stripe it stays unset.
    expect(config.BILLING_PLANS_FILE).toBeUndefined();
  });

  test('blank values count as unset for every new key', () => {
    const config = loadConfig({
      ...VALID,
      STRIPE_SECRET_KEY: '',
      STRIPE_WEBHOOK_SECRET: ' ',
      GEOCODIO_API_KEY: '',
      TWILIO_ACCOUNT_SID: '',
      TWILIO_PRIMARY_PROFILE_SID: '',
      POLICY_PAGES_DOMAIN: '',
      FAKE_PROVIDERS: '',
      BILLING_PLANS_FILE: '',
    });
    expect(config.STRIPE_SECRET_KEY).toBeUndefined();
    expect(config.TWILIO_ACCOUNT_SID).toBeUndefined();
    expect(config.FAKE_PROVIDERS).toBeUndefined();
    expect(config.BILLING_PLANS_FILE).toBeUndefined();
  });

  test('STRIPE_SECRET_KEY must start with sk_, and the message names the key only', () => {
    const message = problem({ ...VALID, STRIPE_SECRET_KEY: 'pk_live_nope' });
    expect(message).toContain('STRIPE_SECRET_KEY');
    expect(message).toContain('must start with sk_');
    expect(message).not.toContain('pk_live_nope');
  });

  test('STRIPE_SECRET_KEY needs STRIPE_WEBHOOK_SECRET', () => {
    const message = problem({ ...VALID, STRIPE_SECRET_KEY: STRIPE_KEY });
    expect(message).toContain('STRIPE_WEBHOOK_SECRET');
    expect(message).toContain('is required when STRIPE_SECRET_KEY is set');
  });

  test('STRIPE_WEBHOOK_SECRET must start with whsec_', () => {
    const message = problem({ ...VALID, STRIPE_WEBHOOK_SECRET: 'secret' });
    expect(message).toContain('STRIPE_WEBHOOK_SECRET');
    expect(message).toContain('whsec_');
  });

  test('a complete Stripe pair is accepted', () => {
    const config = loadConfig({
      ...VALID,
      STRIPE_SECRET_KEY: STRIPE_KEY,
      STRIPE_WEBHOOK_SECRET: WHSEC,
      BILLING_PLANS_FILE: 'config/billing-plans.example.json',
    });
    expect(config).toMatchObject({ STRIPE_SECRET_KEY: STRIPE_KEY, STRIPE_WEBHOOK_SECRET: WHSEC });
  });

  test('in production with Stripe, BILLING_PLANS_FILE is required', () => {
    const message = problem({ ...VALID, STRIPE_SECRET_KEY: STRIPE_KEY, STRIPE_WEBHOOK_SECRET: WHSEC });
    expect(message).toContain('BILLING_PLANS_FILE');
    expect(message).toContain('is required in production when STRIPE_SECRET_KEY is set');
  });

  test('BILLING_PLANS_FILE defaults to the example plans file outside production', () => {
    const config = loadConfig({ ...VALID, NODE_ENV: 'development' });
    expect(path.isAbsolute(config.BILLING_PLANS_FILE!)).toBe(true);
    expect(config.BILLING_PLANS_FILE!.endsWith(path.join('config', 'billing-plans.example.json'))).toBe(true);
    expect(loadConfig({ ...VALID, NODE_ENV: 'test' }).BILLING_PLANS_FILE!.endsWith(path.join('config', 'billing-plans.example.json'))).toBe(true);
  });

  test('a relative BILLING_PLANS_FILE is read from the repository root', () => {
    const config = loadConfig({ ...VALID, NODE_ENV: 'development', BILLING_PLANS_FILE: 'config/other.json' });
    expect(config.BILLING_PLANS_FILE).toBe(path.resolve(import.meta.dirname, '../../..', 'config/other.json'));
  });

  test('GEOCODIO_API_KEY is kept as written', () => {
    expect(loadConfig({ ...VALID, GEOCODIO_API_KEY: 'geo-key' }).GEOCODIO_API_KEY).toBe('geo-key');
  });

  test('TWILIO_ACCOUNT_SID must be AC followed by 32 hex digits, and names the key', () => {
    const message = problem({ ...VALID, TWILIO_ACCOUNT_SID: 'ACxyz' });
    expect(message).toContain('TWILIO_ACCOUNT_SID');
    expect(message).toContain('must be AC followed by 32 hex digits');
    expect(message).not.toContain('ACxyz');
  });

  test('TWILIO_ACCOUNT_SID needs TWILIO_AUTH_TOKEN', () => {
    const message = problem({ ...VALID, TWILIO_ACCOUNT_SID: AC_SID });
    expect(message).toContain('TWILIO_AUTH_TOKEN');
    expect(loadConfig({ ...VALID, TWILIO_ACCOUNT_SID: AC_SID, TWILIO_AUTH_TOKEN: 'tok' }).TWILIO_ACCOUNT_SID).toBe(AC_SID);
  });

  test('TWILIO_PRIMARY_PROFILE_SID must be BU followed by 32 hex digits', () => {
    expect(loadConfig({ ...VALID, TWILIO_PRIMARY_PROFILE_SID: BU_SID }).TWILIO_PRIMARY_PROFILE_SID).toBe(BU_SID);
    const message = problem({ ...VALID, TWILIO_PRIMARY_PROFILE_SID: 'AC' + 'a'.repeat(32) });
    expect(message).toContain('TWILIO_PRIMARY_PROFILE_SID');
  });

  test('POLICY_PAGES_DOMAIN is a bare lowercase hostname (case is folded)', () => {
    expect(loadConfig({ ...VALID, POLICY_PAGES_DOMAIN: 'Roofline.App' }).POLICY_PAGES_DOMAIN).toBe('roofline.app');
    expect(loadConfig({ ...VALID, POLICY_PAGES_DOMAIN: 'policies.roofline.app' }).POLICY_PAGES_DOMAIN).toBe(
      'policies.roofline.app',
    );
    for (const value of ['https://roofline.app', 'roofline.app/terms', 'localhost', 'roof line.app']) {
      const message = problem({ ...VALID, POLICY_PAGES_DOMAIN: value });
      expect(message).toContain('POLICY_PAGES_DOMAIN');
      expect(message).toContain('must be a bare hostname, like roofline.app');
    }
  });

  test('MICROSOFT_CLIENT_ID and MICROSOFT_CLIENT_SECRET come as a pair; the issue names the missing one', () => {
    const noSecret = problem({ ...VALID, MICROSOFT_CLIENT_ID: 'ms-id' });
    expect(noSecret).toContain('MICROSOFT_CLIENT_SECRET');
    expect(noSecret).toContain('is required when MICROSOFT_CLIENT_ID is set');
    const noId = problem({ ...VALID, MICROSOFT_CLIENT_SECRET: 'ms-secret' });
    expect(noId).toContain('MICROSOFT_CLIENT_ID');
    expect(noId).toContain('is required when MICROSOFT_CLIENT_SECRET is set');
    const both = loadConfig({ ...VALID, MICROSOFT_CLIENT_ID: 'ms-id', MICROSOFT_CLIENT_SECRET: 'ms-secret' });
    expect(both).toMatchObject({ MICROSOFT_CLIENT_ID: 'ms-id', MICROSOFT_CLIENT_SECRET: 'ms-secret' });
    const blank = loadConfig({ ...VALID, MICROSOFT_CLIENT_ID: ' ', MICROSOFT_CLIENT_SECRET: '' });
    expect(blank.MICROSOFT_CLIENT_ID).toBeUndefined();
    expect(blank.MICROSOFT_CLIENT_SECRET).toBeUndefined();
  });

  test('GOOGLE_CLIENT_SECRET needs GOOGLE_CLIENT_ID', () => {
    const message = problem({ ...VALID, GOOGLE_CLIENT_SECRET: 'g-secret' });
    expect(message).toContain('GOOGLE_CLIENT_ID');
    expect(message).toContain('is required when GOOGLE_CLIENT_SECRET is set');
    expect(loadConfig({ ...VALID, GOOGLE_CLIENT_ID: 'g-id', GOOGLE_CLIENT_SECRET: 'g-secret' })).toMatchObject({
      GOOGLE_CLIENT_SECRET: 'g-secret',
    });
  });

  test('FAKE_PROVIDERS is a flag, and is refused in production', () => {
    expect(loadConfig({ ...VALID, NODE_ENV: 'development', FAKE_PROVIDERS: '1' }).FAKE_PROVIDERS).toBe(true);
    expect(loadConfig({ ...VALID, NODE_ENV: 'test', FAKE_PROVIDERS: 'false' }).FAKE_PROVIDERS).toBe(false);
    const message = problem({ ...VALID, FAKE_PROVIDERS: '1' });
    expect(message).toContain('FAKE_PROVIDERS');
    expect(message).toContain('must not be set in production');
    // Off in production is fine.
    expect(loadConfig({ ...VALID, FAKE_PROVIDERS: '0' }).FAKE_PROVIDERS).toBe(false);
  });

  test('DEMO_MODE is refused in production unless DEMO_MODE_ALLOW_PROD is set', () => {
    const message = problem({ ...VALID, DEMO_MODE: '1' });
    expect(message).toContain('DEMO_MODE');
    expect(message).toContain('is refused in production');
    expect(problem({ ...VALID, DEMO_MODE: '1', DEMO_MODE_ALLOW_PROD: '0' })).toContain('DEMO_MODE');
  });

  test('DEMO_MODE with DEMO_MODE_ALLOW_PROD loads in production with every provider fake and the weather off', () => {
    const config = loadConfig({ ...VALID, DEMO_MODE: '1', DEMO_MODE_ALLOW_PROD: '1' });
    expect(config).toMatchObject({ DEMO_MODE: true, DEMO_MODE_ALLOW_PROD: true, FAKE_PROVIDERS: true, WEATHER_DISABLED: true });
    // FAKE_PROVIDERS set explicitly is allowed alongside the override too.
    expect(loadConfig({ ...VALID, DEMO_MODE: '1', DEMO_MODE_ALLOW_PROD: '1', FAKE_PROVIDERS: '1' }).FAKE_PROVIDERS).toBe(true);
    // The override alone changes nothing.
    const overrideOnly = loadConfig({ ...VALID, DEMO_MODE_ALLOW_PROD: '1' });
    expect(overrideOnly.DEMO_MODE).toBeFalsy();
    expect(overrideOnly.FAKE_PROVIDERS).toBeFalsy();
  });

  test('DEMO_MODE in development forces FAKE_PROVIDERS and WEATHER_DISABLED on', () => {
    const dev = { ...VALID, NODE_ENV: 'development' };
    expect(loadConfig({ ...dev, DEMO_MODE: '1', FAKE_PROVIDERS: '0' })).toMatchObject({ DEMO_MODE: true, FAKE_PROVIDERS: true, WEATHER_DISABLED: true });
    const plain = loadConfig(dev);
    expect(plain.DEMO_MODE).toBeFalsy();
    expect(plain.FAKE_PROVIDERS).toBeFalsy();
  });

  test('DEMO_DATABASE_URL_OWNER is optional and must be a postgres URL', () => {
    expect(loadConfig(VALID).DEMO_DATABASE_URL_OWNER).toBeUndefined();
    const url = 'postgres://owner:pw@localhost:5432/roofline';
    expect(loadConfig({ ...VALID, DEMO_DATABASE_URL_OWNER: url }).DEMO_DATABASE_URL_OWNER).toBe(url);
    expect(problem({ ...VALID, DEMO_DATABASE_URL_OWNER: 'https://example.test' })).toContain('DEMO_DATABASE_URL_OWNER');
  });
});

describe('E1 settings', () => {
  const R2 = {
    R2_ACCOUNT_ID: 'acct',
    R2_ACCESS_KEY_ID: 'key-id',
    R2_SECRET_ACCESS_KEY: 'key-secret',
    R2_BUCKET: 'proposals',
  };

  test('EAGLEVIEW_CLIENT_ID without the secret is refused (names EAGLEVIEW_CLIENT_SECRET)', () => {
    const message = problem({ ...VALID, EAGLEVIEW_CLIENT_ID: 'ev-id' });
    expect(message).toContain('EAGLEVIEW_CLIENT_SECRET');
    expect(message).toContain('is required when EAGLEVIEW_CLIENT_ID is set');
  });

  test('EAGLEVIEW_CLIENT_SECRET without the id is refused (names EAGLEVIEW_CLIENT_ID)', () => {
    const message = problem({ ...VALID, EAGLEVIEW_CLIENT_SECRET: 'ev-secret' });
    expect(message).toContain('EAGLEVIEW_CLIENT_ID');
    expect(message).toContain('is required when EAGLEVIEW_CLIENT_SECRET is set');
    expect(message).not.toContain('ev-secret');
  });

  test('both EagleView settings load', () => {
    expect(loadConfig({ ...VALID, EAGLEVIEW_CLIENT_ID: 'ev-id', EAGLEVIEW_CLIENT_SECRET: 'ev-secret' })).toMatchObject({
      EAGLEVIEW_CLIENT_ID: 'ev-id',
      EAGLEVIEW_CLIENT_SECRET: 'ev-secret',
    });
    expect(loadConfig(VALID).EAGLEVIEW_CLIENT_ID).toBeUndefined();
  });

  test('EAGLEVIEW_ENV defaults to sandbox and rejects other values', () => {
    expect(loadConfig(VALID).EAGLEVIEW_ENV).toBe('sandbox');
    expect(loadConfig({ ...VALID, EAGLEVIEW_ENV: 'production' }).EAGLEVIEW_ENV).toBe('production');
    const message = problem({ ...VALID, EAGLEVIEW_ENV: 'staging' });
    expect(message).toContain('EAGLEVIEW_ENV');
    expect(message).toContain('must be sandbox or production');
  });

  test('EAGLEVIEW_PRODUCT_ID defaults to 0 and rejects non-integers', () => {
    expect(loadConfig(VALID).EAGLEVIEW_PRODUCT_ID).toBe(0);
    expect(loadConfig({ ...VALID, EAGLEVIEW_PRODUCT_ID: '11' }).EAGLEVIEW_PRODUCT_ID).toBe(11);
    for (const value of ['1.5', '-1', 'abc', '2147483648']) {
      expect(problem({ ...VALID, EAGLEVIEW_PRODUCT_ID: value })).toContain('EAGLEVIEW_PRODUCT_ID');
    }
  });

  test('R2 settings: all four load; one alone is refused (names the missing ones); none loads outside production', () => {
    const dev = { ...BASE, NODE_ENV: 'development' };
    expect(loadConfig({ ...dev, ...R2 })).toMatchObject(R2);
    const message = problem({ ...dev, R2_BUCKET: 'proposals' });
    for (const name of ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY']) {
      expect(message).toContain(name);
    }
    expect(message).toContain('is required when the other R2 settings are set');
    expect(message).not.toContain('R2_BUCKET:');
    const noBucket = problem({ ...dev, ...R2, R2_BUCKET: undefined });
    expect(noBucket).toContain('R2_BUCKET');
    expect(noBucket).not.toContain('key-secret');
    // None set loads outside production: signing is refused there until R2 is set.
    for (const NODE_ENV of ['development', 'test']) expect(loadConfig({ ...BASE, NODE_ENV }).R2_BUCKET).toBeUndefined();
  });

  test('Ruling ET: production without R2 refuses to start, naming every R2 setting and no value', () => {
    const message = problem(BASE);
    for (const name of ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET']) {
      expect(message).toContain(`${name}: is required in production (signed proposals are stored in R2)`);
    }
    expect(message).not.toContain(KEY);
    expect(loadConfig({ ...BASE, ...R2 }).R2_BUCKET).toBe('proposals');
  });

  test('C-M5: PROPOSAL_LINK_BASE_URL must be on the same origin as APP_ORIGIN (homeowners sign through it)', () => {
    expect(loadConfig({ ...VALID, PROPOSAL_LINK_BASE_URL: 'https://app.roofline.test/' }).PROPOSAL_LINK_BASE_URL).toBe('https://app.roofline.test');
    expect(loadConfig({ ...VALID, PROPOSAL_LINK_BASE_URL: 'https://app.roofline.test/x/' }).PROPOSAL_LINK_BASE_URL).toBe('https://app.roofline.test/x');
    for (const other of ['https://p.roofline.test', 'http://app.roofline.test', 'https://app.roofline.test:8443']) {
      const message = problem({ ...VALID, PROPOSAL_LINK_BASE_URL: other });
      expect(message).toContain('PROPOSAL_LINK_BASE_URL: must be on the same origin as APP_ORIGIN (homeowners sign through it)');
    }
  });

  test('PROPOSAL_LINK_BASE_URL defaults to APP_ORIGIN, strips trailing slashes, rejects non-http', () => {
    expect(loadConfig(VALID).PROPOSAL_LINK_BASE_URL).toBe('https://app.roofline.test');
    expect(loadConfig({ ...VALID, PROPOSAL_LINK_BASE_URL: 'https://app.roofline.test/' }).PROPOSAL_LINK_BASE_URL).toBe(
      'https://app.roofline.test',
    );
    expect(loadConfig({ ...VALID, PROPOSAL_LINK_BASE_URL: 'https://app.roofline.test/x//' }).PROPOSAL_LINK_BASE_URL).toBe(
      'https://app.roofline.test/x',
    );
    expect(problem({ ...VALID, PROPOSAL_LINK_BASE_URL: 'ftp://app.roofline.test' })).toContain('PROPOSAL_LINK_BASE_URL');
  });

  test('FOOTPRINTS_BASE_URL defaults to the Microsoft set and always ends in a slash', () => {
    const fallback = 'https://usbuildingdata.blob.core.windows.net/usbuildings-v2/';
    expect(loadConfig(VALID).FOOTPRINTS_BASE_URL).toBe(fallback);
    expect(loadConfig({ ...VALID, FOOTPRINTS_BASE_URL: 'https://files.test/fp' }).FOOTPRINTS_BASE_URL).toBe(
      'https://files.test/fp/',
    );
    expect(loadConfig({ ...VALID, FOOTPRINTS_BASE_URL: 'https://files.test/fp/' }).FOOTPRINTS_BASE_URL).toBe(
      'https://files.test/fp/',
    );
    expect(problem({ ...VALID, FOOTPRINTS_BASE_URL: 'file:///etc' })).toContain('FOOTPRINTS_BASE_URL');
  });
});

describe('buildDeps providers', () => {
  /** A deps over `extra`, ended in `finally` (the pools are lazy, so nothing connects). */
  async function withDeps(extra: Record<string, string>, use: (deps: ReturnType<typeof buildDeps>) => void) {
    const deps = buildDeps(loadConfig({ ...VALID, NODE_ENV: 'test', ...extra }), new InlineQueue(), new InlineJobs());
    try {
      use(deps);
    } finally {
      await deps.pools.end();
    }
  }

  test('FAKE_PROVIDERS=1 wires the fakes for every outside service', async () => {
    await withDeps({ FAKE_PROVIDERS: '1' }, (deps) => {
      expect(deps.geocoder).toBeInstanceOf(FakeGeocoder);
      expect(deps.billing).toBeInstanceOf(FakeBillingProvider);
      expect(deps.registrar).toBeInstanceOf(FakeTextingRegistrar);
      expect(deps.sms).toBeInstanceOf(FakeSmsAdapter);
      expect(deps.jobs).toBeInstanceOf(InlineJobs);
    });
  });

  test('without FAKE_PROVIDERS nothing is configured and texts are refused', async () => {
    await withDeps({}, (deps) => {
      expect(deps.geocoder.configured).toBe(false);
      expect(deps.billing.configured).toBe(false);
      expect(deps.registrar.configured).toBe(false);
      expect(deps.sms).toBeInstanceOf(DisabledSmsAdapter);
    });
  });
});

describe('Front Desk config', () => {
  test('defaults', () => {
    const cfg = loadConfig(VALID);
    expect(cfg.FRONT_DESK_ROUTER_MODEL).toBe('claude-haiku-5-5');
    expect(cfg.FRONT_DESK_ANSWER_MODEL).toBe('claude-opus-5-5');
    expect(cfg.FRONT_DESK_OPUS_FAST).toBe(false);
    expect(cfg.FRONT_DESK_MAX_CALLS).toBe(40);
    expect(cfg.ANTHROPIC_API_KEY).toBeUndefined();
    expect(cfg.TWILIO_TEST_CALLER_NUMBER).toBeUndefined();
  });

  test('RELAY_PUBLIC_URL is derived from PUBLIC_BASE_URL, and an explicit value is kept', () => {
    expect(loadConfig(VALID).RELAY_PUBLIC_URL).toBe('wss://app.roofline.test/relay');
    expect(loadConfig({ ...VALID, NODE_ENV: 'development', PUBLIC_BASE_URL: 'http://localhost:4400' }).RELAY_PUBLIC_URL).toBe(
      'ws://localhost:4400/relay',
    );
    expect(loadConfig({ ...VALID, RELAY_PUBLIC_URL: 'wss://relay.roofline.test/r/' }).RELAY_PUBLIC_URL).toBe(
      'wss://relay.roofline.test/r',
    );
  });

  test('a RELAY_PUBLIC_URL that is not wss:// is rejected in production, ws:// is allowed elsewhere', () => {
    expect(problem({ ...VALID, RELAY_PUBLIC_URL: 'http://relay.roofline.test/relay' })).toContain('RELAY_PUBLIC_URL');
    expect(problem({ ...VALID, RELAY_PUBLIC_URL: 'ws://relay.roofline.test/relay' })).toContain('RELAY_PUBLIC_URL');
    expect(loadConfig({ ...VALID, NODE_ENV: 'development', RELAY_PUBLIC_URL: 'ws://127.0.0.1:4400/relay' }).RELAY_PUBLIC_URL).toBe(
      'ws://127.0.0.1:4400/relay',
    );
  });

  test('TWILIO_TEST_CALLER_NUMBER must be E.164', () => {
    expect(loadConfig({ ...VALID, TWILIO_TEST_CALLER_NUMBER: '+14025550100' }).TWILIO_TEST_CALLER_NUMBER).toBe('+14025550100');
    expect(problem({ ...VALID, TWILIO_TEST_CALLER_NUMBER: '402-555-0100' })).toContain(
      'TWILIO_TEST_CALLER_NUMBER: must be an E.164 number like +14025550100',
    );
  });

  test('RELAY_TOKEN_SECRET must be at least 32 bytes; unset is derived deterministically', () => {
    expect(problem({ ...VALID, RELAY_TOKEN_SECRET: 'too-short' })).toContain('RELAY_TOKEN_SECRET: must be at least 32 bytes');
    const given = 'x'.repeat(32);
    expect(loadConfig({ ...VALID, RELAY_TOKEN_SECRET: given }).RELAY_TOKEN_SECRET).toBe(given);
    const a = loadConfig(VALID).RELAY_TOKEN_SECRET;
    expect(loadConfig(VALID).RELAY_TOKEN_SECRET).toBe(a);
    expect(Buffer.from(a, 'base64')).toHaveLength(32);
    expect(loadConfig({ ...VALID, ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64') }).RELAY_TOKEN_SECRET).not.toBe(a);
  });

  test('FRONT_DESK_OPUS_FAST reads as a flag', () => {
    expect(loadConfig({ ...VALID, FRONT_DESK_OPUS_FAST: '1' }).FRONT_DESK_OPUS_FAST).toBe(true);
    expect(loadConfig({ ...VALID, FRONT_DESK_OPUS_FAST: 'false' }).FRONT_DESK_OPUS_FAST).toBe(false);
  });
});
