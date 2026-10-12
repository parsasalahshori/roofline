import { CalendarUnavailableError, type ExternalCalendar, type ExternalEvent, type ExternalEventInput, type SyncPage } from './calendar.ts';
import { GOOGLE_UNAVAILABLE_MESSAGE, type GoogleHttp, readJson } from './google-calendar-http.ts';

/** Calendar list, event CRUD and sync for Google. Every body is built here; tokens and event bodies never reach an error. */

const CALENDAR_API = 'https://www.googleapis.com/calendar/v3';
const SYNC_PAGE_SIZE = '250';

/** Wire shapes: only the fields we read. */
type RawCalendar = { id?: string; summary?: string; summaryOverride?: string; primary?: boolean; accessRole?: string };
type RawCalendarList = { items?: RawCalendar[]; nextPageToken?: string };
type RawTime = { date?: string; dateTime?: string };
type RawEvent = { id?: string; etag?: string; status?: string; transparency?: string; updated?: string; start?: RawTime; end?: RawTime };
type RawEventsPage = { items?: RawEvent[]; nextPageToken?: string; nextSyncToken?: string };
type EventTime = { dateTime: string; timeZone: string } | { date: string };
type EventBody = {
  summary: string;
  location?: string;
  description: string;
  transparency: 'opaque';
  extendedProperties: { private: { roofline: 'appointment' } };
  start: EventTime;
  end: EventTime;
};

function unavailable(): CalendarUnavailableError {
  return new CalendarUnavailableError(GOOGLE_UNAVAILABLE_MESSAGE);
}

function authHeaders(accessToken: string, json: boolean): Record<string, string> {
  const headers: Record<string, string> = { Authorization: `Bearer ${accessToken}` };
  if (json) headers['Content-Type'] = 'application/json';
  return headers;
}

function calendarPath(calendarId: string): string {
  return `${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}`;
}

function eventPath(calendarId: string, eventId: string): string {
  return `${calendarPath(calendarId)}/events/${encodeURIComponent(eventId)}`;
}

