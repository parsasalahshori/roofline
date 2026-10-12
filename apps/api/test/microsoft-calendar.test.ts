import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { loadConfig } from '../src/config.ts';
import {
  MicrosoftCalendarApi,
  MICROSOFT_CALENDAR_SCOPES,
  ROOFLINE_EVENT_PROPERTY_ID,
  microsoftCalendarFor,
} from '../src/providers/microsoft-calendar.ts';
import { CalendarAuthError, CalendarUnavailableError, type ExternalEventInput } from '../src/providers/calendar.ts';

/*
 * The Microsoft Graph adapter, against recorded JSON. Nothing here reaches the network: every test hands
 * the adapter its own `fetch`, so a request nobody answered fails as a test bug, not a call to Microsoft.
 */

const fixture = (name: string): string => readFileSync(new URL(`./fixtures/microsoft-calendar/${name}.json`, import.meta.url), 'utf8');

const TOKEN_EXCHANGE = fixture('token-exchange');
const TOKEN_REFRESH = fixture('token-refresh');
const TOKEN_INVALID_GRANT = fixture('token-invalid-grant');
const ME = fixture('me');
const CALENDARS = fixture('calendars');
const EVENT_CREATE = fixture('event-create');
const EVENT_PATCH = fixture('event-patch');
const EVENT_GET = fixture('event-get');
const DELTA_FULL = fixture('delta-full');
const DELTA_INCREMENTAL = fixture('delta-incremental');
const DELTA_GONE = fixture('delta-gone');

const FULL_PAGES = (JSON.parse(DELTA_FULL) as { pages: unknown[] }).pages;
const PAGE1_NEXT_LINK = 'https://graph.microsoft.com/v1.0/me/calendars/cal-default/calendarView/delta?$skiptoken=page2';
const DELTA_1 = 'https://graph.microsoft.com/v1.0/me/calendars/cal-default/calendarView/delta?$deltatoken=delta-1';

const WINDOW = { from: new Date('2030-01-01T00:00:00Z'), to: new Date('2030-03-02T00:00:00Z') };

const VALID = {
  NODE_ENV: 'production',
  APP_ORIGIN: 'https://app.roofline.test',
  DATABASE_URL_TENANT: 'postgres://app_tenant:pw@localhost:5432/roofline',
  DATABASE_URL_SYSTEM: 'postgres://app_system:pw@localhost:5432/roofline',
  ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64'),
  PUBLIC_BASE_URL: 'https://app.roofline.test',
} satisfies Record<string, string>;

type Call = { url: string; method: string; headers: Record<string, string>; body: string | undefined };
type Responder = (url: string, init: RequestInit | undefined) => Response | Promise<Response>;
type Answer = { status?: number; body?: unknown } | { throws: Error } | Responder;

/** A `fetch` that answers requests in order and records each one. Running out of answers is a test bug. */
function makeFetch(answers: Answer[]): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  let next = 0;
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({
      url,
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === 'string' ? init.body : undefined,
    });
    const answer = answers[next];
    next += 1;
    if (answer === undefined) throw new Error(`test bug: no fetch answer for ${url}`);
    if (typeof answer === 'function') return answer(url, init);
    if ('throws' in answer) throw answer.throws;
    const text = typeof answer.body === 'string' ? answer.body : answer.body === undefined ? '' : JSON.stringify(answer.body);
    // An empty body is null, so a 204 is a legal response.
    return new Response(text === '' ? null : text, { status: answer.status ?? 200 });
  }) as typeof fetch;
  return { fetch: fn, calls };
}

function makeApi(answers: Answer[], timeoutMs?: number) {
  const { fetch, calls } = makeFetch(answers);
  const api = new MicrosoftCalendarApi({ clientId: 'cid', clientSecret: 'csecret', fetch, ...(timeoutMs === undefined ? {} : { timeoutMs }) });
  return { api, calls };
}

/** The rejection reason of a promise that must reject. */
async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error('expected the call to reject');
}

