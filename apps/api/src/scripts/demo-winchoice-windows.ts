import { deflateSync } from 'node:zlib';
import { randomUUID } from 'node:crypto';
import {
  appendWindowUpload,
  createWindowMeasurement,
  createWindowOrder,
  getWindowOrderSettings,
  updateWindowMeasurement,
  withTenant,
  type Pools,
  type StoredWindowUpload,
  type TenantContext,
} from '@roofline/db';
import {
  INCHES_PER_METRE,
  linesFromPhotoWindows,
  type PhotoWindowInput,
  type WindowOrderLine,
  type WindowStyle,
} from '@roofline/shared';
import { toWindowView } from '../estimator/windows-view.ts';
import type { ObjectStore } from '../providers/object-store.ts';

/*
 * The Measure windows demo for WinChoice: one window measurement at 305 Ridgeway Dr, Little Rock, with seven windows
 * (four measured on site, three estimated from the walls) and a draft factory order for the measured ones. Everything
 * goes through the same models the app uses: the readings are stored as photo windows (iPhone LiDAR AR corners and
 * measuring-sheet photos), sized by the same code on every read, so the table, the quote tiers and the order sheet show
 * what the app really computes. The photos are drawn here (a wall, a white frame, dark glass, the measuring sheet).
 */

const PHOTO_W = 1200;
const PHOTO_H = 1600;
const FOCAL_35MM = 26;
const FOCAL_PX = (FOCAL_35MM / 36) * Math.max(PHOTO_W, PHOTO_H);
/** How far the frame is from the camera, inches: the window fills about half the photo's width. */
const FRAME_DEPTH_IN = 100;
/** The frame sits this far in front of the sheet's plane (the sheet is taped on the glass), inches. */
const PLANE_OFFSET_IN = 1;
const PX_PER_IN = FOCAL_PX / FRAME_DEPTH_IN;

type Quad = [[number, number], [number, number], [number, number], [number, number]];

/** The four corners of a window `widthIn` by `heightIn` (inches, on the frame's plane) centred at (cxIn, cyIn) from the photo's middle, in photo pixels. */
function frameQuad(widthIn: number, heightIn: number, cxIn: number, cyIn: number): Quad {
  const px = (xIn: number, yIn: number): [number, number] => [PHOTO_W / 2 + (xIn + cxIn) * PX_PER_IN, PHOTO_H / 2 + (yIn + cyIn) * PX_PER_IN];
  return [px(-widthIn / 2, -heightIn / 2), px(widthIn / 2, -heightIn / 2), px(widthIn / 2, heightIn / 2), px(-widthIn / 2, heightIn / 2)];
}

/** The measuring sheet as the app finds it: a lattice of matched points (photo pixels and inches on the sheet), for a camera square to the wall. */
function sheetScale(leftIn: number, topIn: number): Extract<PhotoWindowInput['scale'], { kind: 'sheet' }> {
  const depth = FRAME_DEPTH_IN + PLANE_OFFSET_IN;
  const imagePoints: [number, number][] = [];
  const sheetPointsIn: [number, number][] = [];
  for (const sy of [1.25, 3.5, 5.75, 8, 10.25]) {
    for (const sx of [0.9, 2.9, 4.9, 6.9]) {
      sheetPointsIn.push([sx, sy]);
      imagePoints.push([PHOTO_W / 2 + (FOCAL_PX * (leftIn + sx)) / depth, PHOTO_H / 2 + (FOCAL_PX * (topIn + sy)) / depth]);
    }
  }
  return { kind: 'sheet', paper: 'letter', imagePoints, sheetPointsIn, planeOffsetIn: PLANE_OFFSET_IN };
}

