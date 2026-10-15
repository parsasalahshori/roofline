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
  /**
   * How far to trust the face, 0-1 (absent on reconstructions stored before it existed): the confidence of the outline
   * edges it ends on (Roof3dEdge.confidence) and whether Google's own roof segment under it agrees with its pitch and
   * facing. Informational: it never changes the face's area or the quote.
   */
  confidence?: number;
  /** Where the face came from (absent: Google's heights). 'lidar': a roof part only leaf-off lidar saw, pitch from its lidar plane. */
  source?: Roof3dSource;
  /** Share (0-1) of the face's plan area that only leaf-off lidar saw (lidar fusion), when any. */
  lidarShare?: number;
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
  /**
   * What the reconstruction cut out of Google's mask part before fitting (absent on older reconstructions): see
   * RoofMaskCut. Recorded so a large cut is visible to review; the outline's own quality cannot see it.
   */
  maskCut?: RoofMaskCut;
  /**
   * The evidence for each outline edge (edge i runs from outline[from] to the next corner), in outline order. Absent on
   * reconstructions stored before it existed, or when the height map could not be read along the outline.
   */
  edges?: Roof3dEdge[];
  /**
   * What the leaf-off lidar hidden-edge step did (roof-reconstruct/outline-lidar.ts): present only when it was asked to
   * run. Moved edges stay unverified in `edges` (the height map still cannot see them); this says lidar placed them.
   */
  lidarEdges?: Roof3dLidarEdges;
  /**
   * What the hidden-edge step (roof-reconstruct's hiddenEdge option) put into the outline that the heights did not show:
   * present only when the step ran (absent on every roof made with it off, and on older reconstructions). Inferred roof
   * is a hypothesis; past a few square feet the roof carries the 'roof-inferred' review reason.
   */
  inferredEdges?: Roof3dInferredEdges;
  /**
   * What the leaf-off lidar fusion did (roof-reconstruct/lidar-fusion.ts): present only when lidar was given. Faces and
   * edges it added carry source 'lidar'; past a small share of the area the roof carries 'roof-from-lidar'.
   */
  lidarFusion?: Roof3dLidarFusion;
};

/**
 * The hidden-edge step's record on a stored roof: the methods that ran, each outline edge with an inferred stretch
 * (`from` indexes `outline` as in Roof3dEdge; the method that put it there; the inferred length and its largest
 * distance from the outline the heights drew, feet), and the plan area added and removed (square feet). `undone`: the
 * steps' combined change was too large and the heights' outline was kept.
 */
export type Roof3dInferredEdges = {
  methods: ('photo' | 'planes')[];
  edges: { from: number; method: 'photo' | 'planes'; lengthFt: number; offsetFt: number }[];
  addedSqFt: number;
  removedSqFt: number;
  undone?: 'large-change';
};

/**
 * applied: some hidden edges were moved onto the lidar's eaves (`moved`: their outline edge before the move, offset in
 * feet, positive outward); otherwise `reason` (LIDAR_EDGE_REASONS) says why the outline was left as the heights drew it.
 */
export type Roof3dLidarEdges = { applied: boolean; reason?: string; moved: { offsetFt: number; lengthFt: number }[]; areaChangeSqFt: number };

/**
 * Leaf-off airborne lidar for one house, as the lidar service (apps/api, USGS 3DEP) hands it to the reconstruction's
 * fusion step (roof-reconstruct/lidar-fusion.ts). Points are offsets from (originE, originN) in UTM metres of EPSG
 * `epsg` (32601-32660 / 32701-32760 WGS84 or 26901-26923 NAD83: the fusion registers the cloud onto Google's frame
 * itself, so a metre of datum difference is fine), z in the lidar's own vertical datum (the offset is fitted).
 * flags: LIDAR_FLAG_LAST (last return of its pulse) and LIDAR_FLAG_GROUND (classified ground, ASPRS class 2).
 * Arrays are in the order read (deterministic); at most LIDAR_EVIDENCE_MAX_POINTS points.
 */
export type LidarEvidence = {
  epsg: number;
  originE: number;
  originN: number;
  dx: Float32Array;
  dy: Float32Array;
  z: Float32Array;
  flags: Uint8Array;
  flight: LidarFlight;
};
export const LIDAR_FLAG_LAST = 1;
export const LIDAR_FLAG_GROUND = 2;
/** A 70 m QL1 square is about 150 000 points; the fusion declines ('too-many-points') above this. */
export const LIDAR_EVIDENCE_MAX_POINTS = 400_000;

