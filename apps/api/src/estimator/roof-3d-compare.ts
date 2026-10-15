import { type LngLat, ROOF_QUALITY_SEVERITY, type Roof3d, type RoofQuality, type RoofQualityReason, type SolarBuilding } from '@roofline/shared';

/*
 * A reconstructed roof checked against Google Solar's own roof segments (buildingInsights) and the acceptance targets:
 * every face of 150 sq ft or more within 1/12 of the pitch and 15 degrees of the facing of the segment under it; no
 * face under 25 sq ft; none steeper than 18/12 unless Google has a segment that steep; the outline overlapping
 * Google's mask by 0.85 or more with most of its length within 0.5 m of the mask's edge. Used by the real-data test
 * and the roof-3d-check script.
 */

const SQ_FT_PER_M2 = 10.7639104167;
export const TARGETS = { mainFaceSqFt: 150, pitchX12: 1, facingDeg: 15, junkSqFt: 25, steepX12: 18, outlineIoU: 0.85, edgeFit: 0.75 } as const;

export type FaceRow = {
  face: string;
  planSqFt: number;
  pitchX12: number;
  azimuthDeg: number;
  flat: boolean;
  /** Google's segment whose centre lies on this face (the largest, when several do); null when none does. */
  segment: { pitchX12: number; azimuthDeg: number; planSqFt: number } | null;
  /** Checked: a face of 150 sq ft or more with a segment. */
  main: boolean;
  pitchOk: boolean;
  facingOk: boolean;
};

export type Acceptance = {
  rows: FaceRow[];
  /** Faces of 150 sq ft or more matching their segment (and those checked). */
  mainOk: number;
  mainChecked: number;
  junkFaces: number;
  steepFaces: number;
  outlineOk: boolean;
  passed: boolean;
};

