import type { CalendarProvider } from '@roofline/shared';
import {
  type CalendarApi,
  CalendarAuthError,
  CalendarUnavailableError,
  type ExternalCalendar,
  type ExternalEvent,
  type ExternalEventInput,
  type OAuthTokens,
  type SyncPage,
} from '../calendar.ts';

const EXPIRY = new Date('2030-01-01T00:00:00Z');
const CLOCK_START = Date.UTC(2030, 0, 1, 0, 0, 0);

/** One stored event. `change` is the global change number of its last change. */
type EventRec = {
  id: string;
  version: number;
  start: Date;
  end: Date;
  allDay: boolean;
  updatedAt: Date;
  cancelled: boolean;
  busy: boolean;
  change: number;
};

/** Deterministic in-memory calendar: no network, no timers, no randomness. */
export class FakeCalendarApi implements CalendarApi {
  readonly configured = true;
  /** Every CalendarApi call, in order, recorded before it runs. */
  readonly calls: { method: string; args: unknown[] }[] = [];
  /** Accounts keyed by refresh token. */
  private readonly accounts = new Map<string, { calendars: ExternalCalendar[] }>();
  /** Events keyed by `${refreshToken}/${calendarId}`, then by event id. */
  private readonly events = new Map<string, Map<string, EventRec>>();
  private readonly revoked = new Set<string>();
  private rotateTo: string | null = null;
  private failures = 0;
  private cursorExpired = false;
  private eventSeq = 0;
  private changeSeq = 0;
  private tick = 0;

  constructor(readonly provider: CalendarProvider) {}

  authUrl(i: { state: string; redirectUri: string }): string {
    this.calls.push({ method: 'authUrl', args: [i] });
    return `https://calendar.fake.test/${this.provider}/auth?state=${encodeURIComponent(i.state)}`;
  }

  async exchangeCode(i: { code: string; redirectUri: string }): Promise<OAuthTokens> {
    this.calls.push({ method: 'exchangeCode', args: [i] });
    const refreshToken = `refresh-${i.code}`;
    this.ensureAccount(refreshToken);
    return {
      refreshToken,
      accessToken: `access-${i.code}`,
      expiresAt: EXPIRY,
      scopes: ['calendar'],
      accountEmail: `${i.code}@example.test`,
    };
  }

  async refresh(refreshToken: string): Promise<{ accessToken: string; expiresAt: Date; refreshToken?: string }> {
    this.calls.push({ method: 'refresh', args: [refreshToken] });
    this.guard(refreshToken);
    const rotated = this.rotateTo;
    if (rotated !== null) {
      this.rotateTo = null;
      this.ensureAccount(rotated);
      return { accessToken: rotated.replace(/^refresh-/, 'access-'), expiresAt: EXPIRY, refreshToken: rotated };
    }
    return { accessToken: refreshToken.replace(/^refresh-/, 'access-'), expiresAt: EXPIRY };
  }

  async listCalendars(accessToken: string): Promise<ExternalCalendar[]> {
    this.calls.push({ method: 'listCalendars', args: [accessToken] });
    const refresh = this.guard(accessToken);
    return this.accounts.get(refresh)!.calendars.map((c) => ({ ...c }));
  }

  async createEvent(accessToken: string, calendarId: string, e: ExternalEventInput): Promise<{ id: string; etag: string | null }> {
    this.calls.push({ method: 'createEvent', args: [accessToken, calendarId, e] });
    const key = this.key(this.guard(accessToken), calendarId);
    const id = `evt-${++this.eventSeq}`;
    const rec: EventRec = {
      id,
      version: 1,
      start: new Date(e.start),
      end: new Date(e.end),
      allDay: e.allDay,
      updatedAt: this.nextTime(),
      cancelled: false,
      busy: true,
      change: ++this.changeSeq,
    };
    this.bucket(key).set(id, rec);
    return { id, etag: etagOf(rec) };
  }

  async updateEvent(
    accessToken: string,
    calendarId: string,
    eventId: string,
    etag: string | null,
    e: ExternalEventInput,
  ): Promise<{ etag: string | null } | 'gone' | 'conflict'> {
    this.calls.push({ method: 'updateEvent', args: [accessToken, calendarId, eventId, etag, e] });
    const rec = this.events.get(this.key(this.guard(accessToken), calendarId))?.get(eventId);
    if (!rec || rec.cancelled) return 'gone';
    if (etag !== null && etag !== etagOf(rec)) return 'conflict';
    rec.version++;
    rec.start = new Date(e.start);
    rec.end = new Date(e.end);
    rec.allDay = e.allDay;
    rec.updatedAt = this.nextTime();
    rec.change = ++this.changeSeq;
    return { etag: etagOf(rec) };
  }

  async deleteEvent(accessToken: string, calendarId: string, eventId: string): Promise<void> {
    this.calls.push({ method: 'deleteEvent', args: [accessToken, calendarId, eventId] });
    const rec = this.events.get(this.key(this.guard(accessToken), calendarId))?.get(eventId);
    if (!rec) return;
    rec.cancelled = true;
    rec.updatedAt = this.nextTime();
    rec.change = ++this.changeSeq;
  }

