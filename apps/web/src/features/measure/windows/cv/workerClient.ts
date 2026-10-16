// The measuring engine with its heavy steps in a Web Worker (worker.ts). Same WindowPhotoCv as the in-page engine; the
// photo's pixels go over once (a copy, transferred) and later calls name it. If the worker cannot start or breaks,
// every call falls back to the in-page engine, so measuring never stops working.
import type { Quad, RgbaImage, SheetDetection, SnappedQuad, WindowMeasureTarget, WindowPhotoCv } from '@roofline/shared';

export type WorkerRequest =
  | { id: number; op: 'image'; imageId: number; width: number; height: number; data: ArrayBuffer }
  | { id: number; op: 'detect'; imageId: number }
  | { id: number; op: 'snap'; imageId: number; rough: Quad; opts: unknown }
  | { id: number; op: 'propose'; imageId: number; sheet: SheetDetection; target: WindowMeasureTarget | undefined };
export type WorkerReply = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: string };

/** A worker-like endpoint (a real Worker, or a stand-in in tests). */
export type WorkerPort = {
  postMessage(m: WorkerRequest, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<WorkerReply>) => void) | null;
  onerror: ((e: unknown) => void) | null;
  terminate(): void;
};

export function workerCv(port: WorkerPort, local: WindowPhotoCv): WindowPhotoCv {
  let broken = false;
  let nextId = 1;
  let nextImage = 1;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const sent = new WeakMap<Uint8ClampedArray, number>();
  const breakDown = () => {
    if (broken) return;
    broken = true;
    port.terminate();
    for (const p of pending.values()) p.reject(new Error('worker stopped'));
    pending.clear();
  };
  port.onmessage = (e) => {
    const r = e.data;
    const p = pending.get(r.id);
    if (p === undefined) return;
    pending.delete(r.id);
    if (r.ok) p.resolve(r.result);
    else p.reject(new Error(r.error));
  };
  port.onerror = breakDown;
  const call = <T>(m: WorkerRequest, transfer?: Transferable[]): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      pending.set(m.id, { resolve: resolve as (v: unknown) => void, reject });
      try {
        port.postMessage(m, transfer);
      } catch (err) {
        pending.delete(m.id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  /** The photo's id in the worker, sending it the first time. */
  const imageId = async (img: RgbaImage): Promise<number> => {
    const known = sent.get(img.data);
    if (known !== undefined) return known;
    const id = nextImage++;
    const copy = img.data.slice();
    await call({ id: nextId++, op: 'image', imageId: id, width: img.width, height: img.height, data: copy.buffer }, [copy.buffer]);
    sent.set(img.data, id);
    return id;
  };
  /** In the worker, or here when the worker is broken (or breaks during the call: then it is done here). */
  const heavy = async <T>(img: RgbaImage, run: (id: number) => Promise<T>, here: () => Promise<T>): Promise<T> => {
    if (broken) return here();
    try {
      return await run(await imageId(img));
    } catch {
      breakDown();
      return here();
    }
  };
  return {
    calibrationSheet: (paper, which) => local.calibrationSheet(paper, which),
    measure: (input) => local.measure(input),
    combine: (ms) => local.combine(ms),
    detectSheet: (img) => heavy(img, (imageId) => call<SheetDetection | null>({ id: nextId++, op: 'detect', imageId }), () => local.detectSheet(img)),
    snapQuad: (img, rough, opts) =>
      heavy(img, (imageId) => call<SnappedQuad>({ id: nextId++, op: 'snap', imageId, rough, opts: { sheet: opts?.sheet, target: opts?.target } }), () => local.snapQuad(img, rough, opts)),
    proposeQuad: (img, sheet, target) =>
      heavy(img, (imageId) => call<SnappedQuad | null>({ id: nextId++, op: 'propose', imageId, sheet, target }), () => local.proposeQuad?.(img, sheet, target) ?? Promise.resolve(null)),
  };
}
