import { describe, expect, test } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.ts';

const KEY = Buffer.alloc(32, 9).toString('base64');

const VALID = {
  NODE_ENV: 'production',
  APP_ORIGIN: 'https://app.roofline.test',
  DATABASE_URL_TENANT: 'postgres://app_tenant:pw@localhost:5432/roofline',
  DATABASE_URL_SYSTEM: 'postgres://app_system:pw@localhost:5432/roofline',
  ENCRYPTION_KEY: KEY,
  PUBLIC_BASE_URL: 'https://app.roofline.test',
  // Production requires R2 (E1 Ruling ET).
  R2_ACCOUNT_ID: 'acct',
  R2_ACCESS_KEY_ID: 'key-id',
  R2_SECRET_ACCESS_KEY: 'key-secret',
  R2_BUCKET: 'proposals',
} satisfies Record<string, string>;

const GOOGLE_ADS = {
  GOOGLE_ADS_DEVELOPER_TOKEN: 'dev',
  GOOGLE_ADS_MANAGER_ID: '1234567890',
  GOOGLE_ADS_CLIENT_ID: 'cid',
  GOOGLE_ADS_CLIENT_SECRET: 'secret',
  GOOGLE_ADS_REFRESH_TOKEN: 'refresh',
} satisfies Record<string, string>;

const META = {
  META_APP_ID: 'app',
  META_APP_SECRET: 'secret',
  META_SYSTEM_USER_TOKEN: 'token',
  META_BUSINESS_ID: '987',
} satisfies Record<string, string>;

function problem(env: Record<string, string | undefined>): string {
  try {
    loadConfig(env);
  } catch (err) {
    expect(err).toBeInstanceOf(ConfigError);
    return (err as Error).message;
  }
  throw new Error('Expected loadConfig to throw');
}

