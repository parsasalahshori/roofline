// The measuring engine's heavy steps (finding the sheet, fitting and proposing corners) off the main thread, so the
// screen keeps moving on mid-range phones (2-4 s of work on a 12 MP photo). workerClient.ts is the other side.
import type { Quad, SheetDetection, WindowMeasureTarget } from '@roofline/shared';
import { detectSheetSync } from './detect-sheet.ts';
import { proposeQuadSync } from './propose-quad.ts';
import { snapQuadSync, type SnapOptions } from './snap-quad.ts';
import type { WorkerReply, WorkerRequest } from './workerClient.ts';

/** The photos sent over, by id; the newest two (the screen measures one photo at a time). */
const images = new Map<number, { width: number; height: number; data: Uint8ClampedArray }>();

const reply = (r: WorkerReply) => (self as unknown as { postMessage: (m: WorkerReply) => void }).postMessage(r);

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const m = e.data;
  try {
    if (m.op === 'image') {
      images.set(m.imageId, { width: m.width, height: m.height, data: new Uint8ClampedArray(m.data) });
      while (images.size > 2) images.delete(images.keys().next().value!);
      reply({ id: m.id, ok: true, result: null });
      return;
    }
    const img = images.get(m.imageId);
    if (img === undefined) throw new Error('image not sent');
    if (m.op === 'detect') reply({ id: m.id, ok: true, result: detectSheetSync(img) });
    else if (m.op === 'snap') reply({ id: m.id, ok: true, result: snapQuadSync(img, m.rough as Quad, m.opts as SnapOptions) });
    else reply({ id: m.id, ok: true, result: proposeQuadSync(img, m.sheet as SheetDetection, m.target as WindowMeasureTarget | undefined) });
  } catch (err) {
    reply({ id: m.id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
