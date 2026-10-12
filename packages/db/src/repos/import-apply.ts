import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  importConsent,
  isTimeZone,
  normalizeAddressKey,
  type ConsentStatus,
  type ExistingCustomer,
  type ExistingIndex,
  type ImportCounts,
  type NormalizedRow,
} from '@roofline/shared';
import type { LngLat } from '../schema/columns.ts';
import { activities, customers, importRows, imports, jobs, optOuts, properties } from '../schema/index.ts';
import type { CustomerPhone } from '../schema/index.ts';
import type { TenantContext, Tx } from '../tenant.ts';
import { audit } from './audit.ts';
import { ensureOptOuts } from './customers.ts';
import { lockRecipients } from './inbound.ts';
import { existingIndexFor, type ImportRow } from './imports.ts';

export const IMPORT_CHUNK = 250;
export type ChunkWrite = {
  rows: { rowNumber: number; normalized: NormalizedRow; match: ExistingCustomer | null; consent: ConsentStatus; consentChanged: boolean;
    geo: { lng: number; lat: number; timezone: string | null; accuracy: number; source: string } | null }[];
  createJobs: boolean; fileName: string; attested: { userId: string; text: string } | null; importId: string; createdByUserId: string | null;
};

/** Rows per multi-row statement for the skip writes. */
const WRITE_BATCH = 1000;
/** Jobs in these stages are open: an import does not add a second one on the same home. */
const OPEN_STAGES = ['lead', 'inspection', 'proposal', 'won'] as const;
/** The timeline shows the first 500 characters of a note. */
const NOTE_LIMIT = 500;

type GeoPoint = NonNullable<ChunkWrite['rows'][number]['geo']>;
type ConsentColumns = Pick<
  typeof customers.$inferInsert,
  'smsConsentStatus' | 'smsConsentSource' | 'smsConsentAt' | 'smsConsentByUserId' | 'smsConsentEvidence'
>;
type ChunkCounts = { created: number; updated: number; jobs: number; located: number; notLocated: number };

/** A matched customer as the chunk changes it: merged in memory, then written once. */
type Working = {
  id: string;
  phones: CustomerPhone[];
  emails: string[];
  firstName: string | null;
  lastName: string | null;
  state: ExistingCustomer;
  consentCols: ConsentColumns | null;
  dirty: boolean;
};

/** One locked row of the chunk, with the customer it belongs to and the consent it gets. */
type Resolved = {
  rowNumber: number;
  normalized: NormalizedRow;
  geo: GeoPoint | null;
  address: NormalizedRow['address'];
  addressKey: string | null;
  customerId: string;
  isNew: boolean;
  consent: ConsentStatus;
};

/** Queued moves to processing, keeping started_at. Processing stays processing (a resumed run). Anything else gives null. */
export async function claimImport(tx: Tx, ctx: TenantContext, id: string, now: Date): Promise<ImportRow | null> {
  const [row] = await tx
    .update(imports)
    .set({ status: 'processing', updatedAt: now })
    .where(
      and(eq(imports.companyId, ctx.companyId), eq(imports.id, id), inArray(imports.status, ['queued', 'processing'])),
    )
    .returning();
  return row ?? null;
}

/** True once the plan has written a skipped row, so a resumed run does not plan again. */
export async function hasPlannedSkips(tx: Tx, ctx: TenantContext, id: string): Promise<boolean> {
  const [row] = await tx
    .select({ rowNumber: importRows.rowNumber })
    .from(importRows)
    .where(and(eq(importRows.companyId, ctx.companyId), eq(importRows.importId, id), eq(importRows.outcome, 'skipped')))
    .limit(1);
  return row !== undefined;
}

/** Marks the planned skips: outcome `skipped` and the reason, in batches. */
export async function writePlannedSkips(
  tx: Tx,
  ctx: TenantContext,
  id: string,
  skips: readonly { row: number; reason: string }[],
): Promise<void> {
  for (let start = 0; start < skips.length; start += WRITE_BATCH) {
    const batch = skips.slice(start, start + WRITE_BATCH);
    const values = sql.join(
      batch.map((s) => sql`(${s.row}::int, ${s.reason}::text)`),
      sql`, `,
    );
    await tx.execute(sql`
      UPDATE import_rows AS r
      SET outcome = 'skipped', reason = v.reason
      FROM (VALUES ${values}) AS v(row_number, reason)
      WHERE r.company_id = ${ctx.companyId}::uuid
        AND r.import_id = ${id}::uuid
        AND r.row_number = v.row_number
    `);
  }
}

