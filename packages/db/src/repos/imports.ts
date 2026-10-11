import { and, asc, desc, eq, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import type { ExistingCustomer, ExistingIndex, ImportCounts, ImportMapping } from '@roofline/shared';
import { customers, importRows, imports, optOuts } from '../schema/index.ts';
import type { TenantContext, Tx } from '../tenant.ts';

export type ImportRow = typeof imports.$inferSelect;

/** Rows per INSERT, so a 20,000-row file stays well under the bind-parameter limit. */
const INSERT_CHUNK = 1000;

/** Creates an import in the `uploaded` state, owned by the caller. */
export async function createImport(
  tx: Tx,
  ctx: TenantContext,
  i: { fileName: string; headers: string[]; mapping: ImportMapping; rowCount: number },
  now: Date,
): Promise<ImportRow> {
  const [row] = await tx
    .insert(imports)
    .values({
      companyId: ctx.companyId,
      fileName: i.fileName,
      headers: i.headers,
      mapping: i.mapping,
      rowCount: i.rowCount,
      status: 'uploaded',
      createdByUserId: ctx.userId,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  if (!row) throw new Error('insert into imports returned no row');
  return row;
}

/** Stores the file's data rows. Row numbers start at 2: row 1 of the file is the header. */
export async function insertImportRows(tx: Tx, ctx: TenantContext, importId: string, rows: readonly string[][]): Promise<void> {
  for (let start = 0; start < rows.length; start += INSERT_CHUNK) {
    const chunk = rows.slice(start, start + INSERT_CHUNK);
    await tx.insert(importRows).values(
      chunk.map((cells, offset) => ({
        companyId: ctx.companyId,
        importId,
        rowNumber: start + offset + 2,
        cells: [...cells],
      })),
    );
  }
}

export async function getImport(tx: Tx, ctx: TenantContext, id: string): Promise<ImportRow | null> {
  const [row] = await tx
    .select()
    .from(imports)
    .where(and(eq(imports.companyId, ctx.companyId), eq(imports.id, id)))
    .limit(1);
  return row ?? null;
}

/** Replaces the mapping and its counts. Only an import that has not started can change. */
export async function setImportMapping(
  tx: Tx,
  ctx: TenantContext,
  id: string,
  mapping: ImportMapping,
  counts: ImportCounts,
  now: Date,
): Promise<boolean> {
  const updated = await tx
    .update(imports)
    .set({
      mapping,
      counts: counts as unknown as Record<string, number>,
      updatedAt: now,
    })
    .where(and(eq(imports.companyId, ctx.companyId), eq(imports.id, id), eq(imports.status, 'uploaded')))
    .returning({ id: imports.id });
  return updated.length > 0;
}

/**
 * Moves an uploaded import to `queued` and records the consent it was made under. Only one caller
 * can win this: a second start finds the row already queued and gets false.
 */
export async function startImport(
  tx: Tx,
  ctx: TenantContext,
  id: string,
  i: { attested: boolean; text: string | null },
  now: Date,
): Promise<boolean> {
  const updated = await tx
    .update(imports)
    .set({
      status: 'queued',
      consentAttested: i.attested,
      consentText: i.text,
      attestedByUserId: i.attested ? ctx.userId : null,
      attestedAt: i.attested ? now : null,
      startedAt: now,
      updatedAt: now,
    })
    .where(and(eq(imports.companyId, ctx.companyId), eq(imports.id, id), eq(imports.status, 'uploaded')))
    .returning({ id: imports.id });
  return updated.length > 0;
}

/** A failed import goes back to `queued` with its plain-English error cleared. */
export async function retryImport(tx: Tx, ctx: TenantContext, id: string, now: Date): Promise<boolean> {
  const updated = await tx
    .update(imports)
    .set({ status: 'queued', errorPlain: null, updatedAt: now })
    .where(and(eq(imports.companyId, ctx.companyId), eq(imports.id, id), eq(imports.status, 'failed')))
    .returning({ id: imports.id });
  return updated.length > 0;
}

/** Every data row's cells, in file order. */
export async function importCells(tx: Tx, ctx: TenantContext, id: string): Promise<string[][]> {
  const rows = await tx
    .select({ cells: importRows.cells })
    .from(importRows)
    .where(and(eq(importRows.companyId, ctx.companyId), eq(importRows.importId, id)))
    .orderBy(asc(importRows.rowNumber));
  return rows.map((r) => r.cells);
}

/**
 * Finds the company's live customers that share any of these phones or emails. The phone and email
 * halves are skipped when their list is empty, so the GIN indexes on `phones` and `emails` apply.
 * `optedOut` is true when any of a customer's phones is on the company's opt-out list.
 */
export async function existingIndexFor(
  tx: Tx,
  ctx: TenantContext,
  phones: readonly string[],
  emails: readonly string[],
): Promise<ExistingIndex> {
  const byPhone = new Map<string, ExistingCustomer>();
  const byEmail = new Map<string, ExistingCustomer>();
  const phoneList = [...new Set(phones)];
  const emailList = [...new Set(emails.map((e) => e.toLowerCase()))];
  if (phoneList.length === 0 && emailList.length === 0) return { byPhone, byEmail };

  const matches: SQL[] = [];
  if (phoneList.length > 0) {
    const phoneArray = sql.join(
      phoneList.map((e164) => sql`${JSON.stringify([{ e164 }])}::jsonb`),
      sql`, `,
    );
    matches.push(sql`${customers.phones} @> ANY(ARRAY[${phoneArray}]::jsonb[])`);
  }
  if (emailList.length > 0) {
    const emailArray = sql.join(
      emailList.map((email) => sql`${email}`),
      sql`, `,
    );
    matches.push(sql`${customers.emails} ?| ARRAY[${emailArray}]::text[]`);
  }

  const found = await tx
    .select({
      id: customers.id,
      phones: customers.phones,
      emails: customers.emails,
      status: customers.smsConsentStatus,
      doNotContact: customers.doNotContact,
    })
    .from(customers)
    .where(and(eq(customers.companyId, ctx.companyId), isNull(customers.archivedAt), or(...matches)))
    .orderBy(asc(customers.createdAt), asc(customers.id));
  if (found.length === 0) return { byPhone, byEmail };

  const allPhones = [...new Set(found.flatMap((c) => c.phones.map((p) => p.e164)))];
  const optedOutPhones = new Set<string>();
  if (allPhones.length > 0) {
    const outs = await tx
      .select({ phoneE164: optOuts.phoneE164 })
      .from(optOuts)
      .where(and(eq(optOuts.companyId, ctx.companyId), inArray(optOuts.phoneE164, allPhones)));
    for (const out of outs) optedOutPhones.add(out.phoneE164);
  }

  for (const c of found) {
    const existing: ExistingCustomer = {
      id: c.id,
      status: c.status,
      doNotContact: c.doNotContact,
      optedOut: c.phones.some((p) => optedOutPhones.has(p.e164)),
    };
    for (const p of c.phones) {
      if (!byPhone.has(p.e164)) byPhone.set(p.e164, existing);
    }
    for (const e of c.emails) {
      const key = e.toLowerCase();
      if (!byEmail.has(key)) byEmail.set(key, existing);
    }
  }
  return { byPhone, byEmail };
}

/** The rows the import skipped, with the reason each one was skipped. */
export async function skippedImportRows(
  tx: Tx,
  ctx: TenantContext,
  id: string,
): Promise<{ row: number; reason: string; cells: string[] }[]> {
  const rows = await tx
    .select({ rowNumber: importRows.rowNumber, reason: importRows.reason, cells: importRows.cells })
    .from(importRows)
    .where(
      and(eq(importRows.companyId, ctx.companyId), eq(importRows.importId, id), eq(importRows.outcome, 'skipped')),
    )
    .orderBy(asc(importRows.rowNumber));
  return rows.map((r) => ({ row: r.rowNumber, reason: r.reason ?? '', cells: r.cells }));
}

/** The company's most recent imports, newest first. */
export async function listImports(tx: Tx, ctx: TenantContext, limit: number): Promise<ImportRow[]> {
  return tx
    .select()
    .from(imports)
    .where(eq(imports.companyId, ctx.companyId))
    .orderBy(desc(imports.createdAt), desc(imports.id))
    .limit(limit);
}
