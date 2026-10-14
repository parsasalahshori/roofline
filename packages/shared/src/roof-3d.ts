// A roof reconstructed in 3D from Google Solar's height map (roof-reconstruct/): its real outline, faces (each with
// its own pitch and area) and lines, as a measurement stores it. Here: the stored shape, and the roof model (facets
// and lines, the drawing and its totals) made from it. Pure; never throws.
import type { LngLat, Ring } from './roof.ts';
import type { RoofPlane } from './roof-model.ts';

/**
 * Ridge, hip and valley: creases between two faces. Eave and rake: a face's edge where the roof ends, on the outline or
 * over a lower roof. Flashing (the wall runs level along the face below it) and step flashing (the wall climbs along
 * it): where a lower roof meets a wall rising above it. Flat edge: where two flat faces meet.
 */
export const ROOF_3D_LINE_KINDS = ['ridge', 'hip', 'valley', 'eave', 'rake', 'flashing', 'step-flashing', 'flat-edge'] as const;
/**
 * A line's kind. 'step' is what reconstructions stored before October 2026 called the line between a higher and a lower
 * roof (one line for the higher roof's edge and the lower roof's wall); it is read as step flashing.
 */
export type Roof3dLineKind = (typeof ROOF_3D_LINE_KINDS)[number] | 'step';

export type Roof3dFace = {
  /** [lng, lat], open ring, counter-clockwise. */
  ring: LngLat[];
  /** Measured pitch, x/12 (two decimals). */
  pitchX12: number;
  /** Compass direction the face slopes down towards, degrees (0 north, 90 east). */
  azimuthDeg: number;
  planAreaSqFt: number;
  slopedAreaSqFt: number;
  /** Below 2/12: a flat or low-slope face. */
  flat: boolean;
  /** [lng, lat], well inside the face. */
  labelAt: LngLat;
};

export type Roof3dLine = {
  kind: Roof3dLineKind;
  coords: [LngLat, LngLat];
  /** True (3D) length, feet. */
  lengthFt: number;
  /** How much the line climbs end to end, feet. */
  riseFt: number;
  /** Indexes into `faces`: the face whose edge it is (eave, rake, flashing, flat edge), or the two a crease is between. */
  faces: number[];
};

export type Roof3d = {
  version: 1;
  /** [lng, lat], open ring, counter-clockwise: the roof's real outline (overhangs included). */
  outline: LngLat[];
  /** Largest plan area first. */
  faces: Roof3dFace[];
  lines: Roof3dLine[];
  /** The height map's resolution, metres a pixel (0.1 for Google's HIGH imagery, 0.25 for MEDIUM). */
  pixelSizeM: number;
  imageryQuality: string | null;
  /** YYYY-MM-DD. */
  imageryDate: string | null;
  /** How far to trust it (absent on reconstructions stored before it existed). */
  quality?: RoofQuality;
  /**
   * Other roofs on the same height map close to this one (a detached garage, a shed, a carport), reconstructed the
   * same way, nearest first. Not in this roof's faces, lines or totals: offered so they can be added (a measurer such
   * as EagleView counts them as further structures). Absent when there are none, or on older reconstructions.
   */
  structures?: Roof3dStructure[];
};

/** Another roof near the main one (see Roof3d.structures). */
export type Roof3dStructure = {
  outline: LngLat[];
  faces: Roof3dFace[];
  lines: Roof3dLine[];
  quality?: RoofQuality;
  /** Gap from the main roof's outline, feet. */
  gapFt: number;
};

/** Why a reconstruction needs a person's review. */
export const ROOF_QUALITY_REASONS = [
  'coarse-imagery',
  'outline-off',
  'faces-patchy',
  'rough-heights',
  'trees',
  'differs-from-google',
  'joined-buildings',
  'roof-hidden',
  'low-attachment',
] as const;
export type RoofQualityReason = (typeof ROOF_QUALITY_REASONS)[number];

/**
 * How far a reconstruction can be trusted: the imagery's quality (HIGH, MEDIUM); the outline's overlap with Google's
 * roof mask (intersection over union) and the share of its length within 0.5 m of the mask's edge; the share of the
 * mask its faces cover; the mean distance of the heights from their faces' planes, metres; the share of the roof under
 * tree crowns; faces drawn from their pixels because their polygon could not be built; a roof cut out of a mask part it
 * shares with the buildings it touches (a terrace, a semi-detached pair); roof the height map's mask may have missed
 * (tree crowns along the outline as high as its edge, or raised smooth ground next to it in Google's box for the
 * building: 'roof-hidden'); a flat part at the outline no higher than the eaves it adjoins (a porch roof, a patio cover
 * or a deck, which a measurer may leave out: 'low-attachment'); and (added by the server, which has Google's
 * own roof segments) main faces whose pitch or facing differ from the segment under them. Any reason: review it.
 */
export type RoofQuality = {
  imagery: string | null;
  outlineIoU: number;
  edgeFit: number;
  faceCoverage: number;
  meanResidualM: number;
  treeShare: number;
  fallbackFaces: number;
  reasons: RoofQualityReason[];
};

/** Whether a reconstruction should be checked by a person before it is priced (any quality reason). */
export function needsReview(roof: Roof3d | null | undefined): boolean {
  return (roof?.quality?.reasons.length ?? 0) > 0;
}

