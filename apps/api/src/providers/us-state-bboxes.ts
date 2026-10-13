/** [west, south, east, north] in degrees (WGS84). */
export type BBox = readonly [number, number, number, number];

/**
 * A bounding box for each US state and DC (US_STATE_CODES), from the Census TIGER state outlines,
 * rounded outward to two decimals. Used to pick the Global ML footprint tiles a state needs and to
 * keep only the buildings that may lie in it. Boxes overlap near borders; the loader dedupes.
 * Alaska's box stops at the antimeridian: the western Aleutians (east of 180°) are not loaded.
 */
export const US_STATE_BBOXES: Readonly<Record<string, BBox>> = {
  AL: [-88.48, 30.22, -84.88, 35.01],
  AK: [-179.15, 51.21, -129.97, 71.54],
  AZ: [-114.82, 31.33, -109.04, 37.01],
  AR: [-94.62, 33.0, -89.64, 36.5],
  CA: [-124.41, 32.53, -114.13, 42.01],
  CO: [-109.07, 36.99, -102.04, 41.01],
  CT: [-73.73, 40.98, -71.78, 42.06],
  DE: [-75.79, 38.45, -75.04, 39.84],
  DC: [-77.12, 38.79, -76.9, 39.0],
  FL: [-87.64, 24.52, -80.03, 31.01],
  GA: [-85.61, 30.35, -80.83, 35.01],
  HI: [-178.34, 18.91, -154.8, 28.41],
  ID: [-117.25, 41.98, -111.04, 49.01],
  IL: [-91.52, 36.97, -87.49, 42.51],
  IN: [-88.1, 37.77, -84.78, 41.77],
  IA: [-96.64, 40.37, -90.14, 43.51],
  KS: [-102.06, 36.99, -94.58, 40.01],
  KY: [-89.58, 36.49, -81.96, 39.15],
  LA: [-94.05, 28.92, -88.81, 33.02],
  ME: [-71.09, 42.97, -66.94, 47.46],
  MD: [-79.49, 37.91, -75.04, 39.73],
  MA: [-73.51, 41.23, -69.92, 42.89],
  MI: [-90.42, 41.69, -82.41, 48.24],
  MN: [-97.24, 43.49, -89.49, 49.39],
  MS: [-91.66, 30.17, -88.09, 35.0],
  MO: [-95.78, 35.99, -89.09, 40.62],
  MT: [-116.06, 44.35, -104.03, 49.01],
  NE: [-104.06, 39.99, -95.3, 43.01],
  NV: [-120.01, 35.0, -114.03, 42.01],
  NH: [-72.56, 42.69, -70.61, 45.31],
  NJ: [-75.56, 38.92, -73.89, 41.36],
  NM: [-109.06, 31.33, -103.0, 37.01],
  NY: [-79.77, 40.49, -71.85, 45.02],
  NC: [-84.33, 33.84, -75.46, 36.59],
  ND: [-104.05, 45.93, -96.55, 49.01],
  OH: [-84.83, 38.4, -80.51, 41.98],
  OK: [-103.01, 33.61, -94.43, 37.01],
  OR: [-124.57, 41.99, -116.46, 46.3],
  PA: [-80.52, 39.71, -74.68, 42.27],
  RI: [-71.87, 41.14, -71.12, 42.02],
  SC: [-83.36, 32.03, -78.54, 35.22],
  SD: [-104.06, 42.47, -96.43, 45.95],
  TN: [-90.32, 34.98, -81.64, 36.68],
  TX: [-106.65, 25.83, -93.5, 36.51],
  UT: [-114.06, 36.99, -109.04, 42.01],
  VT: [-73.44, 42.72, -71.46, 45.02],
  VA: [-83.68, 36.54, -75.24, 39.47],
  WA: [-124.77, 45.54, -116.91, 49.01],
  WV: [-82.65, 37.2, -77.71, 40.64],
  WI: [-92.89, 42.49, -86.8, 47.31],
  WY: [-111.06, 40.99, -104.05, 45.01],
};

/** The state's box, or null for a code with none (any case, surrounding spaces ignored). */
export function stateBbox(state: string): BBox | null {
  return US_STATE_BBOXES[state.trim().toUpperCase()] ?? null;
}

export function bboxesIntersect(a: BBox, b: BBox): boolean {
  return a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
}

export function bboxContains(box: BBox, lng: number, lat: number): boolean {
  return lng >= box[0] && lng <= box[2] && lat >= box[1] && lat <= box[3];
}
