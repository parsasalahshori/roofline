// Run by hand: node apps/api/test/fixtures/footprints/make-ne-zip.mjs
// Builds NE.geojson.zip (Nebraska.geojson inside) from ../footprints-ne.json.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = JSON.parse(readFileSync(join(here, '..', 'footprints-ne.json'), 'utf8'));
const features = src.map((b) => ({
  type: 'Feature',
  properties: { id: b.sourceRef },
  geometry: { type: 'Polygon', coordinates: [b.ring] },
}));
const [lng, lat] = src[0].ring[0];
features.push({
  type: 'Feature',
  properties: { id: 'skip-multipolygon' },
  geometry: {
    type: 'MultiPolygon',
    coordinates: [[[[lng, lat], [lng + 0.0001, lat], [lng + 0.0001, lat + 0.0001], [lng, lat]]]],
  },
});
features.push({
  type: 'Feature',
  properties: { id: 'skip-point' },
  geometry: { type: 'Point', coordinates: [lng, lat] },
});
features.push({
  type: 'Feature',
  properties: { id: 'skip-unclosed' },
  geometry: {
    type: 'Polygon',
    coordinates: [[[lng, lat], [lng + 0.0001, lat], [lng + 0.0001, lat + 0.0001], [lng, lat + 0.0001]]],
  },
});

const dir = mkdtempSync(join(tmpdir(), 'ne-zip-'));
try {
  writeFileSync(join(dir, 'Nebraska.geojson'), JSON.stringify({ type: 'FeatureCollection', features }));
  const out = join(here, 'NE.geojson.zip');
  if (existsSync(out)) rmSync(out);
  try {
    execFileSync('zip', ['-q', '-X', out, 'Nebraska.geojson'], { cwd: dir });
  } catch {
    execFileSync('python3', ['-m', 'zipfile', '-c', out, join(dir, 'Nebraska.geojson')]);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
