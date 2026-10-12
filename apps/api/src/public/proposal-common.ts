import { createHash } from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { publicProposalState, withTenant, type TenantContext } from '@roofline/db';
import { resolveProposalToken } from '@roofline/db/system';
import type { ProposalStatus } from '@roofline/shared';
import type { AppDeps } from '../app.ts';
import { AppError } from '../errors.ts';

const NOT_WORKING = "This proposal link doesn't work.";
const GONE = 'This proposal link has expired.';
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{20,64}$/;
const GRACE_MS = 30 * 24 * 60 * 60 * 1000;

/** sha256 of the token string, as a Buffer (matches proposals.link_token_hash). */
export function tokenHashOf(token: string): Buffer {
  return createHash('sha256').update(token).digest();
}

/** First 8 hex chars of the hash: the only thing ever logged about a token. */
export function tokenHashPrefix(hash: Buffer): string {
  return hash.toString('hex').slice(0, 8);
}

/** Cache-Control: no-store, Referrer-Policy: no-referrer, X-Robots-Tag: noindex. */
export const publicProposalHeaders: RequestHandler = (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Robots-Tag', 'noindex');
  next();
};

export type ResolvedLink = { ctx: TenantContext; proposalId: string; status: ProposalStatus; validUntil: string; tokenHash: Buffer };

/** Thrown by resolveLink for a gone link. */
export class GoneLinkError extends Error {
  constructor(readonly companyPhone: string | null) {
    super('gone');
  }
}

/**
 * token -> link via resolveProposalToken(deps.pools.system, hash). Unknown (or malformed) token: AppError 404.
 * Gone (replaced, or valid_until + 30 days passed): GoneLinkError, answered 410 { error, companyPhone }.
 */
export async function resolveLink(deps: AppDeps, token: string, now: Date): Promise<ResolvedLink> {
  if (!TOKEN_SHAPE.test(token)) throw new AppError(404, NOT_WORKING);
  const tokenHash = tokenHashOf(token);
  const found = await resolveProposalToken(deps.pools.system, tokenHash);
  if (found === null) throw new AppError(404, NOT_WORKING);
  const ctx: TenantContext = { companyId: found.companyId, userId: null, role: 'system', canApproveSpend: false };
  const validUntilMs = new Date(found.validUntil).getTime();
  const gone = found.status === 'replaced' || (Number.isFinite(validUntilMs) && now.getTime() > validUntilMs + GRACE_MS);
  if (gone) {
    const state = await withTenant(deps.pools, ctx, (tx) => publicProposalState(tx, ctx, found.proposalId));
    throw new GoneLinkError(state?.companyPhone ?? null);
  }
  return { ctx, proposalId: found.proposalId, status: found.status, validUntil: found.validUntil, tokenHash };
}

/** sha256(ip + companyId) hex, for proposal_events.ip_hash. */
export function ipHashFor(req: Request, companyId: string): string {
  return createHash('sha256').update(`${req.ip ?? ''}${companyId}`).digest('hex');
}

/** Route catch helper: GoneLinkError -> 410 { error, companyPhone }; anything else -> next(err). */
export function handleProposalError(err: unknown, res: Response, next: NextFunction): void {
  if (err instanceof GoneLinkError) {
    res.status(410).json({ error: GONE, companyPhone: err.companyPhone });
    return;
  }
  next(err);
}
