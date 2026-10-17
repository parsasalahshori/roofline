import { splitAddress } from './address.ts';
import { useRequestRows } from './lift/requests.ts';

const sameStreet = (a: string, b: string): boolean => splitAddress(a).street.toLowerCase() === splitAddress(b).street.toLowerCase();

/**
 * Where the Gutters tab goes from a Measure page that has no roof of its own open (the windows pages), so its switch has
 * the same three tabs as the roof's. With a home open it is that home's roof on the request list, if a measured roof is
 * there; with no home open, as the Roof tab does, the first request's. Null when there is none: a tab with no place to go
 * is left out, as it is on the roof page itself.
 */
export function useGuttersLink(address: string | null): string | null {
  const { rows } = useRequestRows('');
  const row = address === null ? rows[0] : rows.find((r) => sameStreet(r.address, address));
  return row === undefined ? null : `/estimator/measure/${encodeURIComponent(row.measurementId)}/gutters`;
}