  async getEvent(accessToken: string, calendarId: string, eventId: string): Promise<ExternalEvent | null> {
    this.calls.push({ method: 'getEvent', args: [accessToken, calendarId, eventId] });
    const rec = this.events.get(this.key(this.guard(accessToken), calendarId))?.get(eventId);
    return rec ? toExternal(rec) : null;
  }

  async syncEvents(accessToken: string, calendarId: string, cursor: string | null, window: { from: Date; to: Date }): Promise<SyncPage> {
    this.calls.push({ method: 'syncEvents', args: [accessToken, calendarId, cursor, window] });
    const key = this.key(this.guard(accessToken), calendarId);
    const bucket = this.bucket(key);
    const nextCursor = String(this.changeSeq);
    if (cursor === null || this.cursorExpired) {
      this.cursorExpired = false;
      const events = [...bucket.values()]
        .filter((r) => !r.cancelled && r.start < window.to && r.end > window.from)
        .map(toExternal);
      return { events, nextCursor, fullResync: true };
    }
    const since = Number(cursor);
    const events = [...bucket.values()].filter((r) => r.change > since).map(toExternal);
    return { events, nextCursor, fullResync: false };
  }

  /** Test helper: an external move of any stored event. */
  externalMove(eventId: string, start: Date, end: Date): void {
    const rec = this.find(eventId);
    rec.version++;
    rec.start = new Date(start);
    rec.end = new Date(end);
    rec.updatedAt = this.nextTime();
    rec.change = ++this.changeSeq;
  }

  /** Test helper: an external delete of any stored event. */
  externalDelete(eventId: string): void {
    const rec = this.find(eventId);
    rec.cancelled = true;
    rec.updatedAt = this.nextTime();
    rec.change = ++this.changeSeq;
  }

  /** Test helper: an event made outside the app on the first account's primary calendar. */
  addOutsideEvent(i: { start: Date; end: Date; allDay?: boolean; busy?: boolean }): string {
    const refresh = this.accounts.keys().next().value ?? 'refresh-outside';
    this.ensureAccount(refresh);
    const id = `evt-${++this.eventSeq}`;
    const rec: EventRec = {
      id,
      version: 1,
      start: new Date(i.start),
      end: new Date(i.end),
      allDay: i.allDay ?? false,
      updatedAt: this.nextTime(),
      cancelled: false,
      busy: i.busy ?? true,
      change: ++this.changeSeq,
    };
    this.bucket(this.key(refresh, 'primary')).set(id, rec);
    return id;
  }

  /** Test helper: the grant for this refresh token is gone. */
  revoke(refreshToken: string): void {
    this.revoked.add(refreshToken);
  }

  /** Test helper: the next refresh returns this new refresh token (and an access token made from it). */
  rotateNext(newRefreshToken: string): void {
    this.rotateTo = newRefreshToken;
  }

  /** Test helper: the next sync returns a full resync. */
  expireCursor(): void {
    this.cursorExpired = true;
  }

  /** Test helper: the next `n` calls throw CalendarUnavailableError. */
  failNext(n: number): void {
    this.failures += n;
  }

  /** Checks revocation, then the failure budget; auto-creates the account. Returns the refresh token. */
  private guard(token: string): string {
    const refresh = token.replace(/^access-/, 'refresh-');
    if (this.revoked.has(refresh)) throw new CalendarAuthError('revoked');
    if (this.failures > 0) {
      this.failures--;
      throw new CalendarUnavailableError('unavailable');
    }
    this.ensureAccount(refresh);
    return refresh;
  }

  private ensureAccount(refresh: string): void {
    if (!this.accounts.has(refresh)) {
      this.accounts.set(refresh, { calendars: [{ id: 'primary', name: 'My calendar', primary: true, canWrite: true }] });
    }
  }

  private key(refresh: string, calendarId: string): string {
    return `${refresh}/${calendarId}`;
  }

  private bucket(key: string): Map<string, EventRec> {
    let b = this.events.get(key);
    if (!b) {
      b = new Map();
      this.events.set(key, b);
    }
    return b;
  }

  private find(eventId: string): EventRec {
    for (const bucket of this.events.values()) {
      const rec = bucket.get(eventId);
      if (rec) return rec;
    }
    throw new Error(`Fake calendar has no event ${eventId}.`);
  }

  private nextTime(): Date {
    return new Date(CLOCK_START + ++this.tick * 1000);
  }
}

function etagOf(rec: EventRec): string {
  return `"${rec.version}"`;
}

function toExternal(rec: EventRec): ExternalEvent {
  return {
    id: rec.id,
    etag: etagOf(rec),
    start: new Date(rec.start),
    end: new Date(rec.end),
    allDay: rec.allDay,
    updatedAt: new Date(rec.updatedAt),
    cancelled: rec.cancelled,
    busy: rec.busy,
  };
}
