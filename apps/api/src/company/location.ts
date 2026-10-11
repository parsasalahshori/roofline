import { GeocoderUnavailableError, type GeocodeResult, type Geocoder } from '../providers/geocoder.ts';

export type LocateOutcome = { kind: 'located'; result: GeocodeResult } | { kind: 'not_found' } | { kind: 'unavailable' };
export const DEFAULT_SERVICE_AREA_MILES = 40;
export const SERVICE_AREA_CHOICES = [10, 20, 40, 60] as const;

/**
 * Looks an address up on the map. A null answer is "not found"; a missing or unreachable geocoder is
 * "unavailable". Provider error text never leaves this function: any other error is rethrown as-is.
 */
export async function locateAddress(geocoder: Geocoder, text: string): Promise<LocateOutcome> {
  if (geocoder.configured === false) return { kind: 'unavailable' };
  try {
    const result = await geocoder.geocode(text);
    if (result === null) return { kind: 'not_found' };
    return { kind: 'located', result };
  } catch (error) {
    if (error instanceof GeocoderUnavailableError) return { kind: 'unavailable' };
    throw error;
  }
}