/** AR world-space corners (metres, +Y up, the wall 2 m in front of where the session began): top-left, top-right, bottom-right, bottom-left. */
function arCorners(widthIn: number, heightIn: number, shearIn = 0): [[number, number, number], [number, number, number], [number, number, number], [number, number, number]] {
  const m = (inches: number) => inches / INCHES_PER_METRE;
  const w = m(widthIn);
  // With a shear the left and right edges lean, so they are longer than the rise: keep the edge length at heightIn.
  const rise = Math.sqrt(heightIn * heightIn - shearIn * shearIn);
  const h = m(rise);
  const s = m(shearIn);
  const x0 = -w / 2;
  const z = -2;
  return [
    [x0 + s, h, z],
    [x0 + s + w, h, z],
    [x0 + w, 0, z],
    [x0, 0, z],
  ];
}

/* ---------------------------------------- the photo: a small PNG encoder ---------------------------------------- */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  Buffer.from(data).copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

type Rgb = readonly [number, number, number];

/** A PNG of a wall with a window in it (white frame, dark glass, mullions) and the measuring sheet, drawn with filled rectangles. */
function windowPng(opts: { quad: Quad; panes: number; sheet: { leftIn: number; topIn: number } | null; wall: Rgb }): Buffer {
  const pixels = Buffer.alloc(PHOTO_W * PHOTO_H * 3);
  const fill = (x0: number, y0: number, x1: number, y1: number, [r, g, b]: Rgb) => {
    const xa = Math.max(0, Math.round(x0));
    const xb = Math.min(PHOTO_W, Math.round(x1));
    for (let y = Math.max(0, Math.round(y0)); y < Math.min(PHOTO_H, Math.round(y1)); y += 1) {
      for (let x = xa; x < xb; x += 1) {
        const i = (y * PHOTO_W + x) * 3;
        pixels[i] = r;
        pixels[i + 1] = g;
        pixels[i + 2] = b;
      }
    }
  };
  fill(0, 0, PHOTO_W, PHOTO_H, opts.wall);
  // Clapboard lines on the wall.
  for (let y = 0; y < PHOTO_H; y += 46) fill(0, y, PHOTO_W, y + 3, [opts.wall[0] - 22, opts.wall[1] - 22, opts.wall[2] - 24]);
  const [tl, , br] = opts.quad;
  const frame = 26;
  fill(tl[0] - frame - 6, tl[1] - frame - 6, br[0] + frame + 6, br[1] + frame + 14, [214, 211, 203]);
  fill(tl[0] - frame, tl[1] - frame, br[0] + frame, br[1] + frame, [246, 246, 243]);
  fill(tl[0], tl[1], br[0], br[1], [62, 78, 92]);
  // Reflection on the glass, and the mullions between the panes.
  fill(tl[0], tl[1], br[0], tl[1] + (br[1] - tl[1]) * 0.35, [76, 94, 108]);
  const paneW = (br[0] - tl[0]) / opts.panes;
  for (let p = 1; p < opts.panes; p += 1) fill(tl[0] + p * paneW - 9, tl[1], tl[0] + p * paneW + 9, br[1], [246, 246, 243]);
  if (opts.sheet !== null) {
    const depth = FRAME_DEPTH_IN + PLANE_OFFSET_IN;
    const toPx = (xIn: number, yIn: number): [number, number] => [PHOTO_W / 2 + (FOCAL_PX * xIn) / depth, PHOTO_H / 2 + (FOCAL_PX * yIn) / depth];
    const [sx0, sy0] = toPx(opts.sheet.leftIn, opts.sheet.topIn);
    const [sx1, sy1] = toPx(opts.sheet.leftIn + 8.5, opts.sheet.topIn + 11);
    fill(sx0, sy0, sx1, sy1, [252, 252, 250]);
    for (const sy of [1.25, 3.5, 5.75, 8, 10.25]) {
      for (const sx of [0.9, 2.9, 4.9, 6.9]) {
        const [px, py] = toPx(opts.sheet.leftIn + sx, opts.sheet.topIn + sy);
        fill(px - 4, py - 4, px + 4, py + 4, [20, 24, 28]);
      }
    }
  }
  // PNG scanlines: a filter byte (0) before each row.
  const raw = Buffer.alloc((PHOTO_W * 3 + 1) * PHOTO_H);
  for (let y = 0; y < PHOTO_H; y += 1) {
    raw[y * (PHOTO_W * 3 + 1)] = 0;
    pixels.copy(raw, y * (PHOTO_W * 3 + 1) + 1, y * PHOTO_W * 3, (y + 1) * PHOTO_W * 3);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(PHOTO_W, 0);
  header.writeUInt32BE(PHOTO_H, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // RGB
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0))]);
}

