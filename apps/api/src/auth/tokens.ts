import type { Db } from '@roofline/db';
import {
  consumeUserToken,
  insertUserToken,
  isUserTokenLive,
  resetPasswordWithToken,
  type UserTokenKind,
  verifyEmailWithToken,
} from '@roofline/db/system';
import { generateToken, hashToken, isWellFormedToken } from './sessions.ts';

/*
 * One-time tokens for the links in emails: "confirm your email" and "reset your password". They are
 * made and stored the way session tokens are (32 random bytes as base64url; the database keeps
 * only the sha256), so a leaked user_tokens table cannot be turned into working links.
 * Every function takes the app clock's time from its caller; none reads the system clock.
 */

const HOUR_MS = 60 * 60 * 1000;
export const VERIFY_EMAIL_TTL_MS = 7 * 24 * HOUR_MS;
export const RESET_PASSWORD_TTL_MS = HOUR_MS;

export type { UserTokenKind };

/**
 * Makes a token for the user, stores its hash, and returns the raw token for the email link. It
 * expires `ttlMs` after `now`. Issuing a `reset_password` token retires that user's earlier unused
 * reset tokens, so only the newest reset link works.
 */
export async function issueToken(
  system: Db,
  userId: string,
  kind: UserTokenKind,
  ttlMs: number,
  now: Date,
): Promise<string> {
  const token = generateToken();
  await insertUserToken(system, {
    userId,
    kind,
    tokenHash: hashToken(token),
    now,
    expiresAt: new Date(now.getTime() + ttlMs),
  });
  return token;
}

/**
 * Spends a token of this kind. Returns the user it was issued to, or null when it is unknown, of a
 * different kind, already used, or expired at `now`. Single use is decided by one atomic UPDATE,
 * so of several simultaneous attempts exactly one succeeds.
 * (When something else must change in the same breath, use `confirmEmail` or `resetPassword`.)
 */
export async function consumeToken(
  system: Db,
  token: string,
  kind: UserTokenKind,
  now: Date,
): Promise<string | null> {
  if (!isWellFormedToken(token)) return null;
  return consumeUserToken(system, hashToken(token), kind, now);
}

/** Spends a verification token and verifies that user's email, together. False when the token cannot be used. */
export async function confirmEmail(system: Db, token: string, now: Date): Promise<boolean> {
  if (!isWellFormedToken(token)) return false;
  return (await verifyEmailWithToken(system, hashToken(token), now)) !== null;
}

/** Whether a reset token could be used right now. Spends nothing; lets the caller skip a costly hash for junk tokens. */
export async function isResetTokenLive(system: Db, token: string, now: Date): Promise<boolean> {
  if (!isWellFormedToken(token)) return false;
  return isUserTokenLive(system, hashToken(token), 'reset_password', now);
}

/**
 * Spends a reset token and sets the new password in one step: the password changes, the email
 * counts as verified, and every one of the user's sessions is deleted, or (if anything fails)
 * none of that happens and the token still works. Returns the user, or null when the token cannot be used.
 */
export async function resetPassword(
  system: Db,
  token: string,
  passwordHash: string,
  now: Date,
): Promise<string | null> {
  if (!isWellFormedToken(token)) return null;
  return resetPasswordWithToken(system, { tokenHash: hashToken(token), passwordHash, now });
}
