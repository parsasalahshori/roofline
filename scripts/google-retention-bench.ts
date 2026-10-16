import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GOOGLE_CONTENT_MAX_DAYS, parseRetentionDays } from '@roofline/shared';

/*
 * Google content retention for the owner's local research data, outside the app (docs/compliance/google-data-retention.md).
 * The app's own copies are deleted by the worker's google-retention job; this covers what sits on this Mac:
 *
 *  - the roof benchmark (~/RooflineWork/roof-bench: testset*, its manifest.json carrying data.deleteBy per house) and the
 *    older saved test data (~/RooflineWork/saved-testdata): each house folder's Google Solar files (dsm.tif, mask.tif,
 *    rgb.tif from Data Layers; bi.json, meta.json from buildingInsights);
 *  - Claude Code scratchpads (/private/tmp/claude-<uid>/<project>/<session>/scratchpad): Solar files, and Street View
 *    photos (JPEGs in a folder named sv, street-view or streetview).
 *
 * Only those Google files go. A house folder's other files (truth, EagleView and OpenStreetMap data, notes, our own
 * results) stay. Images made from Google's photo outside the house folders (overlay PNGs, SVGs embedding a photo) are
 * listed for review and deleted only with --include-derived-images.
 *
 * Dry run by default: it prints what it would delete and deletes nothing. --apply deletes. Never run --apply without the
 * owner's OK.
 *
 *   npx tsx scripts/google-retention-bench.ts [--apply] [--include-derived-images] [--now YYYY-MM-DD] [--days N]
 *                                             [--root DIR ...] [--no-scratchpads] [--list]
 *
 * A folder's date (the day its Google files must be gone by): the manifest's data.deleteBy when the manifest lists it,
 * else info.json's downloadedAt + 30 days, else the oldest Google file's modification time + 30 days (a copy's time is
 * at or after the download, so that date may be late; the manifest's is preferred). Files are due ON that date. With
 * --days N below 30, everything is due 30 - N days earlier.
 */

export const SOLAR_FILES = ['dsm.tif', 'mask.tif', 'rgb.tif', 'bi.json'] as const;
/** buildingInsights' imagery block, saved beside the Solar files: Google's too, but only where a Solar file is. */
export const SOLAR_COMPANION_FILES = ['meta.json'] as const;
const STREET_VIEW_DIRS = new Set(['sv', 'street-view', 'streetview']);
const DAY_MS = 86_400_000;
const MAX_DEPTH = 5;

export type Source = 'manifest' | 'info' | 'mtime';
export type Kind = 'solar' | 'street-view' | 'derived-image';
export type Item = { kind: Kind; dir: string; files: string[]; bytes: number; deleteBy: string; source: Source; root: string };

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Whether an item dated `deleteBy` (YYYY-MM-DD) is due on `today` when `days` are kept: due on its date, or 30 - days earlier. */
export function due(deleteBy: string, today: string, days: number = GOOGLE_CONTENT_MAX_DAYS): boolean {
  const slack = (GOOGLE_CONTENT_MAX_DAYS - parseRetentionDays(days)) * DAY_MS;
  const at = Date.parse(`${deleteBy}T00:00:00Z`);
  return !Number.isFinite(at) || at - slack <= Date.parse(`${today}T00:00:00Z`);
}

/** The manifest's deleteBy per house folder (absolute path). */
export function manifestDates(bench: string): Map<string, string> {
  const map = new Map<string, string>();
  try {
    const m = JSON.parse(readFileSync(path.join(bench, 'manifest.json'), 'utf8')) as { houses?: { dir?: unknown; data?: { deleteBy?: unknown } }[] };
    for (const h of m.houses ?? []) {
      if (typeof h.dir === 'string' && typeof h.data?.deleteBy === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(h.data.deleteBy)) {
        map.set(path.resolve(bench, h.dir), h.data.deleteBy);
      }
    }
  } catch {
    // No manifest (or not JSON): the folders date themselves.
  }
  return map;
}

function sizeOf(dir: string, files: readonly string[]): number {
  return files.reduce((sum, f) => sum + statSync(path.join(dir, f)).size, 0);
}

