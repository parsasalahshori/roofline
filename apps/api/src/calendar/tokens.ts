import { decrypt, encrypt, markConnectionError, updateConnectionCredentials, type CalendarConnectionRow, type TenantContext, withTenant } from '@roofline/db';
import type { AppDeps } from '../app.ts';
import { CalendarAuthError } from '../providers/calendar.ts';

/*
 * Short-lived access tokens for a person's calendar, made from the refresh token we keep encrypted.
 * A token lives only in this process's memory, until a minute before its provider expiry. A dead
 * grant (CalendarAuthError) marks the connection `error` once; the caller then stops pushing and
 * pulling for it. Tokens and provider messages never reach a log or an error.
 */

const MARGIN_MS = 60_000;
const RECONNECT = 'Reconnect your calendar.';

const cache = new Map<string, { token: string; expiresAt: number }>();

/** Forgets every cached token. Tests call it between cases. */
export function clearTokenCache(): void {
  cache.clear();
}

/** Forgets the cached token of one connection. A reconnect keeps the row id, so the old token must not outlive the old grant. */
export function forgetCachedToken(connectionId: string): void {
  cache.delete(connectionId);
}

/** A usable access token for this connection, refreshed from its stored refresh token when needed. */
export async function accessTokenFor(deps: AppDeps, ctx: TenantContext, conn: CalendarConnectionRow): Promise<string> {
  const cached = cache.get(conn.id);
  if (cached && deps.clock.now().getTime() < cached.expiresAt - MARGIN_MS) return cached.token;

  const { refreshToken } = JSON.parse(decrypt(conn.encryptedCredentials, deps.config.ENCRYPTION_KEY)) as { refreshToken: string };
  const api = deps.calendars[conn.provider];
  try {
    const r = await api.refresh(refreshToken);
    cache.set(conn.id, { token: r.accessToken, expiresAt: r.expiresAt.getTime() });
    // A provider may rotate the refresh token; the old one can stop working, so the new one is stored.
    if (r.refreshToken !== undefined && r.refreshToken !== refreshToken) {
      const encrypted = encrypt(JSON.stringify({ refreshToken: r.refreshToken }), deps.config.ENCRYPTION_KEY);
      await withTenant(deps.pools, ctx, (tx) => updateConnectionCredentials(tx, ctx, conn.id, encrypted, deps.clock.now()));
    }
    return r.accessToken;
  } catch (err) {
    if (err instanceof CalendarAuthError) {
      cache.delete(conn.id);
      await withTenant(deps.pools, ctx, (tx) => markConnectionError(tx, ctx, conn.id, RECONNECT, deps.clock.now()));
    }
    throw err;
  }
}
