// Benchmark scenes: seeded random windows and photos with known truth (see render.ts for the scene model).
import type { SynthScene } from '../../apps/web/src/features/measure/windows/cv/synth/render.ts';
import { mulberry32 } from '../../apps/web/src/features/measure/windows/cv/synth/render.ts';

export type BenchWindow = {
  id: number;
  widthIn: number;
  heightIn: number;
  offsetIn: number;
  photos: BenchPhoto[];
};
export type BenchPhoto = { scene: SynthScene; jpegQuality: number; megapixels: 12 | 3; seed: number };

const PALETTES: SynthScene['colors'][] = [
  // White vinyl window in white trim on tan siding (lowest contrast at the measured edge).
  { wall: [168, 150, 120], trim: [238, 236, 230], frame: [212, 210, 204], sash: [228, 226, 220] },
  // Bronze aluminium in white trim, grey siding.
  { wall: [120, 126, 130], trim: [232, 230, 224], frame: [92, 78, 64], sash: [110, 96, 80] },
  // Wood window in painted trim, red siding.
  { wall: [140, 70, 60], trim: [225, 220, 205], frame: [150, 105, 70], sash: [170, 125, 85] },
  // Almond vinyl in dark trim, blue-grey siding.
  { wall: [100, 115, 135], trim: [70, 72, 75], frame: [205, 195, 175], sash: [220, 212, 195] },
];

/** `count` windows, three photos each, from one seed. */
export function benchWindows(count: number, seed: number): BenchWindow[] {
  const rnd = mulberry32(seed);
  const U = (a: number, b: number) => a + (b - a) * rnd();
  const out: BenchWindow[] = [];
  for (let id = 0; id < count; id++) {
    const widthIn = Math.round(U(20, 60) * 8) / 8;
    const heightIn = Math.round(U(24, 72) * 8) / 8;
    const offsetIn = Math.round(U(0, 2) * 8) / 8;
    const colors = PALETTES[Math.floor(rnd() * PALETTES.length)]!;
    const grille = rnd() < 0.5;
    const paper = rnd() < 0.7 ? 'letter' : 'a4';
    const sheetW = paper === 'letter' ? 8.5 : 8.27;
    const sheetH = paper === 'letter' ? 11 : 11.69;
    const inner = 1.5 + 1.25;
    // The sheet in a lower corner of the glass (or the middle of the lower sash), a little turned.
    const sx = U(inner + 0.5, Math.max(inner + 0.6, widthIn - inner - sheetW - 0.5));
    const sy = U(heightIn / 2 + 1.25 + 0.5, Math.max(heightIn / 2 + 1.8, heightIn - inner - sheetH - 0.5));
    const rotDeg = U(-8, 8);
    const curlIn = U(0, 0.05);
    const photos: BenchPhoto[] = [];
    for (let k = 0; k < 3; k++) {
      const mp = rnd() < 0.5 ? 12 : 3;
      const portrait = heightIn >= widthIn * 0.8;
      const long = mp === 12 ? 4032 : 2016;
      const short = mp === 12 ? 3024 : 1512;
      const [w, h] = portrait ? [short, long] : [long, short];
      const focal35mm = U(24, 28);
      const theta = U(0, 45);
      const phi = U(0, 2 * Math.PI);
      const yawDeg = theta * Math.cos(phi);
      const pitchDeg = theta * Math.sin(phi);
      // Close enough to want, far enough that the window and its trim fit with a margin.
      const f = (focal35mm / 36) * Math.max(w, h);
      const needW = ((widthIn + 9) * f) / (w * 0.92);
      const needH = ((heightIn + 9) * f) / (h * 0.92);
      const distanceIn = Math.max(U(36, 144), needW, needH);
      const scale = mp === 12 ? 1 : 0.6;
      photos.push({
        megapixels: mp,
        jpegQuality: Math.round(U(70, 90)),
        seed: id * 10 + k + seed * 1000,
        scene: {
          widthPx: w,
          heightPx: h,
          focal35mm,
          distanceIn,
          yawDeg,
          pitchDeg,
          rollDeg: U(-3, 3),
          aim: [widthIn / 2 + U(-0.08, 0.08) * widthIn, heightIn / 2 + U(-0.08, 0.08) * heightIn],
          window: { widthIn, heightIn, offsetIn, trimIn: 3.5, frameIn: 1.5, sashIn: 1.25, grille },
          sheet: { paper, xIn: sx, yIn: sy, rotDeg, curlIn },
          k1: U(-0.01, 0.01),
          light: { gain: U(0.75, 1.1), gradX: U(-0.3, 0.3), gradY: U(-0.3, 0.3), vignette: U(0.1, 0.4) },
          colors,
          occluder: rnd() < 0.25 ? { x: sx + U(0, sheetW), y: sy + U(0, sheetH), rx: U(1, 2.5), ry: U(1, 2.5) } : null,
          blur: { defocusPx: U(0.3, 1.2) * scale, motionPx: U(0, 3) * scale, motionDeg: U(0, 180) },
          noise: U(1, 4),
          supersample: mp === 12 ? 2 : 3,
          seed: id * 10 + k + seed * 1000,
        },
      });
    }
    out.push({ id, widthIn, heightIn, offsetIn, photos });
  }
  return out;
}

/** Photos the engine should refuse (or flag): no sheet, heavy blur, very steep, ultra-wide. */
export function refusalPhotos(seed: number): { kind: string; photo: BenchPhoto; widthIn: number; heightIn: number; offsetIn: number }[] {
  const base = benchWindows(12, seed);
  const out: { kind: string; photo: BenchPhoto; widthIn: number; heightIn: number; offsetIn: number }[] = [];
  base.forEach((w, i) => {
    const p = w.photos.find((x) => x.megapixels === 3) ?? w.photos[0]!;
    const sc = { ...p.scene, widthPx: p.scene.widthPx > p.scene.heightPx ? 2016 : 1512, heightPx: p.scene.widthPx > p.scene.heightPx ? 1512 : 2016, supersample: 2 };
    const kind = ['no sheet', 'heavy blur', 'steep 60-70 deg', 'ultra-wide 13 mm'][i % 4]!;
    if (kind === 'no sheet') sc.sheet = null;
    if (kind === 'heavy blur') sc.blur = { defocusPx: 4, motionPx: 8, motionDeg: 30 };
    if (kind === 'steep 60-70 deg') {
      sc.yawDeg = 60 + (i % 3) * 5;
      sc.pitchDeg = 0;
    }
    if (kind === 'ultra-wide 13 mm') {
      sc.focal35mm = 13;
      sc.k1 = -0.06;
      sc.distanceIn = sc.distanceIn * 0.5;
    }
    out.push({ kind, photo: { ...p, megapixels: 3, scene: sc }, widthIn: w.widthIn, heightIn: w.heightIn, offsetIn: w.offsetIn });
  });
  return out;
}
