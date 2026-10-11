import { and, eq, isNotNull } from 'drizzle-orm';
import {
  applyImportChunk,
  type ChunkWrite,
  claimImport,
  existingIndexFor,
  failImport,
  finishImport,
  hasPlannedSkips,
  IMPORT_CHUNK,
  importCells,
  importRows,
  nextImportChunk,
  saveImportProgress,
  type TenantContext,
  type Tx,
  withTenant,
  writePlannedSkips,
} from '@roofline/db';
import type { ExistingCustomer, ExistingIndex, ImportCounts, ImportMapping, NormalizedRow } from '@roofline/shared';
import type { AppDeps } from '../app.ts';
import type { JobMeta } from '../jobs/queue.ts';
import type { GeocodeResult } from '../providers/geocoder.ts';
import { systemContext } from '../permissions.ts';
import { normalizeRow } from './normalize.ts';
import { planImport } from './plan.ts';

/** The plain-English error an import is failed with after its last attempt. */
export const IMPORT_FAILED_PLAIN = "We couldn't finish this import. Rows already imported are saved. Try again from Setup.";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Rows per existing-customer lookup while planning, so a 20,000-row file never sends one huge query. */
const INDEX_SLICE = 1000;

type Geo = ChunkWrite['rows'][number]['geo'];

/**
 * Runs one customer import (the `import-customers` job). Resolves when the import is finished, or
 * when this attempt is saved for a retry. A throw is rethrown after the import is failed (on the
 * last attempt only), so the queue sees it and counts the attempt.
 *
 * The first claim plans the whole file (skips are written at once). Each chunk of rows is written
 * in one transaction together with the running counts, so a crash never leaves the counts behind
 * the rows that were written. `processed` starts at the skipped count: skipped rows are done too,
 * so the progress bar reaches the total. `new`, `updated`, `jobs`, `located` and `notLocated` are
 * running totals of what the chunks actually wrote (the plan only estimates them).
 */
export async function runImport(deps: AppDeps, companyId: string, importId: string, meta: JobMeta): Promise<void> {
  // The job's data is not checked by the queue, so a bad id is refused here, before the database sees it.
  if (typeof importId !== 'string' || !UUID_PATTERN.test(importId)) {
    throw new Error('This import could not be found.');
  }
  const ctx = systemContext(companyId);
  try {
    const now = deps.clock.now();
    const claimed = await withTenant(deps.pools, ctx, async (tx) => {
      const row = await claimImport(tx, ctx, importId, now);
      if (row === null) return null;
      return { row, planned: await alreadyPlanned(tx, ctx, importId) };
    });
    if (claimed === null) return;
    const { row } = claimed;
    const mapping = row.mapping as ImportMapping;

    let counts: ImportCounts = claimed.planned
      ? (row.counts as unknown as ImportCounts)
      : await planFile(deps, ctx, importId, mapping, row.consentAttested, now);

    const createJobs = mapping.stage !== undefined;
    const attested = row.consentAttested && row.attestedByUserId
      ? { userId: row.attestedByUserId, text: row.consentText ?? '' }
      : null;

    for (;;) {
      const chunk = await withTenant(deps.pools, ctx, (tx) => nextImportChunk(tx, ctx, importId, IMPORT_CHUNK));
      if (chunk.length === 0) break;

      const rows = chunk.map((r) => {
        const normalized = normalizeRow(r.cells, mapping);
        if ('skip' in normalized) throw new Error(`Row ${r.rowNumber} was skipped after the import was planned.`);
        return { rowNumber: r.rowNumber, normalized };
      });
      // Geocoding calls out to a service, so it runs outside any transaction.
      const geos = await geocodeRows(deps, rows.map((r) => r.normalized));

      counts = await withTenant(deps.pools, ctx, async (tx) => {
        const written = await applyImportChunk(
          tx,
          ctx,
          {
            rows: rows.map((r, i) => ({
              rowNumber: r.rowNumber,
              normalized: r.normalized,
              // Placeholders: applyImportChunk matches each row and recomputes consent from the database.
              match: null,
              consent: 'none',
              consentChanged: false,
              geo: geos[i] ?? null,
            })),
            createJobs,
            fileName: row.fileName,
            attested,
            importId,
            createdByUserId: row.createdByUserId,
          },
          now,
        );
        const progressed: ImportCounts = {
          ...counts,
          processed: counts.processed + chunk.length,
          new: counts.new + written.created,
          updated: counts.updated + written.updated,
          jobs: counts.jobs + written.jobs,
          located: counts.located + written.located,
          notLocated: counts.notLocated + written.notLocated,
        };
        await saveImportProgress(tx, ctx, importId, progressed, now);
        return progressed;
      });
    }

    await withTenant(deps.pools, ctx, (tx) => finishImport(tx, ctx, importId, counts, now));
  } catch (err) {
    if (meta.lastAttempt) {
      try {
        await withTenant(deps.pools, ctx, (tx) => failImport(tx, ctx, importId, IMPORT_FAILED_PLAIN, deps.clock.now()));
      } catch {
        // The original error is the one that matters; a failure to record it is not reported over it.
      }
    }
    throw err;
  }
}

