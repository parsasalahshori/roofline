// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { Quad, RgbaImage, SheetDetection } from '@roofline/shared';
import { detectSheetSync } from '../src/features/measure/windows/cv/detect-sheet.ts';
import { windowPhotoCv } from '../src/features/measure/windows/cv/engine.ts';
import { proposeQuadSync } from '../src/features/measure/windows/cv/propose-quad.ts';
import { snapQuadSync } from '../src/features/measure/windows/cv/snap-quad.ts';
import { renderScene } from '../src/features/measure/windows/cv/synth/render.ts';
import { workerCv, type WorkerPort, type WorkerReply, type WorkerRequest } from '../src/features/measure/windows/cv/workerClient.ts';

/* The engine's heavy steps in a Web Worker: the same answers, the photo sent once, and the page engine when it breaks. */

/** A worker stand-in running the same code as worker.ts, asynchronously, with the messages structured-cloned. */
function fakeWorker(o: { breakOn?: WorkerRequest['op'] } = {}) {
  const log: WorkerRequest['op'][] = [];
  const images = new Map<number, RgbaImage>();
  const port: WorkerPort & { terminated: boolean } = {
    onmessage: null,
    onerror: null,
    terminated: false,
    terminate() {
      this.terminated = true;
    },
    postMessage(raw: WorkerRequest) {
      const m = structuredClone(raw);
      log.push(m.op);
      setTimeout(() => {
        if (o.breakOn === m.op) {
          port.onerror?.(new Error('crashed'));
          return;
        }
        let r: WorkerReply;
        if (m.op === 'image') {
          images.set(m.imageId, { width: m.width, height: m.height, data: new Uint8ClampedArray(m.data) });
          r = { id: m.id, ok: true, result: null };
        } else {
          const img = images.get(m.imageId)!;
          const result = m.op === 'detect' ? detectSheetSync(img) : m.op === 'snap' ? snapQuadSync(img, m.rough, m.opts as never) : proposeQuadSync(img, m.sheet, m.target);
          r = { id: m.id, ok: true, result: structuredClone(result) };
        }
        port.onmessage?.({ data: r } as MessageEvent<WorkerReply>);
      }, 1);
    },
  };
  return { port, log };
}

const photo = () => {
  const p = renderScene({
    widthPx: 900,
    heightPx: 1200,
    focal35mm: 26,
    distanceIn: 60,
    yawDeg: 15,
    pitchDeg: 0,
    rollDeg: 0,
    window: { widthIn: 28, heightIn: 40, offsetIn: 1, trimIn: 3.5, frameIn: 1.5, sashIn: 1.25, grille: false },
    sheet: { paper: 'letter', xIn: 9, yIn: 24, rotDeg: 2, curlIn: 0 },
    k1: 0,
    light: { gain: 1, gradX: 0.1, gradY: 0, vignette: 0.1 },
    colors: { wall: [150, 120, 95], trim: [235, 232, 225], frame: [190, 185, 175], sash: [215, 212, 205] },
    occluder: null,
    blur: { defocusPx: 0.6, motionPx: 0, motionDeg: 0 },
    noise: 2,
    supersample: 2,
    seed: 5,
  });
  return { img: { width: p.width, height: p.height, data: p.data } as RgbaImage, truth: p.windowQuad };
};

describe('the engine in a worker', () => {
  it('gives the page engine\'s answers, sends the photo once, and leaves the page\'s pixels intact', async () => {
    const { img, truth } = photo();
    const { port, log } = fakeWorker();
    const cv = workerCv(port, windowPhotoCv);
    const det = (await cv.detectSheet(img)) as SheetDetection;
    expect(det).toEqual(detectSheetSync(img));
    const rough = truth.map(([x, y]) => [x + 4, y - 3]) as Quad;
    const s = await cv.snapQuad(img, rough, { sheet: det });
    expect(s.quad).toEqual(snapQuadSync(img, rough, { sheet: det }).quad);
    const p = await cv.proposeQuad!(img, det, 'inside-frame');
    expect(p?.quad).toEqual(proposeQuadSync(img, det, 'inside-frame')?.quad);
    expect(log).toEqual(['image', 'detect', 'snap', 'propose']);
    expect(img.data.byteLength).toBe(900 * 1200 * 4);
  });

  it('a worker that breaks: the call is done in the page, and every later one too', async () => {
    const { img } = photo();
    const { port, log } = fakeWorker({ breakOn: 'detect' });
    const cv = workerCv(port, windowPhotoCv);
    expect(await cv.detectSheet(img)).toEqual(detectSheetSync(img));
    expect(port.terminated).toBe(true);
    await cv.detectSheet(img);
    expect(log).toEqual(['image', 'detect']);
  });
});