const ROOFLINE_INPUT: ExternalEventInput = {
  title: 'Inspection - Dana Lee',
  location: '12 Oak St',
  description: 'Roofline link',
  start: new Date('2030-01-10T16:00:00Z'),
  end: new Date('2030-01-10T17:00:00Z'),
  allDay: false,
  timeZone: 'America/Chicago',
};

function allDayInput(start: Date, end: Date): ExternalEventInput {
  return { ...ROOFLINE_INPUT, title: 'Install - Dana Lee', location: null, description: 'Roofline link', start, end, allDay: true, timeZone: 'America/Chicago' };
}

describe('OAuth', () => {
  test('authUrl carries the oauth params', () => {
    const { api } = makeApi([]);
    const raw = api.authUrl({ state: 'state-1', redirectUri: 'https://app.roofline.test/callback' });
    expect(raw.startsWith('https://login.microsoftonline.com/common/oauth2/v2.0/authorize?')).toBe(true);
    const url = new URL(raw);
    expect(url.searchParams.get('client_id')).toBe('cid');
    expect(url.searchParams.get('redirect_uri')).toBe('https://app.roofline.test/callback');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('response_mode')).toBe('query');
    expect(url.searchParams.get('scope')).toBe('offline_access User.Read Calendars.ReadWrite');
    expect(url.searchParams.get('scope')).toBe(MICROSOFT_CALENDAR_SCOPES.join(' '));
    expect(url.searchParams.get('state')).toBe('state-1');
    expect(url.searchParams.get('prompt')).toBe('select_account');
    expect(MICROSOFT_CALENDAR_SCOPES).toEqual(['offline_access', 'User.Read', 'Calendars.ReadWrite']);
  });

  test('exchangeCode posts the form then reads /me', async () => {
    const { api, calls } = makeApi([{ body: TOKEN_EXCHANGE }, { body: ME }]);
    const before = Date.now();
    const tokens = await api.exchangeCode({ code: 'auth-code-1', redirectUri: 'https://app.roofline.test/callback' });

    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.url).toBe('https://login.microsoftonline.com/common/oauth2/v2.0/token');
    expect(calls[0]?.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    const form = new URLSearchParams(calls[0]?.body ?? '');
    expect(form.get('grant_type')).toBe('authorization_code');
    expect(form.get('code')).toBe('auth-code-1');
    expect(form.get('redirect_uri')).toBe('https://app.roofline.test/callback');
    expect(form.get('client_id')).toBe('cid');
    expect(form.get('client_secret')).toBe('csecret');

    expect(calls[1]?.method).toBe('GET');
    expect(calls[1]?.url).toBe('https://graph.microsoft.com/v1.0/me');
    expect(calls[1]?.headers.Authorization).toBe('Bearer ms-access-1');

    expect(tokens.refreshToken).toBe('ms-refresh-1');
    expect(tokens.accessToken).toBe('ms-access-1');
    expect(tokens.accountEmail).toBe('pat@contoso.test');
    expect(tokens.scopes).toEqual(['offline_access', 'User.Read', 'Calendars.ReadWrite']);
    expect(Math.abs(tokens.expiresAt.getTime() - (before + 3599000))).toBeLessThan(5000);
  });

  test('accountEmail falls back to userPrincipalName when mail is null', async () => {
    const me = { ...(JSON.parse(ME) as Record<string, unknown>), mail: null };
    const { api } = makeApi([{ body: TOKEN_EXCHANGE }, { body: me }]);
    const tokens = await api.exchangeCode({ code: 'auth-code-1', redirectUri: 'https://app.roofline.test/callback' });
    expect(tokens.accountEmail).toBe('pat@contoso.onmicrosoft.test');
  });

  test('refresh posts the refresh_token grant', async () => {
    const { api, calls } = makeApi([{ body: TOKEN_REFRESH }]);
    const result = await api.refresh('ms-refresh-1');

    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.url).toBe('https://login.microsoftonline.com/common/oauth2/v2.0/token');
    const form = new URLSearchParams(calls[0]?.body ?? '');
    expect(form.get('grant_type')).toBe('refresh_token');
    expect(form.get('refresh_token')).toBe('ms-refresh-1');
    expect(form.get('client_id')).toBe('cid');
    expect(form.get('client_secret')).toBe('csecret');

    expect(result.accessToken).toBe('ms-access-2');
    expect(result.refreshToken).toBe('ms-refresh-2');
    expect(result.expiresAt).toBeInstanceOf(Date);
  });

  test('refresh without a new refresh_token leaves refreshToken undefined', async () => {
    const noRotation = { token_type: 'Bearer', expires_in: 3599, access_token: 'ms-access-3' };
    const { api } = makeApi([{ body: noRotation }]);
    const result = await api.refresh('ms-refresh-1');
    expect(result.accessToken).toBe('ms-access-3');
    expect(result.refreshToken).toBeUndefined();
  });

  test('invalid_grant on refresh is an auth error that leaks no provider text', async () => {
    const { api } = makeApi([{ status: 400, body: TOKEN_INVALID_GRANT }]);
    const err = await rejection(api.refresh('ms-refresh-1'));
    expect(err).toBeInstanceOf(CalendarAuthError);
    expect(String((err as Error).message)).not.toContain('SECRET-DETAIL');
    expect(String((err as Error).message)).not.toContain('ms-refresh');
  });

  test('invalid_grant on exchangeCode is an auth error that leaks no provider text', async () => {
    const { api } = makeApi([{ status: 400, body: TOKEN_INVALID_GRANT }]);
    const err = await rejection(api.exchangeCode({ code: 'auth-code-1', redirectUri: 'https://app.roofline.test/callback' }));
    expect(err).toBeInstanceOf(CalendarAuthError);
    expect(String((err as Error).message)).not.toContain('SECRET-DETAIL');
    expect(String((err as Error).message)).not.toContain('ms-refresh');
  });
});

