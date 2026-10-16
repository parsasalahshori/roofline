// Synthetic phone photos of a window with the measuring sheet on its glass, with the exact truth: the benchmark's and
// the detection tests' renderer. Test and benchmark code only (the app never imports it). Pure TypeScript, no DOM.
//
// Scene (inches; x right, y down, z away from the camera; the glass is z = 0):
// - the frame plane z = -offsetIn (in front of the glass): wall siding, trim (casing), the frame (the measured
//   rectangle is the frame's outer edge, where it meets the trim), the sash with a meeting rail, all 3D-consistent;
// - the jamb between the frame plane and the glass, seen through the opening at an angle;
// - the glass (z = 0) with muntins, reflections, and the sheet taped on it (slightly curled);
// - optionally a leaf/hand in front, hiding part of the sheet.
// Camera: pinhole with radial distortion k1, principal point at the centre, jittered supersampling (antialiasing),
// uneven light, then defocus and motion blur and sensor noise (JPEG is the caller's: jpeg-js in the scripts).
import type { Pt, Quad, SheetPaper } from '@roofline/shared';
import { markerCornersIn, markerInk, rulerSpec, sheetLayout } from '../sheet-layout.ts';

export type SynthScene = {
  widthPx: number;
  heightPx: number;
  focal35mm: number;
  distanceIn: number;
  yawDeg: number;
  pitchDeg: number;
  rollDeg: number;
  /** Where the camera aims, inches on the glass (defaults to the window's centre). */
  aim?: Pt;
  window: { widthIn: number; heightIn: number; offsetIn: number; trimIn: number; frameIn: number; sashIn: number; grille: boolean };
  sheet: { paper: SheetPaper; xIn: number; yIn: number; rotDeg: number; curlIn: number } | null;
  k1: number;
  light: { gain: number; gradX: number; gradY: number; vignette: number };
  colors: { wall: [number, number, number]; trim: [number, number, number]; frame: [number, number, number]; sash: [number, number, number] };
  occluder: { x: number; y: number; rx: number; ry: number } | null;
  blur: { defocusPx: number; motionPx: number; motionDeg: number };
  noise: number;
  supersample: number;
  seed: number;
};

export type SynthPhoto = {
  width: number;
  height: number;
  data: Uint8ClampedArray;
  focalPx: number;
  /** The measured rectangle's corners (frame outer edge), TL TR BR BL, photo pixels. */
  windowQuad: Quad;
  /** The sheet's four paper corners and every marker corner, photo pixels (null without a sheet). */
  paperQuad: Quad | null;
  markerCorners: { imagePoints: Pt[]; sheetPointsIn: Pt[] } | null;
  /** Projection of a point on a plane `offsetIn` in front of the glass (photo pixels, with the lens distortion). */
  project: (x: number, y: number, z: number) => Pt;
  /** Inches per pixel near a point on the frame plane (for click-noise models). */
  inchesPerPx: number;
};

type V3 = [number, number, number];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V3): V3 => {
  const l = Math.hypot(...a);
  return [a[0] / l, a[1] / l, a[2] / l];
};

export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Smooth value noise in [0,1] (for siding grain, reflections). */
function valueNoise(seed: number) {
  const hash = (i: number, j: number) => {
    let h = (i * 374761393 + j * 668265263 + seed * 2147483647) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };
  return (x: number, y: number) => {
    const i = Math.floor(x);
    const j = Math.floor(y);
    const fx = x - i;
    const fy = y - j;
    const sx = fx * fx * (3 - 2 * fx);
    const sy = fy * fy * (3 - 2 * fy);
    const a = hash(i, j) + (hash(i + 1, j) - hash(i, j)) * sx;
    const b = hash(i, j + 1) + (hash(i + 1, j + 1) - hash(i, j + 1)) * sx;
    return a + (b - a) * sy;
  };
}

