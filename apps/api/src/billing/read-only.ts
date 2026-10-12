import type { RequestHandler } from 'express';
import type { SessionInfo } from '../auth/sessions.ts';

/** What a signed-in member sees when a write is refused, by the company status that caused it. */
export const READ_ONLY_MESSAGE: Record<'trial_ended' | 'canceled', string> = {
  trial_ended: 'Your free trial has ended, so Roofline is read-only for now. Pick a plan to keep going.',
  canceled: 'Your plan was canceled, so Roofline is read-only for now. Pick a plan to keep going.',
};

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Sections that stay open in read-only mode: signing in and out (`auth`), billing (to pick a plan),
 * and the member's own Today marker (`me`). A path is open when it is one of these names, bare or
 * with anything under it, so `/billing` and `/billing/checkout` are open and `/billingx` is not.
 */
const ALWAYS_OPEN_SECTIONS = ['auth', 'billing', 'me'];

/**
 * Refuses writes from a company whose trial has ended or whose plan was canceled. Reads still work,
 * and signing in and out, billing (bare or under it) and the member's own marker stay open so the
 * company can pick a plan.
 * `past_due` is not read-only: the send gate pauses texts for it instead. The company status comes
 * from the session, which is read on every request, so a change applies without signing in again.
 * Mounted under `/api`, so `req.path` is relative to that prefix. Requests without a session pass.
 */
export const readOnlyGuard: RequestHandler = (req, res, next) => {
  const session = req.session as SessionInfo | undefined;
  if (!session) {
    next();
    return;
  }
  const status = session.companyStatus;
  if (status !== 'trial_ended' && status !== 'canceled') {
    next();
    return;
  }
  if (READ_METHODS.has(req.method)) {
    next();
    return;
  }
  const path = req.path.toLowerCase();
  if (ALWAYS_OPEN_SECTIONS.some((name) => path === `/${name}` || path.startsWith(`/${name}/`))) {
    next();
    return;
  }
  res.status(403).json({ error: READ_ONLY_MESSAGE[status] });
};
