import type { LngLat, Roof3d, SolarBuilding } from '@roofline/shared';

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
    const main = f.planAreaSqFt >= TARGETS.mainFaceSqFt && segment !== null;
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
