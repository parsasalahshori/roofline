import { useEffect, useState } from 'react';
import { xrSystem } from './xr.ts';

/*
 * Whether this phone can measure windows in AR: Chrome on an Android phone with ARCore answers
 * navigator.xr.isSessionSupported('immersive-ar') with true. iPhone Safari has no WebXR, and desktops answer false.
 * Kept tiny and eager (it decides whether the AR tab shows); everything else in ar/ is loaded only when used.
 */

export type ArSupport = 'checking' | 'supported' | 'unsupported';

let answer: Promise<boolean> | null = null;
let known: boolean | null = null;

/** Asks once per page; the answer never changes while the page is open. */
export function checkArSupport(): Promise<boolean> {
  if (answer !== null) return answer;
  const xr = xrSystem();
  answer = (xr === null ? Promise.resolve(false) : xr.isSessionSupported('immersive-ar').then((v) => v === true, () => false)).then((v) => {
    known = v;
    return v;
  });
  return answer;
}

/** For tests: forget the answer so a new fake navigator.xr is asked. */
export function forgetArSupport(): void {
  answer = null;
  known = null;
}

export function useArSupport(): ArSupport {
  const [state, setState] = useState<ArSupport>(known === null ? 'checking' : known ? 'supported' : 'unsupported');
  useEffect(() => {
    let live = true;
    void checkArSupport().then((v) => {
      if (live) setState(v ? 'supported' : 'unsupported');
    });
    return () => {
      live = false;
    };
  }, []);
  return state;
}