/** The next rows still waiting for an outcome, in file order. */
export async function nextImportChunk(
  tx: Tx,
  ctx: TenantContext,
  id: string,
  size: number,
): Promise<{ rowNumber: number; cells: string[] }[]> {
  const rows = await tx
    .select({ rowNumber: importRows.rowNumber, cells: importRows.cells })
    .from(importRows)
    .where(and(eq(importRows.companyId, ctx.companyId), eq(importRows.importId, id), isNull(importRows.outcome)))
    .orderBy(asc(importRows.rowNumber))
    .limit(size);
  return rows.map((r) => ({ rowNumber: r.rowNumber, cells: r.cells }));
}

/** First match by phone, then by email: the same order the planner uses. */
function matchFor(index: ExistingIndex, n: NormalizedRow): ExistingCustomer | null {
  for (const p of n.phones) {
    const m = index.byPhone.get(p);
    if (m !== undefined) return m;
  }
  for (const e of n.emails) {
    const m = index.byEmail.get(e.toLowerCase());
    if (m !== undefined) return m;
  }
  return null;
}

/**
 * The consent a row gets. importConsent ignores the phone for a matched customer, so a row with no
 * phone never raises an existing customer: it keeps the status it has.
 */
function decideConsent(existing: ExistingCustomer | null, hasPhone: boolean, attested: boolean): ConsentStatus {
  if (existing !== null && !hasPhone) return existing.status;
  return importConsent(existing, hasPhone, attested);
}

/** The consent columns for a raised (or new) customer. Null when the consent sets nothing (`none`). */
function consentColumns(consent: ConsentStatus, w: ChunkWrite, now: Date): ConsentColumns | null {
  if (consent === 'attested' && w.attested !== null) {
    return {
      smsConsentStatus: 'attested',
      smsConsentSource: 'import',
      smsConsentAt: now,
      smsConsentByUserId: w.attested.userId,
      smsConsentEvidence: { import_id: w.importId, text: w.attested.text },
    };
  }
  if (consent === 'express') {
    return {
      smsConsentStatus: 'express',
      smsConsentSource: 'import',
      smsConsentAt: now,
      smsConsentByUserId: w.createdByUserId,
      smsConsentEvidence: { import_id: w.importId },
    };
  }
  return null;
}

/** Adds a row's phones and emails the customer lacks, and fills an empty name. Never removes anything. */
function mergeRow(s: Working, n: NormalizedRow): void {
  for (const e164 of n.phones) {
    if (s.phones.some((p) => p.e164 === e164)) continue;
    s.phones.push({ e164, primary: s.phones.length === 0 });
    s.dirty = true;
  }
  for (const email of n.emails) {
    const lower = email.toLowerCase();
    if (s.emails.some((e) => e.toLowerCase() === lower)) continue;
    s.emails.push(lower);
    s.dirty = true;
  }
  if (!s.firstName && n.firstName) {
    s.firstName = n.firstName;
    s.dirty = true;
  }
  if (!s.lastName && n.lastName) {
    s.lastName = n.lastName;
    s.dirty = true;
  }
}

/** The zone a geocode gives, only when it is a real place name. */
function zoneOf(geo: GeoPoint): string | undefined {
  return geo.timezone !== null && isTimeZone(geo.timezone) ? geo.timezone : undefined;
}

/** The geo columns a property gets from a geocode. */
function geoFields(geo: GeoPoint) {
  const zone = zoneOf(geo);
  return {
    geom: [geo.lng, geo.lat] as LngLat,
    geocodeSource: geo.source,
    geocodeAccuracy: String(geo.accuracy),
    ...(zone !== undefined && { timezone: zone }),
  };
}

/**
 * Writes one chunk in the caller's transaction. Locks the chunk's still-open rows (a second runner
 * skips them), re-matches them against the database, then writes customers, homes, jobs, timeline
 * lines and row outcomes in bulk. No per-customer audit row: the import writes one at the end.
 */