function dateOf(dir: string, files: readonly string[], manifest: ReadonlyMap<string, string>): { deleteBy: string; source: Source } {
  const fromManifest = manifest.get(path.resolve(dir));
  if (fromManifest !== undefined) return { deleteBy: fromManifest, source: 'manifest' };
  try {
    const info = JSON.parse(readFileSync(path.join(dir, 'info.json'), 'utf8')) as { downloadedAt?: unknown };
    if (typeof info.downloadedAt === 'string' && Number.isFinite(Date.parse(info.downloadedAt))) {
      return { deleteBy: day(Date.parse(info.downloadedAt) + GOOGLE_CONTENT_MAX_DAYS * DAY_MS), source: 'info' };
    }
  } catch {
    // No info.json: fall back to the files' times.
  }
  const oldest = Math.min(...files.map((f) => statSync(path.join(dir, f)).mtimeMs));
  return { deleteBy: day(oldest + GOOGLE_CONTENT_MAX_DAYS * DAY_MS), source: 'mtime' };
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Every folder under `roots` holding Google files: Solar house folders (their Solar files and meta.json), and Street
 * View photo folders (their JPEGs). Folders are not followed into once they are a house folder.
 */
export function googleFolders(roots: readonly string[], manifest: ReadonlyMap<string, string>): Item[] {
  const out: Item[] = [];
  const visit = (root: string, dir: string, depth: number) => {
    if (depth > MAX_DEPTH || !isDir(dir)) return;
    const names = readdirSync(dir).sort();
    const solar = SOLAR_FILES.filter((f) => names.includes(f));
    if (solar.length > 0) {
      const files = [...solar, ...SOLAR_COMPANION_FILES.filter((f) => names.includes(f))];
      out.push({ kind: 'solar', dir, files, bytes: sizeOf(dir, files), root, ...dateOf(dir, solar, manifest) });
      return;
    }
    if (STREET_VIEW_DIRS.has(path.basename(dir).toLowerCase())) {
      const files = names.filter((n) => /\.(jpe?g)$/i.test(n) && !isDir(path.join(dir, n)));
      if (files.length > 0) {
        // Each photo dated by its own time: group by date so one old photo does not take a new one with it.
        const byDate = new Map<string, string[]>();
        for (const f of files) {
          const d = day(statSync(path.join(dir, f)).mtimeMs + GOOGLE_CONTENT_MAX_DAYS * DAY_MS);
          byDate.set(d, [...(byDate.get(d) ?? []), f]);
        }
        for (const [deleteBy, group] of [...byDate.entries()].sort()) {
          out.push({ kind: 'street-view', dir, files: group, bytes: sizeOf(dir, group), root, deleteBy, source: 'mtime' });
        }
      }
    }
    for (const name of names) visit(root, path.join(dir, name), depth + 1);
  };
  for (const root of roots) visit(path.resolve(root), path.resolve(root), 0);
  return out;
}

/**
 * Images made from Google's photo under `roots` but outside the house folders: *.png, and *.svg embedding an image
 * (data:image/), dated by the earliest house date found under the same root (which house each came from is not
 * recorded, so the strictest date applies). For review: they may hold Google pixels, or only our own drawing.
 */
export function derivedImages(roots: readonly string[], houses: readonly Item[]): Item[] {
  const out: Item[] = [];
  const houseDirs = new Set(houses.filter((h) => h.kind === 'solar').map((h) => path.resolve(h.dir)));
  for (const root of roots.map((r) => path.resolve(r))) {
    const dates = houses.filter((h) => h.kind === 'solar' && h.root === root).map((h) => h.deleteBy).sort();
    if (dates.length === 0) continue;
    const deleteBy = dates[0]!;
    const visit = (dir: string, depth: number) => {
      if (depth > MAX_DEPTH + 1 || houseDirs.has(dir) || !isDir(dir)) return;
      const files: string[] = [];
      for (const name of readdirSync(dir).sort()) {
        const full = path.join(dir, name);
        if (isDir(full)) visit(full, depth + 1);
        else if (/\.png$/i.test(name)) files.push(name);
        else if (/\.svg$/i.test(name) && statSync(full).size < 64 * 1024 * 1024 && readFileSync(full, 'utf8').includes('data:image/')) files.push(name);
      }
      if (files.length > 0) out.push({ kind: 'derived-image', dir, files, bytes: sizeOf(dir, files), root, deleteBy, source: 'manifest' });
    };
    visit(root, 0);
  }
  return out;
}

/** Claude Code scratchpads on this machine: /private/tmp/claude-<uid>/<project>/<session>/scratchpad. */
export function scratchpads(base: string = path.join('/private/tmp', `claude-${process.getuid?.() ?? 501}`)): string[] {
  const out: string[] = [];
  if (!isDir(base)) return out;
  for (const project of readdirSync(base)) {
    const p = path.join(base, project);
    if (!isDir(p)) continue;
    for (const session of readdirSync(p)) {
      const pad = path.join(p, session, 'scratchpad');
      if (isDir(pad)) out.push(pad);
    }
  }
  return out.sort();
}

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** A short summary of `items`: how many folders and files, how big, and the span of their dates. */
export function summary(items: readonly Item[]): string {
  if (items.length === 0) return 'none';
  const files = items.reduce((s, i) => s + i.files.length, 0);
  const bytes = items.reduce((s, i) => s + i.bytes, 0);
  const dates = items.map((i) => i.deleteBy).sort();
  return `${items.length} folders, ${files} files, ${mb(bytes)}, dates ${dates[0]}${dates.length > 1 && dates.at(-1) !== dates[0] ? ` to ${dates.at(-1)}` : ''}`;
}

export type Args = { apply: boolean; derived: boolean; now: string; days: number; roots: string[]; scratch: boolean; list: boolean };

export function parseArgs(argv: readonly string[], today: string = day(Date.now())): Args | string {
  const a: Args = { apply: false, derived: false, now: today, days: GOOGLE_CONTENT_MAX_DAYS, roots: [], scratch: true, list: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--apply') a.apply = true;
    else if (arg === '--include-derived-images') a.derived = true;
    else if (arg === '--no-scratchpads') a.scratch = false;
    else if (arg === '--list') a.list = true;
    else if (arg === '--now') a.now = argv[++i] ?? '';
    else if (arg === '--root') a.roots.push(argv[++i] ?? '');
    else if (arg === '--days') {
      try {
        a.days = parseRetentionDays(argv[++i] ?? '');
      } catch (err) {
        return (err as Error).message.replace('GOOGLE_CONTENT_RETENTION_DAYS', '--days');
      }
    } else return `unknown argument ${arg}`;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(a.now)) return '--now must be YYYY-MM-DD';
  return a;
}

const HOME = os.homedir();
export const DEFAULT_BENCH = path.join(HOME, 'RooflineWork', 'roof-bench');
export const DEFAULT_SAVED = path.join(HOME, 'RooflineWork', 'saved-testdata');

export function main(argv: readonly string[], log: (line: string) => void = console.log): number {
  const args = parseArgs(argv);
  if (typeof args === 'string') {
    console.error(args);
    return 2;
  }
  const bench = path.resolve(process.env.ROOF_BENCH_DIR ?? DEFAULT_BENCH);
  const dataRoots = args.roots.length > 0 ? args.roots : [bench, DEFAULT_SAVED];
  const pads = args.scratch ? scratchpads() : [];
  const manifest = manifestDates(bench);
  // saved-testdata mirrors the bench's folder names: the manifest's date covers its copy too.
  for (const [dir, by] of [...manifest]) manifest.set(path.join(DEFAULT_SAVED, path.relative(bench, dir)), by);

  const found = googleFolders([...dataRoots, ...pads], manifest);
  const derived = derivedImages(dataRoots, found);
  const dueNow = found.filter((i) => due(i.deleteBy, args.now, args.days));
  const derivedDue = derived.filter((i) => due(i.deleteBy, args.now, args.days));
  const verb = args.apply ? 'deleting' : 'would delete';

  log(`Google content retention, local data (${args.apply ? 'APPLY' : 'dry run'}), today ${args.now}, kept ${args.days} days`);
  log(`  roots: ${dataRoots.join(', ')}${pads.length > 0 ? ` and ${pads.length} scratchpads` : ''}`);
  for (const kind of ['solar', 'street-view'] as const) {
    const all = found.filter((i) => i.kind === kind);
    log(`  ${kind}: found ${summary(all)}; due now ${summary(dueNow.filter((i) => i.kind === kind))}`);
  }
  log(`  derived images (review; deleted only with --include-derived-images): found ${summary(derived)}; due now ${summary(derivedDue)}`);
  const bySource = new Map<string, number>();
  for (const i of found.filter((x) => x.kind === 'solar')) bySource.set(i.source, (bySource.get(i.source) ?? 0) + 1);
  log(`  solar folders dated by: ${[...bySource.entries()].map(([s, n]) => `${s} ${n}`).join(', ') || 'none'}`);
  const upcoming = new Map<string, number>();
  for (const i of found) if (!due(i.deleteBy, args.now, args.days)) upcoming.set(i.deleteBy, (upcoming.get(i.deleteBy) ?? 0) + i.files.length);
  if (upcoming.size > 0) log(`  upcoming (date: files): ${[...upcoming.entries()].sort().map(([d, n]) => `${d}: ${n}`).join(', ')}`);

  const act = (items: readonly Item[], label: string) => {
    for (const i of items) {
      if (args.list || args.apply || items.length <= 40) log(`${verb} ${label} ${i.files.join(', ')} in ${i.dir} (${mb(i.bytes)}, delete by ${i.deleteBy}, from ${i.source})`);
      if (args.apply) for (const f of i.files) rmSync(path.join(i.dir, f), { force: true });
    }
    if (!args.list && !args.apply && items.length > 40) log(`  (${items.length} ${label} entries; pass --list to print each)`);
  };
  act(dueNow, 'Google files');
  if (args.derived) act(derivedDue, 'derived images');
  else if (derivedDue.length > 0 && args.list) for (const i of derivedDue) log(`review (kept) derived images ${i.files.join(', ')} in ${i.dir}`);
  if (!args.apply && (dueNow.length > 0 || (args.derived && derivedDue.length > 0))) log('dry run: nothing deleted. Pass --apply (with the owner\'s OK) to delete them.');
  if (!args.apply && dueNow.length === 0) log('nothing is due today.');
  return 0;
}

if (process.argv[1] !== undefined && existsSync(process.argv[1]) && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  process.exitCode = main(process.argv.slice(2));
}
