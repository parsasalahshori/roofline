import { createHash } from 'node:crypto';
import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { publicProposalState, publicProposalView, signProposal, withTenant } from '@roofline/db';
import { CONSENT_TEXT_V1, canonicalJson, signedDocument, type SignatureRecord } from '@roofline/shared';
import type { AppDeps } from '../app.ts';
import { AppError, MESSAGES } from '../errors.ts';
import { parse } from '../validate.ts';
import { handleProposalError, publicProposalHeaders, resolveLink, tokenHashOf } from './proposal-common.ts';

/** Signing a proposal, signed out, under `/api/public/proposals`. */

const HOUR_MS = 60 * 60 * 1000;
const SIGN_ATTEMPTS_PER_TOKEN_PER_HOUR = 10;
const MAX_DRAWN_CHARS = 200_000;
const MAX_USER_AGENT = 300;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

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

export function proposalSignRoutes(deps: AppDeps): Router {
  const router = Router();
  router.use(publicProposalHeaders);

  const perToken = rateLimit({
    windowMs: HOUR_MS,
    limit: SIGN_ATTEMPTS_PER_TOKEN_PER_HOUR,
    standardHeaders: false,
    legacyHeaders: false,
    validate: { keyGeneratorIpFallback: false },
    keyGenerator: (req) => `token:${tokenHashOf(String(req.params['token'] ?? '')).toString('hex')}`,
    handler: (_req, _res, next) => {
      next(new AppError(429, MESSAGES.tooFast));
    },
  });

  router.post('/:token/sign', perToken, async (req, res, next) => {
    try {
      const body = parse(signBody, req.body);
      let drawnHash: string | null = null;
      if (body.drawnSignature !== undefined) {
        const png = Buffer.from(body.drawnSignature, 'base64');
        if (png.length < PNG_MAGIC.length || !png.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) {
          throw new AppError(400, DRAW_AGAIN);
        }
        drawnHash = sha256Hex(png);
      }

      const now = deps.clock.now();
      const link = await resolveLink(deps, String(req.params['token'] ?? ''), now);
      const { ctx, proposalId } = link;

      const outcome = await withTenant(deps.pools, ctx, async (tx) => {
        const view = await publicProposalView(tx, ctx, proposalId, now);
        const state = await publicProposalState(tx, ctx, proposalId);
        if (state === null) throw new AppError(404, "This proposal link doesn't work.");
        if (view.status === 'signed') throw new AppError(409, ALREADY_SIGNED);
        if (view.status !== 'open') throw new AppError(409, EXPIRED);
        const option = view.options.find((o) => o.id === body.optionId);
        if (!option) throw new AppError(400, PICK_OPTION, 'optionId');

        const record: SignatureRecord = {
          optionId: option.id,
          signerName: body.signerName,
          typedSignature: body.typedSignature,
          drawnSignaturePngSha256: drawnHash,
          consentText: CONSENT_TEXT_V1,
          consentVersion: 'v1',
          documentSha256: sha256Hex(canonicalJson(signedDocument(view, option.id, state.estimateClause))),
          totalCents: option.totalCents,
          ip: req.ip ?? '',
          userAgent: (req.get('User-Agent') ?? '').slice(0, MAX_USER_AGENT),
          signedAt: now.toISOString(),
          viewedFirstAt: null,
        };
        return signProposal(tx, ctx, proposalId, record, now);
      });

      if (outcome === 'already_signed') throw new AppError(409, ALREADY_SIGNED);
      if (outcome === 'closed') throw new AppError(409, EXPIRED);
      await deps.jobs.send('signed-pdf', { companyId: ctx.companyId, proposalId }, { singletonKey: proposalId });
      res.json({ signed: true });
    } catch (err) {
      handleProposalError(err, res, next);
    }
  });

  return router;
}