export async function applyImportChunk(tx: Tx, ctx: TenantContext, w: ChunkWrite, now: Date): Promise<ChunkCounts> {
  const empty: ChunkCounts = { created: 0, updated: 0, jobs: 0, located: 0, notLocated: 0 };
  const numbers = w.rows.map((r) => r.rowNumber);
  if (numbers.length === 0) return empty;

  const locked = await tx
    .select({ rowNumber: importRows.rowNumber })
    .from(importRows)
    .where(
      and(
        eq(importRows.companyId, ctx.companyId),
        eq(importRows.importId, w.importId),
        inArray(importRows.rowNumber, numbers),
        isNull(importRows.outcome),
      ),
    )
    .orderBy(asc(importRows.rowNumber))
    .for('update', { skipLocked: true });
  const lockedNumbers = new Set(locked.map((r) => r.rowNumber));
  const rows = w.rows.filter((r) => lockedNumbers.has(r.rowNumber));
  if (rows.length === 0) return empty;

  // Re-match against the database: customers added since the plan are updated, not duplicated.
  const index = await existingIndexFor(
    tx,
    ctx,
    rows.flatMap((r) => r.normalized.phones),
    rows.flatMap((r) => r.normalized.emails),
  );
  const hits = rows.map((r) => matchFor(index, r.normalized));

  const hitById = new Map<string, ExistingCustomer>();
  for (const h of hits) if (h !== null) hitById.set(h.id, h);
  const matchedIds = [...hitById.keys()];
  // Same order as the STOP and carrier opt-out paths: texting lock first, then the customer rows by id.
  // Consent is decided from these locked rows, so a STOP that committed first is seen and never raised.
  await lockRecipients(tx, ctx, matchedIds);
  const current =
    matchedIds.length === 0
      ? []
      : await tx
          .select()
          .from(customers)
          .where(
            and(eq(customers.companyId, ctx.companyId), inArray(customers.id, matchedIds), isNull(customers.archivedAt)),
          )
          .orderBy(asc(customers.id))
          .for('update');
  const lockedPhones = [...new Set(current.flatMap((c) => c.phones.map((p) => p.e164)))];
  const optedOutPhones = new Set<string>();
  if (lockedPhones.length > 0) {
    const outs = await tx
      .select({ phoneE164: optOuts.phoneE164 })
      .from(optOuts)
      .where(and(eq(optOuts.companyId, ctx.companyId), inArray(optOuts.phoneE164, lockedPhones)));
    for (const out of outs) optedOutPhones.add(out.phoneE164);
  }
  const working = new Map<string, Working>();
  for (const c of current) {
    working.set(c.id, {
      id: c.id,
      phones: [...c.phones],
      emails: [...c.emails],
      firstName: c.firstName,
      lastName: c.lastName,
      state: {
        id: c.id,
        status: c.smsConsentStatus,
        doNotContact: c.doNotContact,
        optedOut: c.phones.some((p) => optedOutPhones.has(p.e164)),
      },
      consentCols: null,
      dirty: false,
    });
  }

  const attested = w.attested !== null;
  const resolved: Resolved[] = [];
  for (const [i, r] of rows.entries()) {
    const n = r.normalized;
    const hasPhone = n.phones.length > 0;
    const addressKey = n.address ? normalizeAddressKey(n.address.addressLine, n.address.zip) : null;
    const s = hits[i] ? working.get(hits[i].id) : undefined;
    if (s !== undefined) {
      // Matched: merge in memory, so a second row for the same customer sees the first one's change.
      mergeRow(s, n);
      const consent = decideConsent(s.state, hasPhone, attested);
      if (consent !== s.state.status) {
        s.state.status = consent;
        s.consentCols = consentColumns(consent, w, now);
        s.dirty = true;
      }
      resolved.push({
        rowNumber: r.rowNumber,
        normalized: n,
        geo: r.geo,
        address: n.address,
        addressKey,
        customerId: s.id,
        isNew: false,
        consent,
      });
    } else {
      resolved.push({
        rowNumber: r.rowNumber,
        normalized: n,
        geo: r.geo,
        address: n.address,
        addressKey,
        customerId: randomUUID(),
        isNew: true,
        consent: decideConsent(null, hasPhone, attested),
      });
    }
  }

  // New customers: one insert. The ids are chosen above, so the homes, jobs and timeline can name them.
  const newCustomers: (typeof customers.$inferInsert)[] = resolved
    .filter((r) => r.isNew)
    .map((r) => ({
      id: r.customerId,
      companyId: ctx.companyId,
      displayName: r.normalized.displayName,
      firstName: r.normalized.firstName,
      lastName: r.normalized.lastName,
      phones: r.normalized.phones.map((e164, i) => ({ e164, primary: i === 0 })),
      emails: r.normalized.emails,
      source: 'import',
      createdByUserId: null,
      createdAt: now,
      updatedAt: now,
      ...(consentColumns(r.consent, w, now) ?? {}),
    }));
  if (newCustomers.length > 0) await tx.insert(customers).values(newCustomers);

  for (const s of working.values()) {
    if (!s.dirty) continue;
    await tx
      .update(customers)
      .set({
        phones: s.phones,
        emails: s.emails,
        firstName: s.firstName,
        lastName: s.lastName,
        updatedAt: now,
        ...(s.consentCols ?? {}),
      })
      .where(and(eq(customers.companyId, ctx.companyId), eq(customers.id, s.id)));
  }

  // A customer who is opted out keeps every number on the opt-out list, including numbers this chunk added.
  const outs = [...working.values()]
    .filter((s) => s.dirty && (s.state.status === 'revoked' || s.state.doNotContact))
    .flatMap((s) => s.phones.map((p) => p.e164));
  await ensureOptOuts(tx, ctx, outs, now);

  // Homes: one per address key (the first row with that key names its customer).
  const wanted = new Map<
    string,
    { addressKey: string; customerId: string; address: NonNullable<NormalizedRow['address']>; geo: GeoPoint | null }
  >();
  for (const r of resolved) {
    if (r.addressKey === null || r.address === null || wanted.has(r.addressKey)) continue;
    wanted.set(r.addressKey, { addressKey: r.addressKey, customerId: r.customerId, address: r.address, geo: r.geo });
  }
  const wantList = [...wanted.values()];
  if (wantList.length > 0) {
    await tx
      .insert(properties)
      .values(
        wantList.map((p) => ({
          companyId: ctx.companyId,
          customerId: p.customerId,
          addressLine: p.address.addressLine,
          city: p.address.city,
          state: p.address.state,
          zip: p.address.zip,
          addressKey: p.addressKey,
          createdAt: now,
          updatedAt: now,
          ...(p.geo !== null && geoFields(p.geo)),
        })),
      )
      .onConflictDoNothing({ target: [properties.companyId, properties.addressKey] });
  }

  const stored =
    wantList.length === 0
      ? []
      : await tx
          .select({
            id: properties.id,
            addressKey: properties.addressKey,
            customerId: properties.customerId,
            geom: properties.geom,
          })
          .from(properties)
          .where(
            and(
              eq(properties.companyId, ctx.companyId),
              inArray(
                properties.addressKey,
                wantList.map((p) => p.addressKey),
              ),
            ),
          );
  const storedByKey = new Map(stored.map((s) => [s.addressKey, s]));

  // Who owns each home after this chunk: its customer, or this chunk's customer when it was unowned.
  const placed = new Map<string, { propertyId: string; ownerId: string }>();
  for (const p of wantList) {
    const s = storedByKey.get(p.addressKey);
    if (s === undefined) continue;
    let ownerId = s.customerId;
    if (ownerId === null) {
      ownerId = p.customerId;
      await tx
        .update(properties)
        .set({
          customerId: p.customerId,
          updatedAt: now,
          ...(s.geom === null && p.geo !== null && geoFields(p.geo)),
        })
        .where(and(eq(properties.companyId, ctx.companyId), eq(properties.id, s.id), isNull(properties.customerId)));
    }
    placed.set(p.addressKey, { propertyId: s.id, ownerId });
  }

  let located = 0;
  let notLocated = 0;
  for (const r of resolved) {
    if (r.address === null) continue;
    if (r.geo !== null) located += 1;
    else notLocated += 1;
  }

  // Jobs: only with a mapped stage column, on a home this customer owns, with no open job on it.
  const jobRows: (typeof jobs.$inferInsert)[] = [];
  if (w.createJobs) {
    const placedIds = [...placed.values()].map((p) => p.propertyId);
    const openOnHomes =
      placedIds.length === 0
        ? []
        : await tx
            .select({ propertyId: jobs.propertyId })
            .from(jobs)
            .where(
              and(
                eq(jobs.companyId, ctx.companyId),
                inArray(jobs.propertyId, placedIds),
                inArray(jobs.stage, [...OPEN_STAGES]),
                isNull(jobs.archivedAt),
              ),
            );
    const busy = new Set(openOnHomes.map((j) => j.propertyId));
    for (const r of resolved) {
      const stage = r.normalized.stage;
      if (stage === null || r.addressKey === null) continue;
      const p = placed.get(r.addressKey);
      if (p === undefined || p.ownerId !== r.customerId || busy.has(p.propertyId)) continue;
      busy.add(p.propertyId);
      jobRows.push({
        companyId: ctx.companyId,
        customerId: r.customerId,
        propertyId: p.propertyId,
        stage,
        source: 'import',
        stageChangedAt: now,
        createdAt: now,
        updatedAt: now,
      });
    }
    if (jobRows.length > 0) await tx.insert(jobs).values(jobRows);
  }

  // Timeline: one line per row, plus the note when there is one.
  const actorType: 'user' | 'system' = ctx.userId !== null ? 'user' : 'system';
  const timeline: (typeof activities.$inferInsert)[] = [];
  for (const r of resolved) {
    timeline.push({
      companyId: ctx.companyId,
      subjectType: 'customer',
      subjectId: r.customerId,
      kind: 'customer.imported',
      summary: `Imported from ${w.fileName}`,
      actorType,
      actorUserId: ctx.userId,
      at: now,
      createdAt: now,
      updatedAt: now,
    });
    if (r.normalized.notes !== null) {
      timeline.push({
        companyId: ctx.companyId,
        subjectType: 'customer',
        subjectId: r.customerId,
        kind: 'customer.note',
        summary: r.normalized.notes.slice(0, NOTE_LIMIT),
        actorType,
        actorUserId: ctx.userId,
        at: now,
        createdAt: now,
        updatedAt: now,
      });
    }
  }
  if (timeline.length > 0) await tx.insert(activities).values(timeline);

  // Row outcomes: one UPDATE ... FROM (VALUES ...) per batch of rows.
  for (let start = 0; start < resolved.length; start += IMPORT_CHUNK) {
    const batch = resolved.slice(start, start + IMPORT_CHUNK);
    const values = sql.join(
      batch.map((r) => sql`(${r.rowNumber}::int, ${r.isNew ? 'created' : 'updated'}::text, ${r.customerId}::uuid)`),
      sql`, `,
    );
    await tx.execute(sql`
      UPDATE import_rows AS r
      SET outcome = v.outcome, customer_id = v.customer_id, updated_at = ${now.toISOString()}::timestamptz
      FROM (VALUES ${values}) AS v(row_number, outcome, customer_id)
      WHERE r.company_id = ${ctx.companyId}::uuid
        AND r.import_id = ${w.importId}::uuid
        AND r.row_number = v.row_number
    `);
  }

  return {
    created: resolved.filter((r) => r.isNew).length,
    updated: resolved.filter((r) => !r.isNew).length,
    jobs: jobRows.length,
    located,
    notLocated,
  };
}

