import { localDate } from '@roofline/shared';
import type { Config } from '../config.ts';
import {
  type CalendarApi,
  CalendarAuthError,
  CalendarUnavailableError,
  type ExternalCalendar,
  type ExternalEvent,
  type ExternalEventInput,
  type OAuthTokens,
  type SyncPage,
} from './calendar.ts';

const AUTH = 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize';
const TOKEN = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';
const GRAPH = 'https://graph.microsoft.com/v1.0';

export const MICROSOFT_CALENDAR_SCOPES = ['offline_access', 'User.Read', 'Calendars.ReadWrite'];
/** The extended property that marks an event as created by Roofline. */
export const ROOFLINE_EVENT_PROPERTY_ID = 'String {66f5a359-4659-4830-9070-00047ec6ac6e} Name RooflineAppointment';

const DEFAULT_TIMEOUT_MS = 10000;
const MAX_SYNC_PAGES = 100;
const UNAVAILABLE_MESSAGE = "Couldn't reach Outlook.";
const RECONNECT_MESSAGE = 'Reconnect your calendar.';
const SCOPE_TEXT = MICROSOFT_CALENDAR_SCOPES.join(' ');
const FORM_HEADERS: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded' };
const JSON_HEADERS: Record<string, string> = { 'Content-Type': 'application/json' };
const SYNC_HEADERS: Record<string, string> = { Prefer: 'odata.maxpagesize=200, outlook.timezone="UTC"' };
const UTC_HEADERS: Record<string, string> = { Prefer: 'outlook.timezone="UTC"' };

type JsonRecord = Record<string, unknown>;
type GraphDateTime = { dateTime: string; timeZone: string };
type GraphEventBody = {
  subject: string;
  body: { contentType: 'text'; content: string };
  location: { displayName: string };
  isAllDay: boolean;
  start: GraphDateTime;
  end: GraphDateTime;
  showAs: 'busy';
};
type SyncRun = { resync: true } | { resync: false; events: ExternalEvent[]; nextCursor: string };

function unavailable(): CalendarUnavailableError {
  return new CalendarUnavailableError(UNAVAILABLE_MESSAGE);
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown): JsonRecord {
  if (!isRecord(value)) throw unavailable();
  return value;
}

function requireString(o: JsonRecord, key: string): string {
  const value = o[key];
  if (typeof value !== 'string' || value === '') throw unavailable();
  return value;
}

function requireNumber(o: JsonRecord, key: string): number {
  const value = o[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) throw unavailable();
  return value;
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function listOf(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw unavailable();
  return value as unknown[];
}

function bearer(accessToken: string): Record<string, string> {
  return { Authorization: `Bearer ${accessToken}` };
}

/** Throws the reconnect error on 401/403 and the unavailable error on anything else not in `handled`. */
function ensureOk(res: Response, handled: readonly number[] = []): void {
  if (res.ok || handled.includes(res.status)) return;
  if (res.status === 401 || res.status === 403) throw new CalendarAuthError(RECONNECT_MESSAGE);
  throw unavailable();
}

/** The JSON body, or undefined when it is not JSON. Never throws. */
async function tryJson(res: Response): Promise<unknown> {
  try {
    const json: unknown = await res.json();
    return json;
  } catch {
    return undefined;
  }
}

async function readJson(res: Response): Promise<unknown> {
  const body = await tryJson(res);
  if (body === undefined) throw unavailable();
  return body;
}

function graphErrorCode(body: unknown): string | null {
  if (!isRecord(body)) return null;
  const error = body.error;
  if (!isRecord(error)) return null;
  return typeof error.code === 'string' ? error.code : null;
}

function scopesOf(value: unknown): string[] {
  const parts = typeof value === 'string' ? value.split(' ').filter((s) => s !== '') : [];
  return parts.length > 0 ? parts : [...MICROSOFT_CALENDAR_SCOPES];
}

/** Graph returns UTC wall time without an offset when Prefer outlook.timezone="UTC" is sent. */
function parseGraphDate(value: unknown): Date {
  const dateTime = requireString(requireRecord(value), 'dateTime');
  const text = /(Z|[+-]\d{2}:?\d{2})$/.test(dateTime) ? dateTime : `${dateTime}Z`;
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) throw unavailable();
  return date;
}

