import type { Config } from '../../config.ts';
import type { SmsAdapter } from '@roofline/send-gate';

// Stub: the real Twilio SMS adapter lands in a later task. Until then SMS is disabled unless faked.
export function twilioSmsFor(config: Config): SmsAdapter | null {
  void config;
  return null;
}
