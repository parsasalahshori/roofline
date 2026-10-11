import type { Config } from '../../config.ts';
import type { TextingBrands } from '../registrar.ts';

// Stub: the real Twilio brand and campaign adapter lands in a later task.
export function twilioBrandsFor(config: Config): TextingBrands | null {
  void config;
  return null;
}