function inside(p: LngLat, ring: readonly LngLat[]): boolean {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

export function arcDeg(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

const x12 = (deg: number) => 12 * Math.tan((deg * Math.PI) / 180);

/** The faces against Google's segments, and the acceptance targets. */
export function checkRoof(roof: Roof3d, building: SolarBuilding | null): Acceptance {
  const segments = building?.segments ?? [];
  const rows: FaceRow[] = roof.faces.map((f, k) => {
    const under = segments.filter((seg) => inside(seg.center, f.ring)).sort((a, b) => b.groundAreaM2 - a.groundAreaM2)[0];
    const segment = under === undefined ? null : { pitchX12: x12(under.pitchDeg), azimuthDeg: under.azimuthDeg, planSqFt: under.groundAreaM2 * SQ_FT_PER_M2 };
    // A face mostly measured by leaf-off lidar (source 'lidar') lies where Google's leaf-on view saw a crown: the segment
    // under it was fitted to the canopy, so it is not checked against it (the roof carries 'roof-from-lidar' instead).
    const main = f.planAreaSqFt >= TARGETS.mainFaceSqFt && segment !== null && f.source !== 'lidar';
    const pitchOk = segment === null || Math.abs(f.pitchX12 - segment.pitchX12) <= TARGETS.pitchX12;
    // Facing means nothing on a flat face (or a flat segment).
    const facingOk = segment === null || f.flat || segment.pitchX12 < 2 || arcDeg(f.azimuthDeg, segment.azimuthDeg) <= TARGETS.facingDeg;
    return { face: String.fromCharCode(65 + (k % 26)) + (k >= 26 ? String(Math.floor(k / 26) + 1) : ''), planSqFt: f.planAreaSqFt, pitchX12: f.pitchX12, azimuthDeg: f.azimuthDeg, flat: f.flat, segment, main, pitchOk, facingOk };
  });
  const steepAllowed = segments.some((seg) => x12(seg.pitchDeg) > TARGETS.steepX12);
  const checked = rows.filter((r) => r.main);
  const mainOk = checked.filter((r) => r.pitchOk && r.facingOk).length;
  const junkFaces = rows.filter((r) => r.planSqFt < TARGETS.junkSqFt).length;
  const steepFaces = steepAllowed ? 0 : rows.filter((r) => r.pitchX12 > TARGETS.steepX12).length;
  const q = roof.quality;
  const outlineOk = q !== undefined && q.outlineIoU >= TARGETS.outlineIoU && q.edgeFit >= TARGETS.edgeFit;
  return { rows, mainOk, mainChecked: checked.length, junkFaces, steepFaces, outlineOk, passed: mainOk === checked.length && junkFaces === 0 && steepFaces === 0 && outlineOk };
}

/** The check as a plain-text table. */
export function formatCheck(name: string, roof: Roof3d, a: Acceptance, ms?: number): string {
  const q = roof.quality;
  const lines = [
    `${name}: ${roof.faces.length} faces${ms !== undefined ? ` in ${Math.round(ms)} ms` : ''}, ${roof.faces.reduce((t, f) => t + f.slopedAreaSqFt, 0).toFixed(0)} sq ft sloped, imagery ${roof.imageryQuality ?? '?'} ${roof.pixelSizeM} m`,
    q === undefined
      ? '  quality: -'
      : `  outline IoU ${q.outlineIoU.toFixed(3)} (>= ${TARGETS.outlineIoU}), edges within 0.5 m ${(q.edgeFit * 100).toFixed(0)}% (>= ${TARGETS.edgeFit * 100}%), faces cover ${(q.faceCoverage * 100).toFixed(0)}% of the mask, mean residual ${(q.meanResidualM * 100).toFixed(1)} cm, under trees ${(q.treeShare * 100).toFixed(0)}%${q.reasons.length > 0 ? ` -> NEEDS REVIEW (${q.reasons.join(', ')})` : ' -> ok'}`,
    q?.edgeSupport === undefined
      ? '  edges: -'
      : `  edges: eave drop strong ${(q.edgeSupport.strongShare * 100).toFixed(0)}%, weak ${(q.edgeSupport.weakShare * 100).toFixed(0)}%, unverified ${(q.edgeSupport.unverifiedShare * 100).toFixed(0)}% (${q.edgeSupport.unverifiedFt.toFixed(0)} ft), beside trees ${(q.edgeSupport.canopyShare * 100).toFixed(0)}%${(q.notes ?? []).length > 0 ? `; notes: ${q.notes!.join(', ')}` : ''}`,
    '  face | plan sq ft | pitch ours / Google | facing ours / Google | Google segment sq ft | check',
  ];
  for (const r of a.rows) {
    const seg = r.segment;
    const check = !r.main ? (r.planSqFt < TARGETS.junkSqFt ? 'JUNK' : '-') : r.pitchOk && r.facingOk ? 'ok' : 'FAIL';
    lines.push(
      `  ${r.face.padEnd(4)} | ${r.planSqFt.toFixed(0).padStart(10)} | ${(r.flat ? 'flat' : r.pitchX12.toFixed(1)).padStart(4)} / ${seg === null ? '-' : seg.pitchX12.toFixed(1)} | ${(r.flat ? '-' : r.azimuthDeg.toFixed(0)).padStart(3)} / ${seg === null || seg.pitchX12 < 2 ? '-' : seg.azimuthDeg.toFixed(0)} | ${seg === null ? '-' : seg.planSqFt.toFixed(0)} | ${check}`,
    );
  }
  lines.push(
    `  targets: main faces ${a.mainOk}/${a.mainChecked} | junk faces (< ${TARGETS.junkSqFt} sq ft) ${a.junkFaces} | steeper than ${TARGETS.steepX12}/12 ${a.steepFaces} | outline ${a.outlineOk ? 'ok' : 'off'} => ${a.passed ? 'PASS' : 'FAIL'}`,
  );
  return lines.join('\n');
}

/**
 * Whether any main face (150 sq ft or more) misses Google's own segment under it by more than the targets (1/12 of
 * pitch, 15 degrees of facing): such a roof is never shown as if it were sure.
 */
export function differsFromGoogle(roof: Roof3d, building: SolarBuilding | null): boolean {
  return checkRoof(roof, building).rows.some((r) => r.main && (!r.pitchOk || !r.facingOk));
}

/**
 * The quality with its reasons sorted by severity (ROOF_QUALITY_SEVERITY): 'block' and 'check' reasons stay in
 * `reasons` (a person reviews the roof), 'info' ones move to `notes` (shown, counted, no review). Idempotent.
 */
export function tierReasons(q: RoofQuality): RoofQuality {
  const reasons: RoofQualityReason[] = [];
  const notes: RoofQualityReason[] = [];
  for (const r of q.reasons) {
    const into = ROOF_QUALITY_SEVERITY[r] === 'info' ? notes : reasons;
    if (!into.includes(r)) into.push(r);
  }
  // A note stays a note (withGoogleCheck files a minor Google difference there): tiering only ever demotes.
  for (const r of q.notes ?? []) if (!reasons.includes(r) && !notes.includes(r)) notes.push(r);
  const out: RoofQuality = { ...q, reasons };
  if (notes.length > 0) out.notes = notes;
  else delete out.notes;
  return out;
}

/**
 * Main faces that differ from Google's segment under them carry at least this share of the main faces' area: then
 * 'differs-from-google' needs a review; below it, it is a note. A third: enough area for the roof's dominant pitch (the
 * one carrying the most area) to be in question. On the DEV houses a smaller difference was right as often as Google
 * (ours is closer to EagleView in 16 of 27 conflicts), so it is not worth a review on its own.
 */
export const DIFFERS_AREA_SHARE = 1 / 3;

/**
 * ...or when the area at stake is at least this share of the roof's plan area: the plan area by which the differing
 * faces and Google's segments under them disagree (sum of |ours - Google's| over those faces). 5%: the benchmark's
 * "area within 5%" line, half the 10% at which a roof counts as badly measured, so a disagreement that alone could take
 * an otherwise right roof out of that band is never only a note. A pitch difference changes a face's area by a few
 * percent; an area difference this big means the two do not agree on what the face is (a porch, a crown, a wing).
 * Calibrated on DEV only (docs/roof-3d/remediate.md): it restores the review on the one bad DEV roof (+13.8%) the
 * third-of-area rule had demoted, at the cost of two more flags on houses without an answer key.
 */
export const DIFFERS_STAKE_SHARE = 0.05;

/** The share of the main faces' area (150 sq ft or more, with a segment) whose pitch or facing differ from Google's. */
export function differingShare(roof: Roof3d, building: SolarBuilding | null): number {
  const main = checkRoof(roof, building).rows.filter((r) => r.main);
  const all = main.reduce((t, r) => t + r.planSqFt, 0);
  const off = main.filter((r) => !r.pitchOk || !r.facingOk).reduce((t, r) => t + r.planSqFt, 0);
  return all > 0 ? off / all : 0;
}

/** The plan area at stake in the main faces that differ from Google's segments, as a share of the roof's plan area. */
export function differingStake(roof: Roof3d, building: SolarBuilding | null): number {
  const rows = checkRoof(roof, building).rows;
  const total = roof.faces.reduce((t, f) => t + f.planAreaSqFt, 0);
  const gap = rows.filter((r) => r.main && (!r.pitchOk || !r.facingOk)).reduce((t, r) => t + Math.abs(r.planSqFt - r.segment!.planSqFt), 0);
  return total > 0 ? gap / total : 0;
}

/** Whether a Google difference needs a review (not only a note): DIFFERS_AREA_SHARE of the main area or DIFFERS_STAKE_SHARE at stake. */
export function differsNeedsReview(roof: Roof3d, building: SolarBuilding | null): boolean {
  return differingShare(roof, building) >= DIFFERS_AREA_SHARE || differingStake(roof, building) >= DIFFERS_STAKE_SHARE;
}

/** Confidence of a face whose own edges are all creases (no outline edge to check): a verified edge's. */
const INTERIOR_FACE_CONFIDENCE = 0.771;
/**
 * A face whose pitch or facing differ from Google's segment under it keeps this share of its confidence: when they
 * differ by more than 1/12 ours is the closer to EagleView 16 times in 27 (failure taxonomy, mode 12), so a
 * disagreement is weak evidence either way.
 */
const SEGMENT_DISAGREES = 0.8;
/** An outline edge is a face's when its middle is this close to the face's boundary, metres. */
const EDGE_ON_FACE_M = 0.3;

function metresBetween(a: LngLat, b: LngLat): [number, number] {
  const k = 111_320;
  return [(b[0] - a[0]) * k * Math.cos((a[1] * Math.PI) / 180), (b[1] - a[1]) * k];
}

function nearRing(p: LngLat, ring: readonly LngLat[], tolM: number): boolean {
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!;
    const [bx, by] = metresBetween(a, ring[(i + 1) % ring.length]!);
    const [px, py] = metresBetween(a, p);
    const l2 = bx * bx + by * by;
    const t = l2 > 0 ? Math.max(0, Math.min(1, (px * bx + py * by) / l2)) : 0;
    if (Math.hypot(px - t * bx, py - t * by) <= tolM) return true;
  }
  return false;
}

/**
 * Each face's confidence (Roof3dFace.confidence): the length-weighted confidence of the outline edges it ends on
 * (INTERIOR_FACE_CONFIDENCE when it ends on none), times SEGMENT_DISAGREES when Google's segment under it disagrees.
 * Needs the roof's edges (withEdgeEvidence); without them the roof comes back unchanged.
 */
export function withFaceConfidence(roof: Roof3d, building: SolarBuilding | null): Roof3d {
  const edges = roof.edges;
  if (edges === undefined || edges.length === 0) return roof;
  const rows = checkRoof(roof, building).rows;
  const mids = edges.map((e) => {
    const a = roof.outline[e.from]!;
    const b = roof.outline[(e.from + 1) % roof.outline.length]!;
    return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] as LngLat;
  });
  const faces = roof.faces.map((f, k) => {
    let len = 0;
    let sum = 0;
    edges.forEach((e, i) => {
      if (!nearRing(mids[i]!, f.ring, EDGE_ON_FACE_M)) return;
      len += e.lengthFt;
      sum += e.lengthFt * e.confidence;
    });
    const fromEdges = len > 0 ? sum / len : INTERIOR_FACE_CONFIDENCE;
    const row = rows[k];
    const agrees = row === undefined || row.segment === null || (row.pitchOk && row.facingOk);
    return { ...f, confidence: Math.round(fromEdges * (agrees ? 1 : SEGMENT_DISAGREES) * 1000) / 1000 };
  });
  return { ...roof, faces };
}

/**
 * The roof as the server keeps it: 'differs-from-google' when a main face misses Google's segment, among its review
 * reasons when the faces that do carry DIFFERS_AREA_SHARE of the main area or more or put DIFFERS_STAKE_SHARE of the
 * roof's area at stake (differsNeedsReview), else among its notes; and each
 * face's confidence (withFaceConfidence).
 */
export function withGoogleCheck(roof: Roof3d, building: SolarBuilding | null): Roof3d {
  if (roof.quality === undefined) return roof;
  const checked = withFaceConfidence(roof, building);
  const has = roof.quality.reasons.includes('differs-from-google') || (roof.quality.notes ?? []).includes('differs-from-google');
  if (has || !differsFromGoogle(roof, building)) return checked;
  const q = roof.quality;
  const quality = differsNeedsReview(roof, building) ? { ...q, reasons: [...q.reasons, 'differs-from-google' as const] } : { ...q, notes: [...(q.notes ?? []), 'differs-from-google' as const] };
  return { ...checked, quality: tierReasons(quality) };
}
