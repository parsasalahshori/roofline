// The measuring engine's front door. The screen lazy-loads THIS module (photoEngine.tsx: import('./cv/index.ts')), so
// the marker finder and edge fitting become their own chunk and only the photo-measure view downloads them. The
// arithmetic the server re-checks is in @roofline/shared.
import type { WindowPhotoCv } from '@roofline/shared';
import { windowPhotoCv } from './engine.ts';

export { windowPhotoCv };
export default windowPhotoCv;

/** The engine for callers that are not already inside a lazy import (same object every time). */
export function loadWindowPhotoCv(): Promise<WindowPhotoCv> {
  return Promise.resolve(windowPhotoCv);
}
