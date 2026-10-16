import { createHash } from 'node:crypto';
import jpeg from 'jpeg-js';
import type { Quad } from '@roofline/shared';
import { exifSegment, withExif } from './window-photo-fixture.ts';

/*
 * Synthetic photos for the homeowner API tests: a phone photo (a flat grey JPEG with an EXIF focal length) and, for the
 * credit-card method, where the card's four tapped corners and the window frame's four corners fall in it when a
 * pinhole camera sees them. Pure geometry, no randomness.
 */

const IN = 0.0254;
const MM = 1 / 25.4;
/** An ID-1 card, inches. */
export const CARD_IN = { w: 85.6 * MM, h: 53.98 * MM };
/** The tip of a rounded corner sits this far inside the card's true corner, along both edges (r = 3.18 mm). */
const TIP_IN = (1 - Math.SQRT1_2) * 3.18 * MM;

export type CardScene = {
  bytes: Uint8Array;
  widthPx: number;
  heightPx: number;
  /** The card's four tapped corners (tips of the rounded corners), around the card, starting top-left. */
  cardCorners: Quad;
  /** The window frame's four corners: top-left, top-right, bottom-right, bottom-left. */
  windowCorners: Quad;
  /** The window's true size, inches. */
  truth: { widthIn: number; heightIn: number };
};

const photoCache = new Map<string, Uint8Array>();

/** A flat grey JPEG of the given size with an EXIF focal length and orientation 1 (encoded once per size). */
export function greyJpeg(widthPx: number, heightPx: number, focal35mm: number | null = 26): Uint8Array {
  const key = `${widthPx}x${heightPx}:${focal35mm}`;
  const cached = photoCache.get(key);
  if (cached) return cached;
  const data = new Uint8Array(widthPx * heightPx * 4).fill(128);
  for (let i = 3; i < data.length; i += 4) data[i] = 255;
  let bytes: Uint8Array = new Uint8Array(jpeg.encode({ width: widthPx, height: heightPx, data }, 60).data);
  bytes = withExif(bytes, exifSegment({ orientation: 1, ...(focal35mm !== null && { focal35mm }), takenAt: '2026:10:15 10:30:00' }));
  photoCache.set(key, bytes);
  return bytes;
}

/**
 * A window `windowIn` wide and high on a wall `distanceM` from a phone turned `yawDeg` off square, with a credit card lying
 * flat in the middle of the glass and the window frame `offsetIn` in front of the glass (toward the camera). The phone is
 * upright (a portrait photo) with a 26 mm (35 mm equivalent) lens unless said.
 */
export function cardScene(o: { windowIn: { w: number; h: number }; distanceM?: number; yawDeg?: number; offsetIn?: number; widthPx?: number; heightPx?: number; focal35mm?: number }): CardScene {
  const W = o.widthPx ?? 3024;
  const H = o.heightPx ?? 4032;
  const yaw = ((o.yawDeg ?? 10) * Math.PI) / 180;
  const D = o.distanceM ?? 1.6;
  const focal35 = o.focal35mm ?? 26;
  const f = (focal35 / 36) * Math.max(W, H);
  const offset = o.offsetIn ?? 1;
  const { w, h } = o.windowIn;
  const e1 = [Math.cos(yaw), 0, Math.sin(yaw)];
  // The window's middle straight ahead of the camera; image y runs down, so world y does too.
  const C = [-(w / 2) * IN * e1[0]!, -(h / 2) * IN, D - (w / 2) * IN * e1[2]!];
  const project = (u: number, v: number, off: number): [number, number] => {
    const P = [C[0]! + u * IN * e1[0]! + off * IN * Math.sin(yaw), C[1]! + v * IN, C[2]! + u * IN * e1[2]! - off * IN * Math.cos(yaw)];
    return [W / 2 + (f * P[0]!) / P[2]!, H / 2 + (f * P[1]!) / P[2]!];
  };
  const cw = CARD_IN.w - 2 * TIP_IN;
  const ch = CARD_IN.h - 2 * TIP_IN;
  const u0 = w / 2 - cw / 2;
  const v0 = h / 2 - ch / 2;
  return {
    bytes: greyJpeg(W, H, focal35),
    widthPx: W,
    heightPx: H,
    cardCorners: [project(u0, v0, 0), project(u0 + cw, v0, 0), project(u0 + cw, v0 + ch, 0), project(u0, v0 + ch, 0)],
    windowCorners: [project(0, 0, offset), project(w, 0, offset), project(w, h, offset), project(0, h, offset)],
    truth: { widthIn: w, heightIn: h },
  };
}

/** The four corners of a w x h inch window frame in AR space, metres: top corners higher (y up), on a wall 2 m ahead. */
export function arCorners(widthIn: number, heightIn: number, o: { x?: number; z?: number } = {}): [[number, number, number], [number, number, number], [number, number, number], [number, number, number]] {
  const [x, z] = [o.x ?? 0, o.z ?? -2];
  const w = widthIn * IN;
  const h = heightIn * IN;
  return [
    [x, 1.5, z],
    [x + w, 1.5, z],
    [x + w, 1.5 - h, z],
    [x, 1.5 - h, z],
  ];
}

/** The window frame's four corners as pixels, for an AR window (the same corners projected into the photo; any inside it will do). */
export function boxCorners(widthPx: number, heightPx: number, share = 0.5): Quad {
  const [w, h] = [widthPx * share, heightPx * share];
  const [x, y] = [(widthPx - w) / 2, (heightPx - h) / 2];
  return [
    [x, y],
    [x + w, y],
    [x + w, y + h],
    [x, y + h],
  ];
}

/** SHA-256 of a token, hex: what the server keeps. */
export const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');
