import type { Config } from '../config.ts';
import {
  CalendarAuthError,
  CalendarUnavailableError,
  type CalendarApi,
  type ExternalCalendar,
  type ExternalEvent,
  type ExternalEventInput,
  type OAuthTokens,
  type SyncPage,
} from './calendar.ts';
import {
  googleCreateEvent,
  googleDeleteEvent,
  googleGetEvent,
  googleListCalendars,
  googleSyncEvents,
  googleUpdateEvent,
} from './google-calendar-events.ts';
import {
  GOOGLE_RECONNECT_MESSAGE,
  GOOGLE_UNAVAILABLE_MESSAGE,
  makeGoogleHttp,
  readJson,
  type GoogleHttp,
} from './google-calendar-http.ts';

export const GOOGLE_CALENDAR_SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
];

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';
const FORM_CONTENT_TYPE = 'application/x-www-form-urlencoded';

function field(body: unknown, key: string): unknown {
  return typeof body === 'object' && body !== null ? (body as Record<string, unknown>)[key] : undefined;
}

/** Reads a JSON body for error classification only; a non-JSON body yields null. */
async function errorBody(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function expiresAtFrom(expiresIn: unknown): Date {
  if (typeof expiresIn !== 'number') throw new CalendarUnavailableError(GOOGLE_UNAVAILABLE_MESSAGE);
  return new Date(Date.now() + expiresIn * 1000);
}

export class GoogleCalendarApi implements CalendarApi {
  readonly provider = 'google' as const;
  readonly configured = true;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly http: GoogleHttp;

  constructor(o: { clientId: string; clientSecret: string; fetch?: typeof fetch; timeoutMs?: number }) {
    this.clientId = o.clientId;
    this.clientSecret = o.clientSecret;
    this.http = makeGoogleHttp(o);
  }

  authUrl({ state, redirectUri }: { state: string; redirectUri: string }): string {
    const params = new URLSearchParams([
      ['client_id', this.clientId],
      ['redirect_uri', redirectUri],
      ['response_type', 'code'],
      ['scope', GOOGLE_CALENDAR_SCOPES.join(' ')],
      ['access_type', 'offline'],
      ['prompt', 'consent'],
      ['include_granted_scopes', 'true'],
      ['state', state],
    ]);
    return `${AUTH_URL}?${params.toString()}`;
  }

  async exchangeCode({ code, redirectUri }: { code: string; redirectUri: string }): Promise<OAuthTokens> {
    const res = await this.postToken({
      code,
      client_id: this.clientId,
      client_secret: this.clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    });
    if (res.status !== 200) {
      if (res.status === 400 && field(await errorBody(res), 'error') === 'invalid_grant') {
        throw new CalendarAuthError(GOOGLE_RECONNECT_MESSAGE);
      }
      throw new CalendarUnavailableError(GOOGLE_UNAVAILABLE_MESSAGE);
    }
    const token = await readJson(res);
    const accessToken = field(token, 'access_token');
    const scope = field(token, 'scope');
    if (typeof accessToken !== 'string') throw new CalendarUnavailableError(GOOGLE_UNAVAILABLE_MESSAGE);

    const info = await this.http(USERINFO_URL, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (info.status !== 200) throw new CalendarUnavailableError(GOOGLE_UNAVAILABLE_MESSAGE);
    const accountEmail = field(await readJson(info), 'email');
    if (typeof accountEmail !== 'string') throw new CalendarUnavailableError(GOOGLE_UNAVAILABLE_MESSAGE);

    const refreshToken = field(token, 'refresh_token');
    if (typeof refreshToken !== 'string') throw new CalendarAuthError(GOOGLE_RECONNECT_MESSAGE);

    return {
      refreshToken,
      accessToken,
      expiresAt: expiresAtFrom(field(token, 'expires_in')),
      scopes: typeof scope === 'string' ? scope.split(' ') : [],
      accountEmail,
    };
  }

  async refresh(refreshToken: string): Promise<{ accessToken: string; expiresAt: Date; refreshToken?: string }> {
    const res = await this.postToken({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    });
    if (res.status !== 200) {
      if (res.status === 400 && field(await errorBody(res), 'error') === 'invalid_grant') {
        throw new CalendarAuthError(GOOGLE_RECONNECT_MESSAGE);
      }
      throw new CalendarUnavailableError(GOOGLE_UNAVAILABLE_MESSAGE);
    }
    const token = await readJson(res);
    const accessToken = field(token, 'access_token');
    if (typeof accessToken !== 'string') throw new CalendarUnavailableError(GOOGLE_UNAVAILABLE_MESSAGE);
    const rotated = field(token, 'refresh_token');
    return {
      accessToken,
      expiresAt: expiresAtFrom(field(token, 'expires_in')),
      ...(typeof rotated === 'string' ? { refreshToken: rotated } : {}),
    };
  }

  listCalendars(accessToken: string): Promise<ExternalCalendar[]> {
    return googleListCalendars(this.http, accessToken);
  }

  createEvent(accessToken: string, calendarId: string, e: ExternalEventInput): Promise<{ id: string; etag: string | null }> {
    return googleCreateEvent(this.http, accessToken, calendarId, e);
  }

  updateEvent(
    accessToken: string,
    calendarId: string,
    eventId: string,
    etag: string | null,
    e: ExternalEventInput,
  ): Promise<{ etag: string | null } | 'gone' | 'conflict'> {
    return googleUpdateEvent(this.http, accessToken, calendarId, eventId, etag, e);
  }

  deleteEvent(accessToken: string, calendarId: string, eventId: string): Promise<void> {
    return googleDeleteEvent(this.http, accessToken, calendarId, eventId);
  }

  getEvent(accessToken: string, calendarId: string, eventId: string): Promise<ExternalEvent | null> {
    return googleGetEvent(this.http, accessToken, calendarId, eventId);
  }

  syncEvents(accessToken: string, calendarId: string, cursor: string | null, window: { from: Date; to: Date }): Promise<SyncPage> {
    return googleSyncEvents(this.http, accessToken, calendarId, cursor, window);
  }

  private postToken(form: Record<string, string>): Promise<Response> {
    return this.http(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': FORM_CONTENT_TYPE },
      body: new URLSearchParams(form).toString(),
    });
  }
}

/** The Google adapter when both GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are set; else null. */
export function googleCalendarFor(config: Config): CalendarApi | null {
  if (!config.GOOGLE_CLIENT_ID || !config.GOOGLE_CLIENT_SECRET) return null;
  return new GoogleCalendarApi({ clientId: config.GOOGLE_CLIENT_ID, clientSecret: config.GOOGLE_CLIENT_SECRET });
}
