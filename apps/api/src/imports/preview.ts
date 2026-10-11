import type { ImportCounts, ImportMapping, ImportPreviewRow, ImportView, SkipKey } from '@roofline/shared';
import { existingIndexFor, importCells, type ImportRow, type TenantContext, type Tx } from '@roofline/db';
import { normalizeRow } from './normalize.ts';
import { planImport, previewRows } from './plan.ts';

const SKIP_KEYS: readonly SkipKey[] = ['noName', 'noContact', 'badPhone', 'duplicate'];

function zeroCounts(): ImportCounts {
  return {
    total: 0,
    new: 0,
    updated: 0,
    skipped: 0,
    skippedBy: Object.fromEntries(SKIP_KEYS.map((k) => [k, 0])) as ImportCounts['skippedBy'],
    consent: { attested: 0, express: 0, unchanged: 0, optedOutKept: 0 },
    jobs: 0,
    processed: 0,
    located: 0,
    notLocated: 0,
  };
}

// Stored counts may be partial (an import that has only been mapped), so missing numbers read as zero.
function countsFrom(stored: unknown): ImportCounts {
  const partial = (stored ?? {}) as Partial<ImportCounts>;
  const base = zeroCounts();
  return {
    ...base,
    ...partial,
    skippedBy: { ...base.skippedBy, ...partial.skippedBy },
    consent: { ...base.consent, ...partial.consent },
  };
}

/** The import as the wizard shows it. Before the job starts, counts and preview come from the rows. */
export async function buildImportView(tx: Tx, ctx: TenantContext, row: ImportRow, attestedPreview: boolean): Promise<ImportView> {
  let counts: ImportCounts;
  let preview: ImportPreviewRow[] = [];

  if (row.status === 'uploaded') {
    const mapping = row.mapping as ImportMapping;
    const cells = await importCells(tx, ctx, row.id);
    const normalized = cells.map((c) => normalizeRow(c, mapping));
    const phones: string[] = [];
    const emails: string[] = [];
    for (const n of normalized) {
      if ('skip' in n) continue;
      phones.push(...n.phones);
      emails.push(...n.emails);
    }
    const index = await existingIndexFor(tx, ctx, phones, emails);
    const plan = planImport(normalized, index, attestedPreview);
    counts = plan.counts;
    preview = previewRows(plan);
  } else {
    counts = countsFrom(row.counts);
  }

  return {
    id: row.id,
    fileName: row.fileName,
    status: row.status,
    headers: row.headers,
    mapping: row.mapping as ImportMapping,
    rowCount: row.rowCount,
    counts,
    preview,
    progress: { processed: counts.processed, total: row.rowCount },
    consentAttested: row.consentAttested,
    startedAt: row.startedAt ? row.startedAt.toISOString() : null,
    finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
    errorPlain: row.errorPlain,
    skippedDownloadUrl: row.status === 'done' ? row.errorFileUrl : null,
  };
}
