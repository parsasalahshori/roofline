import type { Config } from '../config.ts';
import { DisabledSmsAdapter, FakeSmsAdapter, type SmsAdapter } from '@roofline/send-gate';
import { twilioSmsFor } from './twilio/sms.ts';

/** The SMS adapter the app uses: the fake under FAKE_PROVIDERS, else Twilio when configured, else disabled. */
export function createSmsAdapter(config: Config): SmsAdapter {
  if (config.FAKE_PROVIDERS) return new FakeSmsAdapter();
  return twilioSmsFor(config) ?? new DisabledSmsAdapter();
}
