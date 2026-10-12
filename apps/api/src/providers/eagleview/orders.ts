import type { Config } from '../../config.ts';
import type { ExactReports } from '../exact-reports.ts';

/** The real EagleView orders client arrives in a later task. */
export function eagleViewOrdersFor(config: Config): ExactReports | null {
  void config;
  return null;
}
