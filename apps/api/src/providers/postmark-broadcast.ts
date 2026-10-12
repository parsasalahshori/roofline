import type { Config } from '../config.ts';
import type { BroadcastMailer } from './broadcast.ts';

/** The real Postmark broadcast mailer when configured. Stub from S1 Task 7: null until Task 13 builds it. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- stub parameter, used once the mailer exists
export function postmarkBroadcastFor(_config: Config): BroadcastMailer | null {
  return null;
}
