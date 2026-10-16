// The measuring engine's front door. The screen lazy-loads THIS module (photoEngine.tsx: import('./cv/index.ts')), so
// the marker finder and edge fitting become their own chunk and only the photo-measure view downloads them. The
// arithmetic the server re-checks is in @roofline/shared.
import type { WindowPhotoCv } from '@roofline/shared';
import { windowPhotoCv } from './engine.ts';
import { workerCv, type WorkerPort } from './workerClient.ts';

export { windowPhotoCv };
export default windowPhotoCv;

let inWorker: WindowPhotoCv | null = null;

/**
 * The engine for the screen: its heavy steps in a Web Worker where the browser has one (the page stays responsive),
 * else in the page. Same object every time.
 */
export function loadWindowPhotoCv(): Promise<WindowPhotoCv> {
  if (inWorker !== null) return Promise.resolve(inWorker);
  if (typeof Worker === 'undefined') return Promise.resolve(windowPhotoCv);
  try {
    const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module', name: 'window-photo-engine' });
    inWorker = workerCv(worker as unknown as WorkerPort, windowPhotoCv);
    return Promise.resolve(inWorker);
  } catch {
    return Promise.resolve(windowPhotoCv);
  }
}
