import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import type { LngLat, Roof3d, SolarBuilding } from '@roofline/shared';
import { checkRoof, formatCheck, TARGETS } from '../src/estimator/roof-3d-compare.ts';
import { roofOnLayers, steepRoof } from '../src/estimator/roof-3d.ts';
import { parseBuildingInsights } from '../src/providers/google-solar.ts';
import { layersFrom, readGeoTiff, readRgbGeoTiff } from '../src/providers/google-solar-layers.ts';

/*
 * Real Google Solar Data Layers (not committed: Google's files): set ROOF_3D_REAL_DATA to a folder holding, per
 * house, a folder with dsm.tif, mask.tif (and rgb.tif) as Google serves them, and Google's buildingInsights answer for
 * the house (its raw JSON, or a SolarBuilding). The acceptance targets (estimator/roof-3d-compare.ts) are checked:
 * every face of 150 sq ft or more within 1/12 and 15 degrees of the segment under it, no face under 25 sq ft, none
 * steeper than 18/12, the outline over Google's mask. Skipped when the folder is not set. The same check runs on any
 * house with `npm run roof3d:check -w @roofline/api`.
 */

const DATA = process.env.ROOF_3D_REAL_DATA;

const HOUSES: { name: string; dir: string; point: LngLat; insights: string }[] = [
  { name: '305 Ridgeway Dr, Little Rock AR', dir: 'dl305', point: [-92.311074, 34.753229], insights: 'dl305-bi.json' },
  { name: '1007 Roland Dr, Papillion NE', dir: 'dlund', point: [-96.0243555, 41.1721737], insights: 'dlund-bi.json' },
  { name: '99 Briar Ln, Irvine CA', dir: 'dlirv', point: [-117.7723202, 33.7400499], insights: 'irvine-bi.json' },
];

/**
 * Where Google's segment and the height map disagree, checked by hand (face letter on that house):
 * - Papillion C, the south hip end: Google says 8.6/12. The height map down the middle of the face drops 2.23 m over
 *   3.5 m (7.6/12); a plain least-squares plane through the face gives 7.8/12, the reconstruction 7.5/12.
 * - Papillion F, the low east roof (2.9/12): Google splits it into three segments (2.9/12 facing 81, 3.5/12 facing 51,
 *   2.1/12 facing 124); the one under the face's middle faces 51, the face as one plane faces 70. At 3/12 the facing of
 *   a plane is poorly defined.
 */
const KNOWN: Record<string, Record<string, 'pitch' | 'facing'>> = {
  dlund: { C: 'pitch', F: 'facing' },
};

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
    test(`${house.name}: the acceptance targets`, async () => {
      const dir = path.join(DATA!, house.dir);
      const dsm = await readGeoTiff(await readTiff(path.join(dir, 'dsm.tif')));
      const mask = await readGeoTiff(await readTiff(path.join(dir, 'mask.tif')));
      const rgb = path.join(dir, 'rgb.tif');
      const layers = {
        ...layersFrom(dsm, mask, { imageryQuality: 'HIGH', imageryDate: null }),
        photo: existsSync(rgb) ? await readRgbGeoTiff(await readTiff(rgb)) : null,
      };
      const building = insightsOf(path.join(DATA!, house.insights));
      const started = performance.now();
      const roof: Roof3d | null = roofOnLayers(layers, house.point, { steep: steepRoof(building) });
      const ms = performance.now() - started;
      expect(roof).not.toBeNull();
      const check = checkRoof(roof!, building);
      process.stdout.write(`${formatCheck(house.name, roof!, check, ms)}\n`);
      const known = KNOWN[house.dir] ?? {};
      for (const row of check.rows.filter((r) => r.main)) {
        if (known[row.face] !== 'pitch') expect(row.pitchOk, `${house.name} ${row.face}: pitch`).toBe(true);
        if (known[row.face] !== 'facing') expect(row.facingOk, `${house.name} ${row.face}: facing`).toBe(true);
      }
      expect(check.junkFaces, 'faces under 25 sq ft').toBe(0);
      expect(check.steepFaces, `faces steeper than ${TARGETS.steepX12}/12`).toBe(0);
      expect(roof!.quality!.outlineIoU).toBeGreaterThanOrEqual(TARGETS.outlineIoU);
      expect(roof!.quality!.edgeFit).toBeGreaterThanOrEqual(TARGETS.edgeFit);
    });
  }
});
