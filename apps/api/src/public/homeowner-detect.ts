import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { type Router } from 'express';
import type { AppDeps } from '../app.ts';
import { AppError } from '../errors.ts';
import { readImageInfo } from '../estimator/window-uploads.ts';
import { DetectorError, DetectorUnconfiguredError, pickWindowBox, type DetectedBox } from '../providers/window-detector.ts';
import type { WindowQuad } from '../providers/window-segmenter.ts';
import { readUpload } from '../routes/window-measurements.ts';
import { authed, rateLimited, type TokenBudget } from './homeowner-auth.ts';
import { guardUpload } from './homeowner-upload.ts';
import { route } from './quote-access.ts';

/*
 * Two additive routes of the homeowner phone app's API (the contract: docs/windows/homeowner-api.md), registered by
 * homeowner.ts behind the same bearer token as the others:
 *
 *   POST /:slug/requests/:id/detect-windows
 *     One upright JPEG of the frozen frame (the app sends it at about 1024 px on its long side, quality 0.7) as the raw body.
 *     Answers the windows the OWLv2 detector sees in it: { boxes: [{ x, y, w, h, confidence }], picked, quad, widthPx, heightPx,
 *     detector, segmenter, ms, msDetect, msSegment }, boxes 0..1 of the photo from its top-left, best first, nested boxes kept.
 *     `picked` is the box the person aimed at (the one holding the photo's middle, or the point ?aimX=&aimY=; the largest of the
 *     nested ones scoring within 70% of the best), and `quad` its four corners (TL, TR, BR, BL, 0..1) cut out by SAM 2 with a fit
 *     quality, or null when WINDOW_SEGMENTER is off or the mask has no believable quad. 503 `detector_unavailable` when the detector is
 *     off or its model is not on this machine (WINDOW_DETECTOR / WINDOW_MODEL_DIR), 503 `detector_failed` when it failed or
 *     timed out. Nothing is stored and nothing is logged about the photo.
 *
 *   POST /:slug/requests/:id/debug-captures/:captureId/:file
 *     A tester build's dump of one Capture (photo, depth, camera, result) so a bad proposal can be replayed on a Mac. Only when
 *     DEBUG_CAPTURES_DIR is set; otherwise 404 `debug_captures_off`. Files only, no database.
 */

/** What a frozen frame needs of a photo for finding a window is small: the app sends about 150 to 300 KB; more is refused. */
export const DETECT_MAX_BYTES = 4 * 1024 * 1024;
/** One detection takes about a second of this machine's processor: so few at once (in all, and per request). */
export const DETECT_GATE = { inProcess: 2, perRequest: 1, retryAfterSeconds: 2 } as const;
/** A photo that stops arriving, or is not whole after this long, is cut off. */
const DETECT_IDLE_MS = 8_000;
const DETECT_TOTAL_MS = 30_000;

const DETECTOR_OFF_MESSAGE = "Finding windows automatically isn't available right now. You can mark the window yourself.";
const DETECTOR_FAILED_MESSAGE = "We couldn't look for the window just now. You can mark it yourself.";
const DETECT_TYPE_MESSAGE = 'Send a JPEG photo.';
const DETECT_BIG_MESSAGE = 'That photo is too large. Send it at about 1024 pixels on its long side.';

/** Counts the detections running, in all and per request, and says no past the bounds. */
export class DetectGate {
  private total = 0;
  private readonly requests = new Set<string>();

  constructor(private readonly max: { inProcess: number; perRequest: number } = DETECT_GATE) {}

  enter(request: string): { leave(): void } | null {
    if (this.total >= this.max.inProcess || (this.max.perRequest <= 1 && this.requests.has(request))) return null;
    this.total += 1;
    this.requests.add(request);
    let left = false;
    return {
      leave: () => {
        if (left) return;
        left = true;
        this.total -= 1;
        this.requests.delete(request);
      },
    };
  }

  get inFlight(): number {
    return this.total;
  }
}

export type DetectResponse = {
  boxes: DetectedBox[];
  /** The box the person aimed at, or null when none holds the aim. */
  picked: DetectedBox | null;
  /** The picked window's four corners, or null (no segmenter, no believable quad). */
  quad: WindowQuad | null;
  widthPx: number;
  heightPx: number;
  detector: 'owlv2';
  segmenter: 'sam2' | null;
  /** The server's time for all of it, and for each step, milliseconds. */
  ms: number;
  msDetect: number;
  msSegment: number;
};

/** The point the person aimed at, 0..1 of the photo: the photo's middle unless the app sends `aimX` and `aimY`. */
function aimOf(query: Record<string, unknown>): { x: number; y: number } {
  const num = (v: unknown, fallback: number): number => {
    const n = typeof v === 'string' ? Number(v) : NaN;
    return Number.isFinite(n) && n >= 0 && n <= 1 ? n : fallback;
  };
  return { x: num(query.aimX, 0.5), y: num(query.aimY, 0.5) };
}

const round4 = (v: number): number => Math.round(v * 10_000) / 10_000;

