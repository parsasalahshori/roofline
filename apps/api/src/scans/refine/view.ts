import type { WindowScanRow } from '@roofline/db';
import { type ScanFrame, type ScanFrameView, type ScanRefineView, scanEffectiveFrames } from '@roofline/shared';

/*
 * How a scan's refinement is shown to the staff screen: the frames with their refined poses (so the screen's live triangulation
 * uses the same poses as the server), each frame's AI result with the URL of its mask, and the refinement's own status.
 */

/** The scan's frames with COLMAP's pose on the frames that took it. */
export const effectiveFramesOf = (row: Pick<WindowScanRow, 'frames' | 'refinement'>): ScanFrame[] => scanEffectiveFrames(row.frames, row.refinement?.poses);

const base = (id: string) => `/api/window-scans/${id}`;

export function frameViewsOf(row: Pick<WindowScanRow, 'id' | 'frames' | 'refinement'>): ScanFrameView[] {
  const rec = row.refinement;
  const poses = rec?.poses ?? {};
  return scanEffectiveFrames(row.frames, poses).map((f) => {
    const ai = rec?.frames.find((a) => a.frameId === f.frameId);
    const { maskKey, ...rest } = ai ?? { maskKey: null };
    return {
      ...f,
      imageUrl: `${base(row.id)}/frames/${encodeURIComponent(f.frameId)}/image`,
      ...(rec !== null && rec !== undefined && rec.poseSource !== null && { poseSource: poses[f.frameId] === undefined ? ('arkit' as const) : ('colmap' as const) }),
      ...(ai !== undefined && { ai: { ...(rest as Omit<NonNullable<typeof ai>, 'maskKey'>), maskUrl: maskKey === null ? null : `${base(row.id)}/frames/${encodeURIComponent(f.frameId)}/mask` } }),
    };
  });
}

export function refineViewOf(row: Pick<WindowScanRow, 'id' | 'refinement'>): ScanRefineView | null {
  const rec = row.refinement;
  if (rec === null || rec === undefined) return null;
  const { poses: _poses, frames, cloudKey, firstResult, ...rest } = rec;
  void _poses;
  return {
    ...rest,
    frames: frames.map(({ maskKey, ...a }) => ({ ...a, maskUrl: maskKey === null ? null : `${base(row.id)}/frames/${encodeURIComponent(a.frameId)}/mask` })),
    firstWidthIn: firstResult?.widthIn ?? null,
    firstHeightIn: firstResult?.heightIn ?? null,
    cloudUrl: cloudKey === null ? null : `${base(row.id)}/refinement/cloud`,
  };
}
