import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { type LngLat, pitchX12FromDegrees, type Roof3d, type SolarBuilding } from '@roofline/shared';
import { roofOnLayers } from '../src/estimator/roof-3d.ts';
import { parseBuildingInsights } from '../src/providers/google-solar.ts';
import { layersFrom, readGeoTiff } from '../src/providers/google-solar-layers.ts';

/*
 * Real Google Solar Data Layers (not committed: Google's files): set ROOF_3D_REAL_DATA to a folder holding, per
 * house, a folder with dsm.tif and mask.tif as Google serves them, and Google's buildingInsights answer for the house
 * (its raw JSON, or a SolarBuilding). The reconstruction's faces are compared with Google's own roof segments: every
 * main segment (20 m2 or more of plan) must have a face under its centre within 1/12 of its pitch and 15 degrees of
 * the way it faces. Skipped when the folder is not set.
 */

const DATA = process.env.ROOF_3D_REAL_DATA;

const HOUSES: { name: string; dir: string; point: LngLat; insights: string }[] = [
  { name: '305 Ridgeway Dr, Little Rock AR', dir: 'dl305', point: [-92.311074, 34.753229], insights: 'dl305-bi.json' },
  { name: 'Omaha NE (hip roof)', dir: 'dlund', point: [-96.0243555, 41.1721737], insights: 'dlund-bi.json' },
  { name: '99 Briar Ln, Irvine CA', dir: 'dlirv', point: [-117.7723202, 33.7400499], insights: 'irvine-bi.json' },
];

const MAIN_SEGMENT_M2 = 20;
/**
 * Where Google's segment and the height map disagree: Omaha's south hip end. Google says 8.6/12; a plain least-squares
 * plane through the face's own heights gives 7.8/12 and the reconstruction (outliers trimmed) 7.5/12. Allowed 1.25/12.
 */
const KNOWN: { house: string; azimuthDeg: number; pitchX12: number; allowX12: number }[] = [
  { house: 'dlund', azimuthDeg: 159, pitchX12: 8.6, allowX12: 1.25 },
];

function inside(p: LngLat, ring: readonly LngLat[]): boolean {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

function arc(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

async function readTiff(file: string): Promise<ArrayBuffer> {
  const bytes = readFileSync(file);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function insightsOf(file: string): SolarBuilding {
  const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  return 'segments' in raw ? (raw as unknown as SolarBuilding) : parseBuildingInsights(raw);
}

describe.skipIf(DATA === undefined || !existsSync(DATA))('the 3D roof on real Google Data Layers', () => {
  for (const house of HOUSES) {
    test(`${house.name}: main faces match Google's roof segments`, async () => {
      const dir = path.join(DATA!, house.dir);
      const dsm = await readGeoTiff(await readTiff(path.join(dir, 'dsm.tif')));
      const mask = await readGeoTiff(await readTiff(path.join(dir, 'mask.tif')));
      const layers = layersFrom(dsm, mask, { imageryQuality: 'HIGH', imageryDate: null });
      const started = performance.now();
      const roof: Roof3d | null = roofOnLayers(layers, house.point);
      const ms = performance.now() - started;
      expect(roof).not.toBeNull();
      const building = insightsOf(path.join(DATA!, house.insights));
      const rows: string[] = [];
      const checks: (() => void)[] = [];
      for (const seg of [...building.segments].sort((a, b) => b.groundAreaM2 - a.groundAreaM2)) {
        const k = roof!.faces.findIndex((f) => inside(seg.center, f.ring));
        const face = k >= 0 ? roof!.faces[k]! : null;
        const theirs = (12 * Math.tan((seg.pitchDeg * Math.PI) / 180)).toFixed(1);
        const ours = face === null ? '-' : face.pitchX12.toFixed(1);
        const facing = face === null || seg.pitchDeg < 9.5 ? '-' : `${face.azimuthDeg.toFixed(0)} vs ${seg.azimuthDeg.toFixed(0)}`;
        rows.push(
          `${face === null ? '?' : String.fromCharCode(65 + k)} | ${ours} vs ${theirs}/12 | ${facing} | ${face === null ? '-' : (face.planAreaSqFt / 10.7639).toFixed(1)} m2 face vs ${seg.groundAreaM2.toFixed(1)} m2 segment`,
        );
        if (seg.groundAreaM2 < MAIN_SEGMENT_M2) continue;
        checks.push(() => {
          expect(face, `${house.name}: a face under the ${theirs}/12 segment`).not.toBeNull();
          const theirX12 = 12 * Math.tan((seg.pitchDeg * Math.PI) / 180);
          const known = KNOWN.find((x) => x.house === house.dir && arc(x.azimuthDeg, seg.azimuthDeg) < 3 && Math.abs(x.pitchX12 - theirX12) < 0.1);
          expect(Math.abs(face!.pitchX12 - theirX12), `${house.name}: pitch`).toBeLessThanOrEqual(known?.allowX12 ?? 1);
          if (pitchX12FromDegrees(seg.pitchDeg) >= 2) expect(arc(face!.azimuthDeg, seg.azimuthDeg), `${house.name}: facing`).toBeLessThanOrEqual(15);
        });
      }
      // The comparison, for the record (face, pitch ours vs Google's, facing, plan area).
      process.stdout.write(`${house.name}: ${roof!.faces.length} faces in ${ms.toFixed(0)} ms\n  ${rows.join('\n  ')}\n`);
      for (const check of checks) check();
    });
  }
});