/**
 * Where a lidar crop came from (USGS work-unit metadata), so a fused roof says which flight measured it.
 * collectStart/collectEnd: the work unit's collection window (YYYY-MM-DD; the point dates when known, else the unit's).
 * leafOff: the work unit was flown leaf-off (null when the metadata does not say). ql: 'QL 0'..'QL 3' as USGS writes it.
 * pointsPerM2: the nominal or measured pulse density, when known. credit: shown with the result (USGS is public domain).
 */
export type LidarFlight = {
  project: string;
  workUnit: string;
  collectStart: string | null;
  collectEnd: string | null;
  leafOff: boolean | null;
  ql: string | null;
  pointsPerM2: number | null;
  source: 'ept' | 'copc' | 'laz-tile' | 'cache';
  credit: string;
};

/**
 * Why the lidar service has no evidence for a house (it never throws into a Measure request): no 3DEP project covers
 * it, none flown leaf-off, too old, too sparse (QL2-3), the read would exceed its size or time limit, a fetch failed,
 * or the data read were malformed.
 */
export const LIDAR_EVIDENCE_MISSES = ['no-coverage', 'not-leaf-off', 'too-old', 'sparse', 'too-large', 'timeout', 'fetch-error', 'bad-data'] as const;
export type LidarEvidenceMiss = (typeof LIDAR_EVIDENCE_MISSES)[number];
export type LidarEvidenceResult = { ok: true; evidence: LidarEvidence } | { ok: false; miss: LidarEvidenceMiss };

/**
 * Where an outline edge or a face came from. Absent or 'google': measured by Google's height map. 'lidar': measured by
 * leaf-off USGS lidar where Google's leaf-on heights could not see the roof (a wing or an eave under a tree crown):
 * measured, but by another sensor on another date, so it is shown and flagged ('roof-from-lidar'), never silently
 * priced as Google's.
 */
export type Roof3dSource = 'google' | 'lidar';

/**
 * What the lidar fusion step did (roof-reconstruct/lidar-fusion.ts): present only when lidar was given. applied: roof
 * the lidar sees and the heights did not was added (addedPlanSqFt / addedSlopedSqFt, and addedShare of the final plan
 * area); the faces and edges it added carry source 'lidar'. Otherwise `reason` (LIDAR_FUSION_REASONS in
 * roof-reconstruct) says why the roof was left as the heights drew it. flight: which lidar, for the credit and the date.
 */
export type Roof3dLidarFusion = {
  applied: boolean;
  reason?: string;
  /** Which lidar (set by the server from LidarEvidence.flight; absent when the caller did not say). */
  flight?: { project: string; workUnit: string; collectEnd: string | null; leafOff: boolean | null; ql: string | null; credit: string };
  addedPlanSqFt: number;
  addedSlopedSqFt: number;
  addedShare: number;
  /** Faces with lidar-only area: that area (plan sq ft) and the face's pitch (x/12), fitted on Google's and the lidar's heights. */
  parts: { planSqFt: number; pitchX12: number }[];
};

/**
 * What the height map says about one outline edge (eave-support.ts): 'strong' when the heights drop 1 m or more across
 * it (a real eave), 'weak' for 0.5-1 m, 'none' when they do not drop (a tree crown, a taller wall or a deck stands
 * beside it, so the edge cannot be checked from the heights: unverified).
 */
export type Roof3dEdgeSupport = 'strong' | 'weak' | 'none';
/** Why an edge is unverified: a crown beside it, a taller neighbour or wall, no height data, or level ground (a deck). */
export const ROOF_3D_EDGE_REASONS = ['crown', 'taller-neighbour', 'data-gap', 'level'] as const;
export type Roof3dEdgeReason = (typeof ROOF_3D_EDGE_REASONS)[number];

export type Roof3dEdge = {
  /** Index into `outline` of the corner the edge starts at; it ends at the next corner. */
  from: number;
  lengthFt: number;
  /** The class of the edge's median eave drop. */
  support: Roof3dEdgeSupport;
  /** Share of the edge's length with no eave drop (0-1). */
  unverifiedShare: number;
  /** The most common reason along its unverified stretch; null when it has none. */
  reason: Roof3dEdgeReason | null;
  /** Half or more of it runs beside a tree crown. */
  canopy: boolean;
  /** Chance the edge is within half a metre of an independent outline (EagleView or lidar), 0-1, from its support. */
  confidence: number;
  /** Where the edge came from (absent: Google's heights). 'lidar': placed by leaf-off lidar where the heights could not see it. */
  source?: Roof3dSource;
};