export function renderScene(sc: SynthScene): SynthPhoto {
  const W = sc.widthPx;
  const H = sc.heightPx;
  const f = (sc.focal35mm / 36) * Math.max(W, H);
  const cx = W / 2;
  const cy = H / 2;
  const win = sc.window;
  const off = win.offsetIn;
  const aim: V3 = [sc.aim?.[0] ?? win.widthIn / 2, sc.aim?.[1] ?? win.heightIn / 2, 0];
  const yaw = (sc.yawDeg * Math.PI) / 180;
  const pitch = (sc.pitchDeg * Math.PI) / 180;
  const C: V3 = [aim[0] + sc.distanceIn * Math.sin(yaw) * Math.cos(pitch), aim[1] - sc.distanceIn * Math.sin(pitch), -sc.distanceIn * Math.cos(yaw) * Math.cos(pitch)];
  const zc = norm(sub(aim, C));
  let xc = norm(cross([0, 1, 0], zc));
  let yc = cross(zc, xc);
  const roll = (sc.rollDeg * Math.PI) / 180;
  [xc, yc] = [
    [xc[0] * Math.cos(roll) + yc[0] * Math.sin(roll), xc[1] * Math.cos(roll) + yc[1] * Math.sin(roll), xc[2] * Math.cos(roll) + yc[2] * Math.sin(roll)],
    [yc[0] * Math.cos(roll) - xc[0] * Math.sin(roll), yc[1] * Math.cos(roll) - xc[1] * Math.sin(roll), yc[2] * Math.cos(roll) - xc[2] * Math.sin(roll)],
  ];
  const k1 = sc.k1;

  /** World point -> photo pixel (with distortion: ideal = distorted * (1 + k1 r_d^2), solved by fixed point). */
  const project = (x: number, y: number, z: number): Pt => {
    const d = sub([x, y, z], C);
    const X = d[0] * xc[0] + d[1] * xc[1] + d[2] * xc[2];
    const Y = d[0] * yc[0] + d[1] * yc[1] + d[2] * yc[2];
    const Z = d[0] * zc[0] + d[1] * zc[1] + d[2] * zc[2];
    const xu = X / Z;
    const yu = Y / Z;
    let xd = xu;
    let yd = yu;
    for (let i = 0; i < 20; i++) {
      const s = 1 + k1 * (xd * xd + yd * yd);
      xd = xu / s;
      yd = yu / s;
    }
    return [cx + f * xd, cy + f * yd];
  };

  // Sheet placement on the glass: sheet (u, v) inches -> glass (x, y).
  const sheet = sc.sheet;
  const layout = sheet === null ? null : sheetLayout(sheet.paper);
  const rot = sheet === null ? 0 : (sheet.rotDeg * Math.PI) / 180;
  const cr = Math.cos(rot);
  const sr = Math.sin(rot);
  const toGlass = (u: number, v: number): [number, number] => (sheet === null ? [u, v] : [sheet.xIn + u * cr - v * sr, sheet.yIn + u * sr + v * cr]);
  const toSheet = (x: number, y: number): [number, number] => {
    const dx = x - (sheet?.xIn ?? 0);
    const dy = y - (sheet?.yIn ?? 0);
    return [dx * cr + dy * sr, -dx * sr + dy * cr];
  };
  // Curl: a gentle cylinder along the sheet's width, its middle lifted off the glass toward the camera.
  const curl = (u: number): number => {
    if (sheet === null || layout === null) return 0;
    const t = (2 * u) / layout.widthIn - 1;
    return sheet.curlIn * Math.max(0, 1 - t * t);
  };
  const ruler = sheet === null ? null : rulerSpec(sheet.paper);
  const noise1 = valueNoise(sc.seed);
  const noise2 = valueNoise(sc.seed + 7);

  const rng = mulberry32(sc.seed);
  const ss = sc.supersample;
  const out = new Float32Array(W * H * 3);
  const wallRow = (y: number) => Math.floor(y / 6);
  const frameIn = win.frameIn;
  const sashIn = win.sashIn;
  const openX0 = frameIn + sashIn;
  const openY0 = frameIn + sashIn;
  const openX1 = win.widthIn - frameIn - sashIn;
  const openY1 = win.heightIn - frameIn - sashIn;
  const midY = win.heightIn / 2;
  const rail = sashIn; // meeting rail half-height

  const shade = (dx: number, dy: number, dz: number, px: number, py: number): [number, number, number] => {
    // Occluder in front of the frame (a leaf / a hand), dark green-brown.
    if (sc.occluder !== null) {
      const zo = -off - 8;
      const t = (zo - C[2]) / dz;
      const ox = C[0] + t * dx;
      const oy = C[1] + t * dy;
      const e = ((ox - sc.occluder.x) / sc.occluder.rx) ** 2 + ((oy - sc.occluder.y) / sc.occluder.ry) ** 2;
      if (e < 1) return [55 + 20 * noise1(ox * 2, oy * 2), 70, 40];
    }
    // Frame plane.
    const t1 = (-off - C[2]) / dz;
    const x1 = C[0] + t1 * dx;
    const y1 = C[1] + t1 * dy;
    const inOpening = x1 > openX0 && x1 < openX1 && y1 > openY0 && y1 < openY1 && !(Math.abs(y1 - midY) < rail);
    if (!inOpening) {
      if (x1 < -win.trimIn || y1 < -win.trimIn || x1 > win.widthIn + win.trimIn || y1 > win.heightIn + win.trimIn) {
        // Lap siding: 6 in boards with a shadow line at each lap, grain.
        const r = wallRow(y1);
        const fy = y1 / 6 - r;
        const lap = fy < 0.06 ? 0.55 : 1 - 0.1 * fy;
        const grain = 0.9 + 0.2 * noise1(x1 * 0.25, r * 13.1);
        const k = lap * grain;
        return [sc.colors.wall[0] * k, sc.colors.wall[1] * k, sc.colors.wall[2] * k];
      }
      if (x1 < 0 || y1 < 0 || x1 > win.widthIn || y1 > win.heightIn) {
        const k = 0.95 + 0.06 * noise2(x1 * 1.5, y1 * 1.5);
        return [sc.colors.trim[0] * k, sc.colors.trim[1] * k, sc.colors.trim[2] * k];
      }
      if (x1 < frameIn || y1 < frameIn || x1 > win.widthIn - frameIn || y1 > win.heightIn - frameIn) return sc.colors.frame;
      return sc.colors.sash;
    }
    // Through the opening to the glass; outside the opening's footprint there it hits the jamb.
    const t0 = (0 - C[2]) / dz;
    const x0 = C[0] + t0 * dx;
    const y0 = C[1] + t0 * dy;
    if (x0 < openX0 || x0 > openX1 || y0 < openY0 || y0 > openY1 || Math.abs(y0 - midY) < rail) {
      const s = sc.colors.sash;
      return [s[0] * 0.7, s[1] * 0.7, s[2] * 0.7];
    }
    // The sheet (taped on the glass, curled toward the camera).
    if (sheet !== null && layout !== null) {
      let [u, v] = toSheet(x0, y0);
      for (let it = 0; it < 2; it++) {
        const h = curl(u);
        const t = (-h - C[2]) / dz;
        [u, v] = toSheet(C[0] + t * dx, C[1] + t * dy);
      }
      if (u >= 0 && v >= 0 && u <= layout.widthIn && v <= layout.heightIn) {
        let ink = markerInk(layout, u, v);
        if (!ink && ruler !== null) {
          if (v >= ruler.y && v <= ruler.y + 0.012 && u >= ruler.x && u <= ruler.x + ruler.lengthIn) ink = true;
          for (const tk of ruler.ticks) if (Math.abs(u - ruler.x - tk.at) <= 0.006 && v >= ruler.y && v <= ruler.y + tk.len) ink = true;
          // The words: grey blocks.
          if (v > ruler.y + 0.65 && v < ruler.y + 1.3 && u > 0.5 && u < 7.4 && Math.floor(v * 8) % 2 === 0 && noise2(u * 9, Math.floor(v * 8)) > 0.45) ink = true;
        }
        const paper = 238 + 6 * noise2(u * 3, v * 3);
        const k = ink ? 26 : paper;
        return [k, k, k * 0.99];
      }
    }
    // Muntins (grilles) between the panes, a 3 x 2 pattern per sash.
    if (win.grille) {
      const gx = (openX1 - openX0) / 3;
      const nearX = Math.abs(((x0 - openX0) % gx) - gx / 2) > gx / 2 - 0.375;
      const halfH = y0 < midY ? midY - rail - openY0 : openY1 - midY - rail;
      const yy = y0 < midY ? y0 - openY0 : y0 - midY - rail;
      const nearY = Math.abs(yy - halfH / 2) < 0.375;
      if (nearX || nearY) {
        return [sc.colors.sash[0] * 0.92, sc.colors.sash[1] * 0.92, sc.colors.sash[2] * 0.92];
      }
    }
    // Glass: a dark room with sky/tree reflections (a function of the view direction, so it moves with the camera).
    const refl = 0.55 * noise1(px * 0.004 + 3, py * 0.004) + 0.45 * noise2(dx * 3, dy * 3);
    const streak = Math.max(0, Math.sin((px + py) * 0.002 + sc.seed) - 0.85) * 400;
    const g = 40 + 90 * refl + streak;
    return [g * 0.85, g * 0.95, g * 1.05];
  };

  for (let py = 0; py < H; py++) {
    for (let px = 0; px < W; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const u = px + (sx + rng()) / ss;
          const v = py + (sy + rng()) / ss;
          const xd = (u - cx) / f;
          const yd = (v - cy) / f;
          const s = 1 + k1 * (xd * xd + yd * yd);
          const xu = xd * s;
          const yu = yd * s;
          const dx = xc[0] * xu + yc[0] * yu + zc[0];
          const dy = xc[1] * xu + yc[1] * yu + zc[1];
          const dz = xc[2] * xu + yc[2] * yu + zc[2];
          const c = shade(dx, dy, dz, u, v);
          r += c[0];
          g += c[1];
          b += c[2];
        }
      }
      const n = ss * ss;
      // Uneven light: a gradient across the photo and vignetting.
      const nx = (px - cx) / W;
      const ny = (py - cy) / H;
      const light = sc.light.gain * (1 + sc.light.gradX * nx + sc.light.gradY * ny) * (1 - sc.light.vignette * (nx * nx + ny * ny));
      const i = (py * W + px) * 3;
      out[i] = (r / n) * light;
      out[i + 1] = (g / n) * light;
      out[i + 2] = (b / n) * light;
    }
  }

  let buf: Float32Array = out;
  if (sc.blur.defocusPx > 0.05) buf = gaussianBlur(buf, W, H, sc.blur.defocusPx);
  if (sc.blur.motionPx > 0.3) buf = motionBlur(buf, W, H, sc.blur.motionPx, sc.blur.motionDeg);
  const data = new Uint8ClampedArray(W * H * 4);
  const nr = mulberry32(sc.seed ^ 0x9e3779b9);
  const gauss = () => {
    const u = Math.max(1e-12, nr());
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * nr());
  };
  for (let i = 0, j = 0; i < W * H; i++, j += 4) {
    // Shot noise grows with brightness; read noise floor.
    for (let c = 0; c < 3; c++) {
      const v = buf[i * 3 + c]!;
      data[j + c] = v + gauss() * sc.noise * Math.sqrt(0.3 + v / 255);
    }
    data[j + 3] = 255;
  }

  const windowQuad: Quad = [project(0, 0, -off), project(win.widthIn, 0, -off), project(win.widthIn, win.heightIn, -off), project(0, win.heightIn, -off)];
  let paperQuad: Quad | null = null;
  let markerCorners: SynthPhoto['markerCorners'] = null;
  if (sheet !== null && layout !== null) {
    const onGlass = (u: number, v: number): Pt => {
      const [x, y] = toGlass(u, v);
      return project(x, y, -curl(u));
    };
    paperQuad = [onGlass(0, 0), onGlass(layout.widthIn, 0), onGlass(layout.widthIn, layout.heightIn), onGlass(0, layout.heightIn)];
    const sheetPointsIn = layout.markers.flatMap((m) => markerCornersIn(m));
    markerCorners = { sheetPointsIn, imagePoints: sheetPointsIn.map(([u, v]) => onGlass(u, v)) };
  }
  const c0 = project(win.widthIn / 2, win.heightIn / 2, -off);
  const c1 = project(win.widthIn / 2 + 1, win.heightIn / 2, -off);
  const inchesPerPx = 1 / Math.hypot(c1[0] - c0[0], c1[1] - c0[1]);
  return { width: W, height: H, data, focalPx: f, windowQuad, paperQuad, markerCorners, project, inchesPerPx };
}

