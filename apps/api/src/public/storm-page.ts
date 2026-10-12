import { Router } from 'express';
import type { AppDeps } from '../app.ts';

/** The storm landing page on the company host (`GET /storm/:code`). Stub from S1 Task 7: passes every request on until Task 20. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- stub parameters, used once the body exists
export function stormPage(_deps: AppDeps): Router {
  return Router();
}
