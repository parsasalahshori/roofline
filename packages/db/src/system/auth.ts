import { and, asc, desc, eq, gt, isNull, like, lt, or } from 'drizzle-orm';
import type { CompanyStatus, Role } from '@roofline/shared';
import { isUniqueViolation } from '../errors.ts';
import type { Db } from '../pools.ts';
import { pickFreeSlug, slugify } from '../repos/companies.ts';
import { companies, memberships, sessions, type USER_TOKEN_KINDS, users, userTokens } from '../schema/index.ts';

/*
 * Authentication data access. These run on the app_system pool: users, sessions and memberships
 * are global tables that app_tenant cannot read. Only apps/api/src/auth/** imports this module.
 * Nothing here reads a clock or generates a token: callers pass `now` and token hashes in, so the
 * API's injected clock decides every expiry.
 */

export type AuthUser = {
  id: string;
  email: string;
  name: string;
  passwordHash: string | null;
  emailVerifiedAt: Date | null;
};

export type AuthCompany = { id: string; name: string; slug: string; status: CompanyStatus };

/** One of a user's companies, as the sign-in and company-switcher code needs it. */
export type ActiveMembership = AuthCompany & { role: Role; canApproveSpend: boolean };

/** Thrown by `createAccount` when the email already belongs to a user. */
export class EmailInUseError extends Error {
  constructor() {
    super('That email already has an account.');
    this.name = 'EmailInUseError';
  }
}

const USER_COLUMNS = {
  id: users.id,
  email: users.email,
  name: users.name,
  passwordHash: users.passwordHash,
  emailVerifiedAt: users.emailVerifiedAt,
} as const;

/** The user with this email, or null. `email` is compared case-insensitively (the column is citext). */
export async function findUserByEmail(system: Db, email: string): Promise<AuthUser | null> {
  const [row] = await system.select(USER_COLUMNS).from(users).where(eq(users.email, email)).limit(1);
  return row ?? null;
}

export async function findUserById(system: Db, userId: string): Promise<AuthUser | null> {
  const [row] = await system.select(USER_COLUMNS).from(users).where(eq(users.id, userId)).limit(1);
  return row ?? null;
}

/** The user's active memberships with their companies, the oldest membership first. */
export async function listActiveMemberships(system: Db, userId: string): Promise<ActiveMembership[]> {
  return system
    .select({
      id: companies.id,
      name: companies.name,
      slug: companies.slug,
      status: companies.status,
      role: memberships.role,
      canApproveSpend: memberships.canApproveSpend,
    })
    .from(memberships)
    .innerJoin(companies, eq(companies.id, memberships.companyId))
    .where(and(eq(memberships.userId, userId), eq(memberships.status, 'active')))
    .orderBy(asc(memberships.createdAt), asc(memberships.id));
}

export type NewAccount = {
  email: string;
  name: string;
  passwordHash: string;
  companyName: string;
  trialEndsAt: Date;
};

export type CreatedAccount = {
  user: AuthUser;
  company: AuthCompany;
  membershipId: string;
};

const SLUG_ATTEMPTS = 25;

/**
 * Creates a user, their company (status `trial`, slug from the name) and an active owner
 * membership in ONE transaction: either all three exist afterwards or none do.
 * The company's time zone is left at the column default; F3 sets it from the geocoded address.
 * Throws EmailInUseError when the email is taken.
 */
export async function createAccount(system: Db, input: NewAccount): Promise<CreatedAccount> {
  try {
    return await system.transaction(async (tx) => {
      const [user] = await tx
        .insert(users)
        .values({ email: input.email, name: input.name, passwordHash: input.passwordHash })
        .returning(USER_COLUMNS);

      const base = slugify(input.companyName);
      let company: AuthCompany | undefined;
      for (let attempt = 0; attempt < SLUG_ATTEMPTS && !company; attempt++) {
        const existing = await tx
          .select({ slug: companies.slug })
          .from(companies)
          .where(or(eq(companies.slug, base), like(companies.slug, `${base}-%`)));
        const slug = pickFreeSlug(
          base,
          existing.map((r) => r.slug),
        );
        try {
          // A savepoint: a slug taken by a sign-up that committed a moment ago must not abort the
          // whole transaction, only this attempt.
          [company] = await tx.transaction((sp) =>
            sp
              .insert(companies)
              .values({ name: input.companyName, slug, status: 'trial', trialEndsAt: input.trialEndsAt })
              .returning({ id: companies.id, name: companies.name, slug: companies.slug, status: companies.status }),
          );
        } catch (err) {
          if (!isUniqueViolation(err, 'companies_slug_unique')) throw err;
        }
      }
      if (!company) throw new Error('Could not find a free company slug.');

      const [membership] = await tx
        .insert(memberships)
        .values({ companyId: company.id, userId: user!.id, role: 'owner', canApproveSpend: false, status: 'active' })
        .returning({ id: memberships.id });

      return { user: user!, company, membershipId: membership!.id };
    });
  } catch (err) {
    if (isUniqueViolation(err, 'users_email_unique')) throw new EmailInUseError();
    throw err;
  }
}

