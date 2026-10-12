import { Router } from 'express';
import type { AppDeps } from '../app.ts';
import { forwardingTestRoutes } from '../front-desk/forwarding-test.ts';

const NOT_BUILT = 'This part of Front Desk (Front Desk) is not built yet.';

/** A stub: every route answers 501 until the task that builds it replaces this router. */
export function frontDeskRoutes(deps: AppDeps): Router {
  const router = Router();
  router.use('/forwarding-test', forwardingTestRoutes(deps));
  router.all('/',(_req, res) => {
    res.status(501).json({ error: NOT_BUILT });
  });
  router.all('/{*rest}', (_req, res) => {
    res.status(501).json({ error: NOT_BUILT });
  });
  return router;
}
