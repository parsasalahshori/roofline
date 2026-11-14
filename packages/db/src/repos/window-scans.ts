import { and, asc, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import type { StoredWindowUpload } from '../schema/tenant.ts';
import type { ScanHistoryEvent, ScanStatus } from '@roofline/shared';
import { homeownerRequests, quoteRequests, windowMeasurements, windowScans } from '../schema/index.ts';
import type { TenantContext, Tx } from '../tenant.ts';
import { audit } from './audit.ts';

/*
 * Multi-frame window scans (docs/windows/scan-contract.md): the homeowner app's scan of one window and the review that
 * follows. Everything runs inside the caller's withTenant. The audit trail gets ids and outcomes only (no address, name,
 * mark or image).
 */

export type WindowScanRow = typeof windowScans.$inferSelect;

export type NewWindowScan = {
  homeownerRequestId: string;
  scanId: string;
  windowId: string;
  app: string | null;
  device: string | null;
  wall: WindowScanRow['wall'];
  frames: WindowScanRow['frames'];
  marks: WindowScanRow['marks'];
  phoneResult: WindowScanRow['phoneResult'];
  serverResult: WindowScanRow['serverResult'];
  status: ScanStatus;
  slaDueAt: Date;
  /** Set when the scan is to be refined (the status is then `processing`). */
  refinement?: WindowScanRow['refinement'];
};

/** Stores a scan; the same scan id on the same request is not stored twice (null: it was there already). */
export async function createWindowScan(tx: Tx, ctx: TenantContext, s: NewWindowScan, now: Date): Promise<WindowScanRow | null> {
  const first: ScanHistoryEvent = { at: now.toISOString(), by: null, action: 'created', to: s.status };
  const [row] = await tx
    .insert(windowScans)
    .values({
      companyId: ctx.companyId,
      homeownerRequestId: s.homeownerRequestId,
      scanId: s.scanId,
      windowId: s.windowId,
      app: s.app,
      device: s.device,
      wall: s.wall,
      frames: s.frames,
      marks: s.marks,
      marksOriginal: s.marks,
      phoneResult: s.phoneResult,
      serverResult: s.serverResult,
      status: s.status,
      slaDueAt: s.slaDueAt,
      history: s.status === 'measured' ? [first, { at: now.toISOString(), by: null, action: 'auto_accepted', from: 'processing', to: 'measured' }] : [first],
      refinement: s.refinement ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: [windowScans.companyId, windowScans.homeownerRequestId, windowScans.scanId] })
    .returning();
  if (row === undefined) return null;
  await audit(tx, ctx, { action: 'window_scan.create', targetType: 'window_scan', targetId: row.id, after: { status: s.status, windowId: s.windowId }, ip: null, at: now });
  return row;
}

/** One scan of this company by id (RLS keeps other companies' out), or null. `lock`: FOR UPDATE, for a change that must not race another. */
export async function getWindowScan(tx: Tx, ctx: TenantContext, id: string, opts?: { lock?: boolean }): Promise<WindowScanRow | null> {
  const query = tx
    .select()
    .from(windowScans)
    .where(and(eq(windowScans.id, id), eq(windowScans.companyId, ctx.companyId)))
    .limit(1);
  const [row] = await (opts?.lock === true ? query.for('update') : query);
  return row ?? null;
}

/** The scan the phone sent under this id for this request, or null. */
export async function getWindowScanByScanId(tx: Tx, ctx: TenantContext, requestId: string, scanId: string): Promise<WindowScanRow | null> {
  const [row] = await tx
    .select()
    .from(windowScans)
    .where(and(eq(windowScans.companyId, ctx.companyId), eq(windowScans.homeownerRequestId, requestId), eq(windowScans.scanId, scanId)))
    .limit(1);
  return row ?? null;
}

/**
 * What a request's scans say about its windows: for each window, its newest scan's status. (Only these columns: the
 * frames, marks and results are large and every view of the request reads this.)
 */
export async function scansForRequest(tx: Tx, ctx: TenantContext, requestId: string): Promise<Pick<WindowScanRow, 'id' | 'windowId' | 'status' | 'createdAt'>[]> {
  return tx
    .select({ id: windowScans.id, windowId: windowScans.windowId, status: windowScans.status, createdAt: windowScans.createdAt })
    .from(windowScans)
    .where(and(eq(windowScans.companyId, ctx.companyId), eq(windowScans.homeownerRequestId, requestId)))
    .orderBy(desc(windowScans.createdAt));
}

/** How many scans a request holds, and how many of them are of one window. */
export async function countScansOfRequest(tx: Tx, ctx: TenantContext, requestId: string, windowId: string): Promise<{ request: number; window: number }> {
  const [row] = await tx
    .select({
      request: sql<number>`count(*)`.mapWith(Number),
      window: sql<number>`count(*) filter (where ${windowScans.windowId} = ${windowId})`.mapWith(Number),
    })
    .from(windowScans)
    .where(and(eq(windowScans.companyId, ctx.companyId), eq(windowScans.homeownerRequestId, requestId)));
  return { request: row?.request ?? 0, window: row?.window ?? 0 };
}

/**
 * How many of the company's scans have a refinement waiting or running. A refinement last touched before `since` is a
 * job that died: it no longer counts, so it cannot hold a slot for good.
 */
export async function countUnfinishedRefinements(tx: Tx, ctx: TenantContext, since: Date): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)`.mapWith(Number) })
    .from(windowScans)
    .where(and(eq(windowScans.companyId, ctx.companyId), sql`${windowScans.refinement}->>'state' in ('queued', 'running')`, gte(windowScans.updatedAt, since)));
  return row?.n ?? 0;
}

/**
 * Deletes a window's scans (the homeowner took the window off), answering the rows so their photos can be freed. The audit
 * trail keeps the ids only.
 */
export async function deleteWindowScansForWindow(tx: Tx, ctx: TenantContext, requestId: string, windowId: string, now: Date): Promise<WindowScanRow[]> {
  const rows = await tx
    .delete(windowScans)
    .where(and(eq(windowScans.companyId, ctx.companyId), eq(windowScans.homeownerRequestId, requestId), eq(windowScans.windowId, windowId)))
    .returning();
  for (const row of rows) await audit(tx, ctx, { action: 'window_scan.delete', targetType: 'window_scan', targetId: row.id, before: { status: row.status, windowId }, ip: null, at: now });
  return rows;
}

/** The ids of the photos that the request's scans use as frames. */
export async function scanFrameUploadIds(tx: Tx, ctx: TenantContext, requestId: string): Promise<Set<string>> {
  const result = await tx.execute(sql`
    select distinct f->>'uploadId' as upload_id
      from window_scans s, jsonb_array_elements(s.frames) f
     where s.company_id = ${ctx.companyId} and s.homeowner_request_id = ${requestId}`);
  return new Set(result.rows.map((r) => String(r.upload_id)));
}

export type WindowScanListRow = {
  id: string;
  homeownerRequestId: string;
  windowId: string;
  status: ScanStatus;
  expedite: boolean;
  slaDueAt: Date;
  createdAt: Date;
  updatedAt: Date;
  outcome: WindowScanRow['outcome'];
  juniorUserId: string | null;
  seniorUserId: string | null;
  serverResult: WindowScanRow['serverResult'];
  frameCount: number;
  /** The first frame's id: the scan's picture in the queue. */
  firstFrameId: string | null;
  address: string;
  firstName: string | null;
  lastName: string | null;
  photoWindows: { id: string; room?: string; label?: string }[];
};

/**
 * The review queue: scans in these statuses, expedited first, then by SLA. (Frames and marks stay out of the list; the room
 * and name are read off the request's window measurement and its filed contact.)
 */
export async function listWindowScans(tx: Tx, ctx: TenantContext, opts: { statuses: readonly ScanStatus[]; limit: number }): Promise<WindowScanListRow[]> {
  if (opts.statuses.length === 0) return [];
  const rows = await tx
    .select({
      id: windowScans.id,
      homeownerRequestId: windowScans.homeownerRequestId,
      windowId: windowScans.windowId,
      status: windowScans.status,
      expedite: windowScans.expedite,
      slaDueAt: windowScans.slaDueAt,
      createdAt: windowScans.createdAt,
      updatedAt: windowScans.updatedAt,
      outcome: windowScans.outcome,
      juniorUserId: windowScans.juniorUserId,
      seniorUserId: windowScans.seniorUserId,
      serverResult: windowScans.serverResult,
      frameCount: sql<number>`jsonb_array_length(${windowScans.frames})`.mapWith(Number),
      firstFrameId: sql<string | null>`${windowScans.frames}->0->>'frameId'`,
      address: homeownerRequests.address,
      firstName: quoteRequests.firstName,
      lastName: quoteRequests.lastName,
      photoWindows: sql<WindowScanListRow['photoWindows'] | null>`${windowMeasurements.adjustments}->'photoWindows'`,
    })
    .from(windowScans)
    .innerJoin(homeownerRequests, and(eq(homeownerRequests.id, windowScans.homeownerRequestId), eq(homeownerRequests.companyId, windowScans.companyId)))
    .leftJoin(quoteRequests, and(eq(quoteRequests.id, homeownerRequests.quoteRequestId), eq(quoteRequests.companyId, windowScans.companyId)))
    .leftJoin(windowMeasurements, and(eq(windowMeasurements.id, homeownerRequests.windowMeasurementId), eq(windowMeasurements.companyId, windowScans.companyId)))
    .where(and(eq(windowScans.companyId, ctx.companyId), inArray(windowScans.status, [...opts.statuses])))
    .orderBy(desc(windowScans.expedite), asc(windowScans.slaDueAt), asc(windowScans.createdAt))
    .limit(opts.limit);
  return rows.map((r) => ({ ...r, photoWindows: r.photoWindows ?? [] }));
}

export type WindowScanChange = Partial<
  Pick<WindowScanRow, 'marks' | 'serverResult' | 'refinement' | 'status' | 'expedite' | 'juniorUserId' | 'juniorAt' | 'seniorUserId' | 'seniorAt' | 'outcome' | 'outcomeReason' | 'overrode' | 'history'>
>;

/** Changes a scan; the caller holds it locked and passes the new history (the old one plus the new events). */
export async function updateWindowScan(tx: Tx, ctx: TenantContext, id: string, change: WindowScanChange, now: Date, auditAction?: string): Promise<WindowScanRow | null> {
  const [row] = await tx
    .update(windowScans)
    .set({ ...change, updatedAt: now })
    .where(and(eq(windowScans.id, id), eq(windowScans.companyId, ctx.companyId)))
    .returning();
  if (row === undefined) return null;
  if (auditAction !== undefined) {
    await audit(tx, ctx, { action: auditAction, targetType: 'window_scan', targetId: id, after: { status: row.status, outcome: row.outcome, expedite: row.expedite }, ip: null, at: now });
  }
  return row;
}

/** How many scans there are in each status. */
export async function countWindowScans(tx: Tx, ctx: TenantContext): Promise<Partial<Record<ScanStatus, number>>> {
  const rows = await tx
    .select({ status: windowScans.status, n: sql<number>`count(*)`.mapWith(Number) })
    .from(windowScans)
    .where(eq(windowScans.companyId, ctx.companyId))
    .groupBy(windowScans.status);
  return Object.fromEntries(rows.map((r) => [r.status, r.n]));
}

export type WindowScanContext = {
  address: string;
  firstName: string | null;
  lastName: string | null;
  photoWindow: { id: string; room?: string; label?: string; style?: string } | null;
  uploads: StoredWindowUpload[];
};

/** What a scan is about, for the reviewer: the home's address, the homeowner's name once filed, the window and the request's photos. */
export async function getWindowScanContext(tx: Tx, ctx: TenantContext, scan: Pick<WindowScanRow, 'homeownerRequestId' | 'windowId'>): Promise<WindowScanContext | null> {
  const [row] = await tx
    .select({
      address: homeownerRequests.address,
      firstName: quoteRequests.firstName,
      lastName: quoteRequests.lastName,
      photoWindows: sql<{ id: string; room?: string; label?: string; style?: string }[] | null>`${windowMeasurements.adjustments}->'photoWindows'`,
      uploads: windowMeasurements.uploads,
    })
    .from(homeownerRequests)
    .leftJoin(quoteRequests, and(eq(quoteRequests.id, homeownerRequests.quoteRequestId), eq(quoteRequests.companyId, homeownerRequests.companyId)))
    .leftJoin(windowMeasurements, and(eq(windowMeasurements.id, homeownerRequests.windowMeasurementId), eq(windowMeasurements.companyId, homeownerRequests.companyId)))
    .where(and(eq(homeownerRequests.id, scan.homeownerRequestId), eq(homeownerRequests.companyId, ctx.companyId)))
    .limit(1);
  if (row === undefined) return null;
  return {
    address: row.address,
    firstName: row.firstName,
    lastName: row.lastName,
    photoWindow: (row.photoWindows ?? []).find((w) => w.id === scan.windowId) ?? null,
    uploads: row.uploads ?? [],
  };
}