/* ------------------------------------------------ the seed -------------------------------------------------- */

type WindowSeed = {
  key: string;
  label: string;
  style: WindowStyle;
  panes: number;
  grid?: string;
  obscure?: boolean;
  /** Each reading becomes one photo window: LiDAR corners or a measuring-sheet photo. */
  readings: ({ kind: 'lidar'; widthIn: number; heightIn: number; shearIn?: number } | { kind: 'sheet'; widthIn: number; heightIn: number })[];
};

const WINDOWS: readonly WindowSeed[] = [
  // The living-room slider: three LiDAR readings, one of them leaning (not square): a "check" that sends the rep back.
  {
    key: 'w1',
    label: 'Living, front',
    style: 'slider-3',
    panes: 3,
    readings: [
      { kind: 'lidar', widthIn: 71.25, heightIn: 59.375 },
      { kind: 'lidar', widthIn: 71.375, heightIn: 59.5 },
      { kind: 'lidar', widthIn: 71.625, heightIn: 59.75, shearIn: 5 },
    ],
  },
  { key: 'w2', label: 'Kitchen', style: 'double-hung', panes: 1, grid: '3x2', readings: [{ kind: 'sheet', widthIn: 35.625, heightIn: 47.875 }] },
  { key: 'w3', label: 'Bath, side', style: 'double-hung', panes: 1, obscure: true, readings: [{ kind: 'sheet', widthIn: 23.5, heightIn: 35.75 }] },
  { key: 'w7', label: 'Hall', style: 'single-hung', panes: 1, readings: [{ kind: 'sheet', widthIn: 29.875, heightIn: 47.75 }] },
];

/**
 * Writes the window measurement for the house and its draft factory order. Photos are stored in `store` (skipped when
 * there is none: the readings still size, the thumbnails just do not load). Returns the ids.
 */
