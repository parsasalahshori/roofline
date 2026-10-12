import { Router } from 'express';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { audit, billingFacts, withTenant } from '@roofline/db';
import { ROLES, type Role } from '@roofline/shared';
import type { AppDeps } from '../app.ts';
import { createBackground } from '../background.ts';
import { AppError, MESSAGES } from '../errors.ts';
import { requireVerifiedEmail } from '../auth/middleware.ts';
import {
  AlreadyMemberError,
  createInvite,
  LastOwnerError,
  listInvites,
  listStormAlertFlags,
  updateMember,
} from '../auth/team-store.ts';
import { can, requireCapability } from '../permissions.ts';
import { inviteRateLimit } from '../rate-limit.ts';
import { assertKnownFields, emailField, parse, UUID } from '../validate.ts';

const ROLE_MESSAGE = 'Please pick a role.';
/** A company younger than this gets the smaller invite allowance (see `inviteRateLimit`). */
const NEW_COMPANY_MS = 24 * 60 * 60 * 1000;

const InviteBody = z.object({
  email: emailField,
  role: z.enum(ROLES, { error: ROLE_MESSAGE }),
});

const MEMBER_FIELDS = ['role', 'canApproveSpend', 'status', 'stormAlertEmail'] as const;

const MemberPatchBody = z.object({
  role: z.enum(ROLES, { error: ROLE_MESSAGE }).optional(),
  canApproveSpend: z.boolean({ error: 'Please choose yes or no.' }).optional(),
  status: z.enum(['active', 'disabled'], { error: 'Please choose active or disabled.' }).optional(),
  stormAlertEmail: z.boolean({ error: 'Please choose yes or no.' }).optional(),
});

/** How the invite email names the job. */
const ROLE_PHRASE: Record<Role, string> = {
  owner: 'an owner',
  office: 'office staff',
  rep: 'a sales rep',
};

function inviteText(companyName: string, role: Role, link: string): string {
  return [
    `${companyName} invited you to join their team on Roofline as ${ROLE_PHRASE[role]}.`,
    '',
    'Open this link to accept:',
    link,
    '',
    "The link works for 7 days. If you weren't expecting this, you can ignore this email.",
  ].join('\n');
}

/**
 * `/api/team`: the member list, invitations, and changes to a member. Reading is open to every
 * member; changing anything needs `company_admin` (the owner). The permission checks come before
 * anything else on a route, so a role that may not change the team learns nothing from the error.
 */
export function teamRoutes(deps: AppDeps, logError: (err: unknown, path: string) => void): Router {
  const { pools, config, clock } = deps;
  const { queueMail } = createBackground(deps, logError);
  const router = Router();

  router.get('/', async (req, res) => {
    const { ctx } = req;
    // The company_members view is the only way app_tenant sees names and emails; it is already
    // filtered to this company.
    const result = await withTenant(pools, ctx, (tx) =>
      tx.execute(sql`select id, user_id, name, email, role, status, can_approve_spend from company_members order by name, id`),
    );
    // The storm alert switch is not in company_members; it is read from memberships (system pool).
    const alertFlags = await listStormAlertFlags(pools.system, ctx.companyId);
    const members = result.rows.map((r) => ({
      id: r.id as string,
      userId: r.user_id as string,
      name: r.name as string,
      email: r.email as string,
      role: r.role as Role,
      // Only meaningful for the office role (see permissions.ts); shown as stored for everyone.
      canApproveSpend: r.can_approve_spend as boolean,
      status: r.status as string,
      stormAlertEmail: alertFlags.get(r.id as string) ?? true,
    }));
    // Who has been invited is for the people who manage the team.
    const pending = can(ctx, 'company_admin') ? await listInvites(pools.system, ctx.companyId, clock.now()) : [];
    res.json({
      members,
      invites: pending.map((i) => ({ id: i.id, email: i.email, role: i.role, expiresAt: i.expiresAt })),
    });
  });

  router.post(
    '/invites',
    requireCapability('company_admin'),
    requireVerifiedEmail,
    ...inviteRateLimit(async (req) => {
      const { createdAt } = await withTenant(pools, req.ctx, (tx) => billingFacts(tx, req.ctx));
      return clock.now().getTime() - createdAt.getTime() < NEW_COMPANY_MS;
    }),
    async (req, res) => {
      const { ctx } = req;
      const body = parse(InviteBody, req.body);
      const now = clock.now();
      let created;
      try {
        created = await createInvite(
          pools.system,
          { companyId: ctx.companyId, email: body.email, role: body.role, now },
          (invite) =>
            withTenant(pools, ctx, (tx) =>
              audit(tx, ctx, {
                action: 'invite.create',
                targetType: 'invite',
                targetId: invite.id,
                after: { email: invite.email, role: invite.role, expiresAt: invite.expiresAt.toISOString() },
                ip: req.ip ?? null,
                at: now,
              }),
            ),
        );
      } catch (err) {
        if (err instanceof AlreadyMemberError) throw new AppError(409, MESSAGES.alreadyOnTeam);
        throw err;
      }
      const { invite, token } = created;

      // The invite is saved; the email goes out after the answer, and a mail failure is logged, not shown.
      queueMail(
        {
          to: invite.email,
          subject: `You're invited to join ${invite.companyName.replace(/\s+/g, ' ').trim()} on Roofline`,
          text: inviteText(invite.companyName, invite.role, `${config.APP_ORIGIN}/invite?token=${token}`),
        },
        req.path,
      );
      res.status(201).json({ id: invite.id, email: invite.email, role: invite.role, expiresAt: invite.expiresAt });
    },
  );

  router.patch('/members/:membershipId', requireCapability('company_admin'), async (req, res) => {
    const { ctx } = req;
    const rawId = req.params.membershipId;
    const membershipId = (typeof rawId === 'string' ? rawId : '').toLowerCase();
    // Another company's membership, one that does not exist and a malformed id all look the same.
    if (!UUID.test(membershipId)) throw new AppError(404, MESSAGES.notFound);
    const changes = parse(MemberPatchBody, assertKnownFields(req.body, MEMBER_FIELDS));

    // `canApproveSpend` is only meaningful for the office role. It is accepted for an owner or a
    // rep and stored, but `can()` ignores it for them (an owner always may, a rep never).
    const now = clock.now();
    let updated;
    try {
      updated = await updateMember(
        pools.system,
        {
          companyId: ctx.companyId,
          membershipId,
          // Only what was sent: an absent field must not be read as "false".
          changes: {
            ...(changes.role !== undefined && { role: changes.role }),
            ...(changes.canApproveSpend !== undefined && { canApproveSpend: changes.canApproveSpend }),
            ...(changes.status !== undefined && { status: changes.status }),
            ...(changes.stormAlertEmail !== undefined && { stormAlertEmail: changes.stormAlertEmail }),
          },
        },
        (member) =>
          withTenant(pools, ctx, (tx) =>
            audit(tx, ctx, {
              action: 'member.update',
              targetType: 'membership',
              targetId: member.id,
              before: member.before,
              after: member.after,
              ip: req.ip ?? null,
              at: now,
            }),
          ),
      );
    } catch (err) {
      if (err instanceof LastOwnerError) throw new AppError(400, MESSAGES.lastOwner);
      throw err;
    }
    if (!updated) throw new AppError(404, MESSAGES.notFound);

    res.json({
      id: updated.id,
      userId: updated.userId,
      name: updated.name,
      email: updated.email,
      role: updated.after.role,
      canApproveSpend: updated.after.canApproveSpend,
      status: updated.after.status,
      stormAlertEmail: updated.after.stormAlertEmail,
    });
  });

  return router;
}