/** The calendar day (YYYY-MM-DD) of an instant in the given IANA zone. */
function dayOf(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(instant);
  const part = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

/** The day after a YYYY-MM-DD date, computed in UTC so no local zone is involved. */
function nextDay(ymd: string): string {
  const [y = 0, m = 1, d = 1] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

/** Timed events go out as instants with the company zone; all-day events as dates, end exclusive. */
function timesFor(e: ExternalEventInput): { start: EventTime; end: EventTime } {
  if (!e.allDay) {
    return {
      start: { dateTime: e.start.toISOString(), timeZone: e.timeZone },
      end: { dateTime: e.end.toISOString(), timeZone: e.timeZone },
    };
  }
  const startDate = dayOf(e.start, e.timeZone);
  const endDate = dayOf(e.end, e.timeZone);
  return {
    start: { date: startDate },
    end: { date: endDate > startDate ? endDate : nextDay(startDate) },
  };
}

function bodyFor(e: ExternalEventInput): EventBody {
  const times = timesFor(e);
  const body: EventBody = {
    summary: e.title,
    description: e.description,
    transparency: 'opaque',
    extendedProperties: { private: { roofline: 'appointment' } },
    start: times.start,
    end: times.end,
  };
  if (e.location !== null) body.location = e.location;
  return body;
}

/** Maps a Google event to ExternalEvent. Floating all-day dates are kept as UTC midnight. */
export function mapEvent(raw: RawEvent): ExternalEvent {
  const updatedAt = new Date(raw.updated ?? 0);
  return {
    id: raw.id ?? '',
    etag: raw.etag ?? null,
    start: instantOf(raw.start, updatedAt),
    end: instantOf(raw.end, updatedAt),
    allDay: raw.start?.date !== undefined && raw.start.dateTime === undefined,
    updatedAt,
    cancelled: raw.status === 'cancelled',
    busy: raw.transparency !== 'transparent',
  };
}

/** A timed value is its instant; a date-only value is UTC midnight; a cancelled event without times falls back to updatedAt. */
function instantOf(t: RawTime | undefined, fallback: Date): Date {
  if (t?.dateTime !== undefined) return new Date(t.dateTime);
  if (t?.date !== undefined) return new Date(`${t.date}T00:00:00.000Z`);
  return fallback;
}

export async function googleListCalendars(http: GoogleHttp, accessToken: string): Promise<ExternalCalendar[]> {
  const calendars: ExternalCalendar[] = [];
  let pageToken: string | undefined;
  do {
    const q = new URLSearchParams({ minAccessRole: 'writer' });
    if (pageToken !== undefined) q.set('pageToken', pageToken);
    const res = await http(`${CALENDAR_API}/users/me/calendarList?${q.toString()}`, { headers: authHeaders(accessToken, false) });
    if (res.status !== 200) throw unavailable();
    const json = (await readJson(res)) as RawCalendarList;
    for (const item of json.items ?? []) {
      if (item.id === undefined) continue;
      calendars.push({
        id: item.id,
        name: item.summaryOverride ?? item.summary ?? item.id,
        primary: item.primary === true,
        canWrite: item.accessRole === 'owner' || item.accessRole === 'writer',
      });
    }
    pageToken = json.nextPageToken;
  } while (pageToken !== undefined);
  return calendars;
}

export async function googleCreateEvent(http: GoogleHttp, accessToken: string, calendarId: string, e: ExternalEventInput): Promise<{ id: string; etag: string | null }> {
  const res = await http(`${calendarPath(calendarId)}/events`, {
    method: 'POST',
    headers: authHeaders(accessToken, true),
    body: JSON.stringify(bodyFor(e)),
  });
  if (res.status !== 200) throw unavailable();
  const json = (await readJson(res)) as RawEvent;
  return { id: json.id ?? '', etag: json.etag ?? null };
}

export async function googleUpdateEvent(
  http: GoogleHttp,
  accessToken: string,
  calendarId: string,
  eventId: string,
  etag: string | null,
  e: ExternalEventInput,
): Promise<{ etag: string | null } | 'gone' | 'conflict'> {
  const headers = authHeaders(accessToken, true);
  if (etag !== null) headers['If-Match'] = etag;
  const res = await http(eventPath(calendarId, eventId), { method: 'PATCH', headers, body: JSON.stringify(bodyFor(e)) });
  if (res.status === 412) return 'conflict';
  if (res.status === 404 || res.status === 410) return 'gone';
  if (res.status !== 200) throw unavailable();
  const json = (await readJson(res)) as RawEvent;
  return { etag: json.etag ?? null };
}

export async function googleDeleteEvent(http: GoogleHttp, accessToken: string, calendarId: string, eventId: string): Promise<void> {
  const res = await http(eventPath(calendarId, eventId), { method: 'DELETE', headers: authHeaders(accessToken, false) });
  if (res.status === 200 || res.status === 204 || res.status === 404 || res.status === 410) return;
  throw unavailable();
}

export async function googleGetEvent(http: GoogleHttp, accessToken: string, calendarId: string, eventId: string): Promise<ExternalEvent | null> {
  const res = await http(eventPath(calendarId, eventId), { headers: authHeaders(accessToken, false) });
  if (res.status === 404 || res.status === 410) return null;
  if (res.status !== 200) throw unavailable();
  return mapEvent((await readJson(res)) as RawEvent);
}

type CollectResult = { ok: true; events: ExternalEvent[]; nextSyncToken: string } | { ok: false };

/** Follows nextPageToken for one sync listing. A 410 answers ok: false; anything else unexpected is unavailable. */
async function collectPages(http: GoogleHttp, accessToken: string, calendarId: string, params: URLSearchParams): Promise<CollectResult> {
  const events: ExternalEvent[] = [];
  let pageToken: string | undefined;
  for (;;) {
    const q = new URLSearchParams(params);
    if (pageToken !== undefined) q.set('pageToken', pageToken);
    const res = await http(`${calendarPath(calendarId)}/events?${q.toString()}`, { headers: authHeaders(accessToken, false) });
    if (res.status === 410) return { ok: false };
    if (res.status !== 200) throw unavailable();
    const page = (await readJson(res)) as RawEventsPage;
    for (const item of page.items ?? []) events.push(mapEvent(item));
    if (page.nextPageToken !== undefined) {
      pageToken = page.nextPageToken;
      continue;
    }
    if (page.nextSyncToken === undefined) throw unavailable();
    return { ok: true, events, nextSyncToken: page.nextSyncToken };
  }
}

export async function googleSyncEvents(
  http: GoogleHttp,
  accessToken: string,
  calendarId: string,
  cursor: string | null,
  window: { from: Date; to: Date },
): Promise<SyncPage> {
  const base = { singleEvents: 'true', showDeleted: 'true', maxResults: SYNC_PAGE_SIZE };
  if (cursor !== null) {
    const incremental = await collectPages(http, accessToken, calendarId, new URLSearchParams({ ...base, syncToken: cursor }));
    if (incremental.ok) return { events: incremental.events, nextCursor: incremental.nextSyncToken, fullResync: false };
  }
  const full = await collectPages(
    http,
    accessToken,
    calendarId,
    new URLSearchParams({ ...base, timeMin: window.from.toISOString(), timeMax: window.to.toISOString() }),
  );
  if (!full.ok) throw unavailable();
  return { events: full.events, nextCursor: full.nextSyncToken, fullResync: cursor !== null };
}