describe('storm settings', () => {
  test('google ads settings are all or none', () => {
    expect(problem({ ...VALID, GOOGLE_ADS_DEVELOPER_TOKEN: 'dev' })).toContain(
      'GOOGLE_ADS_MANAGER_ID: is required when the other GOOGLE_ADS settings are set',
    );
    expect(() => loadConfig({ ...VALID, ...GOOGLE_ADS })).not.toThrow();
    expect(loadConfig({ ...VALID, ...GOOGLE_ADS }).GOOGLE_ADS_MANAGER_ID).toBe('1234567890');
  });

  test('meta settings are all or none', () => {
    expect(problem({ ...VALID, META_APP_ID: 'app' })).toContain(
      'META_BUSINESS_ID: is required when the other META settings are set',
    );
    expect(() => loadConfig({ ...VALID, ...META })).not.toThrow();
  });

  test('defaults', () => {
    const config = loadConfig(VALID);
    expect(config.GOOGLE_ADS_API_VERSION).toBe('v21');
    expect(config.META_GRAPH_VERSION).toBe('v24.0');
    expect(config.POSTMARK_BROADCAST_STREAM).toBe('broadcast');
    expect(config.HAIL_STALE_MINUTES).toBe(90);
  });

  test('bad versions refused', () => {
    expect(problem({ ...VALID, GOOGLE_ADS_API_VERSION: '21' })).toContain('GOOGLE_ADS_API_VERSION');
    expect(problem({ ...VALID, META_GRAPH_VERSION: 'v24' })).toContain('META_GRAPH_VERSION');
  });

  test('STORM_MAIL_FROM defaults to storms@ + the MAIL_FROM domain', () => {
    const env = { ...VALID, POSTMARK_TOKEN: 'pm', MAIL_FROM: 'Roofline <hello@mail.example.com>' };
    expect(loadConfig(env).STORM_MAIL_FROM).toBe('storms@mail.example.com');
    expect(loadConfig({ ...env, MAIL_FROM: 'hello@mail.example.com' }).STORM_MAIL_FROM).toBe('storms@mail.example.com');
  });

  test('STORM_MAIL_FROM falls back to POLICY_PAGES_DOMAIN', () => {
    expect(loadConfig({ ...VALID, POLICY_PAGES_DOMAIN: 'roofline.app' }).STORM_MAIL_FROM).toBe('storms@roofline.app');
  });

  test('STORM_MAIL_FROM falls back to the PUBLIC_BASE_URL host', () => {
    expect(loadConfig(VALID).STORM_MAIL_FROM).toBe('storms@app.roofline.test');
  });

  test('an explicit STORM_MAIL_FROM wins', () => {
    expect(loadConfig({ ...VALID, STORM_MAIL_FROM: 'alerts@example.org' }).STORM_MAIL_FROM).toBe('alerts@example.org');
  });

  test('a non-email STORM_MAIL_FROM is refused', () => {
    expect(problem({ ...VALID, STORM_MAIL_FROM: 'Roofline <storms@example.org>' })).toContain('STORM_MAIL_FROM');
    expect(problem({ ...VALID, STORM_MAIL_FROM: 'nope' })).toContain('STORM_MAIL_FROM: must be an email address');
  });

  test('HAIL_STALE_MINUTES is a whole number from 1 up', () => {
    expect(problem({ ...VALID, HAIL_STALE_MINUTES: '0' })).toContain('HAIL_STALE_MINUTES');
    expect(loadConfig({ ...VALID, HAIL_STALE_MINUTES: '120' }).HAIL_STALE_MINUTES).toBe(120);
  });

  test('hail alert thresholds default to 180 and 720, separate from the 90 minute banner', () => {
    const config = loadConfig(VALID);
    expect(config.HAIL_ALERT_STALE_MINUTES_SEASON).toBe(180);
    expect(config.HAIL_ALERT_STALE_MINUTES_OFFSEASON).toBe(720);
    expect(config.HAIL_STALE_MINUTES).toBe(90);
  });

  test('hail alert thresholds can be overridden and refuse 0', () => {
    const config = loadConfig({ ...VALID, HAIL_ALERT_STALE_MINUTES_SEASON: '60', HAIL_ALERT_STALE_MINUTES_OFFSEASON: '240' });
    expect(config.HAIL_ALERT_STALE_MINUTES_SEASON).toBe(60);
    expect(config.HAIL_ALERT_STALE_MINUTES_OFFSEASON).toBe(240);
    expect(problem({ ...VALID, HAIL_ALERT_STALE_MINUTES_SEASON: '0' })).toContain('HAIL_ALERT_STALE_MINUTES_SEASON');
    expect(problem({ ...VALID, HAIL_ALERT_STALE_MINUTES_OFFSEASON: '0' })).toContain('HAIL_ALERT_STALE_MINUTES_OFFSEASON');
  });

  test('OPS_ALERT_EMAIL is optional and must be an email', () => {
    expect(loadConfig(VALID).OPS_ALERT_EMAIL).toBeUndefined();
    expect(loadConfig({ ...VALID, OPS_ALERT_EMAIL: 'ops@example.org' }).OPS_ALERT_EMAIL).toBe('ops@example.org');
    expect(problem({ ...VALID, OPS_ALERT_EMAIL: 'nope' })).toContain('OPS_ALERT_EMAIL');
  });
});

describe('postmark webhook settings', () => {
  test('POSTMARK_WEBHOOK_SECRET is optional', () => {
    expect(loadConfig(VALID).POSTMARK_WEBHOOK_SECRET).toBeUndefined();
  });

  test('POSTMARK_WEBHOOK_SECRET must be at least 16 characters', () => {
    expect(problem({ ...VALID, POSTMARK_WEBHOOK_SECRET: 'short' })).toContain(
      'POSTMARK_WEBHOOK_SECRET: must be at least 16 characters',
    );
    expect(loadConfig({ ...VALID, POSTMARK_WEBHOOK_SECRET: 'pm-hook-secret-0123456789' }).POSTMARK_WEBHOOK_SECRET).toBe(
      'pm-hook-secret-0123456789',
    );
  });
});
