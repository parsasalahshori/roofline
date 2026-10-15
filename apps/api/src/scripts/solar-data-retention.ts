import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { SOLAR_DATA_DAYS } from '@roofline/shared';
import { benchDir, FALLBACK_DATA_DIR } from '../bench/roof3d/paths.ts';

/*
 * Google's Solar data may be kept for 30 days (Solar API terms). This lists, and with --delete removes, the Google
 * files kept on disk for development (the benchmark's and the saved test data's house folders: dsm.tif, mask.tif,
 * rgb.tif, bi.json) once they are past their date. Other files in a folder (an EagleView report, an OpenStreetMap
 * outline, notes) are not Google's and are left. Dry run unless --delete is given.
 *
 *   npm run solar:retention -w @roofline/api [-- --root DIR ...] [--now YYYY-MM-DD] [--delete]
 *
 * A folder's date: the benchmark manifest's deleteBy when it lists the folder, else info.json's downloadedAt plus 30
 * days, else the oldest Google file's modification time plus 30 days (a copy's time is at or after the download, so
 * that date may be late: the manifest's date is preferred).
 */

export const GOOGLE_FILES = ['dsm.tif', 'mask.tif', 'rgb.tif', 'bi.json'] as const;
const DAY_MS = 86_400_000;

export type Folder = { dir: string; deleteBy: string; source: 'manifest' | 'info' | 'mtime'; files: string[] };

/** Every house folder (one with a Google file) under the roots, with the date its Google files must be gone by. */
export function solarFolders(roots: readonly string[], manifestDeleteBy: ReadonlyMap<string, string>): Folder[] {
  const out: Folder[] = [];
  const visit = (dir: string, depth: number) => {
    if (depth > 3 || !existsSync(dir) || !statSync(dir).isDirectory()) return;
    const files = GOOGLE_FILES.filter((f) => existsSync(path.join(dir, f)));
    if (files.length > 0) {
      out.push({ dir, files, ...dateOf(dir, files, manifestDeleteBy) });
      return;
    }
    for (const name of readdirSync(dir).sort()) visit(path.join(dir, name), depth + 1);
  };
  for (const root of roots) visit(path.resolve(root), 0);
  return out;
}

function dateOf(dir: string, files: readonly string[], manifest: ReadonlyMap<string, string>): Pick<Folder, 'deleteBy' | 'source'> {
  const fromManifest = manifest.get(path.resolve(dir));
  if (fromManifest !== undefined) return { deleteBy: fromManifest, source: 'manifest' };
  try {
    const info = JSON.parse(readFileSync(path.join(dir, 'info.json'), 'utf8')) as { downloadedAt?: unknown };
    if (typeof info.downloadedAt === 'string' && Number.isFinite(Date.parse(info.downloadedAt))) {
      return { deleteBy: new Date(Date.parse(info.downloadedAt) + SOLAR_DATA_DAYS * DAY_MS).toISOString().slice(0, 10), source: 'info' };
    }
  } catch {
    // No info.json, or not JSON: fall back to the files' times.
  }
  const oldest = Math.min(...files.map((f) => statSync(path.join(dir, f)).mtimeMs));
  return { deleteBy: new Date(oldest + SOLAR_DATA_DAYS * DAY_MS).toISOString().slice(0, 10), source: 'mtime' };
}

/** The folders whose Google files are past their date at `today` (YYYY-MM-DD): deleteBy before today. */
export function expired(folders: readonly Folder[], today: string): Folder[] {
  return folders.filter((f) => f.deleteBy < today);
}

/** The manifest's deleteBy per house folder (absolute path), or an empty map when there is no manifest. */
function manifestDates(bench: string): Map<string, string> {
  const map = new Map<string, string>();
  try {
    const m = JSON.parse(readFileSync(path.join(bench, 'manifest.json'), 'utf8')) as { houses?: { dir: string; data?: { deleteBy?: string } }[] };
    for (const h of m.houses ?? []) {
      const by = h.data?.deleteBy;
      if (typeof by !== 'string') continue;
      for (const root of [bench, FALLBACK_DATA_DIR]) map.set(path.resolve(root, h.dir), by);
    }
  } catch {
    // No manifest: dates come from the folders.
  }
  return map;
}

function main(argv: string[]): number {
  const roots: string[] = [];
  let now = new Date().toISOString().slice(0, 10);
  let remove = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root') roots.push(argv[++i] ?? '');
    else if (a === '--now') now = argv[++i] ?? now;
    else if (a === '--delete') remove = true;
    else {
      console.error(`unknown argument ${a}`);
      return 2;
    }
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(now)) {
    console.error('--now must be YYYY-MM-DD');
    return 2;
  }
  const bench = benchDir();
  const folders = solarFolders(roots.length > 0 ? roots : [bench, FALLBACK_DATA_DIR], manifestDates(bench));
  const old = expired(folders, now);
  const soonest = [...folders].sort((a, b) => a.deleteBy.localeCompare(b.deleteBy))[0];
  console.log(`${folders.length} folders with Google Solar files; ${old.length} past their date on ${now}${soonest ? `; the earliest date is ${soonest.deleteBy}` : ''}`);
  for (const f of old) {
    console.log(`${remove ? 'deleting' : 'would delete'} ${f.files.join(', ')} in ${f.dir} (delete by ${f.deleteBy}, from ${f.source})`);
    if (remove) for (const file of f.files) rmSync(path.join(f.dir, file), { force: true });
  }
  if (!remove && old.length > 0) console.log('dry run: pass --delete to remove them');
  return 0;
}

if (process.argv[1] !== undefined && import.meta.url.endsWith(path.basename(process.argv[1]))) process.exitCode = main(process.argv.slice(2));
