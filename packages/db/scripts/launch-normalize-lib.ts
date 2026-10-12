/**
 * Pure checks behind `ops/bin/launch-normalize` (the launch merge of all six tracks). Nothing here touches the
 * file system or a database; scripts/launch-normalize.ts reads the files and runs drizzle-kit.
 */

export type JournalEntry = { idx: number; version: string; when: number; tag: string; breakpoints: boolean };
export type Journal = { version: string; dialect: string; entries: JournalEntry[] };

/** One finding. `fixed` means the normalizer changed something; `problem` means the run fails. */
export type Finding = { kind: 'fixed' | 'problem'; message: string };

/** The gap the normalizer puts between two `when` values it has to move. */
export const WHEN_STEP_MS = 1000;

/**
 * Makes the journal's `when` values strictly increasing in idx order: drizzle's migrator skips a migration whose
 * `when` is not newer than the last one applied, so a merged journal with an out-of-order entry silently drops it.
 * Only entries that are not already newer than the one before move (to the one before + WHEN_STEP_MS), so a
 * normalized journal is left exactly as it is. Also reports idx gaps, duplicates and tags that do not match the idx.
 */
export function normalizeJournal(journal: Journal): { journal: Journal; findings: Finding[] } {
  const findings: Finding[] = [];
  const entries = [...journal.entries].sort((a, b) => a.idx - b.idx).map((e) => ({ ...e }));
  if (journal.entries.some((e, i) => e.idx !== entries[i]!.idx)) {
    findings.push({ kind: 'fixed', message: 'journal entries sorted by idx' });
  }
  entries.forEach((entry, position) => {
    if (entry.idx !== position) {
      findings.push({ kind: 'problem', message: `journal idx ${entry.idx} is at position ${position}: idx must run 0, 1, 2, … with no gap or duplicate` });
    }
    const prefix = String(entry.idx).padStart(4, '0');
    if (!entry.tag.startsWith(`${prefix}_`)) {
      findings.push({ kind: 'problem', message: `journal idx ${entry.idx} has tag ${entry.tag}, which does not start with ${prefix}_` });
    }
  });
  for (let i = 1; i < entries.length; i += 1) {
    const prev = entries[i - 1]!;
    const entry = entries[i]!;
    if (entry.when <= prev.when) {
      const when = prev.when + WHEN_STEP_MS;
      findings.push({ kind: 'fixed', message: `${entry.tag}: when ${entry.when} -> ${when} (was not after ${prev.tag})` });
      entry.when = when;
    }
  }
  return { journal: { ...journal, entries }, findings };
}

export type Snapshot = { id: string; prevId: string };

export const ROOT_SNAPSHOT_PREV_ID = '00000000-0000-0000-0000-000000000000';

/**
 * Checks the snapshot chain: every journal tag has a snapshot, the first one's prevId is the root id, each
 * later prevId is the snapshot before it, and the ids are unique. Never changes anything: a broken chain means a
 * track's snapshot was not rebuilt on the merged one before it, which needs the owning track's attention.
 */
export function checkSnapshotChain(tags: string[], snapshots: Map<string, Snapshot>): Finding[] {
  const findings: Finding[] = [];
  const seen = new Map<string, string>();
  let prevId = ROOT_SNAPSHOT_PREV_ID;
  let prevTag = '(root)';
  for (const tag of tags) {
    const snapshot = snapshots.get(tag);
    if (!snapshot) {
      findings.push({ kind: 'problem', message: `${tag}: no meta/${tag.slice(0, 4)}_snapshot.json` });
      continue;
    }
    if (snapshot.prevId !== prevId) {
      findings.push({ kind: 'problem', message: `${tag}: prevId ${snapshot.prevId} is not the id of ${prevTag} (${prevId})` });
    }
    const other = seen.get(snapshot.id);
    if (other) findings.push({ kind: 'problem', message: `${tag}: id ${snapshot.id} is also the id of ${other}` });
    seen.set(snapshot.id, tag);
    prevId = snapshot.id;
    prevTag = tag;
  }
  return findings;
}

/** A statement's privilege on a table: table-wide, or a set of columns. */
type Privilege = { table: true } | { columns: Set<string> };