export async function seedRidgewayWindows(
  pools: Pools,
  ctx: TenantContext,
  now: Date,
  home: { propertyId: string; address: string; lngLat: [number, number] },
  store: ObjectStore | undefined,
): Promise<{ windowMeasurementId: string; orderId: string }> {
  return withTenant(pools, ctx, async (tx) => {
    const at = new Date(now.getTime() - 3 * 60 * 60_000);
    // The walls: a 31 ft wide front and 33 ft deep (128 ft of wall), one floor, the camera on the street side.
    const mPerLat = 111_000;
    const mPerLng = 111_320 * Math.cos((home.lngLat[1] * Math.PI) / 180);
    const halfW = 31 * 0.3048 / 2;
    const halfD = 33 * 0.3048 / 2;
    const [lng, lat] = home.lngLat;
    const ring: [number, number][] = [
      [lng - halfW / mPerLng, lat - halfD / mPerLat],
      [lng + halfW / mPerLng, lat - halfD / mPerLat],
      [lng + halfW / mPerLng, lat + halfD / mPerLat],
      [lng - halfW / mPerLng, lat + halfD / mPerLat],
    ];
    const created = await createWindowMeasurement(
      tx,
      ctx,
      {
        propertyId: home.propertyId,
        address: home.address,
        center: home.lngLat,
        photos: [],
        windows: [],
        estimated: null,
        stories: 1,
        geometry: { ring, camera: [lng, lat - 22 / mPerLat], eaveHeightM: 2.7432, outlineSource: 'footprint' },
        detector: null,
        missingReason: null,
        reviewReasons: [],
        tookMs: 1300,
        photosDeleteBy: null,
      },
      at,
    );

    // The photos and the readings.
    const photoWindows: PhotoWindowInput[] = [];
    let sheetCount = 0;
    for (const w of WINDOWS) {
      const first = w.readings[0]!;
      const uploadId = randomUUID();
      const sheetSpot = { leftIn: -first.widthIn / 2 + 2, topIn: first.heightIn / 2 - 14 };
      const quad = frameQuad(first.widthIn, first.heightIn, 0, 0);
      const png = windowPng({ quad, panes: w.panes, sheet: first.kind === 'sheet' ? sheetSpot : null, wall: [186, 180, 166] });
      const key = `${ctx.companyId}/window-uploads/${uploadId}.png`;
      if (store?.configured) await store.put(key, png, 'image/png');
      const upload: StoredWindowUpload = { id: uploadId, widthPx: PHOTO_W, heightPx: PHOTO_H, focal35mm: FOCAL_35MM, takenAt: null, key, kind: 'png', orientation: 1, bytes: png.length, uploadedAt: at.toISOString() };
      const appended = await appendWindowUpload(tx, ctx, created.id, upload, 40, at);
      if (appended === null || appended === 'full') throw new Error('The demo window photo could not be stored.');
      for (const [i, r] of w.readings.entries()) {
        const readingQuad = frameQuad(r.widthIn, r.heightIn, 0, 0);
        if (r.kind === 'lidar') {
          photoWindows.push({
            id: `${w.key}-r${i + 1}`,
            windowKey: w.key,
            label: w.label,
            uploadId,
            corners: readingQuad,
            scale: { kind: 'ar', pointsM: arCorners(r.widthIn, r.heightIn, r.shearIn ?? 0), trackingLostCount: 0, device: 'arkit-lidar', cornerSpreadM: [0.002, 0.002, 0.002, 0.002] },
          });
        } else {
          sheetCount += 1;
          photoWindows.push({ id: `${w.key}-r${i + 1}`, windowKey: w.key, label: w.label, uploadId, corners: readingQuad, scale: sheetScale(sheetSpot.leftIn, sheetSpot.topIn) });
        }
      }
    }
    void sheetCount;
    // Each window keeps the style it was given, and the bathroom one is frosted (the staff table names both)
    for (const pw of photoWindows) {
      const seed = WINDOWS.find((w) => w.key === pw.windowKey);
      if (seed === undefined) continue;
      pw.style = seed.style;
      if (seed.obscure) pw.frosted = true;
    }
    // Three windows are still counted from the walls: the estimate adds three standard windows to the four measured ones.
    const row = await updateWindowMeasurement(
      tx,
      ctx,
      created.id,
      { adjustments: { excludedWindowIds: [], photoWindows, manualCounts: { small: 0, standard: 3, large: 0, picture: 0 } } },
      at,
    );
    if (row === null) throw new Error('The demo window measurement disappeared.');

    // The draft factory order, made the way POST /api/window-measurements/:id/order makes it.
    const view = toWindowView(row, at);
    const lines: WindowOrderLine[] = linesFromPhotoWindows(view.photoWindows ?? [], new Set()).map((line) => {
      const seed = WINDOWS.find((w) => w.key === line.id)!;
      return {
        ...line,
        location: seed.label,
        style: seed.style,
        grid: seed.grid === undefined ? line.grid : { type: 'colonial', top: seed.grid, bottom: seed.grid },
        obscure: seed.obscure ?? false,
      };
    });
    const settings = await getWindowOrderSettings(tx, ctx);
    const order = await createWindowOrder(tx, ctx, { windowMeasurementId: created.id, lines, settings }, at);
    if (order === null) throw new Error('The demo window order could not be made.');
    return { windowMeasurementId: created.id, orderId: order.id };
  });
}
