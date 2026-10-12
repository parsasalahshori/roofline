import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../src/config.ts';
import { CalendarAuthError, CalendarUnavailableError, type ExternalEventInput } from '../src/providers/calendar.ts';
import { GOOGLE_CALENDAR_SCOPES, GoogleCalendarApi, googleCalendarFor } from '../src/providers/google-calendar.ts';

/** One request the fake Google fetch received, kept for assertions. */
type RecordedRequest = {
  method: string;
  url: string;
  headers: Headers;
  /** The parsed form body of a form-encoded POST; null otherwise. */
  form: URLSearchParams | null;
  /** The parsed JSON body; null when the body is not JSON. */
  json: unknown;
};

/** One response a route serves: a recorded fixture, an inline body, or only a status. */
type RouteEntry = { status?: number; fixture?: string; pages?: boolean; body?: unknown };
type RouteValue = RouteEntry | RouteEntry[];

type RouteState = { entry: number; page: number };

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./fixtures/google-calendar/${name}.json`, import.meta.url), 'utf8'));
}

/** The whole body of an entry: its fixture (or inline body) and, for pages, the page list. */
function pagesOf(entry: RouteEntry): unknown[] {
  const body = fixture(entry.fixture ?? '') as { pages?: unknown[] };
  if (!Array.isArray(body.pages)) throw new Error(`Fixture ${entry.fixture} has no pages`);
  return body.pages;
}

/**
 * A fake fetch for Google. Route keys are 'METHOD <url prefix>' (split at the first space); the longest
 * matching prefix with the same method wins. A route value is one entry or a list served in order: each
 * request takes the next entry, and the last entry repeats. An entry with `pages` serves the pages of its
 * fixture one request at a time before the list moves on. A call that matches no route is recorded and
 * rejects, which fails the test that made it.
 */
function calendarFixtureFetch(routes: Record<string, RouteValue>): typeof fetch & { requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const states = new Map<string, RouteState>();

  const parsedRoutes = Object.entries(routes).map(([key, value]) => {
    const space = key.indexOf(' ');
    return { key, method: key.slice(0, space).toUpperCase(), prefix: key.slice(space + 1), value };
  });

  /** Picks the response for one matched route, advancing its state. */
  const take = (key: string, value: RouteValue): { status: number; body: unknown } => {
    const entries = Array.isArray(value) ? value : [value];
    const state = states.get(key) ?? { entry: 0, page: 0 };
    states.set(key, state);
    const last = entries.length - 1;
    const index = Math.min(state.entry, last);
    const entry = entries[index] as RouteEntry;
    const status = entry.status ?? 200;

    if (entry.pages) {
      const pages = pagesOf(entry);
      const page = Math.min(state.page, pages.length - 1);
      state.page = page + 1;
      if (state.page >= pages.length && index < last) {
        state.entry = index + 1;
        state.page = 0;
      }
      return { status, body: pages[page] };
    }

    if (index < last) state.entry = index + 1;
    const body = entry.fixture !== undefined ? fixture(entry.fixture) : entry.body;
    return { status, body };
  };

  const fake = async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const rawBody = typeof init?.body === 'string' && init.body ? init.body : null;
    const contentType = headers.get('content-type') ?? '';

    requests.push({
      method,
      url,
      headers,
      form: rawBody !== null && contentType.includes('application/x-www-form-urlencoded') ? new URLSearchParams(rawBody) : null,
      json: rawBody !== null && contentType.includes('application/json') ? JSON.parse(rawBody) : null,
    });

    let best: (typeof parsedRoutes)[number] | undefined;
    for (const route of parsedRoutes) {
      if (route.method !== method || !url.startsWith(route.prefix)) continue;
      if (!best || route.prefix.length > best.prefix.length) best = route;
    }
    if (!best) throw new Error(`No fixture route for ${method} ${url}`);

    const served = take(best.key, best.value);
    if (served.body === undefined || served.status === 204 || served.status === 412) {
      return new Response(null, { status: served.status });
    }
    return new Response(JSON.stringify(served.body), {
      status: served.status,
      headers: { 'content-type': 'application/json' },
    });
  };

  return Object.assign(fake as unknown as typeof fetch, { requests }) as typeof fetch & {
    requests: RecordedRequest[];
  };
}

const CALENDAR = 'crew@example.com';
const CALENDAR_PATH = 'https://www.googleapis.com/calendar/v3/calendars/crew%40example.com';
const EVENTS_PATH = `${CALENDAR_PATH}/events`;
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';
const CALENDAR_LIST_URL = 'https://www.googleapis.com/calendar/v3/users/me/calendarList';
const ACCESS_TOKEN = 'ya29.test-access';
const REFRESH_TOKEN = '1//test-refresh';
const UNAVAILABLE = "Couldn't reach Google Calendar.";

const WINDOW = { from: new Date('2026-10-12T05:00:00.000Z'), to: new Date('2026-12-11T06:00:00.000Z') };

function newApi(fetchImpl: typeof fetch): GoogleCalendarApi {
  return new GoogleCalendarApi({ clientId: 'cid', clientSecret: 'secret', fetch: fetchImpl });
}

/** Resolves to the error a promise rejects with; fails the test when it resolves. */
async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('Expected the call to reject');
    },
    (error: unknown) => error,
  );
}

function timedEvent(overrides: Partial<ExternalEventInput> = {}): ExternalEventInput {
  return {
    title: 'Roof inspection',
    location: '123 Main St, Austin, TX',
    description: 'Inspection for the lead.\nhttps://app.example.com/jobs/1',
    start: new Date('2026-10-14T19:00:00.000Z'),
    end: new Date('2026-10-14T20:00:00.000Z'),
    allDay: false,
    timeZone: 'America/Chicago',
    ...overrides,
  };
}

describe('Google Calendar adapter', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-12T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('builds the consent URL with the calendar scopes and offline access', () => {
    const api = newApi(calendarFixtureFetch({}));
    const url = new URL(api.authUrl({ state: 'state-1', redirectUri: 'https://app.example.com/calendar/google/callback' }));

    expect(`${url.origin}${url.pathname}`).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('client_id')).toBe('cid');
    expect(url.searchParams.get('redirect_uri')).toBe('https://app.example.com/calendar/google/callback');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('scope')).toBe(GOOGLE_CALENDAR_SCOPES.join(' '));
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('include_granted_scopes')).toBe('true');
    expect(url.searchParams.get('state')).toBe('state-1');
  });

  it('exchanges the code, reads the account email, and returns the tokens', async () => {
    const fetchImpl = calendarFixtureFetch({
      [`POST ${TOKEN_URL}`]: { fixture: 'token-exchange' },
      [`GET ${USERINFO_URL}`]: { fixture: 'userinfo' },
    });
    const tokens = await newApi(fetchImpl).exchangeCode({
      code: 'auth-code',
      redirectUri: 'https://app.example.com/calendar/google/callback',
    });

    const [tokenRequest, userinfoRequest] = fetchImpl.requests;
    expect(tokenRequest?.method).toBe('POST');
    expect(tokenRequest?.url).toBe(TOKEN_URL);
    expect(tokenRequest?.form?.get('code')).toBe('auth-code');
    expect(tokenRequest?.form?.get('client_id')).toBe('cid');
    expect(tokenRequest?.form?.get('client_secret')).toBe('secret');
    expect(tokenRequest?.form?.get('redirect_uri')).toBe('https://app.example.com/calendar/google/callback');
    expect(tokenRequest?.form?.get('grant_type')).toBe('authorization_code');

    expect(userinfoRequest?.method).toBe('GET');
    expect(userinfoRequest?.url).toBe(USERINFO_URL);
    expect(userinfoRequest?.headers.get('authorization')).toBe(`Bearer ${ACCESS_TOKEN}`);

    expect(tokens.refreshToken).toBe(REFRESH_TOKEN);
    expect(tokens.accessToken).toBe(ACCESS_TOKEN);
    expect(tokens.accountEmail).toBe('crew@example.com');
    expect(tokens.scopes).toContain('https://www.googleapis.com/auth/calendar.events');
    expect(tokens.expiresAt).toEqual(new Date('2026-10-12T12:59:59.000Z'));
  });

  it('refreshes an access token and returns no new refresh token', async () => {
    const fetchImpl = calendarFixtureFetch({ [`POST ${TOKEN_URL}`]: { fixture: 'token-refresh' } });
    const result = await newApi(fetchImpl).refresh(REFRESH_TOKEN);

    const request = fetchImpl.requests[0];
    expect(request?.form?.get('grant_type')).toBe('refresh_token');
    expect(request?.form?.get('refresh_token')).toBe(REFRESH_TOKEN);

    expect(result.accessToken).toBe('ya29.refreshed');
    expect(result.expiresAt).toEqual(new Date('2026-10-12T12:59:59.000Z'));
    expect(result).not.toHaveProperty('refreshToken');
  });

  it('turns a revoked grant into a reconnect error', async () => {
    const fetchImpl = calendarFixtureFetch({
      [`POST ${TOKEN_URL}`]: { status: 400, fixture: 'token-invalid-grant' },
    });
    const error = await rejectionOf(newApi(fetchImpl).refresh(REFRESH_TOKEN));

    expect(error).toBeInstanceOf(CalendarAuthError);
    expect((error as Error).message).toBe('Reconnect your calendar.');
  });

  it('lists the writable calendars with their names and primary flag', async () => {
    const fetchImpl = calendarFixtureFetch({ [`GET ${CALENDAR_LIST_URL}`]: { fixture: 'calendar-list' } });
    const calendars = await newApi(fetchImpl).listCalendars(ACCESS_TOKEN);

    const request = fetchImpl.requests[0];
    expect(request?.url.startsWith(CALENDAR_LIST_URL)).toBe(true);
    expect(request?.url).toContain('minAccessRole=writer');
    expect(request?.headers.get('authorization')).toBe(`Bearer ${ACCESS_TOKEN}`);

    expect(calendars).toEqual([
      { id: 'crew@example.com', name: 'crew@example.com', primary: true, canWrite: true },
      { id: 'team@group.calendar.google.com', name: 'Crew', primary: false, canWrite: true },
      { id: 'holidays@group.v.calendar.google.com', name: 'Holidays in United States', primary: false, canWrite: false },
    ]);
  });

  it('creates a timed event in the company zone with the Roofline marker', async () => {
    const fetchImpl = calendarFixtureFetch({ [`POST ${EVENTS_PATH}`]: { fixture: 'event-insert' } });
    const result = await newApi(fetchImpl).createEvent(ACCESS_TOKEN, CALENDAR, timedEvent());

    const request = fetchImpl.requests[0];
    expect(request?.method).toBe('POST');
    expect(request?.url).toBe(EVENTS_PATH);
    expect(request?.headers.get('authorization')).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(request?.json).toEqual({
      summary: 'Roof inspection',
      location: '123 Main St, Austin, TX',
      description: 'Inspection for the lead.\nhttps://app.example.com/jobs/1',
      start: { dateTime: '2026-10-14T19:00:00.000Z', timeZone: 'America/Chicago' },
      end: { dateTime: '2026-10-14T20:00:00.000Z', timeZone: 'America/Chicago' },
      transparency: 'opaque',
      extendedProperties: { private: { roofline: 'appointment' } },
    });
    expect(result).toEqual({ id: 'evt1', etag: '"etag-1"' });
  });

  it('creates an all-day event as calendar dates with an exclusive end', async () => {
    const fetchImpl = calendarFixtureFetch({ [`POST ${EVENTS_PATH}`]: { fixture: 'event-insert' } });
    await newApi(fetchImpl).createEvent(
      ACCESS_TOKEN,
      CALENDAR,
      timedEvent({
        allDay: true,
        start: new Date('2026-10-15T05:00:00.000Z'),
        end: new Date('2026-10-17T05:00:00.000Z'),
      }),
    );

    const body = fetchImpl.requests[0]?.json as { start: Record<string, unknown>; end: Record<string, unknown> };
    expect(body.start).toEqual({ date: '2026-10-15' });
    expect(body.end).toEqual({ date: '2026-10-17' });
    expect(body.start).not.toHaveProperty('dateTime');
    expect(body.end).not.toHaveProperty('dateTime');
  });

  it('patches an event with its etag in If-Match and returns the new etag', async () => {
    const fetchImpl = calendarFixtureFetch({ [`PATCH ${EVENTS_PATH}/evt1`]: { fixture: 'event-patch' } });
    const result = await newApi(fetchImpl).updateEvent(ACCESS_TOKEN, CALENDAR, 'evt1', '"etag-1"', timedEvent());

    const request = fetchImpl.requests[0];
    expect(request?.method).toBe('PATCH');
    expect(request?.url).toBe(`${EVENTS_PATH}/evt1`);
    expect(request?.headers.get('if-match')).toBe('"etag-1"');
    expect(result).toEqual({ etag: '"etag-2"' });
  });

  it('reports a stale etag as a conflict', async () => {
    const fetchImpl = calendarFixtureFetch({ [`PATCH ${EVENTS_PATH}/evt1`]: { status: 412 } });
    const result = await newApi(fetchImpl).updateEvent(ACCESS_TOKEN, CALENDAR, 'evt1', '"etag-1"', timedEvent());

    expect(result).toBe('conflict');
  });

  it.each([404, 410])('reports a patch answered %i as gone', async (status) => {
    const fetchImpl = calendarFixtureFetch({ [`PATCH ${EVENTS_PATH}/evt1`]: { status } });
    const result = await newApi(fetchImpl).updateEvent(ACCESS_TOKEN, CALENDAR, 'evt1', '"etag-1"', timedEvent());

    expect(result).toBe('gone');
  });

  it('deletes an event and treats a missing event as already deleted', async () => {
    const api = newApi(
      calendarFixtureFetch({ [`DELETE ${EVENTS_PATH}/evt1`]: { status: 204 } }),
    );
    await expect(api.deleteEvent(ACCESS_TOKEN, CALENDAR, 'evt1')).resolves.toBeUndefined();

    for (const status of [404, 410]) {
      const gone = newApi(calendarFixtureFetch({ [`DELETE ${EVENTS_PATH}/evt1`]: { status } }));
      await expect(gone.deleteEvent(ACCESS_TOKEN, CALENDAR, 'evt1')).resolves.toBeUndefined();
    }
  });

  it('reads one event as dates and flags, and returns null when it is missing', async () => {
    const fetchImpl = calendarFixtureFetch({ [`GET ${EVENTS_PATH}/evt1`]: { fixture: 'event-get' } });
    const event = await newApi(fetchImpl).getEvent(ACCESS_TOKEN, CALENDAR, 'evt1');

    expect(event).toEqual({
      id: 'evt1',
      etag: '"etag-2"',
      start: new Date('2026-10-14T19:00:00.000Z'),
      end: new Date('2026-10-14T20:00:00.000Z'),
      allDay: false,
      updatedAt: new Date('2026-10-12T15:00:00.000Z'),
      cancelled: false,
      busy: true,
    });

    const missing = newApi(calendarFixtureFetch({ [`GET ${EVENTS_PATH}/evt1`]: { status: 404 } }));
    await expect(missing.getEvent(ACCESS_TOKEN, CALENDAR, 'evt1')).resolves.toBeNull();
  });

  it('runs a full sync across pages, then an incremental sync from the cursor', async () => {
    const fetchImpl = calendarFixtureFetch({
      [`GET ${EVENTS_PATH}`]: [{ fixture: 'events-sync-full', pages: true }, { fixture: 'events-sync-incremental' }],
    });
    const api = newApi(fetchImpl);

    const full = await api.syncEvents(ACCESS_TOKEN, CALENDAR, null, WINDOW);

    const [firstPage, secondPage] = fetchImpl.requests;
    expect(fetchImpl.requests).toHaveLength(2);
    const firstParams = new URL(firstPage?.url ?? '').searchParams;
    expect(firstParams.get('singleEvents')).toBe('true');
    expect(firstParams.get('showDeleted')).toBe('true');
    expect(firstParams.get('maxResults')).toBe('250');
    expect(firstParams.get('timeMin')).toBe(WINDOW.from.toISOString());
    expect(firstParams.get('timeMax')).toBe(WINDOW.to.toISOString());
    expect(firstParams.has('syncToken')).toBe(false);
    expect(firstParams.has('pageToken')).toBe(false);
    expect(new URL(secondPage?.url ?? '').searchParams.get('pageToken')).toBe('page-2');

    expect(full.fullResync).toBe(false);
    expect(full.nextCursor).toBe('sync-1');
    expect(full.events).toHaveLength(3);
    const byId = new Map(full.events.map((event) => [event.id, event]));
    expect(byId.get('evt3')?.cancelled).toBe(true);
    expect(byId.get('evt2')?.busy).toBe(false);
    expect(byId.get('evt2')?.cancelled).toBe(false);
    expect(byId.get('evt1')?.busy).toBe(true);
    expect(byId.get('evt1')?.updatedAt).toEqual(new Date('2026-10-12T15:00:00.000Z'));
    expect(byId.get('evt2')?.updatedAt).toEqual(new Date('2026-10-11T09:30:00.000Z'));

    const incremental = await api.syncEvents(ACCESS_TOKEN, CALENDAR, 'sync-1', WINDOW);

    const request = fetchImpl.requests[2];
    const params = new URL(request?.url ?? '').searchParams;
    expect(params.get('syncToken')).toBe('sync-1');
    expect(params.has('timeMin')).toBe(false);
    expect(incremental.fullResync).toBe(false);
    expect(incremental.nextCursor).toBe('sync-2');
    expect(incremental.events.map((event) => event.id)).toEqual(['evt2']);
  });

  it('restarts with a full sync when the cursor is gone (410)', async () => {
    const fetchImpl = calendarFixtureFetch({
      [`GET ${EVENTS_PATH}`]: [{ status: 410, fixture: 'events-sync-gone' }, { fixture: 'events-sync-full', pages: true }],
    });
    const page = await newApi(fetchImpl).syncEvents(ACCESS_TOKEN, CALENDAR, 'sync-expired', WINDOW);

    const [incremental, retry] = fetchImpl.requests;
    expect(new URL(incremental?.url ?? '').searchParams.get('syncToken')).toBe('sync-expired');

    const retryParams = new URL(retry?.url ?? '').searchParams;
    expect(retryParams.has('syncToken')).toBe(false);
    expect(retryParams.get('timeMin')).toBe(WINDOW.from.toISOString());
    expect(retryParams.get('timeMax')).toBe(WINDOW.to.toISOString());

    expect(page.fullResync).toBe(true);
    expect(page.nextCursor).toBe('sync-1');
    expect(page.events.map((event) => event.id)).toEqual(['evt1', 'evt2', 'evt3']);
  });

  it('maps a 503 to an unavailable error that carries no token', async () => {
    const fetchImpl = calendarFixtureFetch({ [`GET ${CALENDAR_LIST_URL}`]: { status: 503, body: { error: { message: ACCESS_TOKEN } } } });
    const error = await rejectionOf(newApi(fetchImpl).listCalendars(ACCESS_TOKEN));

    expect(error).toBeInstanceOf(CalendarUnavailableError);
    expect((error as Error).message).toBe(UNAVAILABLE);
    expect((error as Error).message).not.toContain(ACCESS_TOKEN);
    expect((error as Error).message).not.toContain(REFRESH_TOKEN);
  });

  it('maps a network failure to an unavailable error that carries no token', async () => {
    const failing = Object.assign(
      async () => {
        throw new TypeError(`socket hang up ${ACCESS_TOKEN} ${REFRESH_TOKEN}`);
      },
      { requests: [] },
    ) as unknown as typeof fetch;
    const error = await rejectionOf(newApi(failing).listCalendars(ACCESS_TOKEN));

    expect(error).toBeInstanceOf(CalendarUnavailableError);
    expect((error as Error).message).toBe(UNAVAILABLE);
    expect((error as Error).message).not.toContain(ACCESS_TOKEN);
  });

  it('maps a 403 to an auth error', async () => {
    const fetchImpl = calendarFixtureFetch({ [`GET ${CALENDAR_LIST_URL}`]: { status: 403 } });
    const error = await rejectionOf(newApi(fetchImpl).listCalendars(ACCESS_TOKEN));

    expect(error).toBeInstanceOf(CalendarAuthError);
    expect((error as Error).message).toBe('Reconnect your calendar.');
  });

  it('maps a rate-limit 403 to unavailable, not a reconnect', async () => {
    const fetchImpl = calendarFixtureFetch({ [`GET ${CALENDAR_LIST_URL}`]: { status: 403, fixture: 'rate-limited-403' } });
    const error = await rejectionOf(newApi(fetchImpl).listCalendars(ACCESS_TOKEN));

    expect(error).toBeInstanceOf(CalendarUnavailableError);
    expect((error as Error).message).toBe(UNAVAILABLE);
  });

  it('maps a RESOURCE_EXHAUSTED 403 to unavailable', async () => {
    const body = { error: { code: 403, status: 'RESOURCE_EXHAUSTED' } };
    const fetchImpl = calendarFixtureFetch({ [`GET ${CALENDAR_LIST_URL}`]: { status: 403, body } });
    const error = await rejectionOf(newApi(fetchImpl).listCalendars(ACCESS_TOKEN));

    expect(error).toBeInstanceOf(CalendarUnavailableError);
  });

  it('keeps a permission 403 as an auth error', async () => {
    const body = { error: { code: 403, errors: [{ domain: 'global', reason: 'insufficientPermissions' }] } };
    const fetchImpl = calendarFixtureFetch({ [`GET ${CALENDAR_LIST_URL}`]: { status: 403, body } });
    const error = await rejectionOf(newApi(fetchImpl).listCalendars(ACCESS_TOKEN));

    expect(error).toBeInstanceOf(CalendarAuthError);
    expect((error as Error).message).toBe('Reconnect your calendar.');
  });

  it('maps a 200 that is not JSON to unavailable', async () => {
    const fetchImpl = vi.fn(async () => new Response('<html>oops</html>', { status: 200 })) as unknown as typeof fetch;
    const error = await rejectionOf(newApi(fetchImpl).listCalendars(ACCESS_TOKEN));

    expect(error).toBeInstanceOf(CalendarUnavailableError);
  });

  it('is configured only when both Google client settings are present', () => {
    expect(googleCalendarFor({ GOOGLE_CLIENT_ID: 'cid' } as Config)).toBeNull();
    expect(googleCalendarFor({ GOOGLE_CLIENT_SECRET: 'secret' } as Config)).toBeNull();

    const api = googleCalendarFor({ GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'secret' } as Config);
    expect(api).toBeInstanceOf(GoogleCalendarApi);
    expect(api?.provider).toBe('google');
    expect(api?.configured).toBe(true);
  });
});
