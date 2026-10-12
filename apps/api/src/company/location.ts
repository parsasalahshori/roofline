import { GeocoderUnavailableError, type GeocodeResult, type Geocoder } from '../providers/geocoder.ts';

export type LocateOutcome = { kind: 'located'; result: GeocodeResult } | { kind: 'not_found' } | { kind: 'unavailable' };
export const DEFAULT_SERVICE_AREA_MILES = 40;
/** The one message for an address the map cannot place (sign-up, Setup and the batch import use it). */
export const ADDRESS_NOT_FOUND_MESSAGE = "We couldn't find that address. Check the street, city and state.";
/** Sign-up waits this long for the map, so a slow map does not hold up account creation. */
export const SIGNUP_GEOCODE_TIMEOUT_MS = 2000;
export const SERVICE_AREA_CHOICES = [10, 20, 40, 60] as const;

/**
 * Looks an address up on the map. A null answer is "not found"; a missing or unreachable geocoder is
 * "unavailable". Provider error text never leaves this function: any other error is rethrown as-is.
 */
export async function locateAddress(
  geocoder: Geocoder,
  text: string,
  opts?: { timeoutMs?: number },
): Promise<LocateOutcome> {
  if (geocoder.configured === false) return { kind: 'unavailable' };
  try {
    const result = await geocoder.geocode(text, opts);
    if (result === null) return { kind: 'not_found' };
    return { kind: 'located', result };
  } catch (error) {
    if (error instanceof GeocoderUnavailableError) return { kind: 'unavailable' };
    throw error;
  }
}
