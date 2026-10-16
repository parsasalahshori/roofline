import type { Pt, Quad, SheetDetection, SnappedQuad, WindowMeasureTarget, WindowPhotoUpload } from '@roofline/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { usePhotoEngine, usePhotoEngineSeam, type EngineState, type PhotoPixels } from './photoEngine.tsx';

/** The photo is handed to the engine at most this big (longest side, px): a 12 MP phone photo is read whole. */
export const ENGINE_MAX_SIDE = 4096;

export type SheetFind =
  | { status: 'idle' }
  | { status: 'reading' }
  | { status: 'found'; detection: SheetDetection }
  | { status: 'missing' }
  | { status: 'failed' };

const scalePt = ([x, y]: Pt, k: number): Pt => [x * k, y * k];
const scaleQuad = (q: Quad, k: number) => q.map((p) => scalePt(p, k)) as Quad;

/**
 * The measuring sheet on one photo: loads the engine and the photo's pixels, finds the sheet (in the upload's own
 * pixels, whatever size the engine read it at), and snaps window corners onto the frame's edges.
 */
export function useSheetPhoto({ src, upload, enabled }: { src: string; upload: Pick<WindowPhotoUpload, 'widthPx' | 'heightPx'>; enabled: boolean }): {
  engine: EngineState;
  find: SheetFind;
  /** True once the photo's pixels are read (snapping can run). */
  canSnap: boolean;
  snap: (rough: Quad, target: WindowMeasureTarget) => Promise<SnappedQuad | null>;
  /** The engine's proposed outline around the sheet; null when it has none (or the engine cannot propose). */
  propose: ((target: WindowMeasureTarget) => Promise<SnappedQuad | null>) | null;
} {
  const seam = usePhotoEngineSeam();
  const engine = usePhotoEngine(enabled);
  const [find, setFind] = useState<SheetFind>({ status: 'idle' });
  const pixels = useRef<{ px: PhotoPixels; k: number } | null>(null);
  const [canSnap, setCanSnap] = useState(false);
  const cv = engine.cv;

  useEffect(() => {
    if (!enabled || cv === null) return;
    let live = true;
    setFind({ status: 'reading' });
    seam
      .readPixels(src, ENGINE_MAX_SIDE)
      .then(async (px) => {
        // Engine pixels per upload pixel (the browser may have read it at a different size than the upload says)
        const k = px.img.width / Math.max(1, upload.widthPx);
        if (!live) return;
        pixels.current = { px, k };
        setCanSnap(true);
        const found = await cv.detectSheet(px.img);
        if (!live) return;
        if (found === null) {
          setFind({ status: 'missing' });
          return;
        }
        setFind({
          status: 'found',
          detection: { ...found, imagePoints: found.imagePoints.map((p) => scalePt(p, 1 / k)), outline: scaleQuad(found.outline, 1 / k), rmsErrorPx: found.rmsErrorPx / k },
        });
      })
      .catch(() => {
        if (live) setFind({ status: 'failed' });
      });
    return () => {
      live = false;
    };
  }, [enabled, cv, seam, src, upload.widthPx]);

  /** The sheet at the engine's scale (snapQuad and proposeQuad take it in the engine's pixels). */
  const sheetAtEngine = (k: number): SheetDetection | null =>
    find.status === 'found' ? { ...find.detection, imagePoints: find.detection.imagePoints.map((p) => scalePt(p, k)), outline: scaleQuad(find.detection.outline, k) } : null;
  /** A snap result back in the upload's pixels (its candidates too). */
  const back = (s: SnappedQuad, k: number): SnappedQuad => ({
    ...s,
    quad: scaleQuad(s.quad, 1 / k),
    ...(s.candidates !== undefined && { candidates: s.candidates.map((c) => ({ ...c, quad: scaleQuad(c.quad, 1 / k) })) }),
    ...(s.cornerSigmaPx !== undefined && { cornerSigmaPx: s.cornerSigmaPx.map((v) => v / k) as [number, number, number, number] }),
  });

  const snap = useCallback(
    async (rough: Quad, target: WindowMeasureTarget): Promise<SnappedQuad | null> => {
      const p = pixels.current;
      if (cv === null || p === null) return null;
      try {
        const sheet = sheetAtEngine(p.k);
        const s = await cv.snapQuad(p.px.img, scaleQuad(rough, p.k), { target, ...(sheet !== null && { sheet }) });
        return back(s, p.k);
      } catch {
        return null;
      }
    },
    [cv, find],
  );

  const canPropose = cv !== null && typeof cv.proposeQuad === 'function' && find.status === 'found';
  const propose = useCallback(
    async (target: WindowMeasureTarget): Promise<SnappedQuad | null> => {
      const p = pixels.current;
      const sheet = p === null ? null : sheetAtEngine(p.k);
      if (cv?.proposeQuad === undefined || p === null || sheet === null) return null;
      try {
        const s = await cv.proposeQuad(p.px.img, sheet, target);
        return s === null ? null : back(s, p.k);
      } catch {
        return null;
      }
    },
    [cv, find],
  );

  return { engine, find, canSnap, snap, propose: canPropose ? propose : null };
}