/**
 * Undoes `createAccount` (the compensating step when the follow-up work fails). Deletes the
 * membership, company and user in one transaction. Only valid while nothing else references them;
 * a company that already has settings, sessions or data cannot be removed this way.
 */
export async function removeAccount(system: Db, account: Pick<CreatedAccount, 'user' | 'company'>): Promise<void> {
  await system.transaction(async (tx) => {
    await tx.delete(memberships).where(eq(memberships.companyId, account.company.id));
    await tx.delete(companies).where(eq(companies.id, account.company.id));
    await tx.delete(users).where(eq(users.id, account.user.id));
  });
}

export type NewSession = {
  tokenHash: string;
  userId: string;
  companyId: string;
  now: Date;
  expiresAt: Date;
  userAgent: string | null;
  ip: string | null;
};

export async function insertSession(system: Db, input: NewSession): Promise<void> {
  await system.insert(sessions).values({
    tokenHash: input.tokenHash,
    userId: input.userId,
    activeCompanyId: input.companyId,
    expiresAt: input.expiresAt,
    lastSeenAt: input.now,
    userAgent: input.userAgent,
    ip: input.ip,
  });
}

export type SessionRecord = {
  sessionId: string;
  userId: string;
  companyId: string;
  role: Role;
  canApproveSpend: boolean;
  emailVerified: boolean;
  lastSeenAt: Date;
};

/**
 * The live session behind a token hash: not expired at `now`, and its user still has an ACTIVE
 * membership in the session's company. Anything else (unknown, expired, membership disabled or
 * removed) is null.
 */
export async function findLiveSession(system: Db, tokenHash: string, now: Date): Promise<SessionRecord | null> {
  const [row] = await system
    .select({
      sessionId: sessions.id,
      userId: sessions.userId,
      companyId: memberships.companyId,
      role: memberships.role,
      canApproveSpend: memberships.canApproveSpend,
      emailVerifiedAt: users.emailVerifiedAt,
      lastSeenAt: sessions.lastSeenAt,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .innerJoin(
      memberships,
      and(eq(memberships.userId, sessions.userId), eq(memberships.companyId, sessions.activeCompanyId)),
    )
    .where(and(eq(sessions.tokenHash, tokenHash), gt(sessions.expiresAt, now), eq(memberships.status, 'active')))
    .limit(1);
  if (!row) return null;
  const { emailVerifiedAt, ...rest } = row;
  return { ...rest, emailVerified: emailVerifiedAt !== null };
}

/**
 * Slides a session forward: `expires_at` and `last_seen_at` move to the new values, but only if
 * `last_seen_at` is still older than `staleBefore`. Two requests racing to renew the same session
 * therefore renew it once. Returns whether this call did the renewal.
 */
export async function renewSession(
  system: Db,
  sessionId: string,
  renewal: { now: Date; expiresAt: Date; staleBefore: Date },
): Promise<boolean> {
  const updated = await system
    .update(sessions)
    .set({ expiresAt: renewal.expiresAt, lastSeenAt: renewal.now })
    .where(and(eq(sessions.id, sessionId), lt(sessions.lastSeenAt, renewal.staleBefore)))
    .returning({ id: sessions.id });
  return updated.length > 0;
}

/** Deletes a session by id. Returns whether a row was removed. */
export async function deleteSession(system: Db, sessionId: string): Promise<boolean> {
  const deleted = await system.delete(sessions).where(eq(sessions.id, sessionId)).returning({ id: sessions.id });
  return deleted.length > 0;
}

/** Deletes one of this user's sessions. A session id that belongs to someone else removes nothing. */
export async function deleteSessionForUser(system: Db, userId: string, sessionId: string): Promise<boolean> {
  const deleted = await system
    .delete(sessions)
    .where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId)))
    .returning({ id: sessions.id });
  return deleted.length > 0;
}

export type SessionSummary = {
  id: string;
  userAgent: string | null;
  ip: string | null;
  createdAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
};

/** The user's sessions that have not expired at `now`, most recently used first. */
export async function listSessions(system: Db, userId: string, now: Date): Promise<SessionSummary[]> {
  return system
    .select({
      id: sessions.id,
      userAgent: sessions.userAgent,
      ip: sessions.ip,
      createdAt: sessions.createdAt,
      lastSeenAt: sessions.lastSeenAt,
      expiresAt: sessions.expiresAt,
    })
    .from(sessions)
    .where(and(eq(sessions.userId, userId), gt(sessions.expiresAt, now)))
    .orderBy(desc(sessions.lastSeenAt), asc(sessions.id));
}

export type AccountSummary = {
  user: AuthUser;
  company: AuthCompany;
  role: Role;
  /** Every company the user is an active member of, the oldest membership first. */
  companies: { id: string; name: string }[];
};

/**
 * What `GET /api/auth/me` shows: the user, the company they are working in, their role there, and
 * all their companies. Null when the user no longer has an active membership in `companyId`.
 */