/** The files a capture dump may hold, and the most each may be (bytes). */
export const DEBUG_FILES: Readonly<Record<string, { max: number; json: boolean }>> = {
  'capture.json': { max: 1024 * 1024, json: true },
  'result.json': { max: 1024 * 1024, json: true },
  'photo.jpg': { max: 16 * 1024 * 1024, json: false },
  'depth.f32': { max: 2 * 1024 * 1024, json: false },
  'confidence.u8': { max: 1024 * 1024, json: false },
};
const CAPTURE_ID = /^[A-Za-z0-9][A-Za-z0-9-]{7,63}$/;

export function registerDetectRoutes(router: Router, o: { deps: AppDeps; budget: TokenBudget; now?: () => number }): void {
  const { deps, budget } = o;
  const clock = o.now ?? (() => performance.now());
  const gate = new DetectGate();

  router.post(
    '/:slug/requests/:id/detect-windows',
    route(async (req, res) => {
      const { request } = authed(res);
      // The cheap refusals first: the detector is off, or all its places are taken. Neither reads a byte.
      const detector = deps.windowDetector;
      if (!detector.configured || detector.detectInterior === undefined) throw new AppError(503, DETECTOR_OFF_MESSAGE).coded('detector_unavailable');
      const place = gate.enter(request.id);
      if (place === null) throw rateLimited(false, DETECT_GATE.retryAfterSeconds);
      res.once('close', place.leave);
      try {
        await budget(request.id, 'detect');
        if (request.status === 'callback') throw new AppError(409, "We'll call you about this home, so there is nothing to measure here.").coded('callback_only');
        if (Number(req.headers['content-length'] ?? '0') > DETECT_MAX_BYTES) throw new AppError(413, DETECT_BIG_MESSAGE, 'photo').coded('too_large');
        const stopGuard = guardUpload(req, DETECT_IDLE_MS, DETECT_TOTAL_MS);
        let bytes: Uint8Array;
        try {
          bytes = await readUpload(req, DETECT_MAX_BYTES);
        } finally {
          stopGuard();
        }
        const info = await readImageInfo(bytes);
        if (info === null || info === 'heic' || info.kind !== 'jpeg') throw new AppError(415, DETECT_TYPE_MESSAGE, 'photo');
        const started = clock();
        const aim = aimOf(req.query);
        let boxes: DetectedBox[];
        try {
          boxes = await detector.detectInterior(bytes);
        } catch (err) {
          if (err instanceof DetectorUnconfiguredError) throw new AppError(503, DETECTOR_OFF_MESSAGE).coded('detector_unavailable');
          if (err instanceof DetectorError) {
            deps.logError?.(err, 'homeowner-detect-windows');
            throw new AppError(503, DETECTOR_FAILED_MESSAGE).coded('detector_failed');
          }
          throw err;
        }
        const detected = clock();
        const rounded = boxes.map((b) => ({ x: round4(b.x), y: round4(b.y), w: round4(b.w), h: round4(b.h), confidence: round4(b.confidence) }));
        const picked = pickWindowBox(rounded, aim);
        // The second step is a bonus: a failure of it (or of the model) leaves the boxes, never an error
        let quad: WindowQuad | null = null;
        const segmenter = deps.windowSegmenter;
        if (picked !== null && segmenter.configured) {
          try {
            quad = await segmenter.segment(bytes, picked, aim);
          } catch (err) {
            deps.logError?.(err, 'homeowner-segment-window');
          }
        }
        const done = clock();
        const body: DetectResponse = {
          boxes: rounded,
          picked,
          quad,
          widthPx: info.widthPx,
          heightPx: info.heightPx,
          detector: 'owlv2',
          segmenter: segmenter.configured ? segmenter.name : null,
          ms: Math.round(done - started),
          msDetect: Math.round(detected - started),
          msSegment: Math.round(done - detected),
        };
        res.json(body);
      } finally {
        place.leave();
      }
    }),
  );

  router.post(
    '/:slug/requests/:id/debug-captures/:captureId/:file',
    route(async (req, res) => {
      const { request } = authed(res);
      const dir = deps.config.DEBUG_CAPTURES_DIR;
      if (dir === undefined) throw new AppError(404, "We couldn't find that.").coded('debug_captures_off');
      const captureId = typeof req.params.captureId === 'string' ? req.params.captureId : '';
      const file = typeof req.params.file === 'string' ? req.params.file : '';
      const rule = Object.hasOwn(DEBUG_FILES, file) ? DEBUG_FILES[file] : undefined;
      if (!CAPTURE_ID.test(captureId) || rule === undefined) throw new AppError(400, 'That capture file is not one we keep.').coded('invalid_request');
      await budget(request.id, 'debug');
      const stopGuard = guardUpload(req, DETECT_IDLE_MS, 120_000);
      let bytes: Uint8Array;
      try {
        bytes = await readUpload(req, rule.max);
      } finally {
        stopGuard();
      }
      if (rule.json) {
        try {
          JSON.parse(Buffer.from(bytes).toString('utf8'));
        } catch {
          throw new AppError(400, 'That file is not JSON.').coded('invalid_request');
        }
      }
      const folder = path.join(dir, captureId);
      await mkdir(folder, { recursive: true });
      // Whole or not at all: a replay never reads half a file.
      const target = path.join(folder, file);
      const temp = `${target}.${process.pid}.part`;
      await writeFile(temp, bytes);
      await rename(temp, target);
      res.status(201).json({ ok: true, captureId, file, bytes: bytes.length });
    }),
  );
}
