import { Router } from 'express';
import { z } from 'zod';
import {
  audit,
  type CalendarConnectionRow,
  deleteConnection,
  encrypt,
  getConnection,
  saveConnection,
  setConnectionCalendar,
  type TenantContext,
  withTenant,
} from '@roofline/db';
import { CALENDAR_PROVIDERS, type CalendarConnectionView, type CalendarProvider } from '@roofline/shared';
import type { AppDeps } from '../app.ts';
import { makeOAuthState, readOAuthState } from '../calendar/oauth-state.ts';
import { pullConnection } from '../calendar/pull.ts';
import { accessTokenFor, forgetCachedToken } from '../calendar/tokens.ts';
import { AppError, MESSAGES } from '../errors.ts';
import { CalendarAuthError, CalendarUnavailableError, type ExternalCalendar } from '../providers/calendar.ts';
import { assertKnownFields, noNul, parse, TOO_LONG } from '../validate.ts';

/** Every message this file shows a person (C1 Task 12). Plain sentences; no codes, no provider text. */
const CALENDAR_MESSAGES = {
  reconnect: 'Reconnect your calendar.',
  unavailable: 'Your calendar is not available right now. Try again soon.',
  pickOne: 'Pick one of your calendars.',
  checkField: 'Please check this field.',
} as const;

/** A sign-in state is good for ten minutes; the used-state record lives as long as the state could still be read. */
const STATE_TTL_MS = 10 * 60 * 1000;

/**
 * States already spent by a callback, keyed by the state string, valued by their expiry in ms.
 * A replayed state is refused even though its signature still checks out.
 */
const usedStates = new Map<string, number>();

function pruneUsedStates(nowMs: number): void {
  for (const [state, expiresAt] of usedStates) {
    if (expiresAt < nowMs) usedStates.delete(state);
  }
}

const CalendarPatchBody = z.object({
  calendarId: z
    .string({ error: CALENDAR_MESSAGES.pickOne })
    .min(1, CALENDAR_MESSAGES.pickOne)
    .max(256, TOO_LONG)
    .refine(noNul, CALENDAR_MESSAGES.checkField),
});

const CONNECTION_FIELDS = ['calendarId'] as const;

/** Unknown provider names are not found; the provider list is the only truth. */
function providerParam(raw: unknown): CalendarProvider {
  if (typeof raw !== 'string' || !(CALENDAR_PROVIDERS as readonly string[]).includes(raw)) {
    throw new AppError(404, MESSAGES.notFound);
  }
  return raw as CalendarProvider;
}

/** Where the provider sends the person back to; it must be registered on the provider's OAuth client. */
function redirectUriFor(baseUrl: string, provider: CalendarProvider): string {
  return `${baseUrl}/api/calendar/oauth/${provider}/callback`;
}

/** Converts a stored row (or none) to what the settings screen shows. Never credentials or error text. */
function toView(row: CalendarConnectionRow | null, configured: Record<CalendarProvider, boolean>): CalendarConnectionView {
  return {
    provider: row?.provider ?? null,
    status: row?.status ?? null,
    accountEmail: row?.accountEmail ?? null,
    calendarId: row?.calendarId ?? null,
    calendarName: row?.calendarName ?? null,
    lastSyncedAt: row?.lastSyncedAt ? row.lastSyncedAt.toISOString() : null,
    configured,
  };
}

/**
 * Calendar connect and sync API (C1 Task 12). Every member may use every route, for themselves
 * only: a person's connection is never visible to, or changed by, anyone else. The OAuth callback
 * always answers with a redirect back to the settings page, never with a provider message.
 */
