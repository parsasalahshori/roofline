import { Router } from 'express';
import type { AppDeps } from '../app.ts';

/** Twilio's registration webhooks (`/hooks/twilio-registration`). Stub: an empty router until the texting task fills it in. */
export function twilioRegistrationHooks(deps: AppDeps): Router {
  void deps;
  return Router();
}
