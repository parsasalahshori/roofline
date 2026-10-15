import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadHouse } from '../bench/roof3d/data.ts';
import { parseManifest } from '../bench/roof3d/manifest.ts';
import { benchDir } from '../bench/roof3d/paths.ts';
import { checkRoof, withGoogleCheck } from '../estimator/roof-3d-compare.ts';
import { roofOnLayers, steepRoof } from '../estimator/roof-3d.ts';

/*
 * The free-provider comparison's input (docs/roof-3d/free-sources.md): our reconstruction of every benchmark house as
 * the server makes it (seed 7, the server default hidden-edge setting), reduced to what the comparison scores: the
 * outline ring, plan and sloped area, the faces' pitch and area, the quality reasons, and Google buildingInsights'
 * own whole-roof and per-segment numbers (the "free tools" baseline). Writes <ROOF_BENCH_DIR>/free/ours/<slug>.json.
 * Hermetic: files only, no network. Usage: tsx src/scripts/roof-3d-free-dump.ts [slug ...]
 */
async function main(): Promise<void> {
  const bench = benchDir();
  const manifest = parseManifest(JSON.parse(readFileSync(path.join(bench, 'manifest.json'), 'utf8')));
  const only = new Set(process.argv.slice(2));
  const out = path.join(bench, 'free', 'ours');
  mkdirSync(out, { recursive: true });
  for (const e of manifest.houses) {
    if (only.size > 0 && !only.has(e.slug)) continue;
    const h = await loadHouse(e, bench);
    let roof = null;
    let error: string | null = null;
    try {
      const found = roofOnLayers(h.layers, e.point, { steep: steepRoof(h.building), building: h.building, seed: 7 });
      roof = found === null ? null : withGoogleCheck(found, h.building);
    } catch (err) {
      error = (err as Error).message.slice(0, 200);
    }
    const bi = JSON.parse(readFileSync(path.join(h.dir, 'bi.json'), 'utf8')) as Record<string, unknown>;
    const sp = (bi.solarPotential ?? {}) as Record<string, unknown>;
    const whole = (sp.wholeRoofStats ?? null) as Record<string, unknown> | null;
    const segs = ((sp.roofSegmentStats ?? []) as Record<string, unknown>[]).map((s) => {
      const st = (s.stats ?? {}) as Record<string, number>;
      return { pitchDeg: (s.pitchDegrees as number) ?? null, azimuthDeg: (s.azimuthDegrees as number) ?? null, areaM2: st.areaMeters2 ?? null, groundM2: st.groundAreaMeters2 ?? null };
    });
    const doc = {
      slug: e.slug,
      error,
      roof:
        roof === null
          ? null
          : {
              outline: roof.outline,
              planSqFt: roof.faces.reduce((t, f) => t + f.planAreaSqFt, 0),
              slopedSqFt: roof.faces.reduce((t, f) => t + f.slopedAreaSqFt, 0),
              faces: roof.faces.map((f) => ({ pitchX12: f.pitchX12, planSqFt: f.planAreaSqFt, slopedSqFt: f.slopedAreaSqFt, flat: f.flat })),
              reasons: roof.quality?.reasons ?? [],
              checkerPassed: checkRoof(roof, h.building).passed,
            },
      google: {
        wholeRoof: whole === null ? null : { areaM2: (whole.areaMeters2 as number) ?? null, groundM2: (whole.groundAreaMeters2 as number) ?? null },
        segments: segs,
        boundingBox: bi.boundingBox ?? null,
        imageryDate: bi.imageryDate ?? null,
        imageryQuality: bi.imageryQuality ?? null,
      },
    };
    writeFileSync(path.join(out, `${e.slug}.json`), JSON.stringify(doc));
    process.stdout.write(`${e.slug} ${roof === null ? 'no-roof' : 'ok'}\n`);
  }
}

main().catch((err) => {
  process.stderr.write(`${(err as Error).message}\n`);
  process.exit(1);
});
