/*
 * Types the map's parts share. Types only: nothing here runs.
 */

/** What opening a pin goes to: a customer or a job, by id. */
export type PinTarget = { kind: 'customer' | 'job'; id: string };

export type { Bbox } from '../../api/types.ts';

/** `streets` is the plain map; `satellite` needs a map key or the free aerial photos. */
export type MapMode = 'streets' | 'satellite';

/** The build-time map settings, read from the environment where a map starts and handed to `mapStyle`. */
export type MapEnv = { maptilerKey?: string; tiles?: string; imagery?: string };

/** A pin the person clicked, as the pin card shows it. `stage` and `stageLabel` are null for a customer. */
export type PickedPin = PinTarget & {
  name: string;
  addressLine: string;
  stage: string | null;
  stageLabel: string | null;
  /** Where the pin is, [lng, lat]. */
  lngLat: [number, number];
};
