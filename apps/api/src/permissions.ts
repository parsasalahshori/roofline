import type { RequestHandler } from 'express';
import type { Role } from '@roofline/shared';
import { AppError, MESSAGES } from './errors.ts';

/** What a member may be allowed to do (spec 3.2). Routes ask for a capability, never for a role. */
export const CAPABILITIES = [
  'billing',
  'company_admin',
  'approve_message',
  'approve_internal',
  'approve_spend',
  'import',
  'view_money_totals',
] as const;

export type Capability = (typeof CAPABILITIES)[number];

/** What `can` needs to know about someone: their role and whether spend approval was delegated to them. */
export type Member = { role: Role | 'system'; canApproveSpend: boolean };

const OFFICE: ReadonlySet<Capability> = new Set(['approve_message', 'approve_internal', 'view_money_totals']);

/**
 * The permission matrix of spec 3.2.
 * - owner: everything.
 * - office: approve messages and internal tasks, see money totals, and approve spend only when the
 *   owner has delegated it (`canApproveSpend`).
 * - rep: nothing that needs a capability.
 * - system (the runner and the scheduler acting for a company, with no signed-in person): nothing.
 *   Those jobs run the steps people approved; they never approve anything themselves.
 *
 * `canApproveSpend` only means something for the office role. It can be stored on an owner or a rep
 * (the API accepts it) but it changes nothing for them: an owner already may, and a rep never may.
 */
export function can(member: Member, cap: Capability): boolean {
  switch (member.role) {
    case 'owner':
      return true;
    case 'office':
      return cap === 'approve_spend' ? member.canApproveSpend : OFFICE.has(cap);
    case 'rep':
    case 'system':
      return false;
  }
}

/**
 * Route guard: 403 "Your role can't do that. Ask the owner." unless the signed-in member has the
 * capability. Mount it after the sign-in gate (which sets `req.ctx` from the live membership, so a
 * role change takes effect on the very next request).
 */
export function requireCapability(cap: Capability): RequestHandler {
  return (req, _res, next) => {
    const ctx = req.ctx as typeof req.ctx | undefined;
    if (!ctx) {
      // Behind the gate this cannot happen; if a route is ever mounted without it, say what is true.
      next(new AppError(401, MESSAGES.signIn));
      return;
    }
    next(can(ctx, cap) ? undefined : new AppError(403, MESSAGES.roleCannot));
  };
}
