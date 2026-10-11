import type { Config } from '../../config.ts';
import type { TextingAccounts } from '../registrar.ts';

// Stub: the real Twilio subaccount adapter lands in a later task.
export function twilioAccountsFor(config: Config): TextingAccounts | null {
  void config;
  return null;
}
