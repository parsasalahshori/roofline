import { Router } from 'express';
import type { AppDeps } from '../app.ts';

const VOICE_NOT_BUILT = 'Front Desk voice is not built yet.';

/** A stub: answers 501 to every path under its mount, reads no body, needs no session. */
export function twilioVoiceHooks(deps: AppDeps): Router {
  void deps;
  const router = Router();
  router.all('/', (_req, res) => {
    res.status(501).type('text/plain').send(VOICE_NOT_BUILT);
  });
  router.all('/{*rest}', (_req, res) => {
    res.status(501).type('text/plain').send(VOICE_NOT_BUILT);
  });
  return router;
}
