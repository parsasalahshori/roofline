import { randomBytes, createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  customerFirstNames,
  decrypt,
  encrypt,
  findOpenSendTask,
  getCompanyName,
  getProposal,
  lockProposalForSend,
  mintProposalLink,
  setProposalStatus,
  withTenant,
  type TenantContext,
} from '@roofline/db';
import { stepTypes, TIERS, type ProposalView, type Tier } from '@roofline/shared';
import type { Config } from '../config.ts';
import type { AppDeps } from '../app.ts';
import { AppError, MESSAGES } from '../errors.ts';
import { sendOneText } from '../messaging/send-batch.ts';
import { createTask } from '../tasks/service.ts';
import type { StepHandler, StepOutcome } from '../tasks/runner.ts';
import { settleSentProposal, settleUnsentProposal } from './proposal-sent.ts';

/*
 * The Estimator agent's send step (E1 spec): a proposal's text goes to the customer as one approved
 * message, with the homeowner's link to the proposal in it. Drafting the task (`draftProposalSend`) and
 * running its one step (`sendProposalStep`) are here; the texting itself is `sendOneText` (messaging),
 * and what a sent text changes on the proposal and its job is `settleSentProposal` (proposal-sent.ts).
 *
 * The link token is minted once per proposal: 32 random bytes, of which the SHA-256 is stored for the
 * public page's lookup and the token itself encrypted so a resend uses the same link. The token is never
 * logged or put in an error.
 */

export const PROPOSAL_TEXT_TEMPLATE = "Hi {first_name}, it's {company}. Here's your roof proposal for {address}: {link} Reply STOP to opt out.";

const SENT_MESSAGE = 'This proposal was sent. Make a revised proposal to change it.';
const SIGNED_MESSAGE = 'This proposal is signed. Make a new proposal for more work.';
const CLOSED_MESSAGE = "This proposal can't be sent now. Make a revised proposal to change it.";
/** B2: a draft (back from a blocked or failed send, maybe edited since) needs a fresh approval of its new preview. */
export const CHANGED_MESSAGE = 'This proposal changed. Send it again for approval.';
const UNREADABLE = "We couldn't read this proposal text. Please make the proposal again.";
const REFUSED = 'The texting service did not take the proposal text; the step will be tried again.';

/** What the send's transaction decides before the text goes out. */
type Prepared = { kind: 'done' } | { kind: 'needs_attention'; errorPlain: string } | { kind: 'ready'; text: string };

/** The homeowner's link: `${PROPOSAL_LINK_BASE_URL}/p/<token>`. */
export function linkFor(config: Pick<Config, 'PROPOSAL_LINK_BASE_URL'>, token: string): string {
  return `${config.PROPOSAL_LINK_BASE_URL}/p/${token}`;
}

/** The values a proposal text is filled with at send time. `firstName` null (or blank) says "there". */
export type ProposalTextVars = { firstName: string | null; company: string; address: string; link: string };

/**
 * Fills `{first_name}`, `{company}`, `{address}` and `{link}` in one pass, so a value is never read again as
 * a token. Any other token, or one in another case, is left as written.
 */
export function fillProposalText(template: string, vars: ProposalTextVars): string {
  const first = (vars.firstName ?? '').trim();
  const values: Record<string, string> = {
    first_name: first === '' ? 'there' : first,
    company: vars.company,
    address: vars.address,
    link: vars.link,
  };
  return template.replace(/\{(first_name|company|address|link)\}/g, (_match, token: string) => values[token] ?? '');
}

/** A fresh link token: 32 random bytes, base64url. Returns the token, its SHA-256 and the encrypted token. */
function newLinkToken(encryptionKey: string): { hash: Buffer; encrypted: Buffer } {
  const token = randomBytes(32).toString('base64url');
  return {
    hash: createHash('sha256').update(token).digest(),
    encrypted: encrypt(token, encryptionKey),
  };
}

/** Enabled options only, in tier order: the homeowner-facing totals in the step's preview. */
function previewTotals(view: ProposalView): { tier: Tier; totalCents: number }[] {
  return TIERS.flatMap((tier) => view.options.filter((o) => o.enabled && o.tier === tier).map((o) => ({ tier, totalCents: o.totalCents })));
}

/**
 * Makes the proposal's send task: the proposal goes to 'ready' and one `send_proposal` step waits for the
 * approval. Idempotent: a send already queued or under way for this proposal returns its task.
 */