/** Why a reconstruction cut part of Google's mask away: parts lying on the ground, or the buildings a terrace home touches. */
export const ROOF_MASK_CUT_REASONS = ['ground-cut', 'terrace-cut'] as const;
export type RoofMaskCutReason = (typeof ROOF_MASK_CUT_REASONS)[number];
/**
 * A cut of more than this share of Google's mask part is significant: reported with a reason so it can be reviewed
 * (FM11: one ablation lost 42% of a roof to the ground cut with a clean quality block). 10% is the benchmark's "bad"
 * line for area: a cut that size moves the price as much as a wrong measurement.
 */
export const ROOF_MASK_CUT_SHARE = 0.1;
/**
 * The mask part as it came (maskSqFt), what was cut as lying on the ground (groundSqFt) and as other buildings of a
 * terrace (terraceSqFt), plan square feet; removedShare = (ground + terrace) / mask; reason: the larger cut's kind
 * when removedShare exceeds ROOF_MASK_CUT_SHARE, else null.
 */
export type RoofMaskCut = { maskSqFt: number; groundSqFt: number; terraceSqFt: number; removedShare: number; reason: RoofMaskCutReason | null };

const SQ_FT_PER_M2 = 10.7639104167;

/** The RoofMaskCut for the areas cut (square metres), or null when they are not finite. */
export function roofMaskCut(cuts: { maskM2: number; groundM2: number; terraceM2: number } | null | undefined): RoofMaskCut | null {
  if (cuts == null || ![cuts.maskM2, cuts.groundM2, cuts.terraceM2].every((v) => Number.isFinite(v) && v >= 0) || !(cuts.maskM2 > 0)) return null;
  const removedShare = Math.min(1, (cuts.groundM2 + cuts.terraceM2) / cuts.maskM2);
  const reason = removedShare > ROOF_MASK_CUT_SHARE ? (cuts.groundM2 >= cuts.terraceM2 ? 'ground-cut' : 'terrace-cut') : null;
  const ft = (m2: number) => Math.round(m2 * SQ_FT_PER_M2 * 10) / 10;
  return { maskSqFt: ft(cuts.maskM2), groundSqFt: ft(cuts.groundM2), terraceSqFt: ft(cuts.terraceM2), removedShare: Math.round(removedShare * 1000) / 1000, reason };
}

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
  'edges-unverified',
  'roof-inferred',
  'roof-from-lidar',
  'lidar-past-building',
] as const;
export type RoofQualityReason = (typeof ROOF_QUALITY_REASONS)[number];

/**
 * How much a reason matters. 'block': the measured area itself may be wrong (check before pricing); 'check': a part
 * of the roof may be drawn wrong; 'info': worth knowing, not a reason to doubt the numbers. Only 'block' and 'check'
 * reasons are in RoofQuality.reasons (and so make needsReview true); 'info' ones go to RoofQuality.notes.
 */
export type RoofQualitySeverity = 'block' | 'check' | 'info';
export const ROOF_QUALITY_SEVERITY: Record<RoofQualityReason, RoofQualitySeverity> = {
  'coarse-imagery': 'check',
  'outline-off': 'block',
  'faces-patchy': 'check',
  'rough-heights': 'check',
  trees: 'check',
  // A review when the differing faces carry a third of the main roof or more; a note below that (withGoogleCheck).
  'differs-from-google': 'check',
  'joined-buildings': 'block',
  'roof-hidden': 'block',
  'low-attachment': 'check',
  'edges-unverified': 'block',
  // Roof added (or taken off) under trees from the roof's planes or the photo, not seen in the heights: the area may be wrong.
  'roof-inferred': 'block',
  // Roof added from leaf-off lidar where Google's heights could not see it (a wing under trees): measured, but by another
  // sensor on another date, so a person checks it against the photo before it is priced (the quote waits for that).
  // A 'block' (was a 'check'): the lidar can change the measured AREA, by up to the whole of Google's part, so like
  // 'roof-inferred' the area itself is in question until a person has looked.
  'roof-from-lidar': 'block',
  // Lidar roof running well past Google's box for the building: a wing, or the attached unit next door (a duplex).
  'lidar-past-building': 'block',
};

