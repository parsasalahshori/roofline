import { matchCustomersByPhone, saveCallerIdentity, verifyCustomerByNameStreet, withTenant } from '@roofline/db';
import type { ToolContext, ToolHandler } from '../engine-types.ts';
import { systemCtx } from './system-ctx.ts';

/*
 * D1 Task 7: who is calling. identifyCaller matches the caller's phone number to exactly one customer
 * of this company; verifyCaller checks the name and street the caller gives. Neither result ever says
 * which half of a failed check was wrong.
 */

export const MAX_FAILURES = 3;
export const VERIFY_LOCKED =
  'Verification is locked for this conversation after three failed tries. Do not try again. Suggest a transfer to the team so they can help, or offer to take a message.';

async function persistIdentity(ctx: ToolContext): Promise<void> {
  const c = ctx.conversation;
  try {
    const tctx = systemCtx(ctx.companyId);
    await withTenant(ctx.deps.pools, tctx, (tx) =>
      saveCallerIdentity(tx, tctx, c.conversationId, { identity: c.identity, customerId: c.customerId }),
    );
  } catch (err) {
    ctx.deps.logError?.(err, 'front-desk.identity ' + c.conversationId);
  }
}

/** Called at conversation start: exactly one customer with this phone number sets customerId and 'matched'. */
export async function identifyCaller(ctx: ToolContext): Promise<void> {
  const tctx = systemCtx(ctx.companyId);
  const matches = await withTenant(ctx.deps.pools, tctx, (tx) => matchCustomersByPhone(tx, tctx, ctx.conversation.phone));
  const only = matches.length === 1 ? matches[0] : undefined;
  if (only && ctx.conversation.identity !== 'verified') {
    ctx.conversation.customerId = only.customerId;
    ctx.conversation.identity = 'matched';
    await persistIdentity(ctx);
  }
}

export const verifyCaller: ToolHandler<'verify_caller'> = async (ctx, input) => {
  const conversation = ctx.conversation;
  if (conversation.identity === 'verified' && conversation.customerId !== null) {
    return { ok: true, forModel: 'The caller is already verified.' };
  }
  if ((conversation.verifyFailures ?? 0) >= MAX_FAILURES) return { ok: false, forModel: VERIFY_LOCKED };
  const tctx = systemCtx(ctx.companyId);
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
    conversation.verifyFailures = 0;
    conversation.customerId = verifiedId;
    conversation.identity = 'verified';
    await persistIdentity(ctx);
    return { ok: true, forModel: 'The caller is verified. You may now share their job details.' };
  }

  const count = (conversation.verifyFailures ?? 0) + 1;
  conversation.verifyFailures = count;
  if (count >= MAX_FAILURES) {
    return {
      ok: false,
      forModel:
        'That did not match our records, and this was the third try. Do not try again. Suggest a transfer to the team so they can help, or offer to take a message.',
    };
  }
  return { ok: false, forModel: 'That did not match our records. Ask the caller to say their full name and the street address again.' };
};
