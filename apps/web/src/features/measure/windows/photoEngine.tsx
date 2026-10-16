// The one seam between the photo screen and the measuring engine (WindowPhotoCv, @roofline/shared window-photo-cv.ts).
// The screen never imports the engine directly: it asks this context for it. By default the engine is the module at
// ./cv/index.ts (export `windowPhotoCv`, or a default export), lazy-loaded the first time a photo is measured with the
// sheet, so its WASM stays out of the main bundle. Tests (and the visual check) provide a fake through the provider.
import type { RgbaImage, WindowPhotoCv } from '@roofline/shared';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

/** A photo's pixels for the engine, and how much they were scaled from the photo's own size (1 = full size). */
export type PhotoPixels = { img: RgbaImage; scale: number };

export type PhotoEngineSeam = {
  /** The engine, or null where it is not available (not built in, or it failed to load). Called once and cached. */
  load: () => Promise<WindowPhotoCv | null>;
  /** The photo's pixels, its longest side at most `maxSide`. */
  readPixels: (src: string, maxSide: number) => Promise<PhotoPixels>;
};

type CvModule = { windowPhotoCv?: WindowPhotoCv; default?: WindowPhotoCv };

/** The engine module, when it is in the build (Vite finds it at build time; absent until the engine is merged). */
const engineModules = import.meta.glob<CvModule>('./cv/index.{ts,tsx}');

let defaultEngine: Promise<WindowPhotoCv | null> | null = null;
export function loadDefaultEngine(): Promise<WindowPhotoCv | null> {
  if (defaultEngine === null) {
    const loader = Object.values(engineModules)[0];
    defaultEngine =
      loader === undefined
        ? Promise.resolve(null)
        : loader().then(
            (m) => m.windowPhotoCv ?? m.default ?? null,
            () => {
              // A failed load (offline, the WASM did not arrive) can be tried again next time
              defaultEngine = null;
              return null;
            },
          );
  }
  return defaultEngine;
}

/** The photo drawn into a canvas and read back (the browser decodes it; EXIF orientation applied). */
export async function readPixelsFromImage(src: string, maxSide: number): Promise<PhotoPixels> {
  const image = new Image();
  image.crossOrigin = 'use-credentials';
  image.decoding = 'async';
  image.src = src;
  await image.decode();
  const w = image.naturalWidth;
  const h = image.naturalHeight;
  const scale = Math.min(1, maxSide / Math.max(w, h));
  const cw = Math.max(1, Math.round(w * scale));
  const ch = Math.max(1, Math.round(h * scale));
  const canvas = document.createElement('canvas');
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (ctx === null) throw new Error('No canvas');
  ctx.drawImage(image, 0, 0, cw, ch);
  const data = ctx.getImageData(0, 0, cw, ch);
  return { img: { width: cw, height: ch, data: data.data }, scale };
}

export const defaultPhotoEngine: PhotoEngineSeam = { load: loadDefaultEngine, readPixels: readPixelsFromImage };

const PhotoEngineContext = createContext<PhotoEngineSeam>(defaultPhotoEngine);

/** Puts a different engine (a fake in tests) behind the photo screen. */
export function PhotoEngineProvider({ engine, children }: { engine: PhotoEngineSeam; children: ReactNode }) {
  return <PhotoEngineContext.Provider value={engine}>{children}</PhotoEngineContext.Provider>;
}

export function usePhotoEngineSeam(): PhotoEngineSeam {
  return useContext(PhotoEngineContext);
}

export type EngineState = { status: 'loading'; cv: null } | { status: 'ready'; cv: WindowPhotoCv } | { status: 'unavailable'; cv: null };

/** The engine, loaded when `wanted` (the sheet method is open); its state while it loads. */
export function usePhotoEngine(wanted = true): EngineState {
  const seam = usePhotoEngineSeam();
  const [state, setState] = useState<EngineState>({ status: 'loading', cv: null });
  useEffect(() => {
    if (!wanted) return;
    let live = true;
    seam.load().then(
      (cv) => live && setState(cv === null ? { status: 'unavailable', cv: null } : { status: 'ready', cv }),
      () => live && setState({ status: 'unavailable', cv: null }),
    );
    return () => {
      live = false;
    };
  }, [seam, wanted]);
  return state;
}