/** The outline's evidence in total (see Roof3dEdge): shares of its length, and its unverified length in feet. */
export type RoofEdgeSupport = {
  strongShare: number;
  weakShare: number;
  unverifiedShare: number;
  unverifiedFt: number;
  /** Share of the outline's length beside a tree crown. */
  canopyShare: number;
};

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
  /** Reasons worth knowing that do not need a review ('info' severity). Absent on older reconstructions. */
  notes?: RoofQualityReason[];
  /** The outline's eave support (absent on older reconstructions, or when it could not be measured: see edgeSupportFailure). */
  edgeSupport?: RoofEdgeSupport;
  /** Why the eave support could not be measured (a machine-readable code), when it could not. */
  edgeSupportFailure?: string;
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
export type Roof3dSnapshot = {
  fetchedAt: string;
  at: LngLat;
  roof: Roof3d | null;
  /** Why there is no roof (see ROOF_3D_NONE_REASONS). Only 'no-imagery' and 'no-building' are ever reused. */
  none?: Roof3dNoneReason;
  photo?: Roof3dPhoto | null;
  /**
   * ROOF_3D_MODE=shadow: the roof that was reconstructed but not measured from (roof is then null and none 'shadow').
   * Kept so the comparison can be made later, and so turning the mode on reuses it instead of buying the layers again.
   */
  shadowRoof?: Roof3d | null;
  /**
   * Leaf-off USGS lidar for this roof (USGS_LIDAR_MODE): whether it was used, kept for later, or why not. Absent when
   * lidar is off (and on every snapshot stored before it existed). What the reconstruction did with it is the roof's
   * lidarEdges; edges it moved are lidar-derived, never Google-measured.
   */
  lidar?: Roof3dLidarNote;
  /** The snapshot's own layout (ROOF_3D_SNAPSHOT_SCHEMA). Absent on snapshots stored before it existed: 1. */
  schemaVersion?: number;
  /** The reconstruction that made it (ROOF_3D_ALGORITHM_VERSION). Absent on snapshots stored before it existed: 1. */
  algorithmVersion?: number;
};

/**
 * Why leaf-off lidar was not there for a roof: 'lidar-pending' (being fetched when Measure ran; the next Measure uses
 * it), 'no-coverage' (no USGS 3DEP point cloud of QL2 or better there), 'leaf-on-only' (only lidar flown with leaves
 * on, which the crowns block as they block Google), 'too-sparse' (too few returns to place an edge), 'error', 'unreadable' (a tile the decoder can never read: kept, not downloaded again).
 */
export const ROOF_3D_LIDAR_NONE = ['lidar-pending', 'no-coverage', 'leaf-on-only', 'too-sparse', 'error', 'unreadable'] as const;
export type Roof3dLidarNone = (typeof ROOF_3D_LIDAR_NONE)[number];

/** Provenance of the lidar behind a roof (Roof3dSnapshot.lidar). */
export type Roof3dLidarNote = {
  /** 'used': handed to the reconstruction. 'kept': fetched, not used (USGS_LIDAR_MODE=prefetch). 'none': see reason. */
  status: 'used' | 'kept' | 'none';
  reason?: Roof3dLidarNone;
  /** The 3DEP work unit and project, quality level and first/last flight day (YYYY-MM-DD). */
  workunit?: string;
  project?: string;
  ql?: number | null;
  flown?: [string | null, string | null];
  leafOff?: boolean | null;
  /** Whole years between the flight and Google's imagery. */
  ageYears?: number | null;
  points?: number;
  /** Shown wherever the lidar is used: 'Lidar: USGS 3D Elevation Program (3DEP), public domain'. */
  credit?: string;
};

/**
 * Why a snapshot has no roof. 'no-imagery': Google has no HIGH or MEDIUM imagery there. 'no-building': no roof near
 * the point and Google has no building there either (a vacant lot, a point in the street). 'no-roof': Google has a
 * building but no roof part was found near the point (written before November 2026 for every case without a roof).
 * 'clipped': the roof runs off the layers' edge even after one fresh, larger request. 'unusable': a roof was found but
 * is too far off to show, or the layers could not be read. 'timeout': the layers did not come in time. 'shadow':
 * ROOF_3D_MODE=shadow, the roof is in shadowRoof. Only 'no-imagery' and 'no-building' are about the place itself; every
 * other reason is about this attempt and is never reused (roof3dSnapshotFresh), so a later Measure tries again.
 */
export const ROOF_3D_NONE_REASONS = ['no-imagery', 'no-building', 'no-roof', 'clipped', 'unusable', 'timeout', 'shadow'] as const;
export type Roof3dNoneReason = (typeof ROOF_3D_NONE_REASONS)[number];

/**
 * The layout of a stored Roof3dSnapshot. 1: before October 2026 (no version fields). 2: adds schemaVersion and
 * algorithmVersion. Readers accept every schema up to this one and ignore fields they do not know.
 */
export const ROOF_3D_SNAPSHOT_SCHEMA = 2;

