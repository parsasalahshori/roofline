import type { Db } from '@roofline/db';
import {
  acceptInvite as acceptInviteRow,
  type AcceptedInvite,
  type AcceptProof,
  type CreatedInvite,
  findPendingInvite,
  type InviteToAccept,
  insertInvite,
  InviteUnavailableError,
  listPendingInvites,
  type MembershipChanges,
  type MembershipUpdate,
  type PendingInvite,
  updateMembership,
} from '@roofline/db/system';
import type { Role } from '@roofline/shared';
import { generateToken, hashToken, isWellFormedToken } from './sessions.ts';

/*
 * The only module that writes memberships and invitations. The routes (routes/team.ts and the
 * accept-invite route in auth/routes.ts) call these and never import @roofline/db/system for
 * team data themselves. Tokens are made and stored the way session and email-link tokens are:
 * 32 random bytes as base64url, only the sha256 in the database.
 * Every function takes the app clock's time from its caller; none reads the system clock.
 */

export {
  AlreadyMemberError,
  InviteUnavailableError,
  LastOwnerError,
  SignInRequiredError,
} from '@roofline/db/system';
export type {
  AcceptedInvite,
  AcceptProof,
  CreatedInvite,
  InviteToAccept,
  MembershipChanges,
  MembershipUpdate,
  PendingInvite,
};

const DAY_MS = 24 * 60 * 60 * 1000;
/** An invite link works for 7 days. */
export const INVITE_TTL_MS = 7 * DAY_MS;

/**
 * Invites `email` to the company with `role` and returns the raw token for the email link. No
 * membership is created now; it is created when the invite is accepted. An earlier unaccepted
 * invite to the same address is deleted, so only the newest link works. Throws AlreadyMemberError
 * for someone who is already an active member. `beforeCommit` runs inside the transaction, so the
 * audit row and the invite are saved together.
 */
export async function createInvite(
  system: Db,
  input: { companyId: string; email: string; role: Role; now: Date },
  beforeCommit?: (invite: CreatedInvite) => Promise<void>,
): Promise<{ invite: CreatedInvite; token: string }> {
  const token = generateToken();
  const invite = await insertInvite(
    system,
    {
      companyId: input.companyId,
      email: input.email,
      role: input.role,
      tokenHash: hashToken(token),
      expiresAt: new Date(input.now.getTime() + INVITE_TTL_MS),
    },
    beforeCommit,
  );
  return { invite, token };
}

/** The company's pending invites: not accepted and not expired at `now`. */
export function listInvites(system: Db, companyId: string, now: Date): Promise<PendingInvite[]> {
  return listPendingInvites(system, companyId, now);
}

/** The pending invite behind an emailed token, or null for one that is malformed, unknown, used or expired. */
export async function lookUpInvite(system: Db, token: string, now: Date): Promise<InviteToAccept | null> {
  if (!isWellFormedToken(token)) return null;
  return findPendingInvite(system, hashToken(token), now);
}

/**
 * Accepts the invite behind `token`: marks it used, makes (or finds) the user, and makes the
 * membership active with the invited role, all in one transaction. See `acceptInvite` in
 * @roofline/db/system for the errors it can throw.
 */
export async function acceptInvite(
  system: Db,
  input: {
    token: string;
    now: Date;
    newUser: { name: string; passwordHash: string | null; googleSub: string | null } | null;
    proof: AcceptProof | null;
  },
): Promise<AcceptedInvite> {
  if (!isWellFormedToken(input.token)) throw new InviteUnavailableError();
  return acceptInviteRow(system, {
    tokenHash: hashToken(input.token),
    now: input.now,
    newUser: input.newUser,
    proof: input.proof,
  });
}

/**
 * Changes a member's role, spend delegation or status (disabling also ends their sessions in this
 * company). Null when the membership is not in this company. Throws LastOwnerError rather than
 * leave the company without an active owner. `beforeCommit` runs inside the transaction, so the
 * audit row and the change are saved together.
 */
export function updateMember(
  system: Db,
  input: { companyId: string; membershipId: string; changes: MembershipChanges },
  beforeCommit?: (update: MembershipUpdate) => Promise<void>,
): Promise<MembershipUpdate | null> {
  return updateMembership(system, input, beforeCommit);
}