function gaussianBlur(src: Float32Array, W: number, H: number, sigma: number): Float32Array {
  const r = Math.ceil(sigma * 3);
  const k: number[] = [];
  let s = 0;
  for (let i = -r; i <= r; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma));
    k.push(v);
    s += v;
  }
  const kn = k.map((v) => v / s);
  const tmp = new Float32Array(src.length);
  const dst = new Float32Array(src.length);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      for (let c = 0; c < 3; c++) {
        let a = 0;
        for (let i = -r; i <= r; i++) a += kn[i + r]! * src[(y * W + Math.min(W - 1, Math.max(0, x + i))) * 3 + c]!;
        tmp[(y * W + x) * 3 + c] = a;
      }
    }
  }
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      for (let c = 0; c < 3; c++) {
        let a = 0;
        for (let i = -r; i <= r; i++) a += kn[i + r]! * tmp[(Math.min(H - 1, Math.max(0, y + i)) * W + x) * 3 + c]!;
        dst[(y * W + x) * 3 + c] = a;
      }
    }
  }
  return dst;
}

/** Linear motion blur: the average along a centred segment of `len` pixels at `deg`. */
function motionBlur(src: Float32Array, W: number, H: number, len: number, deg: number): Float32Array {
  const n = Math.max(2, Math.ceil(len * 2));
  const ux = Math.cos((deg * Math.PI) / 180);
  const uy = Math.sin((deg * Math.PI) / 180);
  const dst = new Float32Array(src.length);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let i = 0; i < n; i++) {
        const t = (i / (n - 1) - 0.5) * len;
        const sx = Math.min(W - 1, Math.max(0, x + ux * t));
        const sy = Math.min(H - 1, Math.max(0, y + uy * t));
        const x0 = Math.floor(sx);
        const y0 = Math.floor(sy);
        const x1 = Math.min(W - 1, x0 + 1);
        const y1 = Math.min(H - 1, y0 + 1);
        const fx = sx - x0;
        const fy = sy - y0;
        const at = (xx: number, yy: number, c: number) => src[(yy * W + xx) * 3 + c]!;
        for (let c = 0; c < 3; c++) {
          const v = (at(x0, y0, c) * (1 - fx) + at(x1, y0, c) * fx) * (1 - fy) + (at(x0, y1, c) * (1 - fx) + at(x1, y1, c) * fx) * fy;
          if (c === 0) r += v;
          else if (c === 1) g += v;
          else b += v;
        }
      }
      const o = (y * W + x) * 3;
      dst[o] = r / n;
      dst[o + 1] = g / n;
      dst[o + 2] = b / n;
    }
  }
  return dst;
}
