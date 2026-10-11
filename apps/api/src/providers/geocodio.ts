import type { Config } from '../config.ts';
import type { Geocoder } from './geocoder.ts';

// Stub: the real Geocodio adapter lands in a later task. Until then no key-based geocoder exists.
export function geocodioFor(config: Config): Geocoder | null {
  void config;
  return null;
}
