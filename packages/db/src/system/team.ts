import { and, asc, eq, gt, isNull, sql } from 'drizzle-orm';
import type { Role } from '@roofline/shared';
import { isUniqueViolation } from '../errors.ts';
import type { Db } from '../pools.ts';
import { companies, invites, type MEMBERSHIP_STATUSES, memberships, sessions, users } from '../schema/index.ts';
import {
  type AuthCompany,
  type AuthUser,
  EmailInUseError,
  GoogleSubInUseError,
  USER_COLUMNS,
} from './auth.ts';

/*
 * Team data access: invitations and memberships. Runs on the app_system pool, because both tables
 * are global (an invite is read by someone who has no company yet). Only
 * apps/api/src/auth/team-store.ts calls these. As in auth.ts, nothing here reads a clock or makes
 * a token: callers pass `now` and token hashes in.
 */

/** What `system.transaction` hands its callback. */
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export type MembershipStatus = (typeof MEMBERSHIP_STATUSES)[number];

/** The invited person already has an active membership in the company. */
export class AlreadyMemberError extends Error {
  constructor() {
    super('That person is already a member of this company.');
    this.name = 'AlreadyMemberError';
  }
}

/** The invite does not exist, was already accepted, or has expired. */
export class InviteUnavailableError extends Error {
  constructor() {
    super('That invite cannot be used.');
    this.name = 'InviteUnavailableError';
  }
}

/** What the caller proved about who they are no longer holds (or never did) for the user the invite is for. */
export class SignInRequiredError extends Error {
  constructor() {
    super('The caller has not shown they are the invited user.');
    this.name = 'SignInRequiredError';
  }
}

/** The change would leave the company without an active owner. */
export class LastOwnerError extends Error {
  constructor() {
    super('A company needs at least one active owner.');
    this.name = 'LastOwnerError';
  }
}

export type NewInvite = {
  companyId: string;
  /** Trimmed and lowercased by the caller. */
  email: string;
  role: Role;
  tokenHash: string;
  expiresAt: Date;
};

export type CreatedInvite = {
  id: string;
  companyName: string;
  email: string;
  role: Role;
  expiresAt: Date;
};

/**
 * Makes an invitation (the hash of its token, never the token) in one transaction:
 * 1. Takes a lock for this company and email, so two invitations to the same address at the same
 *    moment queue up instead of both leaving a live invite behind.
 * 2. Refuses with AlreadyMemberError when that address already belongs to an ACTIVE member.
 *    (Disabled members and members of other companies can be invited.)
 * 3. Deletes the address's earlier invites that were never accepted, so their links stop working:
 *    only the newest email is good.
 * 4. Inserts the new one. No membership is created; that happens when the invite is accepted.
 * `beforeCommit` runs after the insert and before the commit; if it throws, nothing is saved. The
 * route uses it to write the audit row, so an invite never exists without one.
 */
