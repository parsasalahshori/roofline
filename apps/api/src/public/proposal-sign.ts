import { createHash } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { publicProposalState, publicProposalView, recordSignedDocument, signProposal, type TenantContext, withTenant } from '@roofline/db';
import { CONSENT_TEXT_V1, canonicalJson, signedDocument, type SignatureRecord } from '@roofline/shared';
import type { AppDeps } from '../app.ts';
import { AppError } from '../errors.ts';
import { isAcceptableSignaturePng } from '../estimator/signature-png.ts';
import { drawnSignatureKey } from '../estimator/signed-pdf.ts';
import { parse } from '../validate.ts';
import { handleProposalError, perTokenRateLimit, proposalIpHashFor, publicProposalHeaders, resolveLink } from './proposal-common.ts';

/** Signing a proposal, signed out, under `/api/public/proposals`. */

const HOUR_MS = 60 * 60 * 1000;
const SIGN_ATTEMPTS_PER_TOKEN_PER_HOUR = 10;
const MAX_DRAWN_CHARS = 200_000;
const MAX_USER_AGENT = 300;

const ALREADY_SIGNED = 'This proposal is already signed.';
const EXPIRED = 'This proposal has expired.';
const PICK_OPTION = 'Pick an option.';
const NAME_MESSAGE = 'Type your full name.';
const CONSENT_MESSAGE = 'Check the box to agree to sign electronically.';
const TOO_LARGE = 'That drawing is too large.';
const DRAW_AGAIN = 'Draw your signature again.';

const sha256Hex = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');

const signBody = z.object({
  optionId: z.uuid(PICK_OPTION),
  consent: z.literal(true, CONSENT_MESSAGE),
  signerName: z.string(NAME_MESSAGE).trim().min(1, NAME_MESSAGE).max(120, NAME_MESSAGE),
  typedSignature: z.string(NAME_MESSAGE).trim().min(1, NAME_MESSAGE).max(120, NAME_MESSAGE),
  // Raw base64, no "data:" prefix.
  drawnSignature: z
    .string(DRAW_AGAIN)
    .max(MAX_DRAWN_CHARS, TOO_LARGE)
    .regex(/^[A-Za-z0-9+/]+={0,2}$/, DRAW_AGAIN)
    .optional(),
});

/** What the homeowner chose and typed, with the drawn signature already checked (`isAcceptableSignaturePng`). */
export type SignInput = {
  optionId: string;
  signerName: string;
  typedSignature: string;
  drawn: { png: Buffer; sha256: string } | null;
};

/**
 * Signs a proposal whose link was already resolved: stores the drawn image, records the signature and the exact
 * signed document, and queues the signed PDF. Throws AppError 404/409/400 as the public route answers them. The
 * public sign route and the demo's "homeowner signs" simulation both come through here.
 */
export async function signResolvedProposal(
  deps: AppDeps,
  link: { ctx: TenantContext; proposalId: string },
  body: SignInput,
  meta: { ip: string; userAgent: string },
): Promise<void> {
  const { ctx, proposalId } = link;
  const { drawn } = body;
  const drawnHash = drawn?.sha256 ?? null;
  const now = deps.clock.now();

  // The image is stored before the signature commits, so a recorded hash always has its image (the
  // signed PDF draws it). The key is content-addressed: a retried or refused sign leaves the same object.
  if (drawn !== null) {
    await deps.objectStore.put(drawnSignatureKey(ctx.companyId, proposalId, drawn.sha256), drawn.png, 'image/png');
  }

  const outcome = await withTenant(deps.pools, ctx, async (tx) => {
    const view = await publicProposalView(tx, ctx, proposalId, now);
    const state = await publicProposalState(tx, ctx, proposalId);
    if (state === null) throw new AppError(404, "This proposal link doesn't work.");
    if (view.status === 'signed') throw new AppError(409, ALREADY_SIGNED);
    if (view.status !== 'open') throw new AppError(409, EXPIRED);
    const option = view.options.find((o) => o.id === body.optionId);
    if (!option) throw new AppError(400, PICK_OPTION, 'optionId');

    // The exact document hashed is also stored with the signature (Ruling ER), so the proof can be
    // re-checked and the signed PDF prints these facts, whatever changes in settings later.
    const document = signedDocument(view, option.id, view.estimateClause);
    const record: SignatureRecord = {
      optionId: option.id,
      signerName: body.signerName,
      typedSignature: body.typedSignature,
      drawnSignaturePngSha256: drawnHash,
      consentText: CONSENT_TEXT_V1,
      consentVersion: 'v1',
      documentSha256: sha256Hex(canonicalJson(document)),
      totalCents: option.totalCents,
      ip: meta.ip,
      userAgent: meta.userAgent.slice(0, MAX_USER_AGENT),
      signedAt: now.toISOString(),
      viewedFirstAt: null,
    };
    const ipHash = proposalIpHashFor(deps.config, record.ip, ctx.companyId);
    const signed = await signProposal(tx, ctx, proposalId, { ...record, ipHash }, now);
    if (signed === 'signed') await recordSignedDocument(tx, ctx, proposalId, document);
    return signed;
  });

  if (outcome === 'already_signed') throw new AppError(409, ALREADY_SIGNED);
  if (outcome === 'closed') throw new AppError(409, EXPIRED);
  await deps.jobs.send('signed-pdf', { companyId: ctx.companyId, proposalId }, { singletonKey: proposalId });
}

export function proposalSignRoutes(deps: AppDeps): Router {
  const router = Router();
  router.use(publicProposalHeaders);

  const perToken = perTokenRateLimit(SIGN_ATTEMPTS_PER_TOKEN_PER_HOUR, HOUR_MS);

  router.post('/:token/sign', perToken, async (req, res, next) => {
    try {
      const body = parse(signBody, req.body);
      let drawn: { png: Buffer; sha256: string } | null = null;
      if (body.drawnSignature !== undefined) {
        const png = Buffer.from(body.drawnSignature, 'base64');
        // Checked in full (chunks, size, and the image data inflated to exactly its expected length) before it
        // is stored or signed: a bad PNG must never reach the signed PDF's renderer (signature-png.ts).
        if (!isAcceptableSignaturePng(png)) throw new AppError(400, DRAW_AGAIN, 'drawnSignature');
        drawn = { png, sha256: sha256Hex(png) };
      }
      const now = deps.clock.now();
      const link = await resolveLink(deps, String(req.params['token'] ?? ''), now);
      await signResolvedProposal(deps, link, { ...body, drawn }, { ip: req.ip ?? '', userAgent: req.get('User-Agent') ?? '' });
      res.json({ signed: true });
    } catch (err) {
      handleProposalError(err, res, next);
    }
  });

  return router;
}