/**
 * Which reconstruction (roof-reconstruct/ plus the server's checks on it) made a snapshot. A kept roof made by another
 * version is stale and is reconstructed again (roof3dSnapshotFresh), so an improved algorithm shows on homes measured
 * before it instead of the old roof being served for ROOF_3D_CACHE_DAYS. BUMP IT with any change that changes what a
 * reconstruction returns (faces, lines, outline, quality); a pure refactor leaves it. Snapshots without the field are 1.
 * 2: the October 2026 edge-case round (first versioned snapshots). 3: its remediation (the plane search no longer loses
 * a face when candidates tie, foliage faces along crown-backed eaves dissolve, a Google difference with 5% of the area at
 * stake is a review, edge confidence calibrated on DEV only). 4: hidden edges (outline round, docs/roof-3d/
 * outline-release-notes.md): outline edges under tree crowns are checked against the photo and hidden eaves put on their
 * face's plane at the eave height (roofOnLayers' DEFAULT_HIDDEN_EDGE, photo+planes). 5: that default turned off again
 * (docs/roof-3d/outline-remediate.md): a roof is made as by version 3; 5 and not 3 so that roofs version 4 stored (with
 * inferred roof priced as measured) read as stale, and no number ever means two reconstructions. 6: eave support reads
 * the whole of every outline edge (docs/roof-3d/support.md; before, the second half of each edge was read at its
 * midpoint), so edge support, the edges-unverified review and the edge confidences change; edge confidence now weighs
 * strong, weak and unverified stretches separately, calibrated on DEV against EagleView and lidar truth.
 */
export const ROOF_3D_ALGORITHM_VERSION = 6;

function versionField(value: unknown): number | null {
  if (value === undefined) return 1;
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : null;
}

/** A snapshot's schema and algorithm versions (1 for a snapshot stored before they existed); null for a garbled field. */
export function roof3dSnapshotVersion(snapshot: Pick<Roof3dSnapshot, 'schemaVersion' | 'algorithmVersion'>): { schema: number | null; algorithm: number | null } {
  return { schema: versionField(snapshot.schemaVersion), algorithm: versionField(snapshot.algorithmVersion) };
}

/** Whether a snapshot was made by this reconstruction (an older or newer one, or a garbled version, is not). */
export function roof3dSnapshotCurrent(snapshot: Pick<Roof3dSnapshot, 'schemaVersion' | 'algorithmVersion'>): boolean {
  return roof3dSnapshotVersion(snapshot).algorithm === ROOF_3D_ALGORITHM_VERSION;
}

/** The snapshot stamped with this commit's schema and algorithm versions: every snapshot is stamped before it is kept. */
export function roof3dSnapshotStamp<T extends Roof3dSnapshot>(snapshot: T): T & { schemaVersion: number; algorithmVersion: number } {
  return { ...snapshot, schemaVersion: ROOF_3D_SNAPSHOT_SCHEMA, algorithmVersion: ROOF_3D_ALGORITHM_VERSION };
}

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
 * A kept reconstruction still good for a home at `point` at `now`: fetched within ROOF_3D_CACHE_DAYS, made by this
 * reconstruction (ROOF_3D_ALGORITHM_VERSION; a kept "no imagery" excepted), and for this roof: its outline contains the point, or it was asked about a point within 3 m of it. A kept "no imagery here"
 * covers anything within 50 m (Google's imagery is per area, not per house).
 */
export function roof3dSnapshotFresh(snapshot: Roof3dSnapshot | null | undefined, point: LngLat, now: Date): boolean {
  if (snapshot === null || snapshot === undefined || !finite(snapshot.at) || !finite(point)) return false;
  const at = Date.parse(snapshot.fetchedAt);
  if (!Number.isFinite(at) || now.getTime() - at > ROOF_3D_CACHE_DAYS * 86_400_000 || at > now.getTime() + 60_000) return false;
  const d = metresApart(snapshot.at, point);
  // "No imagery here" is Google's answer, not the reconstruction's: it holds whichever algorithm kept it.
  if (snapshot.roof === null && snapshot.none === 'no-imagery') return d <= 50;
  // Anything the reconstruction decided (a roof, or "no roof here") is only as good as the algorithm that decided it.
  if (!roof3dSnapshotCurrent(snapshot)) return false;
  // Of the other answers without a roof, only "no building here" is about the place; the rest (clipped, unusable,
  // timeout, shadow, and the old catch-all no-roof) are about one attempt and are asked again.
  if (snapshot.roof === null) return snapshot.none === 'no-building' && d <= 3;
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