export async function insertInvite(
  system: Db,
  input: NewInvite,
  beforeCommit?: (invite: CreatedInvite) => Promise<void>,
): Promise<CreatedInvite> {
  return system.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${input.companyId}::text || ':' || lower(${input.email}::text), 0))`,
    );

    const [member] = await tx
      .select({ id: memberships.id })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(
        and(
          eq(memberships.companyId, input.companyId),
          eq(users.email, input.email),
          eq(memberships.status, 'active'),
        ),
      )
      .limit(1);
    if (member) throw new AlreadyMemberError();

    await tx
      .delete(invites)
      .where(
        and(eq(invites.companyId, input.companyId), eq(invites.email, input.email), isNull(invites.acceptedAt)),
      );
    const [row] = await tx
      .insert(invites)
      .values({
        companyId: input.companyId,
        email: input.email,
        role: input.role,
        tokenHash: input.tokenHash,
        expiresAt: input.expiresAt,
      })
      .returning({ id: invites.id });
    const [company] = await tx
      .select({ name: companies.name })
      .from(companies)
      .where(eq(companies.id, input.companyId));

    const created: CreatedInvite = {
      id: row!.id,
      companyName: company!.name,
      email: input.email,
      role: input.role,
      expiresAt: input.expiresAt,
    };
    await beforeCommit?.(created);
    return created;
  });
}

export type PendingInvite = { id: string; email: string; role: Role; expiresAt: Date };

/** The company's invites that are neither accepted nor expired at `now`, soonest to expire first. */
export async function listPendingInvites(system: Db, companyId: string, now: Date): Promise<PendingInvite[]> {
  return system
    .select({ id: invites.id, email: invites.email, role: invites.role, expiresAt: invites.expiresAt })
    .from(invites)
    .where(and(eq(invites.companyId, companyId), isNull(invites.acceptedAt), gt(invites.expiresAt, now)))
    .orderBy(asc(invites.expiresAt), asc(invites.id));
}

export type InviteToAccept = PendingInvite & { companyId: string };

/** The pending invite behind a token hash, or null (unknown, accepted, or expired at `now`). Changes nothing. */
export async function findPendingInvite(system: Db, tokenHash: string, now: Date): Promise<InviteToAccept | null> {
  const [row] = await system
    .select({
      id: invites.id,
      companyId: invites.companyId,
      email: invites.email,
      role: invites.role,
      expiresAt: invites.expiresAt,
    })
    .from(invites)
    .where(and(eq(invites.tokenHash, tokenHash), isNull(invites.acceptedAt), gt(invites.expiresAt, now)))
    .limit(1);
  return row ?? null;
}

/**
 * What the caller has already shown about who the invited address belongs to, when a user with
 * that address exists. `acceptInvite` re-checks it inside its transaction against the locked user
 * row, so a password reset or a Google hand-over that commits in between cannot slip past.
 */
export type AcceptProof =
  /** A live session of that user (`sessions.id`). */
  | { via: 'session'; sessionId: string }
  /** The password hash the user's password was just verified against. */
  | { via: 'password'; passwordHash: string }
  /** The Google account (`sub`) the user has connected. */
  | { via: 'google'; googleSub: string };

export type AcceptInviteInput = {
  tokenHash: string;
  now: Date;
  /** Made when no user has the invite's address yet. The invite proves they read that inbox, so the email counts as confirmed. */
  newUser: { name: string; passwordHash: string | null; googleSub: string | null } | null;
  /** Used when a user with the invite's address exists. */
  proof: AcceptProof | null;
};

export type AcceptedInvite = {
  inviteId: string;
  email: string;
  user: AuthUser;
  company: AuthCompany;
  role: Role;
  membershipId: string;
};

async function assertProof(tx: Tx, user: AuthUser, proof: AcceptProof, now: Date): Promise<void> {
  let holds: boolean;
  switch (proof.via) {
    case 'password':
      holds = user.passwordHash !== null && user.passwordHash === proof.passwordHash;
      break;
    case 'google':
      holds = user.googleSub !== null && user.googleSub === proof.googleSub;
      break;
    case 'session': {
      // FOR SHARE: a logout or "sign out everywhere" has to wait for this transaction, not slip in
      // between the check and the commit.
      const [live] = await tx
        .select({ id: sessions.id })
        .from(sessions)
        .where(and(eq(sessions.id, proof.sessionId), eq(sessions.userId, user.id), gt(sessions.expiresAt, now)))
        .limit(1)
        .for('share');
      holds = live !== undefined;
      break;
    }
  }
  if (!holds) throw new SignInRequiredError();
}

/**
 * Accepts an invitation. ONE transaction does all of it, so a token is used at most once even when
 * requests race, and a failure part-way leaves the invite pending:
 * 1. Claims the invite with a single guarded UPDATE (`accepted_at is null and expires_at > now`).
 *    Of any number of simultaneous requests exactly one gets the row; the rest get
 *    InviteUnavailableError.
 * 2. Locks the user with the invite's address (FOR SHARE) and either checks the caller's `proof`
 *    against it, or, when there is no such user yet, creates one with the email confirmed.
 *    - A user appeared since the caller looked: EmailInUseError (the caller looks again).
 *    - The proof does not hold: SignInRequiredError.
 *    - The Google account belongs to another user: GoogleSubInUseError.
 * 3. Creates the ACTIVE membership with the invited role, or turns a disabled/invited one on again
 *    with that role. Spend approval always starts off. An already active member:
 *    AlreadyMemberError, and the invite is left pending.
 */
export async function acceptInvite(system: Db, input: AcceptInviteInput): Promise<AcceptedInvite> {
  try {
    return await system.transaction(async (tx) => {
      const [invite] = await tx
        .update(invites)
        .set({ acceptedAt: input.now })
        .where(
          and(eq(invites.tokenHash, input.tokenHash), isNull(invites.acceptedAt), gt(invites.expiresAt, input.now)),
        )
        .returning({ id: invites.id, companyId: invites.companyId, email: invites.email, role: invites.role });
      if (!invite) throw new InviteUnavailableError();

      const [found] = await tx
        .select(USER_COLUMNS)
        .from(users)
        .where(eq(users.email, invite.email))
        .limit(1)
        .for('share');
      let user: AuthUser;
      if (found) {
        if (!input.proof) throw new EmailInUseError();
        await assertProof(tx, found, input.proof, input.now);
        user = found;
      } else {
        if (!input.newUser) throw new SignInRequiredError();
        const [created] = await tx
          .insert(users)
          .values({
            email: invite.email,
            name: input.newUser.name,
            passwordHash: input.newUser.passwordHash,
            googleSub: input.newUser.googleSub,
            emailVerifiedAt: input.now,
          })
          .returning(USER_COLUMNS);
        user = created!;
      }

      const [existing] = await tx
        .select({ id: memberships.id, status: memberships.status })
        .from(memberships)
        .where(and(eq(memberships.companyId, invite.companyId), eq(memberships.userId, user.id)))
        .limit(1)
        .for('update');
      let membershipId: string;
      if (existing) {
        if (existing.status === 'active') throw new AlreadyMemberError();
        await tx
          .update(memberships)
          .set({ role: invite.role, canApproveSpend: false, status: 'active' })
          .where(eq(memberships.id, existing.id));
        membershipId = existing.id;
      } else {
        const [created] = await tx
          .insert(memberships)
          .values({
            companyId: invite.companyId,
            userId: user.id,
            role: invite.role,
            canApproveSpend: false,
            status: 'active',
          })
          .returning({ id: memberships.id });
        membershipId = created!.id;
      }

      const [company] = await tx
        .select({ id: companies.id, name: companies.name, slug: companies.slug, status: companies.status })
        .from(companies)
        .where(eq(companies.id, invite.companyId));
      return {
        inviteId: invite.id,
        email: invite.email,
        user,
        company: company!,
        role: invite.role,
        membershipId,
      };
    });
  } catch (err) {
    if (isUniqueViolation(err, 'users_email_unique')) throw new EmailInUseError();
    if (isUniqueViolation(err, 'users_google_sub_unique')) throw new GoogleSubInUseError();
    if (isUniqueViolation(err, 'memberships_company_user_uniq')) throw new AlreadyMemberError();
    throw err;
  }
}

export type MemberSnapshot = { role: Role; canApproveSpend: boolean; status: MembershipStatus };

export type MembershipChanges = {
  role?: Role;
  canApproveSpend?: boolean;
  /** `invited` is not something a person can set. */
  status?: 'active' | 'disabled';
};

export type MembershipUpdate = {
  id: string;
  userId: string;
  name: string;
  email: string;
  before: MemberSnapshot;
  after: MemberSnapshot;
};

/**
 * Changes one membership of `companyId`, in ONE transaction. Null when the membership does not
 * exist in that company (another company's id looks exactly the same).
 *
 * The last active owner: a change that would leave the company without an active owner throws
 * LastOwnerError. Two owners stepping down at the same moment must not both succeed, so every
 * change first locks ALL of the company's owner memberships (FOR UPDATE, in id order) and only
 * then counts the active ones. The second request waits for the lock, then sees the first one's
 * committed result and is refused. The target row is locked after the owners, always in that
 * order, so concurrent changes cannot deadlock.
 *
 * `canApproveSpend` means something only for the office role (an owner always may, a rep never
 * may). It can be stored on any role, but a role change takes it back to false unless the same
 * request says otherwise, so a delegation does not follow someone to a different job.
 *
 * Disabling also deletes the user's sessions that are working in THIS company, in the same
 * transaction (their sessions in other companies stay). Turning someone back on does not bring
 * those back; they sign in again.
 *
 * `beforeCommit` runs after the change and before the commit; if it throws, nothing is saved. The
 * route uses it to write the audit row, so a change never exists without one.
 */
export async function updateMembership(
  system: Db,
  input: { companyId: string; membershipId: string; changes: MembershipChanges },
  beforeCommit?: (update: MembershipUpdate) => Promise<void>,
): Promise<MembershipUpdate | null> {
  return system.transaction(async (tx) => {
    // Selected only to take the locks; the count further down runs after them.
    await tx
      .select({ id: memberships.id })
      .from(memberships)
      .where(and(eq(memberships.companyId, input.companyId), eq(memberships.role, 'owner')))
      .orderBy(asc(memberships.id))
      .for('update');

    const [target] = await tx
      .select({
        id: memberships.id,
        userId: memberships.userId,
        role: memberships.role,
        canApproveSpend: memberships.canApproveSpend,
        status: memberships.status,
      })
      .from(memberships)
      .where(and(eq(memberships.id, input.membershipId), eq(memberships.companyId, input.companyId)))
      .limit(1)
      .for('update');
    if (!target) return null;

    const before: MemberSnapshot = { role: target.role, canApproveSpend: target.canApproveSpend, status: target.status };
    const { changes } = input;
    const role = changes.role ?? before.role;
    const after: MemberSnapshot = {
      role,
      canApproveSpend: changes.canApproveSpend ?? (role === before.role ? before.canApproveSpend : false),
      status: changes.status ?? before.status,
    };

    const wasActiveOwner = before.role === 'owner' && before.status === 'active';
    const staysActiveOwner = after.role === 'owner' && after.status === 'active';
    if (wasActiveOwner && !staysActiveOwner) {
      const activeOwners = await tx
        .select({ id: memberships.id })
        .from(memberships)
        .where(
          and(
            eq(memberships.companyId, input.companyId),
            eq(memberships.role, 'owner'),
            eq(memberships.status, 'active'),
          ),
        );
      if (!activeOwners.some((o) => o.id !== target.id)) throw new LastOwnerError();
    }

    if (after.role !== before.role || after.canApproveSpend !== before.canApproveSpend || after.status !== before.status) {
      await tx.update(memberships).set(after).where(eq(memberships.id, target.id));
    }
    if (after.status === 'disabled') {
      await tx
        .delete(sessions)
        .where(and(eq(sessions.userId, target.userId), eq(sessions.activeCompanyId, input.companyId)));
    }

    const [person] = await tx
      .select({ name: users.name, email: users.email })
      .from(users)
      .where(eq(users.id, target.userId));
    const result: MembershipUpdate = {
      id: target.id,
      userId: target.userId,
      name: person!.name,
      email: person!.email,
      before,
      after,
    };
    await beforeCommit?.(result);
    return result;
  });
}