/**
 * True when this import has already been planned: its skips are written, or one of its rows has an
 * outcome (a chunk was written). A file with no skips has no skip rows, so the second check covers
 * it once a chunk has landed.
 */
async function alreadyPlanned(tx: Tx, ctx: TenantContext, importId: string): Promise<boolean> {
  if (await hasPlannedSkips(tx, ctx, importId)) return true;
  const [started] = await tx
    .select({ id: importRows.id })
    .from(importRows)
    .where(and(eq(importRows.companyId, ctx.companyId), eq(importRows.importId, importId), isNotNull(importRows.outcome)))
    .limit(1);
  return started !== undefined;
}

/**
 * Plans the whole file in one transaction: normalizes every row, looks up the existing customers in
 * slices, writes the skips and stores the starting counts. The running counts start at zero, except
 * `processed`, which starts at the skipped count.
 */
async function planFile(
  deps: AppDeps,
  ctx: TenantContext,
  importId: string,
  mapping: ImportMapping,
  attested: boolean,
  now: Date,
): Promise<ImportCounts> {
  return withTenant(deps.pools, ctx, async (tx) => {
    const cells = await importCells(tx, ctx, importId);
    const normalized = cells.map((c) => normalizeRow(c, mapping));

    const byPhone = new Map<string, ExistingCustomer>();
    const byEmail = new Map<string, ExistingCustomer>();
    for (let start = 0; start < normalized.length; start += INDEX_SLICE) {
      const slice = normalized.slice(start, start + INDEX_SLICE);
      const phones = slice.flatMap((n) => ('skip' in n ? [] : n.phones));
      const emails = slice.flatMap((n) => ('skip' in n ? [] : n.emails));
      const found = await existingIndexFor(tx, ctx, phones, emails);
      for (const [key, customer] of found.byPhone) if (!byPhone.has(key)) byPhone.set(key, customer);
      for (const [key, customer] of found.byEmail) if (!byEmail.has(key)) byEmail.set(key, customer);
    }
    const index: ExistingIndex = { byPhone, byEmail };

    const plan = planImport(normalized, index, attested);
    const skips = plan.rows
      .filter((r) => r.outcome === 'skip')
      .map((r) => ({ row: r.row, reason: r.reason ?? '' }));
    const counts: ImportCounts = {
      ...plan.counts,
      processed: plan.counts.skipped,
      new: 0,
      updated: 0,
      jobs: 0,
      located: 0,
      notLocated: 0,
    };
    await writePlannedSkips(tx, ctx, importId, skips);
    await saveImportProgress(tx, ctx, importId, counts, now);
    return counts;
  });
}

/**
 * Geocodes the addresses of one chunk in one call. Rows without an address get no geo. A failed call
 * gives no geo to the whole chunk, so its rows count as not located.
 */
async function geocodeRows(deps: AppDeps, rows: readonly NormalizedRow[]): Promise<Geo[]> {
  const out: Geo[] = rows.map(() => null);
  const withAddress: { index: number; text: string }[] = [];
  rows.forEach((r, index) => {
    const a = r.address;
    if (a) withAddress.push({ index, text: `${a.addressLine}, ${a.city}, ${a.state} ${a.zip}` });
  });
  if (withAddress.length === 0 || !deps.geocoder.configured) return out;

  let results: (GeocodeResult | null)[];
  try {
    results = await deps.geocoder.geocodeMany(withAddress.map((a) => a.text));
  } catch {
    return out;
  }
  withAddress.forEach((a, k) => {
    const result = results[k] ?? null;
    if (result) {
      out[a.index] = { lng: result.lng, lat: result.lat, timezone: result.timezone, accuracy: result.accuracy, source: result.source };
    }
  });
  return out;
}
