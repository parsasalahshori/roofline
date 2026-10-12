import { describe, expect, test } from 'vitest';
import { FakeCalendarApi } from '../src/providers/fakes/calendar.ts';
import { CalendarAuthError, CalendarUnavailableError, type ExternalEventInput } from '../src/providers/calendar.ts';

const window = { from: new Date('2030-01-01T00:00:00Z'), to: new Date('2030-03-01T00:00:00Z') };

function input(startIso = '2030-01-10T10:00:00Z', endIso = '2030-01-10T11:00:00Z'): ExternalEventInput {
  return {
    title: 'Job visit',
    location: null,
    description: '',
    start: new Date(startIso),
    end: new Date(endIso),
    allDay: false,
    timeZone: 'America/Chicago',
  };
}

describe('FakeCalendarApi', () => {
  test('auth url, code exchange and calendar list', async () => {
    const api = new FakeCalendarApi('google');
    expect(api.authUrl({ state: 's1', redirectUri: 'r' })).toBe('https://calendar.fake.test/google/auth?state=s1');
    const tokens = await api.exchangeCode({ code: 'a', redirectUri: 'r' });
    expect(tokens.refreshToken).toBe('refresh-a');
    expect(tokens.accountEmail).toBe('a@example.test');
    const calendars = await api.listCalendars(tokens.accessToken);
    expect(calendars).toEqual([{ id: 'primary', name: 'My calendar', primary: true, canWrite: true }]);
  });

  test('selfCallback points the auth url straight at the redirect uri', () => {
    const api = new FakeCalendarApi('google', { selfCallback: true });
    expect(api.authUrl({ state: 'a b', redirectUri: 'https://app.test/api/calendar/oauth/google/callback' })).toBe(
      'https://app.test/api/calendar/oauth/google/callback?code=fake&state=a%20b',
    );
  });

  test('create shows in a full sync; the fake reports its own write after a cursor', async () => {
    const api = new FakeCalendarApi('google');
    const tokens = await api.exchangeCode({ code: 'a', redirectUri: 'r' });
    const created = await api.createEvent(tokens.accessToken, 'primary', input());
    expect(created.etag).toBe('"1"');
    const first = await api.syncEvents(tokens.accessToken, 'primary', null, window);
    expect(first.fullResync).toBe(true);
    expect(first.events.map((e) => e.id)).toEqual([created.id]);
    expect(first.events[0]?.etag).toBe('"1"');

    const c1 = first.nextCursor;
    const updated = await api.updateEvent(tokens.accessToken, 'primary', created.id, '"1"', input('2030-01-11T10:00:00Z', '2030-01-11T11:00:00Z'));
    expect(updated).toEqual({ etag: '"2"' });
    const second = await api.syncEvents(tokens.accessToken, 'primary', c1, window);
    expect(second.fullResync).toBe(false);
    expect(second.events).toHaveLength(1);
    expect(second.events[0]?.id).toBe(created.id);
    expect(second.events[0]?.etag).toBe('"2"');
  });

  test('an external move shows in the next sync with a later updatedAt and the new start', async () => {
    const api = new FakeCalendarApi('google');
    const tokens = await api.exchangeCode({ code: 'a', redirectUri: 'r' });
    const created = await api.createEvent(tokens.accessToken, 'primary', input());
    const first = await api.syncEvents(tokens.accessToken, 'primary', null, window);
    const before = first.events[0]!.updatedAt.getTime();

    api.externalMove(created.id, new Date('2030-01-12T09:00:00Z'), new Date('2030-01-12T10:00:00Z'));
    const next = await api.syncEvents(tokens.accessToken, 'primary', first.nextCursor, window);
    expect(next.events).toHaveLength(1);
    expect(next.events[0]?.updatedAt.getTime()).toBeGreaterThan(before);
    expect(next.events[0]?.start.toISOString()).toBe('2030-01-12T09:00:00.000Z');
  });

  test('an external delete shows as cancelled', async () => {
    const api = new FakeCalendarApi('google');
    const tokens = await api.exchangeCode({ code: 'a', redirectUri: 'r' });
    const created = await api.createEvent(tokens.accessToken, 'primary', input());
    const first = await api.syncEvents(tokens.accessToken, 'primary', null, window);

    api.externalDelete(created.id);
    const next = await api.syncEvents(tokens.accessToken, 'primary', first.nextCursor, window);
    expect(next.events).toHaveLength(1);
    expect(next.events[0]?.cancelled).toBe(true);
  });

  test('expireCursor makes the next sync a full resync, and the one after incremental', async () => {
    const api = new FakeCalendarApi('google');
    const tokens = await api.exchangeCode({ code: 'a', redirectUri: 'r' });
    await api.createEvent(tokens.accessToken, 'primary', input());
    const first = await api.syncEvents(tokens.accessToken, 'primary', null, window);

    api.expireCursor();
    const expired = await api.syncEvents(tokens.accessToken, 'primary', first.nextCursor, window);
    expect(expired.fullResync).toBe(true);
    expect(expired.events).toHaveLength(1);

    const after = await api.syncEvents(tokens.accessToken, 'primary', expired.nextCursor, window);
    expect(after.fullResync).toBe(false);
  });

  test('a revoked grant makes later calls throw CalendarAuthError', async () => {
    const api = new FakeCalendarApi('google');
    const tokens = await api.exchangeCode({ code: 'a', redirectUri: 'r' });
    api.revoke(tokens.refreshToken);
    await expect(api.listCalendars(tokens.accessToken)).rejects.toBeInstanceOf(CalendarAuthError);
  });

  test('failNext makes the next calls throw CalendarUnavailableError, then recovers', async () => {
    const api = new FakeCalendarApi('google');
    const tokens = await api.exchangeCode({ code: 'a', redirectUri: 'r' });
    api.failNext(2);
    await expect(api.listCalendars(tokens.accessToken)).rejects.toBeInstanceOf(CalendarUnavailableError);
    await expect(api.listCalendars(tokens.accessToken)).rejects.toBeInstanceOf(CalendarUnavailableError);
    await expect(api.listCalendars(tokens.accessToken)).resolves.toHaveLength(1);
  });

  test('stale etags conflict, unknown ids are gone, and deleting an unknown id resolves', async () => {
    const api = new FakeCalendarApi('google');
    const tokens = await api.exchangeCode({ code: 'a', redirectUri: 'r' });
    const created = await api.createEvent(tokens.accessToken, 'primary', input());
    expect(await api.updateEvent(tokens.accessToken, 'primary', created.id, '"1"', input())).toEqual({ etag: '"2"' });
    expect(await api.updateEvent(tokens.accessToken, 'primary', created.id, '"1"', input())).toBe('conflict');
    expect(await api.updateEvent(tokens.accessToken, 'primary', 'evt-999', null, input())).toBe('gone');
    await expect(api.deleteEvent(tokens.accessToken, 'primary', 'evt-999')).resolves.toBeUndefined();
  });

  test('addOutsideEvent appears in a sync as busy', async () => {
    const api = new FakeCalendarApi('google');
    const tokens = await api.exchangeCode({ code: 'a', redirectUri: 'r' });
    const id = api.addOutsideEvent({ start: new Date('2030-01-15T14:00:00Z'), end: new Date('2030-01-15T15:00:00Z') });
    expect(id.startsWith('evt-')).toBe(true);
    const page = await api.syncEvents(tokens.accessToken, 'primary', null, window);
    const outside = page.events.find((e) => e.id === id);
    expect(outside?.busy).toBe(true);
    expect(outside?.allDay).toBe(false);
  });

  test('calls records the method names in order', async () => {
    const api = new FakeCalendarApi('google');
    api.authUrl({ state: 's', redirectUri: 'r' });
    const tokens = await api.exchangeCode({ code: 'a', redirectUri: 'r' });
    await api.listCalendars(tokens.accessToken);
    expect(api.calls.map((c) => c.method)).toEqual(['authUrl', 'exchangeCode', 'listCalendars']);
  });
});