export async function getAccountSummary(system: Db, userId: string, companyId: string): Promise<AccountSummary | null> {
  const [user, active] = await Promise.all([findUserById(system, userId), listActiveMemberships(system, userId)]);
  const current = active.find((m) => m.id === companyId);
  if (!user || !current) return null;
  return {
    user,
    company: { id: current.id, name: current.name, slug: current.slug, status: current.status },
    role: current.role,
    companies: active.map((m) => ({ id: m.id, name: m.name })),
  };
}

export type UserTokenKind = (typeof USER_TOKEN_KINDS)[number];

export type NewUserToken = {
  userId: string;
  kind: UserTokenKind;
  tokenHash: string;
  /** The app clock's `now()`. Stamps the tokens this call retires. */
  now: Date;
  expiresAt: Date;
};

/** What `system.transaction` hands its callback. */
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/**
 * Stores a verification or reset token (its hash, never the token). A user has at most one live
 * reset link: in the same transaction, their earlier unused reset tokens are marked used at
 * `now`, so the newest email is the only one that works. The user's row is locked first, so two
 * requests issuing at once queue up instead of both leaving a live token behind. Verification
 * links do not replace each other: an older email still works.
 */
export async function insertUserToken(system: Db, input: NewUserToken): Promise<void> {
  await system.transaction(async (tx) => {
    if (input.kind === 'reset_password') {
      await tx.select({ id: users.id }).from(users).where(eq(users.id, input.userId)).for('update');
      await tx
        .update(userTokens)
        .set({ usedAt: input.now })
        .where(
          and(eq(userTokens.userId, input.userId), eq(userTokens.kind, 'reset_password'), isNull(userTokens.usedAt)),
        );
    }
    await tx.insert(userTokens).values({
      userId: input.userId,
      kind: input.kind,
      tokenHash: input.tokenHash,
      expiresAt: input.expiresAt,
    });
  });
}

/**
 * Spends a token: one UPDATE that matches only a token of this kind that is unused and not yet
 * expired at `now` (`expires_at > now`: the last valid moment is the one before it), so of any
 * number of simultaneous attempts exactly one gets the user id and the rest get null.
 */
async function claimUserToken(exec: Pick<Tx, 'update'>, tokenHash: string, kind: UserTokenKind, now: Date) {
  const [row] = await exec
    .update(userTokens)
    .set({ usedAt: now })
    .where(
      and(
        eq(userTokens.tokenHash, tokenHash),
        eq(userTokens.kind, kind),
        isNull(userTokens.usedAt),
        gt(userTokens.expiresAt, now),
      ),
    )
    .returning({ userId: userTokens.userId });
  return row?.userId ?? null;
}

/** Spends the token and nothing else. Returns the user it was issued to, or null when it cannot be used. */
export async function consumeUserToken(
  system: Db,
  tokenHash: string,
  kind: UserTokenKind,
  now: Date,
): Promise<string | null> {
  return claimUserToken(system, tokenHash, kind, now);
}

/** True when the token exists, is of this kind, is unused and is not expired at `now`. Spends nothing. */
export async function isUserTokenLive(system: Db, tokenHash: string, kind: UserTokenKind, now: Date): Promise<boolean> {
  const [row] = await system
    .select({ id: userTokens.id })
    .from(userTokens)
    .where(
      and(
        eq(userTokens.tokenHash, tokenHash),
        eq(userTokens.kind, kind),
        isNull(userTokens.usedAt),
        gt(userTokens.expiresAt, now),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/**
 * Spends an email-verification token and marks the user's email verified at `now` (a no-op if it
 * already was), in one transaction. Null when the token cannot be used.
 */
export async function verifyEmailWithToken(system: Db, tokenHash: string, now: Date): Promise<string | null> {
  return system.transaction(async (tx) => {
    const userId = await claimUserToken(tx, tokenHash, 'verify_email', now);
    if (userId === null) return null;
    await tx
      .update(users)
      .set({ emailVerifiedAt: now })
      .where(and(eq(users.id, userId), isNull(users.emailVerifiedAt)));
    return userId;
  });
}

/**
 * Spends a reset token, then in the same transaction sets the user's password, marks their email
 * verified if it was not (a reset link proves they read that inbox) and deletes ALL of their
 * sessions. Either everything happens or none of it does: a failure leaves the token usable and
 * the old password and sessions in place. Null when the token cannot be used.
 */
export async function resetPasswordWithToken(
  system: Db,
  input: { tokenHash: string; passwordHash: string; now: Date },
): Promise<string | null> {
  return system.transaction(async (tx) => {
    const userId = await claimUserToken(tx, input.tokenHash, 'reset_password', input.now);
    if (userId === null) return null;
    await tx.update(users).set({ passwordHash: input.passwordHash }).where(eq(users.id, userId));
    await tx
      .update(users)
      .set({ emailVerifiedAt: input.now })
      .where(and(eq(users.id, userId), isNull(users.emailVerifiedAt)));
    await tx.delete(sessions).where(eq(sessions.userId, userId));
    return userId;
  });
}
