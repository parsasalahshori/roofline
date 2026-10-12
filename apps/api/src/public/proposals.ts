import { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import {
  declineProposal,
  publicProposalView,
  recordProposalEvent,
  signedPdfFile,
  withTenant,
} from '@roofline/db';
import type { AppDeps } from '../app.ts';
import { AppError } from '../errors.ts';
import { parse, noNul } from '../validate.ts';
import { handleProposalError, ipHashFor, publicProposalHeaders, resolveLink } from './proposal-common.ts';

const viewBody = z.object({ optionId: z.uuid().optional() });
const declineBody = z.object({
  reason: z
    .string()
    .max(500)
    .refine(noNul)
    .optional()
    .transform((value) => {
      const trimmed = value?.trim() ?? '';
      return trimmed === '' ? null : trimmed;
    }),
});

const bodyOf = (req: Request): unknown => (req.body === undefined || req.body === null ? {} : req.body);

/**
 * The homeowner's proposal link, signed out, under `/api/public/proposals`. The token is the only
 * credential: it is hashed and resolved through the system pool, then everything is read inside
 * withTenant for that one company. Signing lives in proposal-sign.ts.
 */
export function publicProposalRoutes(deps: AppDeps): Router {
  const router = Router();
  router.use(publicProposalHeaders);

  const route = (fn: (req: Request, res: Response) => Promise<void>): RequestHandler => {
    return (req: Request, res: Response, next: NextFunction): void => {
      fn(req, res).catch((err: unknown) => handleProposalError(err, res, next));
    };
  };
  const tokenOf = (req: Request): string => String(req.params['token'] ?? '');

  router.get('/:token', route(async (req, res) => {
    const now = deps.clock.now();
    const link = await resolveLink(deps, tokenOf(req), now);
    const view = await withTenant(deps.pools, link.ctx, (tx) => publicProposalView(tx, link.ctx, link.proposalId, now));
    res.json(view);
  }));

  router.post('/:token/view', route(async (req, res) => {
    const now = deps.clock.now();
    const link = await resolveLink(deps, tokenOf(req), now);
    const body = parse(viewBody, bodyOf(req));
    const ipHash = ipHashFor(req, link.ctx.companyId);
    const userAgent = (req.get('user-agent') ?? '').slice(0, 300);
    await withTenant(deps.pools, link.ctx, async (tx) => {
      await recordProposalEvent(tx, link.ctx, link.proposalId, { kind: 'viewed', ipHash, userAgent }, now);
      if (body.optionId !== undefined) {
        await recordProposalEvent(tx, link.ctx, link.proposalId, { kind: 'option_viewed', data: { optionId: body.optionId }, ipHash, userAgent }, now);
      }
    });
    res.status(204).end();
  }));

  router.post('/:token/decline', route(async (req, res) => {
    const now = deps.clock.now();
    const link = await resolveLink(deps, tokenOf(req), now);
    const body = parse(declineBody, bodyOf(req));
    const result = await withTenant(deps.pools, link.ctx, (tx) => declineProposal(tx, link.ctx, link.proposalId, body.reason, now));
    if (result === 'closed') throw new AppError(409, 'This proposal can no longer be declined.');
    res.status(204).end();
  }));

  router.get('/:token/signed.pdf', route(async (req, res) => {
    const link = await resolveLink(deps, tokenOf(req), deps.clock.now());
    const notReady = (): never => {
      throw new AppError(404, "The signed copy isn't ready yet.");
    };
    const file = await withTenant(deps.pools, link.ctx, (tx) => signedPdfFile(tx, link.ctx, link.proposalId));
    if (file === null) return notReady();
    const bytes = await deps.objectStore.get(file.objectKey);
    if (bytes === null) return notReady();
    res.setHeader('Content-Type', file.contentType);
    res.setHeader('Content-Disposition', 'inline; filename="proposal.pdf"');
    res.send(Buffer.from(bytes));
  }));

  return router;
}