function mapEvent(item: unknown): ExternalEvent {
  const e = requireRecord(item);
  const id = requireString(e, 'id');
  if ('@removed' in e) {
    return {
      id,
      etag: null,
      start: new Date(0),
      end: new Date(0),
      allDay: false,
      updatedAt: new Date(),
      cancelled: true,
      busy: false,
    };
  }
  const modified = typeof e.lastModifiedDateTime === 'string' ? new Date(e.lastModifiedDateTime) : null;
  return {
    id,
    etag: optionalString(e['@odata.etag']),
    start: parseGraphDate(e.start),
    end: parseGraphDate(e.end),
    allDay: e.isAllDay === true,
    updatedAt: modified !== null && !Number.isNaN(modified.getTime()) ? modified : new Date(),
    cancelled: e.isCancelled === true,
    busy: e.showAs !== 'free',
  };
}

function utcWallTime(instant: Date): GraphDateTime {
  return { dateTime: instant.toISOString().slice(0, -1), timeZone: 'UTC' };
}

function nextDay(day: string): string {
  const next = new Date(Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)) + 1));
  return next.toISOString().slice(0, 10);
}

function allDayRange(e: ExternalEventInput): { start: GraphDateTime; end: GraphDateTime } {
  const startDay = localDate(e.start, e.timeZone);
  const endDay = localDate(e.end, e.timeZone);
  const lastDay = endDay > startDay ? endDay : nextDay(startDay);
  return {
    start: { dateTime: `${startDay}T00:00:00`, timeZone: e.timeZone },
    end: { dateTime: `${lastDay}T00:00:00`, timeZone: e.timeZone },
  };
}

export class MicrosoftCalendarApi implements CalendarApi {
  readonly provider = 'microsoft' as const;
  readonly configured = true;

  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: (input: string, init: RequestInit) => Promise<Response>;

  constructor(o: { clientId: string; clientSecret: string; fetch?: typeof fetch; timeoutMs?: number }) {
    this.clientId = o.clientId;
    this.clientSecret = o.clientSecret;
    this.timeoutMs = o.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    // Called as a plain function, so an injected fake and the native fetch both work.
    const impl = o.fetch ?? globalThis.fetch;
    this.fetchFn = (input, init) => impl(input, init);
  }