const ident = (s: string): string => s.trim().replace(/^"|"$/g, '').replace(/^public\./i, '').replace(/^"|"$/g, '').toLowerCase();

/** Splits on commas that are not inside parentheses. */
function splitTop(list: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of list) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim() !== '') parts.push(current);
  return parts.map((p) => p.trim());
}

/** The UPDATE part of a privilege list: table-wide (UPDATE or ALL), a column set, or nothing. */
function updatePrivilege(privileges: string): Privilege | null {
  for (const item of splitTop(privileges)) {
    const m = /^(\w+)(?:\s+privileges)?\s*(?:\(([^)]*)\))?$/i.exec(item);
    if (!m) continue;
    const name = m[1]!.toLowerCase();
    if (name !== 'update' && name !== 'all') continue;
    if (m[2] === undefined) return { table: true };
    return { columns: new Set(m[2].split(',').map(ident)) };
  }
  return null;
}

/** SQL with comments and dollar-quoted bodies removed, split into statements. */
export function sqlStatements(sql: string): string[] {
  const stripped = sql
    .replace(/\$([A-Za-z_]*)\$[\s\S]*?\$\1\$/g, '$$$$')
    .replace(/--[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  return stripped
    .split(';')
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter((s) => s !== '');
}

const GRANT = /^grant (.+?) on (?:table )?(.+?) to (.+?)(?: with grant option)?$/i;
const REVOKE = /^revoke (?:grant option for )?(.+?) on (?:table )?(.+?) from (.+?)(?: cascade| restrict)?$/i;

/** Each role's effective UPDATE privilege per table after every migration, in order. */
export function updateGrants(migrations: string[]): Map<string, Map<string, Privilege>> {
  const byRole = new Map<string, Map<string, Privilege>>();
  const tablesOf = (role: string) => {
    let m = byRole.get(role);
    if (!m) byRole.set(role, (m = new Map()));
    return m;
  };
  for (const sql of migrations) {
    for (const statement of sqlStatements(sql)) {
      const grant = GRANT.exec(statement);
      const revoke = grant ? null : REVOKE.exec(statement);
      const m = grant ?? revoke;
      if (!m) continue;
      const target = m[2]!.trim();
      // Sequences, schemas, functions and types carry no column UPDATE.
      if (/^(sequence|schema|function|procedure|routine|type|domain|database|all sequences|all functions)\b/i.test(target)) continue;
      const privilege = updatePrivilege(m[1]!);
      if (!privilege) continue;
      const tables = /^all tables in schema/i.test(target) ? ['*'] : splitTop(target).map(ident);
      for (const role of splitTop(m[3]!).map(ident)) {
        const map = tablesOf(role);
        for (const table of tables) {
          const current = map.get(table);
          if (grant) {
            if ('table' in privilege || (current && 'table' in current)) map.set(table, { table: true });
            else map.set(table, { columns: new Set([...(current && 'columns' in current ? current.columns : []), ...privilege.columns]) });
          } else if ('table' in privilege) {
            map.delete(table);
          } else if (current && 'columns' in current) {
            for (const c of privilege.columns) current.columns.delete(c);
          }
        }
      }
    }
  }
  return byRole;
}

/**
 * Every column-level UPDATE grant on a table whose updated_at Drizzle bumps on every UPDATE (the timestamps()
 * helper's $onUpdate) must include updated_at, or every Drizzle update by that role is refused.
 */
export function checkUpdatedAtGrants(migrations: string[], autoUpdatedTables: Set<string>): Finding[] {
  const findings: Finding[] = [];
  for (const [role, tables] of [...updateGrants(migrations)].sort(([a], [b]) => a.localeCompare(b))) {
    for (const [table, privilege] of [...tables].sort(([a], [b]) => a.localeCompare(b))) {
      if (!('columns' in privilege) || privilege.columns.size === 0) continue;
      if (!autoUpdatedTables.has(table) || privilege.columns.has('updated_at')) continue;
      const cols = [...privilege.columns].sort().join(', ');
      findings.push({ kind: 'problem', message: `${role}: GRANT UPDATE (${cols}) ON ${table} lacks updated_at, which Drizzle sets on every update` });
    }
  }
  return findings;
}