describe('calendars', () => {
  test('listCalendars maps the Graph shape', async () => {
    const { api, calls } = makeApi([{ body: CALENDARS }]);
    const calendars = await api.listCalendars('ms-access-1');
    expect(calls[0]?.url).toBe('https://graph.microsoft.com/v1.0/me/calendars?$select=id,name,isDefaultCalendar,canEdit');
    expect(calls[0]?.headers.Authorization).toBe('Bearer ms-access-1');
    expect(calendars).toEqual([
      { id: 'cal-default', name: 'Calendar', primary: true, canWrite: true },
      { id: 'cal-shared', name: 'Team board', primary: false, canWrite: false },
    ]);
  });
});

describe('events', () => {
  test('createEvent timed sends UTC times and the Roofline marker', async () => {
    const { api, calls } = makeApi([{ status: 201, body: EVENT_CREATE }]);
    const result = await api.createEvent('ms-access-1', 'cal-default', ROOFLINE_INPUT);

    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.url).toBe('https://graph.microsoft.com/v1.0/me/calendars/cal-default/events');
    expect(calls[0]?.headers.Authorization).toBe('Bearer ms-access-1');
    expect(JSON.parse(calls[0]?.body ?? 'null')).toEqual({
      subject: 'Inspection - Dana Lee',
      body: { contentType: 'text', content: 'Roofline link' },
      location: { displayName: '12 Oak St' },
      isAllDay: false,
      start: { dateTime: '2030-01-10T16:00:00.000', timeZone: 'UTC' },
      end: { dateTime: '2030-01-10T17:00:00.000', timeZone: 'UTC' },
      showAs: 'busy',
      singleValueExtendedProperties: [{ id: ROOFLINE_EVENT_PROPERTY_ID, value: 'appointment' }],
    });
    expect(result).toEqual({ id: 'evt-1', etag: 'W/"etag-1"' });
  });

  test('createEvent all-day sends local midnights in the company zone', async () => {
    const { api, calls } = makeApi([{ status: 201, body: EVENT_CREATE }]);
    await api.createEvent('ms-access-1', 'cal-default', allDayInput(new Date('2030-07-10T05:00:00Z'), new Date('2030-07-11T05:00:00Z')));
    const body = JSON.parse(calls[0]?.body ?? 'null') as Record<string, unknown>;
    expect(body.isAllDay).toBe(true);
    expect(body.start).toEqual({ dateTime: '2030-07-10T00:00:00', timeZone: 'America/Chicago' });
    expect(body.end).toEqual({ dateTime: '2030-07-11T00:00:00', timeZone: 'America/Chicago' });
    expect(body.showAs).toBe('busy');
  });

  test('createEvent all-day with end equal to start ends the next day', async () => {
    const { api, calls } = makeApi([{ status: 201, body: EVENT_CREATE }]);
    await api.createEvent('ms-access-1', 'cal-default', allDayInput(new Date('2030-07-10T05:00:00Z'), new Date('2030-07-10T05:00:00Z')));
    const body = JSON.parse(calls[0]?.body ?? 'null') as Record<string, unknown>;
    expect(body.start).toEqual({ dateTime: '2030-07-10T00:00:00', timeZone: 'America/Chicago' });
    expect(body.end).toEqual({ dateTime: '2030-07-11T00:00:00', timeZone: 'America/Chicago' });
  });

  test('createEvent all-day across the fall DST change keeps local midnights', async () => {
    const { api, calls } = makeApi([{ status: 201, body: EVENT_CREATE }]);
    await api.createEvent('ms-access-1', 'cal-default', allDayInput(new Date('2026-11-01T05:00:00Z'), new Date('2026-11-02T06:00:00Z')));
    const body = JSON.parse(calls[0]?.body ?? 'null') as Record<string, unknown>;
    expect(body.start).toEqual({ dateTime: '2026-11-01T00:00:00', timeZone: 'America/Chicago' });
    expect(body.end).toEqual({ dateTime: '2026-11-02T00:00:00', timeZone: 'America/Chicago' });
  });

  test('updateEvent sends If-Match and returns the new etag', async () => {
    const { api, calls } = makeApi([{ body: EVENT_PATCH }]);
    const result = await api.updateEvent('ms-access-1', 'cal-default', 'evt-1', 'W/"etag-1"', ROOFLINE_INPUT);

    expect(calls[0]?.method).toBe('PATCH');
    expect(calls[0]?.url).toBe('https://graph.microsoft.com/v1.0/me/events/evt-1');
    expect(calls[0]?.headers['If-Match']).toBe('W/"etag-1"');
    const body = JSON.parse(calls[0]?.body ?? 'null') as Record<string, unknown>;
    expect(body).not.toHaveProperty('singleValueExtendedProperties');
    expect(result).toEqual({ etag: 'W/"etag-2"' });
  });

  test('updateEvent with a null etag sends no If-Match header', async () => {
    const { api, calls } = makeApi([{ body: EVENT_PATCH }]);
    const result = await api.updateEvent('ms-access-1', 'cal-default', 'evt-1', null, ROOFLINE_INPUT);
    const names = Object.keys(calls[0]?.headers ?? {}).map((k) => k.toLowerCase());
    expect(names).not.toContain('if-match');
    expect(result).toEqual({ etag: 'W/"etag-2"' });
  });

  test('updateEvent maps 412 to conflict and 404 to gone', async () => {
    const { api } = makeApi([{ status: 412, body: { error: { code: 'ErrorItemNotFound' } } }, { status: 404, body: { error: { code: 'ErrorItemNotFound' } } }]);
    expect(await api.updateEvent('ms-access-1', 'cal-default', 'evt-1', 'W/"etag-1"', ROOFLINE_INPUT)).toBe('conflict');
    expect(await api.updateEvent('ms-access-1', 'cal-default', 'evt-1', 'W/"etag-1"', ROOFLINE_INPUT)).toBe('gone');
  });

  test('deleteEvent treats 204 and 404 as done and 503 as unavailable', async () => {
    const { api, calls } = makeApi([{ status: 204 }, { status: 404 }, { status: 503 }]);
    await expect(api.deleteEvent('ms-access-1', 'cal-default', 'evt-1')).resolves.toBeUndefined();
    expect(calls[0]?.method).toBe('DELETE');
    expect(calls[0]?.url).toBe('https://graph.microsoft.com/v1.0/me/events/evt-1');
    await expect(api.deleteEvent('ms-access-1', 'cal-default', 'evt-1')).resolves.toBeUndefined();
    await expect(api.deleteEvent('ms-access-1', 'cal-default', 'evt-1')).rejects.toBeInstanceOf(CalendarUnavailableError);
  });

  test('getEvent maps the event and returns null on 404', async () => {
    const { api } = makeApi([{ body: EVENT_GET }, { status: 404 }]);
    const event = await api.getEvent('ms-access-1', 'cal-default', 'evt-1');
    expect(event).toEqual({
      id: 'evt-1',
      etag: 'W/"etag-2"',
      start: new Date('2030-01-10T16:00:00Z'),
      end: new Date('2030-01-10T17:00:00Z'),
      allDay: false,
      updatedAt: new Date('2030-01-05T12:00:00Z'),
      cancelled: false,
      busy: true,
    });
    expect(await api.getEvent('ms-access-1', 'cal-default', 'evt-1')).toBeNull();
  });
});