export function calendarConnectRoutes(deps: AppDeps): Router {
  const { pools, config, clock } = deps;
  const router = Router();

  const configured = (): Record<CalendarProvider, boolean> => ({
    google: deps.calendars.google.configured,
    microsoft: deps.calendars.microsoft.configured,
  });

  const settingsRedirect = (result: string): string => `${config.APP_ORIGIN}/settings/connections?calendar=${result}`;

  /** A company whose trial ended or whose plan was canceled is read-only: no new connection, even through a GET. */
  const readOnly = (req: { session: { companyStatus?: string } }): boolean =>
    req.session.companyStatus === 'trial_ended' || req.session.companyStatus === 'canceled';

  /** The caller's own connection row, or null. */
  function currentRow(req: { ctx: TenantContext; session: { userId: string } }): Promise<CalendarConnectionRow | null> {
    return withTenant(pools, req.ctx, (tx) => getConnection(tx, req.ctx, req.session.userId));
  }

  /** The calendars a connection may write to, with the provider's token. A dead grant or a provider outage becomes a plain sentence. */
  async function writableCalendars(ctx: TenantContext, conn: CalendarConnectionRow): Promise<ExternalCalendar[]> {
    try {
      const token = await accessTokenFor(deps, ctx, conn);
      const all = await deps.calendars[conn.provider].listCalendars(token);
      return all.filter((c) => c.canWrite);
    } catch (err) {
      if (err instanceof CalendarAuthError) throw new AppError(409, CALENDAR_MESSAGES.reconnect);
      if (err instanceof CalendarUnavailableError) throw new AppError(503, CALENDAR_MESSAGES.unavailable);
      throw err;
    }
  }

  router.get('/connection', async (req, res) => {
    res.json(toView(await currentRow(req), configured()));
  });

  router.get('/connection/calendars', async (req, res) => {
    const conn = await currentRow(req);
    if (!conn) throw new AppError(404, MESSAGES.notFound);
    res.json(await writableCalendars(req.ctx, conn));
  });

  router.get('/connect/:provider', (req, res) => {
    const provider = providerParam(req.params.provider);
    if (readOnly(req)) {
      res.redirect(302, settingsRedirect('failed'));
      return;
    }
    if (!deps.calendars[provider].configured) {
      res.redirect(302, settingsRedirect('not-set-up'));
      return;
    }
    const state = makeOAuthState(
      { companyId: req.ctx.companyId, userId: req.session.userId, provider, now: clock.now() },
      config.ENCRYPTION_KEY,
    );
    const authUrl = deps.calendars[provider].authUrl({ state, redirectUri: redirectUriFor(config.PUBLIC_BASE_URL, provider) });
    res.redirect(302, authUrl);
  });

  router.get('/oauth/:provider/callback', async (req, res) => {
    const provider = providerParam(req.params.provider);
    const { ctx } = req;
    const userId = req.session.userId;
    const now = clock.now();
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    if (readOnly(req)) {
      res.redirect(302, settingsRedirect('failed'));
      return;
    }

    pruneUsedStates(now.getTime());
    const claims = state === '' ? null : readOAuthState(state, config.ENCRYPTION_KEY, now);
    if (
      claims === null ||
      claims.companyId !== ctx.companyId ||
      claims.userId !== userId ||
      claims.provider !== provider ||
      usedStates.has(state)
    ) {
      res.redirect(302, settingsRedirect('failed'));
      return;
    }
    // Spent before the provider is asked anything, so a replay is refused even if the exchange fails.
    usedStates.set(state, now.getTime() + STATE_TTL_MS);

    const error = req.query.error;
    if (error === 'access_denied') {
      res.redirect(302, settingsRedirect('canceled'));
      return;
    }
    const code = req.query.code;
    if (error !== undefined || typeof code !== 'string' || code === '') {
      res.redirect(302, settingsRedirect('failed'));
      return;
    }

    try {
      const api = deps.calendars[provider];
      const tokens = await api.exchangeCode({ code, redirectUri: redirectUriFor(config.PUBLIC_BASE_URL, provider) });
      const calendars = await api.listCalendars(tokens.accessToken);
      const pick = calendars.find((c) => c.primary && c.canWrite) ?? calendars.find((c) => c.canWrite);
      if (!pick) {
        res.redirect(302, settingsRedirect('failed'));
        return;
      }
      const savedId = await withTenant(pools, ctx, async (tx) => {
        const row = await saveConnection(
          tx,
          ctx,
          {
            userId,
            provider,
            accountEmail: tokens.accountEmail,
            encryptedCredentials: encrypt(JSON.stringify({ refreshToken: tokens.refreshToken }), config.ENCRYPTION_KEY),
            scopes: tokens.scopes,
            calendarId: pick.id,
            calendarName: pick.name,
          },
          now,
        );
        await audit(tx, ctx, {
          action: 'calendar.connected',
          targetType: 'calendar_connection',
          targetId: row.id,
          after: { provider },
          ip: req.ip ?? null,
          at: now,
        });
        return row.id;
      });
      // The row id survives a reconnect, so a token cached for the old grant must go.
      forgetCachedToken(savedId);
      res.redirect(302, settingsRedirect('connected'));
    } catch (err) {
      // The provider's own words never reach the person or the log line; the error is handed over whole.
      deps.logError?.(err, req.path);
      res.redirect(302, settingsRedirect('failed'));
    }
  });

  router.patch('/connection', async (req, res) => {
    const { ctx } = req;
    const body = parse(CalendarPatchBody, assertKnownFields(req.body, CONNECTION_FIELDS));
    const conn = await currentRow(req);
    if (!conn) throw new AppError(404, MESSAGES.notFound);

    const pick = (await writableCalendars(ctx, conn)).find((c) => c.id === body.calendarId);
    if (!pick) throw new AppError(400, CALENDAR_MESSAGES.pickOne, 'calendarId');

    const now = clock.now();
    await withTenant(pools, ctx, async (tx) => {
      await setConnectionCalendar(tx, ctx, req.session.userId, pick.id, pick.name, now);
      await audit(tx, ctx, {
        action: 'calendar.updated',
        targetType: 'calendar_connection',
        targetId: conn.id,
        after: { calendarId: pick.id },
        ip: req.ip ?? null,
        at: now,
      });
    });
    res.json(toView(await currentRow(req), configured()));
  });

  router.delete('/connection', async (req, res) => {
    const { ctx } = req;
    const now = clock.now();
    let removedId: string | null = null;
    const removed = await withTenant(pools, ctx, async (tx) => {
      const conn = await getConnection(tx, ctx, req.session.userId);
      if (!conn) return false;
      const done = await deleteConnection(tx, ctx, req.session.userId);
      if (!done) return false;
      removedId = conn.id;
      await audit(tx, ctx, {
        action: 'calendar.disconnected',
        targetType: 'calendar_connection',
        targetId: conn.id,
        before: { provider: conn.provider },
        ip: req.ip ?? null,
        at: now,
      });
      return true;
    });
    if (!removed) throw new AppError(404, MESSAGES.notFound);
    if (removedId !== null) forgetCachedToken(removedId);
    // Disconnecting does not call the provider: the grant is simply forgotten here.
    res.status(204).end();
  });

  router.post('/sync', async (req, res) => {
    const conn = await currentRow(req);
    // No calendar connected: nothing to sync. The Calendar posts this on every open, so it is not an error.
    if (!conn) {
      res.status(204).end();
      return;
    }
    // Rate limit per person, kept in the row so it holds across servers: a sync within 30 s of the last one is a no-op.
    if (conn.lastSyncedAt !== null && clock.now().getTime() - conn.lastSyncedAt.getTime() < 30_000) {
      res.status(202).json({});
      return;
    }
    try {
      await pullConnection(deps, req.ctx, conn);
    } catch (err) {
      deps.logError?.(err, req.path);
    }
    res.status(202).json({});
  });

  return router;
}