/**
 * What a measurement keeps of one Google Solar Data Layers lookup (paid), so measuring the home again does not buy it
 * again: the roof reconstructed at `at`, or why there is none (`none`): Google has no HIGH or MEDIUM imagery there,
 * or no roof near the point.
 */
export type Roof3dSnapshot = { fetchedAt: string; at: LngLat; roof: Roof3d | null; none?: 'no-imagery' | 'no-roof'; photo?: Roof3dPhoto | null };

/**
 * Google's own aerial photo of the roof (the Data Layers photo the height map was made from: true ortho, so the 3D
 * roof sits exactly on it), stored as a PNG under `key` in the file store. `corners` are [lng, lat] of its top-left,
 * top-right, bottom-right and bottom-left corners (a UTM grid is slightly turned against north).
 */
export type Roof3dPhoto = { key: string; corners: [LngLat, LngLat, LngLat, LngLat]; width: number; height: number };

/** How long Google's Solar data (and the photo) may be kept and shown: the Solar API terms allow 30 days of caching. */
export const SOLAR_DATA_DAYS = 30;

/** Whether a snapshot is within the days its Solar data may be kept (at `now`). */
export function solarDataCurrent(snapshot: { fetchedAt: string } | null | undefined, now: Date): boolean {
  const at = Date.parse(snapshot?.fetchedAt ?? '');
  return Number.isFinite(at) && now.getTime() - at <= SOLAR_DATA_DAYS * 86_400_000;
}

/** How long a home's reconstructed roof is reused. */
export const ROOF_3D_CACHE_DAYS = 30;

const EARTH_RADIUS_M = 6371008.8;
const K = (Math.PI / 180) * EARTH_RADIUS_M;

function finite(p: unknown): p is LngLat {
  return Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]);
}

function metresApart(a: LngLat, b: LngLat): number {
  const cos = Math.cos((((a[1] + b[1]) / 2) * Math.PI) / 180);
  return Math.hypot((b[0] - a[0]) * K * cos, (b[1] - a[1]) * K);
}

function inside(point: LngLat, ring: readonly LngLat[]): boolean {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (yi > point[1] !== yj > point[1] && point[0] < ((xj - xi) * (point[1] - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

/** Whether a stored value is a usable reconstruction (an outline and at least one face with a ring). */
export function isRoof3d(value: unknown): value is Roof3d {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Partial<Roof3d>;
  return (
    r.version === 1 &&
    Array.isArray(r.outline) &&
    r.outline.length >= 3 &&
    r.outline.every(finite) &&
    Array.isArray(r.faces) &&
    r.faces.length > 0 &&
    r.faces.every((f) => Array.isArray(f.ring) && f.ring.length >= 3 && f.ring.every(finite) && Number.isFinite(f.pitchX12) && Number.isFinite(f.planAreaSqFt)) &&
    Array.isArray(r.lines)
  );
}

/**
 * A kept reconstruction still good for a home at `point` at `now`: fetched within ROOF_3D_CACHE_DAYS, and for this
 * roof: its outline contains the point, or it was asked about a point within 3 m of it. A kept "no imagery here"
 * covers anything within 50 m (Google's imagery is per area, not per house).
 */
export function roof3dSnapshotFresh(snapshot: Roof3dSnapshot | null | undefined, point: LngLat, now: Date): boolean {
  if (snapshot === null || snapshot === undefined || !finite(snapshot.at) || !finite(point)) return false;
  const at = Date.parse(snapshot.fetchedAt);
  if (!Number.isFinite(at) || now.getTime() - at > ROOF_3D_CACHE_DAYS * 86_400_000 || at > now.getTime() + 60_000) return false;
  const d = metresApart(snapshot.at, point);
  if (snapshot.roof === null) return snapshot.none === 'no-imagery' ? d <= 50 : d <= 3;
  if (!isRoof3d(snapshot.roof)) return false;
  return d <= 3 || inside(point, snapshot.roof.outline);
}

/** Whether a measurement's outline ring is the reconstruction's own outline (to about a centimetre). */
export function sameOutline(ring: Ring, roof: Roof3d): boolean {
  const a = openRing(ring);
  const b = openRing(roof.outline);
  if (a.length !== b.length || a.length < 3) return false;
  // The same corners in the same order, starting anywhere.
  const tol = 2e-7;
  for (let start = 0; start < b.length; start++) {
    let ok = true;
    for (let k = 0; k < a.length && ok; k++) {
      const p = a[k]!;
      const q = b[(start + k) % b.length]!;
      ok = Math.abs(p[0] - q[0]) <= tol && Math.abs(p[1] - q[1]) <= tol;
    }
    if (ok) return true;
  }
  return false;
}

function openRing(ring: readonly LngLat[]): LngLat[] {
  const first = ring[0];
  const last = ring[ring.length - 1];
  return ring.length > 1 && first && last && first[0] === last[0] && first[1] === last[1] ? ring.slice(0, -1) : [...ring];
}

/**
 * The reconstruction's faces as measured roof planes (whole x/12): what an outline drawn by hand over this roof takes
 * its facets' pitch from, as it would from Google Solar's segments.
 */
export function roofPlanesFrom3d(roof: Roof3d): RoofPlane[] {
  return roof.faces.map((f) => ({
    pitchX12: Math.max(0, Math.min(24, Math.round(f.pitchX12))),
    azimuthDeg: Math.round(f.azimuthDeg * 10) / 10,
    center: [f.labelAt[0], f.labelAt[1]],
    areaSqFt: f.planAreaSqFt,
  }));
}