describe('delta sync', () => {
  test('full sync follows nextLink and maps events', async () => {
    const { api, calls } = makeApi(FULL_PAGES.map((page) => ({ body: page })));
    const result = await api.syncEvents('ms-access-1', 'cal-default', null, WINDOW);

    const first = new URL(calls[0]?.url ?? '');
    expect(first.pathname.endsWith('/calendarView/delta')).toBe(true);
    expect(first.searchParams.get('startDateTime')).toBe('2030-01-01T00:00:00.000Z');
    expect(first.searchParams.get('endDateTime')).toBe('2030-03-02T00:00:00.000Z');
    expect(calls[0]?.headers.Authorization).toBe('Bearer ms-access-1');
    expect(calls[0]?.headers.Prefer).toContain('odata.maxpagesize=200');
    expect(calls[1]?.url).toBe(PAGE1_NEXT_LINK);
    expect(calls[1]?.headers.Prefer).toContain('odata.maxpagesize=200');

    expect(result.fullResync).toBe(false);
    expect(result.nextCursor).toBe(DELTA_1);
    expect(result.nextCursor.endsWith('$deltatoken=delta-1')).toBe(true);
    expect(result.events.map((e) => e.id)).toEqual(['e-timed', 'e-free', 'e-allday', 'e-cancelled']);

    const [timed, free, allDay, cancelled] = result.events;
    expect(timed).toEqual({
      id: 'e-timed',
      etag: 'W/"a1"',
      start: new Date('2030-01-10T16:00:00Z'),
      end: new Date('2030-01-10T17:00:00Z'),
      allDay: false,
      updatedAt: new Date('2030-01-05T12:00:00Z'),
      cancelled: false,
      busy: true,
    });
    expect(free?.busy).toBe(false);
    expect(allDay?.allDay).toBe(true);
    expect(cancelled?.cancelled).toBe(true);

    for (const event of result.events) expect(event).not.toHaveProperty('title');
    expect(JSON.stringify(result)).not.toContain('Private title');
  });

  test('incremental sync uses the stored delta link', async () => {
    const { api, calls } = makeApi([{ body: DELTA_INCREMENTAL }]);
    const result = await api.syncEvents('ms-access-1', 'cal-default', DELTA_1, WINDOW);

    const matching = calls.filter((c) => c.url === DELTA_1);
    expect(calls).toHaveLength(1);
    expect(matching).toHaveLength(1);
    expect(result.nextCursor.endsWith('$deltatoken=delta-2')).toBe(true);
    expect(result.fullResync).toBe(false);

    expect(result.events[0]).toMatchObject({
      id: 'e-timed',
      etag: 'W/"a2"',
      start: new Date('2030-01-10T17:00:00Z'),
    });
    expect(result.events[1]).toMatchObject({ id: 'e-free', cancelled: true, busy: false });
  });

  test('HTTP 410 restarts as a full sync', async () => {
    const { api, calls } = makeApi([{ status: 410, body: DELTA_GONE }, { body: FULL_PAGES[0] }, { body: FULL_PAGES[1] }]);
    const result = await api.syncEvents('ms-access-1', 'cal-default', DELTA_1, WINDOW);

    expect(calls[0]?.url).toBe(DELTA_1);
    expect(calls[1]?.url).toContain('/calendarView/delta?startDateTime=');
    expect(result.fullResync).toBe(true);
    expect(result.nextCursor.endsWith('$deltatoken=delta-1')).toBe(true);
    expect(result.events).toHaveLength(4);
  });

  test('syncStateNotFound with another status also restarts', async () => {
    const { api } = makeApi([{ status: 400, body: DELTA_GONE }, { body: FULL_PAGES[0] }, { body: FULL_PAGES[1] }]);
    const result = await api.syncEvents('ms-access-1', 'cal-default', DELTA_1, WINDOW);
    expect(result.fullResync).toBe(true);
    expect(result.events).toHaveLength(4);
  });

  test('a gone answer during a full sync is unavailable', async () => {
    const { api } = makeApi([{ status: 410, body: DELTA_GONE }]);
    await expect(api.syncEvents('ms-access-1', 'cal-default', null, WINDOW)).rejects.toBeInstanceOf(CalendarUnavailableError);
  });
});

