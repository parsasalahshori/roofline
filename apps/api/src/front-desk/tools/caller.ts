import { matchCustomersByPhone, verifyCustomerByNameStreet, withTenant, type TenantContext } from '@roofline/db';
import type { ConversationState, ToolContext, ToolHandler } from '../engine-types.ts';

/*
 * D1 Task 7: who is calling. identifyCaller matches the caller's phone number to exactly one customer
 * of this company; verifyCaller checks the name and street the caller gives. Neither result ever says
 * which half of a failed check was wrong.
 */

const MAX_FAILURES = 3;

/** Failed verification attempts per conversation, in memory only. */
const failures = new WeakMap<ConversationState, number>();

function tenantCtx(companyId: string): TenantContext {
  return { companyId, userId: null, role: 'system', canApproveSpend: false };
}

/** Called at conversation start: exactly one customer with this phone number sets customerId and 'matched'. */
export async function identifyCaller(ctx: ToolContext): Promise<void> {
  const tctx = tenantCtx(ctx.companyId);
  const matches = await withTenant(ctx.deps.pools, tctx, (tx) => matchCustomersByPhone(tx, tctx, ctx.conversation.phone));
  const only = matches.length === 1 ? matches[0] : undefined;
  if (only && ctx.conversation.identity !== 'verified') {
    ctx.conversation.customerId = only.customerId;
    ctx.conversation.identity = 'matched';
  }
}

export const verifyCaller: ToolHandler<'verify_caller'> = async (ctx, input) => {
  const conversation = ctx.conversation;
  if (conversation.identity === 'verified' && conversation.customerId !== null) {
    return { ok: true, forModel: 'The caller is already verified.' };
  }
  const tctx = tenantCtx(ctx.companyId);
  const candidates = await withTenant(ctx.deps.pools, tctx, async (tx) => {
    if (conversation.customerId !== null) return [conversation.customerId];
    const matches = await matchCustomersByPhone(tx, tctx, conversation.phone);
    return matches.map((m) => m.customerId);
  });
  if (candidates.length === 0) {
    return { ok: false, forModel: 'There is no customer record for this phone number, so the caller cannot be verified. Offer to take a message or book a new inspection.' };
  }

  let verifiedId: string | null = null;
  await withTenant(ctx.deps.pools, tctx, async (tx) => {
    for (const id of candidates) {
      if (await verifyCustomerByNameStreet(tx, tctx, id, input.name, input.street)) {
        verifiedId = id;
        return;
      }
    }
  });

  if (verifiedId !== null) {
    failures.delete(conversation);
    conversation.customerId = verifiedId;
    conversation.identity = 'verified';
    return { ok: true, forModel: 'The caller is verified. You may now share their job details.' };
  }

  const count = (failures.get(conversation) ?? 0) + 1;
  failures.set(conversation, count);
  if (count >= MAX_FAILURES) {
    return {
      ok: false,
      forModel:
        'That did not match our records, and this was the third try. Do not try again. Suggest a transfer to the team so they can help, or offer to take a message.',
    };
  }
  return { ok: false, forModel: 'That did not match our records. Ask the caller to say their full name and the street address again.' };
};
