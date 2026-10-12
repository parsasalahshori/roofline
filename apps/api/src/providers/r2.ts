import type { Config } from '../config.ts';
import type { ObjectStore } from './object-store.ts';

/** The real R2 client arrives in a later task. */
export function r2For(config: Config): ObjectStore | null {
  void config;
  return null;
}