describe('errors', () => {
  test('a 503 on listCalendars is unavailable and leaks neither token nor body', async () => {
    const { api } = makeApi([{ status: 503, body: '{"error":"secret-body"}' }]);
    const err = await rejection(api.listCalendars('secret-access-token'));
    expect(err).toBeInstanceOf(CalendarUnavailableError);
    expect((err as Error).message).toBe("Couldn't reach Outlook.");
    expect((err as Error).message).not.toContain('secret-access-token');
    expect((err as Error).message).not.toContain('secret-body');
  });

  test('a 429 on createEvent is unavailable', async () => {
    const { api } = makeApi([{ status: 429 }]);
    const err = await rejection(api.createEvent('ms-access-1', 'cal-default', ROOFLINE_INPUT));
    expect(err).toBeInstanceOf(CalendarUnavailableError);
    expect((err as Error).message).toBe("Couldn't reach Outlook.");
  });

  test('a network failure is unavailable', async () => {
    const { api } = makeApi([{ throws: new Error('network') }]);
    const err = await rejection(api.listCalendars('ms-access-1'));
    expect(err).toBeInstanceOf(CalendarUnavailableError);
    expect((err as Error).message).toBe("Couldn't reach Outlook.");
  });

  test('401 and 403 on listCalendars are auth errors', async () => {
    const { api } = makeApi([{ status: 401 }, { status: 403 }]);
    await expect(api.listCalendars('ms-access-1')).rejects.toBeInstanceOf(CalendarAuthError);
    await expect(api.listCalendars('ms-access-1')).rejects.toBeInstanceOf(CalendarAuthError);
  });

  test('a fetch that never resolves times out as unavailable', async () => {
    const hang = (_url: string, init: RequestInit | undefined) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    const { api } = makeApi([hang], 20);
    await expect(api.listCalendars('ms-access-1')).rejects.toBeInstanceOf(CalendarUnavailableError);
  });
});

describe('microsoftCalendarFor', () => {
  test('returns an adapter when both Microsoft settings are present', () => {
    const config = loadConfig({ ...VALID, MICROSOFT_CLIENT_ID: 'x', MICROSOFT_CLIENT_SECRET: 'y' });
    const api = microsoftCalendarFor(config);
    expect(api).toBeInstanceOf(MicrosoftCalendarApi);
    expect(api?.provider).toBe('microsoft');
    expect(api?.configured).toBe(true);
  });

  test('returns null when neither Microsoft setting is present', () => {
    expect(microsoftCalendarFor(loadConfig(VALID))).toBeNull();
  });
});
