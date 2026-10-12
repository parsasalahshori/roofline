/**
 * The launch-merge normalizer, run through `ops/bin/launch-normalize` after all six tracks are merged
 * (docs/superpowers/launch-runbook.md, "Normalize the migrations"). Four steps, each reported:
 *
 * 1. journal:     meta/_journal.json `when` values strictly increasing in idx order (rewritten unless --check).
 * 2. snapshots:   each meta/NNNN_snapshot.json's prevId is the id before it; ids are unique; every tag has its .sql.
 * 3. drizzle-kit: `drizzle-kit generate` reports no schema changes (anything it writes is removed again).
 * 4. grants:      every column-level GRANT UPDATE on a table with the timestamps() helper includes updated_at.
 *
 * Idempotent: a second run changes nothing. Exit code 0 when every step passes, 1 otherwise.
 * Usage: tsx scripts/launch-normalize.ts [--check] [--skip-generate]   (from packages/db)
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { is } from 'drizzle-orm';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import * as globalSchema from '../src/schema/global.ts';
import * as tenantSchema from '../src/schema/tenant.ts';
import {
  checkSnapshotChain,
  checkUpdatedAtGrants,
  type Finding,
  type Journal,
  normalizeJournal,
  type Snapshot,
} from './launch-normalize-lib.ts';

const DB_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS = join(DB_DIR, 'migrations');
const META = join(MIGRATIONS, 'meta');
const JOURNAL = join(META, '_journal.json');
const CHECK_NAME = 'launch_normalize_check';

const args = new Set(process.argv.slice(2));
const checkOnly = args.has('--check');
const skipGenerate = args.has('--skip-generate');

type Step = { name: string; findings: Finding[]; note?: string };
const steps: Step[] = [];

// 1. Journal.
const journalText = readFileSync(JOURNAL, 'utf8');
const journal = JSON.parse(journalText) as Journal;
const normalized = normalizeJournal(journal);
const journalChanged = normalized.findings.some((f) => f.kind === 'fixed');
if (journalChanged && !checkOnly) {
  writeFileSync(JOURNAL, `${JSON.stringify(normalized.journal, null, 2)}${journalText.endsWith('\n') ? '\n' : ''}`);
}
steps.push({
  name: 'journal',
  findings: checkOnly
    ? normalized.findings.map((f) => (f.kind === 'fixed' ? { kind: 'problem' as const, message: `needs: ${f.message}` } : f))
    : normalized.findings,
  note: `${normalized.journal.entries.length} entries, ${normalized.journal.entries[0]?.tag} … ${normalized.journal.entries.at(-1)?.tag}`,
});

// 2. Snapshot chain, plus a .sql file for every tag and no .sql file outside the journal.
const tags = normalized.journal.entries.map((e) => e.tag);
const snapshots = new Map<string, Snapshot>();
for (const tag of tags) {
  const file = join(META, `${tag.slice(0, 4)}_snapshot.json`);
  if (existsSync(file)) snapshots.set(tag, JSON.parse(readFileSync(file, 'utf8')) as Snapshot);
}
const chain = checkSnapshotChain(tags, snapshots);
for (const tag of tags) {
  if (!existsSync(join(MIGRATIONS, `${tag}.sql`))) chain.push({ kind: 'problem', message: `${tag}: no ${tag}.sql` });
}
for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql'))) {
  if (!tags.includes(file.slice(0, -4))) chain.push({ kind: 'problem', message: `${file} is not in the journal` });
}
steps.push({ name: 'snapshots', findings: chain, note: `${snapshots.size} snapshots chained` });

// 3. drizzle-kit generate must find nothing to do. It reads only the schema and the last snapshot.
if (skipGenerate) {
  steps.push({ name: 'drizzle-kit', findings: [], note: 'skipped (--skip-generate)' });
} else {
  const before = new Set([...readdirSync(MIGRATIONS), ...readdirSync(META).map((f) => `meta/${f}`)]);
  const journalBefore = readFileSync(JOURNAL, 'utf8');
  const kit = join(DB_DIR, '..', '..', 'node_modules', '.bin', 'drizzle-kit');
  const run = spawnSync(kit, ['generate', `--name=${CHECK_NAME}`], {
    cwd: DB_DIR,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 180_000,
  });
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
  const created = [...readdirSync(MIGRATIONS), ...readdirSync(META).map((f) => `meta/${f}`)].filter((f) => !before.has(f));
  for (const f of created) rmSync(join(MIGRATIONS, f));
  if (readFileSync(JOURNAL, 'utf8') !== journalBefore) writeFileSync(JOURNAL, journalBefore);
  const findings: Finding[] = [];
  if (run.error || run.status !== 0) {
    findings.push({ kind: 'problem', message: `drizzle-kit generate failed (${run.error?.message ?? `exit ${run.status}`}): ${output.trim().split('\n').slice(-3).join(' | ')}` });
  } else if (created.length > 0 || !/No schema changes/i.test(output)) {
    findings.push({ kind: 'problem', message: `drizzle-kit generate found schema changes (it would write ${created.join(', ') || 'files'}); the schema and the last snapshot disagree` });
  }
  steps.push({ name: 'drizzle-kit', findings, note: findings.length === 0 ? 'No schema changes' : undefined });
}

// 4. Column-level UPDATE grants on tables whose updated_at Drizzle bumps.
const autoUpdated = new Set<string>();
for (const value of [...Object.values(globalSchema), ...Object.values(tenantSchema)]) {
  if (!is(value, PgTable)) continue;
  const config = getTableConfig(value);
  if (config.columns.some((c) => c.name === 'updated_at' && c.onUpdateFn !== undefined)) autoUpdated.add(config.name);
}
const sqls = tags.filter((t) => existsSync(join(MIGRATIONS, `${t}.sql`))).map((t) => readFileSync(join(MIGRATIONS, `${t}.sql`), 'utf8'));
steps.push({
  name: 'grants',
  findings: checkUpdatedAtGrants(sqls, autoUpdated),
  note: `${autoUpdated.size} tables with an auto-updated updated_at`,
});

// Report.
let failed = false;
console.log(`launch-normalize${checkOnly ? ' --check' : ''}: ${MIGRATIONS}`);
for (const step of steps) {
  const problems = step.findings.filter((f) => f.kind === 'problem');
  const fixes = step.findings.filter((f) => f.kind === 'fixed');
  failed ||= problems.length > 0;
  const status = problems.length > 0 ? 'FAIL' : fixes.length > 0 ? 'FIXED' : 'OK';
  console.log(`\n[${status}] ${step.name}${step.note ? ` (${step.note})` : ''}`);
  for (const f of step.findings) console.log(`  ${f.kind === 'fixed' ? 'fixed:  ' : 'problem:'} ${f.message}`);
}
console.log(`\n${failed ? 'FAILED: fix the problems above and run again.' : journalChanged && !checkOnly ? 'PASSED, with the journal rewritten: commit packages/db/migrations/meta/_journal.json.' : 'PASSED: nothing to change.'}`);
process.exit(failed ? 1 : 0);
