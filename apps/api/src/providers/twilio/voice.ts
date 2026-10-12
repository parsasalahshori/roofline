import type { Config } from '../../config.ts';
import type { CallControl } from '../call-control.ts';

/** Twilio call control. A stub in Task 4: returns null. */
export function twilioCallControlFor(config: Config): CallControl | null {
  void config;
  return null;
}
