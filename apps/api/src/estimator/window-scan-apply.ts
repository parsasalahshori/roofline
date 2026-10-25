import { getHomeownerRequest, getWindowMeasurement, type StoredWindowUpload, type TenantContext, type Tx, updateWindowMeasurement, type WindowScanRow } from '@roofline/db';
import { type ArQuad, scanProject, type PhotoWindowInput, type Quad, sizeFromArPoints, type ScanResult, type WindowAdjustments } from '@roofline/shared';
import { AR_MAX_IN, AR_MIN_IN, arProblem, sizePhotoWindow } from './window-uploads.ts';

/*
 * What an accepted scan does to its window (docs/windows/scan-contract.md): the scan's opening (the fitted rectangle, four
 * points in AR world metres) becomes the window's size. The window is kept as the homeowner sent it, and its `scale` is
 * set to an AR scale on those four points, so the one sizing code (sizePhotoWindow -> sizeFromArPoints) gives exactly the
 * scan's width and height, quality 'good', for the homeowner's view, the staff windows view and the order sheet alike.
 */

/** Why a scan's opening cannot become a window size (outside 6..200 in, or not four usable corners); null when it can. */
export function scanSizeProblem(result: Pick<ScanResult, 'cornersM' | 'widthIn' | 'heightIn'>): string | null {
  if (result.cornersM === null || result.widthIn === null || result.heightIn === null) return 'The scan has no size yet.';
  const m = sizeFromArPoints(result.cornersM as ArQuad);
  if (m === null) return 'The scan corners are on top of each other or in a line.';
  const out = (v: number) => !(v >= AR_MIN_IN && v <= AR_MAX_IN);
  if (out(m.widthIn) || out(m.heightIn)) return `The scan size ${m.widthIn.toFixed(1)} x ${m.heightIn.toFixed(1)} in is outside ${AR_MIN_IN} to ${AR_MAX_IN} in.`;
  return null;
}

/** The window's photo corners for a window that had none (a room-scan window): the opening seen in the scan's first frame. */
function cornersInFrame(scan: WindowScanRow, uploads: readonly StoredWindowUpload[]): { uploadId: string; corners: Quad } | null {
  const cornersM = scan.serverResult.cornersM;
  if (cornersM === null) return null;
  for (const f of scan.frames) {
    const upload = uploads.find((u) => u.id === f.uploadId);
    if (upload === undefined) continue;
    const sx = upload.widthPx / f.intrinsics.width;
    const sy = upload.heightPx / f.intrinsics.height;
    const px = cornersM.map((p) => scanProject(p, f.cameraTransform, f.intrinsics));
    if (px.some((p) => p === null)) continue;
    const quad = px.map((p) => [Math.min(upload.widthPx, Math.max(0, p![0] * sx)), Math.min(upload.heightPx, Math.max(0, p![1] * sy))] as [number, number]) as Quad;
    return { uploadId: upload.id, corners: quad };
  }
  return null;
}

/**
 * Sets the scan's opening as the size of its window (the request's measurement is locked for it). False, with nothing
 * changed, when there is no such window or the scan's size cannot be a window size.
 */
export async function applyMeasuredScan(tx: Tx, ctx: TenantContext, scan: WindowScanRow, now: Date): Promise<boolean> {
  const cornersM = scan.serverResult.cornersM;
  if (cornersM === null || scanSizeProblem(scan.serverResult) !== null) return false;
  const request = await getHomeownerRequest(tx, ctx, scan.homeownerRequestId, { lock: true });
  if (request === null || request.windowMeasurementId === null) return false;
  const found = await getWindowMeasurement(tx, ctx, request.windowMeasurementId, { lock: true });
  if (found === null) return false;
  const list = found.adjustments.photoWindows ?? [];
  const w = list.find((x) => x.id === scan.windowId);
  if (w === undefined) return false;
  const device = w.scale.kind === 'ar' ? (w.scale.device ?? 'arkit') : 'arkit';
  let candidate: PhotoWindowInput = { ...w, scale: { kind: 'ar', pointsM: cornersM as ArQuad, trackingLostCount: 0, device, cornerSpreadM: [0.001, 0.001, 0.001, 0.001] } };
  if (candidate.uploadId === undefined || candidate.corners === undefined) {
    const seen = cornersInFrame(scan, found.uploads ?? []);
    if (seen === null) return false;
    candidate = { ...candidate, uploadId: seen.uploadId, corners: seen.corners };
  }
  const upload = (found.uploads ?? []).find((u) => u.id === candidate.uploadId) ?? null;
  if (arProblem(candidate) !== null || sizePhotoWindow(candidate, upload) === null) return false;
  const next: WindowAdjustments = { ...found.adjustments, photoWindows: list.map((x) => (x.id === w.id ? candidate : x)) };
  await updateWindowMeasurement(tx, ctx, found.id, { adjustments: next }, now);
  return true;
}
