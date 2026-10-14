// UTM (WGS 84) to and from longitude/latitude: the Krueger series (to third order), accurate to about a millimetre
// within a zone. Google Solar's GeoTIFFs are in the UTM zone of the building (EPSG 326zz north, 327zz south).

const A_AXIS = 6378137;
const FLAT = 1 / 298.257223563;
const K0 = 0.9996;
const E0 = 500000;
const N = FLAT / (2 - FLAT);
const A = (A_AXIS / (1 + N)) * (1 + (N * N) / 4 + (N ** 4) / 64);
const ALPHA = [N / 2 - (2 * N * N) / 3 + (5 * N ** 3) / 16, (13 * N * N) / 48 - (3 * N ** 3) / 5, (61 * N ** 3) / 240];
const BETA = [N / 2 - (2 * N * N) / 3 + (37 * N ** 3) / 96, (N * N) / 48 + N ** 3 / 15, (17 * N ** 3) / 480];
const DELTA = [2 * N - (2 * N * N) / 3 - 2 * N ** 3, (7 * N * N) / 3 - (8 * N ** 3) / 5, (56 * N ** 3) / 15];
const RAD = Math.PI / 180;

export type UtmZone = { zone: number; south: boolean };

/** The UTM zone of an EPSG code (32601-32660 north, 32701-32760 south); null for anything else. */
export function utmZoneOfEpsg(epsg: number): UtmZone | null {
  if (epsg >= 32601 && epsg <= 32660) return { zone: epsg - 32600, south: false };
  if (epsg >= 32701 && epsg <= 32760) return { zone: epsg - 32700, south: true };
  return null;
}

/** [lng, lat] of a UTM easting and northing. */
export function utmToLngLat(z: UtmZone, easting: number, northing: number): [number, number] {
  const xi = (northing - (z.south ? 10000000 : 0)) / (K0 * A);
  const eta = (easting - E0) / (K0 * A);
  let xiP = xi;
  let etaP = eta;
  for (let j = 1; j <= 3; j++) {
    xiP -= BETA[j - 1]! * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta);
    etaP -= BETA[j - 1]! * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta);
  }
  const chi = Math.asin(Math.sin(xiP) / Math.cosh(etaP));
  let phi = chi;
  for (let j = 1; j <= 3; j++) phi += DELTA[j - 1]! * Math.sin(2 * j * chi);
  const lambda0 = (z.zone * 6 - 183) * RAD;
  const lambda = lambda0 + Math.atan2(Math.sinh(etaP), Math.cos(xiP));
  return [lambda / RAD, phi / RAD];
}

/** UTM easting and northing of [lng, lat] in a given zone. */
export function lngLatToUtm(z: UtmZone, lng: number, lat: number): { easting: number; northing: number } {
  const phi = lat * RAD;
  const dLambda = (lng - (z.zone * 6 - 183)) * RAD;
  const c = (2 * Math.sqrt(N)) / (1 + N);
  const t = Math.sinh(Math.atanh(Math.sin(phi)) - c * Math.atanh(c * Math.sin(phi)));
  const xiP = Math.atan2(t, Math.cos(dLambda));
  const etaP = Math.atanh(Math.sin(dLambda) / Math.sqrt(1 + t * t));
  let e = etaP;
  let n = xiP;
  for (let j = 1; j <= 3; j++) {
    e += ALPHA[j - 1]! * Math.cos(2 * j * xiP) * Math.sinh(2 * j * etaP);
    n += ALPHA[j - 1]! * Math.sin(2 * j * xiP) * Math.cosh(2 * j * etaP);
  }
  return { easting: E0 + K0 * A * e, northing: (z.south ? 10000000 : 0) + K0 * A * n };
}
