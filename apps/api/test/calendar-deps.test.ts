import { describe, expect, test } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { CalendarUnavailableError, createCalendarApis } from '../src/providers/calendar.ts';
import { FakeCalendarApi } from '../src/providers/fakes/calendar.ts';

const KEY = Buffer.alloc(32, 9).toString('base64');

// Development, not production: FAKE_PROVIDERS is refused in production.
const VALID = {
  NODE_ENV: 'development',
  APP_ORIGIN: 'https://app.roofline.test',
  DATABASE_URL_TENANT: 'postgres://app_tenant:pw@localhost:5432/roofline',
  DATABASE_URL_SYSTEM: 'postgres://app_system:pw@localhost:5432/roofline',
  ENCRYPTION_KEY: KEY,
  PUBLIC_BASE_URL: 'https://app.roofline.test',
} satisfies Record<string, string>;

describe('createCalendarApis', () => {
  test('FAKE_PROVIDERS=1 gives a configured fake for each provider', () => {
    const apis = createCalendarApis(loadConfig({ ...VALID, FAKE_PROVIDERS: '1' }));
    expect(apis.google).toBeInstanceOf(FakeCalendarApi);
    expect(apis.microsoft).toBeInstanceOf(FakeCalendarApi);
    expect(apis.google.provider).toBe('google');
    expect(apis.microsoft.provider).toBe('microsoft');
    expect(apis.google.configured).toBe(true);
    expect(apis.microsoft.configured).toBe(true);
  });

  test('without FAKE_PROVIDERS, unconfigured providers refuse every call with a setup message', async () => {
    const apis = createCalendarApis(loadConfig(VALID));
    for (const api of [apis.google, apis.microsoft]) {
      expect(api.configured).toBe(false);
      expect(() => api.authUrl({ state: 's', redirectUri: 'r' })).toThrow(CalendarUnavailableError);
      await expect(api.listCalendars('t')).rejects.toThrow("Calendar connections aren't set up yet.");
    }
  });
});
