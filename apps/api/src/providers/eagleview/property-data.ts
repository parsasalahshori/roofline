import type { Config } from '../../config.ts';
import type { AerialMeasure } from '../aerial.ts';

/** The real EagleView property-data client arrives in a later task. */
export function eagleViewPropertyDataFor(config: Config): AerialMeasure | null {
  void config;
  return null;
}