export async function draftProposalSend(deps: AppDeps, ctx: TenantContext, proposalId: string): Promise<{ taskId: string }> {
  const now = deps.clock.now();
  return withTenant(deps.pools, ctx, async (tx) => {
    const locked = await lockProposalForSend(tx, ctx, proposalId);
    if (!locked) throw new AppError(404, MESSAGES.notFound);
    if (locked.status === 'signed') throw new AppError(409, SIGNED_MESSAGE);
    if (locked.status !== 'draft' && locked.status !== 'ready') throw new AppError(409, SENT_MESSAGE);

    const open = await findOpenSendTask(tx, ctx, proposalId);
    if (open !== null) return { taskId: open };

    const view = await getProposal(tx, ctx, proposalId);
    if (!view) throw new AppError(404, MESSAGES.notFound);
    if (locked.status === 'draft') await setProposalStatus(tx, ctx, proposalId, ['draft'], 'ready', now);

    const totals = previewTotals(view);
    const body = view.messageBody.trim() === '' ? PROPOSAL_TEXT_TEMPLATE : view.messageBody;
    const { taskId } = await createTask(
      tx,
      ctx,
      {
        agent: 'estimator',
        kind: 'send_proposal',
        title: `Text proposal ${view.number}`,
        subjectType: 'proposal',
        subjectId: proposalId,
        steps: [
          {
            type: 'send_proposal',
            payload: { proposalId, customerId: view.customer.id, body, basis: view.basis, totals },
          },
        ],
      },
      { now, ip: null },
    );
    return { taskId };
  });
}

/**
 * Runs the send step: mints the link once, fills the text, and hands it to `sendOneText` (one customer,
 * informational, dedupe key `proposal:<id>`). A sent text settles the proposal and its job; a text the gate
 * holds or the provider failed sends the proposal back to draft with the reason; a refused one is tried again.
 */
export const sendProposalStep: StepHandler = async (deps, ctx, step): Promise<StepOutcome> => {
  const parsed = stepTypes.send_proposal.payload.safeParse(step.payload);
  if (!parsed.success) return { status: 'needs_attention', result: {}, errorPlain: UNREADABLE };
  const payload = parsed.data;

  const prepared: Prepared = await withTenant(deps.pools, ctx, async (tx) => {
    const locked = await lockProposalForSend(tx, ctx, payload.proposalId);
    if (!locked) return { kind: 'needs_attention' as const, errorPlain: MESSAGES.notFound };
    if (locked.status === 'signed' || locked.status === 'sent' || locked.status === 'viewed') return { kind: 'done' };
    // Only what the owner approved goes out: a draft may have changed since the preview was made (B2).
    if (locked.status === 'draft') return { kind: 'needs_attention' as const, errorPlain: CHANGED_MESSAGE };
    if (locked.status !== 'ready') return { kind: 'needs_attention' as const, errorPlain: CLOSED_MESSAGE };

    // Mint once: when the proposal has no token yet, a new one is stored; either way the stored one is used.
    const minted = newLinkToken(deps.config.ENCRYPTION_KEY);
    const stored = await mintProposalLink(tx, ctx, payload.proposalId, minted.hash, minted.encrypted);
    const token = decrypt(stored, deps.config.ENCRYPTION_KEY);

    const view = await getProposal(tx, ctx, payload.proposalId);
    if (!view) return { kind: 'needs_attention' as const, errorPlain: MESSAGES.notFound };
    // The prices must still be the ones the approval showed (an older task's retry after a newer send asked again).
    if (!isDeepStrictEqual(previewTotals(view), payload.totals)) return { kind: 'needs_attention' as const, errorPlain: CHANGED_MESSAGE };
    const firstNames = await customerFirstNames(tx, ctx, [payload.customerId]);
    const company = (await getCompanyName(tx, ctx)) ?? '';
    const text = fillProposalText(payload.body, {
      firstName: firstNames.get(payload.customerId) ?? null,
      company,
      address: view.address,
      link: linkFor(deps.config, token),
    });
    return { kind: 'ready' as const, text };
  });

  // Ruling EN: the result counts what was sent (A1 reads it for time saved); an earlier send counts once.
  if (prepared.kind === 'done') return { status: 'done', result: { sent: 1 } };
  if (prepared.kind === 'needs_attention') return { status: 'needs_attention', result: { sent: 0 }, errorPlain: prepared.errorPlain };

  const outcome = await sendOneText(deps, ctx, step, {
    customerId: payload.customerId,
    purpose: 'informational',
    body: prepared.text,
    dedupeKey: `proposal:${payload.proposalId}`,
    bodyRendered: true,
  });

  if (outcome === 'sent') {
    await withTenant(deps.pools, ctx, (tx) => settleSentProposal(tx, ctx, payload.proposalId, deps.clock.now()));
    return { status: 'done', result: { sent: 1 } };
  }
  if (outcome === 'scheduled') return { status: 'running', result: { scheduled: 1 } };
  if (outcome === 'refused') throw new Error(REFUSED);

  // blocked or failed: the text did not go out, so the proposal is a draft again, with the reason.
  const errorPlain = await withTenant(deps.pools, ctx, (tx) =>
    settleUnsentProposal(tx, ctx, { proposalId: payload.proposalId, stepId: step.id, customerId: payload.customerId, blocked: outcome === 'blocked' }, deps.clock.now()),
  );
  if (outcome === 'blocked') return { status: 'needs_attention', result: { sent: 0, blocked: 1 }, errorPlain };
  return { status: 'needs_attention', result: { sent: 0, failed: 1 }, errorPlain };
};
