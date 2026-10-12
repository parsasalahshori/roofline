import type { CalendarProvider } from '@roofline/shared';
import type { Config } from '../config.ts';
import { FakeCalendarApi } from './fakes/calendar.ts';
import { googleCalendarFor } from './google-calendar.ts';
import { microsoftCalendarFor } from './microsoft-calendar.ts';

export type OAuthTokens = { refreshToken: string; accessToken: string; expiresAt: Date; scopes: string[]; accountEmail: string };
export type ExternalCalendar = { id: string; name: string; primary: boolean; canWrite: boolean };
export type ExternalEventInput = { title: string; location: string | null; description: string; start: Date; end: Date; allDay: boolean; timeZone: string };
export type ExternalEvent = { id: string; etag: string | null; start: Date; end: Date; allDay: boolean; updatedAt: Date; cancelled: boolean; busy: boolean };
export type SyncPage = { events: ExternalEvent[]; nextCursor: string; fullResync: boolean };
export interface CalendarApi {
  readonly provider: CalendarProvider; readonly configured: boolean;
  authUrl(i: { state: string; redirectUri: string }): string;
  exchangeCode(i: { code: string; redirectUri: string }): Promise<OAuthTokens>;
  refresh(refreshToken: string): Promise<{ accessToken: string; expiresAt: Date; refreshToken?: string }>;
  listCalendars(accessToken: string): Promise<ExternalCalendar[]>;
  createEvent(accessToken: string, calendarId: string, e: ExternalEventInput): Promise<{ id: string; etag: string | null }>;
  updateEvent(accessToken: string, calendarId: string, eventId: string, etag: string | null, e: ExternalEventInput): Promise<{ etag: string | null } | 'gone' | 'conflict'>;
  deleteEvent(accessToken: string, calendarId: string, eventId: string): Promise<void>; // 404/410 count as done
  getEvent(accessToken: string, calendarId: string, eventId: string): Promise<ExternalEvent | null>;
  syncEvents(accessToken: string, calendarId: string, cursor: string | null, window: { from: Date; to: Date }): Promise<SyncPage>; // an expired cursor -> fullResync true from the window
}
export class CalendarUnavailableError extends Error {} // retry later
export class CalendarAuthError extends Error {} // the grant is gone: reconnect
export type CalendarApis = Record<CalendarProvider, CalendarApi>;

const NOT_SET_UP = "Calendar connections aren't set up yet.";

/** Used when a provider is not configured: every call fails with a setup message. */
export class UnconfiguredCalendarApi implements CalendarApi {
  readonly configured = false;
  constructor(readonly provider: CalendarProvider) {}
  authUrl(): string { throw new CalendarUnavailableError(NOT_SET_UP); }
  async exchangeCode(): Promise<OAuthTokens> { throw new CalendarUnavailableError(NOT_SET_UP); }
  async refresh(): Promise<{ accessToken: string; expiresAt: Date; refreshToken?: string }> { throw new CalendarUnavailableError(NOT_SET_UP); }
  async listCalendars(): Promise<ExternalCalendar[]> { throw new CalendarUnavailableError(NOT_SET_UP); }
  async createEvent(): Promise<{ id: string; etag: string | null }> { throw new CalendarUnavailableError(NOT_SET_UP); }
  async updateEvent(): Promise<{ etag: string | null } | 'gone' | 'conflict'> { throw new CalendarUnavailableError(NOT_SET_UP); }
  async deleteEvent(): Promise<void> { throw new CalendarUnavailableError(NOT_SET_UP); }
  async getEvent(): Promise<ExternalEvent | null> { throw new CalendarUnavailableError(NOT_SET_UP); }
  async syncEvents(): Promise<SyncPage> { throw new CalendarUnavailableError(NOT_SET_UP); }
}

/** The calendar apis the app uses: fakes under FAKE_PROVIDERS, else the real adapters when configured. */
export function createCalendarApis(config: Config): CalendarApis {
  if (config.FAKE_PROVIDERS) return { google: new FakeCalendarApi('google'), microsoft: new FakeCalendarApi('microsoft') };
  return {
    google: googleCalendarFor(config) ?? new UnconfiguredCalendarApi('google'),
    microsoft: microsoftCalendarFor(config) ?? new UnconfiguredCalendarApi('microsoft'),
  };
}