/** Stores the running counts on the import (what the progress bar reads). */
export async function saveImportProgress(
  tx: Tx,
  ctx: TenantContext,
  id: string,
  counts: ImportCounts,
  now: Date,
): Promise<void> {
  await tx
    .update(imports)
    .set({ counts: counts as unknown as Record<string, number>, updatedAt: now })
    .where(and(eq(imports.companyId, ctx.companyId), eq(imports.id, id)));
}

/** Marks the import done, with its counts and the skipped-rows file link when rows were skipped, then audits it. */
export async function finishImport(
  tx: Tx,
  ctx: TenantContext,
  id: string,
  counts: ImportCounts,
  now: Date,
): Promise<void> {
  await tx
    .update(imports)
    .set({
      status: 'done',
      finishedAt: now,
      counts: counts as unknown as Record<string, number>,
      updatedAt: now,
      errorFileUrl: counts.skipped > 0 ? `/api/imports/${id}/skipped.csv` : null,
    })
    .where(and(eq(imports.companyId, ctx.companyId), eq(imports.id, id)));
  await audit(tx, ctx, {
    action: 'import.finished',
    targetType: 'import',
    targetId: id,
    after: { importId: id, counts },
    at: now,
  });
}

/** Marks the import failed, with a plain-English reason. */
export async function failImport(tx: Tx, ctx: TenantContext, id: string, errorPlain: string, now: Date): Promise<void> {
  await tx
    .update(imports)
    .set({ status: 'failed', errorPlain, updatedAt: now, finishedAt: now })
    .where(and(eq(imports.companyId, ctx.companyId), eq(imports.id, id)));
}