  authUrl(i: { state: string; redirectUri: string }): string {
    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: i.redirectUri,
      response_type: 'code',
      response_mode: 'query',
      scope: SCOPE_TEXT,
      state: i.state,
      prompt: 'select_account',
    });
    return `${AUTH}?${params.toString()}`;
  }

  async exchangeCode(i: { code: string; redirectUri: string }): Promise<OAuthTokens> {
    const token = await this.tokenRequest({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      grant_type: 'authorization_code',
      code: i.code,
      redirect_uri: i.redirectUri,
      scope: SCOPE_TEXT,
    });
    const accessToken = requireString(token, 'access_token');
    const refreshToken = requireString(token, 'refresh_token');
    const expiresIn = requireNumber(token, 'expires_in');
    const accountEmail = await this.accountEmail(accessToken);
    return {
      refreshToken,
      accessToken,
      expiresAt: new Date(Date.now() + expiresIn * 1000),
      scopes: scopesOf(token.scope),
      accountEmail,
    };
  }

  async refresh(refreshToken: string): Promise<{ accessToken: string; expiresAt: Date; refreshToken?: string }> {
    const token = await this.tokenRequest({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      scope: SCOPE_TEXT,
    });
    const accessToken = requireString(token, 'access_token');
    const expiresAt = new Date(Date.now() + requireNumber(token, 'expires_in') * 1000);
    const rotated = optionalString(token.refresh_token);
    return rotated === null ? { accessToken, expiresAt } : { accessToken, expiresAt, refreshToken: rotated };
  }

  async listCalendars(accessToken: string): Promise<ExternalCalendar[]> {
    const calendars: ExternalCalendar[] = [];
    let url: string | null = `${GRAPH}/me/calendars?$select=id,name,isDefaultCalendar,canEdit`;
    while (url !== null) {
      const page = await this.getGraph(url, accessToken);
      for (const item of listOf(page.value)) {
        const c = requireRecord(item);
        calendars.push({
          id: requireString(c, 'id'),
          name: optionalString(c.name) ?? '',
          primary: c.isDefaultCalendar === true,
          canWrite: c.canEdit === true,
        });
      }
      url = optionalString(page['@odata.nextLink']);
    }
    return calendars;
  }

  async createEvent(
    accessToken: string,
    calendarId: string,
    e: ExternalEventInput,
  ): Promise<{ id: string; etag: string | null }> {
    const body = {
      ...this.eventBody(e),
      singleValueExtendedProperties: [{ id: ROOFLINE_EVENT_PROPERTY_ID, value: 'appointment' }],
    };
    const res = await this.send(
      `${GRAPH}/me/calendars/${encodeURIComponent(calendarId)}/events`,
      'POST',
      { ...bearer(accessToken), ...JSON_HEADERS },
      JSON.stringify(body),
    );
    ensureOk(res);
    const created = requireRecord(await readJson(res));
    return { id: requireString(created, 'id'), etag: optionalString(created['@odata.etag']) };
  }

  async updateEvent(
    accessToken: string,
    _calendarId: string,
    eventId: string,
    etag: string | null,
    e: ExternalEventInput,
  ): Promise<{ etag: string | null } | 'gone' | 'conflict'> {
    const headers: Record<string, string> = { ...bearer(accessToken), ...JSON_HEADERS };
    if (etag !== null) headers['If-Match'] = etag;
    const res = await this.send(
      `${GRAPH}/me/events/${encodeURIComponent(eventId)}`,
      'PATCH',
      headers,
      JSON.stringify(this.eventBody(e)),
    );
    if (res.status === 412) return 'conflict';
    if (res.status === 404 || res.status === 410) return 'gone';
    ensureOk(res);
    const updated = requireRecord(await readJson(res));
    return { etag: optionalString(updated['@odata.etag']) };
  }

  async deleteEvent(accessToken: string, _calendarId: string, eventId: string): Promise<void> {
    const res = await this.send(`${GRAPH}/me/events/${encodeURIComponent(eventId)}`, 'DELETE', bearer(accessToken));
    ensureOk(res, [404, 410]);
  }

  async getEvent(accessToken: string, _calendarId: string, eventId: string): Promise<ExternalEvent | null> {
    const url =
      `${GRAPH}/me/events/${encodeURIComponent(eventId)}` +
      '?$select=id,subject,start,end,isAllDay,isCancelled,showAs,lastModifiedDateTime';
    const res = await this.send(url, 'GET', { ...bearer(accessToken), ...UTC_HEADERS });
    if (res.status === 404 || res.status === 410) return null;
    ensureOk(res);
    return mapEvent(await readJson(res));
  }

  async syncEvents(
    accessToken: string,
    calendarId: string,
    cursor: string | null,
    window: { from: Date; to: Date },
  ): Promise<SyncPage> {
    const fullUrl =
      `${GRAPH}/me/calendars/${encodeURIComponent(calendarId)}/calendarView/delta` +
      `?startDateTime=${encodeURIComponent(window.from.toISOString())}` +
      `&endDateTime=${encodeURIComponent(window.to.toISOString())}`;

    if (cursor !== null) {
      const incremental = await this.collectSync(accessToken, cursor, true);
      if (!incremental.resync) {
        return { events: incremental.events, nextCursor: incremental.nextCursor, fullResync: false };
      }
    }
    const full = await this.collectSync(accessToken, fullUrl, false);
    if (full.resync) throw unavailable();
    return { events: full.events, nextCursor: full.nextCursor, fullResync: cursor !== null };
  }

  /** Follows one delta run to its delta link. An incremental run that the server rejects asks for a resync. */
  private async collectSync(accessToken: string, startUrl: string, incremental: boolean): Promise<SyncRun> {
    const events: ExternalEvent[] = [];
    let url = startUrl;
    for (let pages = 1; ; pages += 1) {
      if (pages > MAX_SYNC_PAGES) throw unavailable();
      const res = await this.send(url, 'GET', { ...bearer(accessToken), ...SYNC_HEADERS });
      const body = await tryJson(res);
      if (res.status === 410 || graphErrorCode(body) === 'syncStateNotFound') {
        if (incremental) return { resync: true };
        throw unavailable();
      }
      ensureOk(res);
      const page = requireRecord(body);
      for (const item of listOf(page.value)) events.push(mapEvent(item));
      const next = optionalString(page['@odata.nextLink']);
      if (next !== null) {
        url = next;
        continue;
      }
      const delta = optionalString(page['@odata.deltaLink']);
      if (delta === null) throw unavailable();
      return { resync: false, events, nextCursor: delta };
    }
  }

  private eventBody(e: ExternalEventInput): GraphEventBody {
    const range = e.allDay ? allDayRange(e) : { start: utcWallTime(e.start), end: utcWallTime(e.end) };
    return {
      subject: e.title,
      body: { contentType: 'text', content: e.description },
      location: { displayName: e.location ?? '' },
      isAllDay: e.allDay,
      start: range.start,
      end: range.end,
      showAs: 'busy',
    };
  }

  private async accountEmail(accessToken: string): Promise<string> {
    const me = await this.getGraph(`${GRAPH}/me`, accessToken);
    const email = optionalString(me.mail) ?? optionalString(me.userPrincipalName);
    if (email === null) throw unavailable();
    return email;
  }

  private async getGraph(url: string, accessToken: string): Promise<JsonRecord> {
    const res = await this.send(url, 'GET', bearer(accessToken));
    ensureOk(res);
    return requireRecord(await readJson(res));
  }

  /** The token endpoint: only a revoked grant (invalid_grant, interaction_required) is a reconnect; anything else that fails is unavailable. */
  private async tokenRequest(params: Record<string, string>): Promise<JsonRecord> {
    const res = await this.send(TOKEN, 'POST', FORM_HEADERS, new URLSearchParams(params).toString());
    const body = await tryJson(res);
    if (!res.ok) {
      const code = isRecord(body) && typeof body.error === 'string' ? body.error : null;
      if (code === 'invalid_grant' || code === 'interaction_required') {
        throw new CalendarAuthError(RECONNECT_MESSAGE);
      }
    }
    // Any other token-endpoint failure (invalid_client, unauthorized_client, 5xx, non-JSON) is not a dead grant.
    if (!res.ok) throw unavailable();
    return requireRecord(body);
  }

  /** One HTTP call with the request timeout. A network error, an abort or a timeout becomes the unavailable error. */
  private async send(url: string, method: string, headers: Record<string, string>, body?: string): Promise<Response> {
    const init: RequestInit = { method, headers, signal: AbortSignal.timeout(this.timeoutMs) };
    if (body !== undefined) init.body = body;
    try {
      return await this.fetchFn(url, init);
    } catch {
      throw unavailable();
    }
  }
}

export function microsoftCalendarFor(config: Config): CalendarApi | null {
  const clientId = config.MICROSOFT_CLIENT_ID;
  const clientSecret = config.MICROSOFT_CLIENT_SECRET;
  return clientId && clientSecret ? new MicrosoftCalendarApi({ clientId, clientSecret }) : null;
}
