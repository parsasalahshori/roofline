import type { RequestHandler } from 'express';

/**
 * Refuses writes from a company whose billing has lapsed. Stub: lets every request through until
 * the billing task fills it in.
 */
export const readOnlyGuard: RequestHandler = (req, res, next) => {
  void req;
  void res;
  next();
};
