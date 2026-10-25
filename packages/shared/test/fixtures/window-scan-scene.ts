// A synthetic window scan: a wall, a window of a known size, cameras with known poses, and the marks a phone would make
// (the window's corners projected into every frame, plus seeded noise). Hermetic and deterministic. Used by the window-scan
// unit tests, the API route tests, the dev seed and the JSON fixtures the iOS code checks too.
import {
  SCAN_CORNERS,
  scanProject,
  type ScanCorner,
  type ScanFrame,
  type ScanIntrinsics,
  type ScanMark,
  type ScanVec3,
  type ScanWall,
} from '../../src/window-scan.ts';

const M_PER_IN = 0.0254;

export const SCENE_INTRINSICS: ScanIntrinsics = { fx: 1500, fy: 1500, cx: 960, cy: 720, width: 1920, height: 1440 };

/** A camera at `eye` looking at `target`, ARKit's way (looks along its -z, +x right, +y up), column-major. */
export function lookAt(eye: ScanVec3, target: ScanVec3): number[] {
  const f = norm([target[0] - eye[0], target[1] - eye[1], target[2] - eye[2]]);
  const z: ScanVec3 = [-f[0], -f[1], -f[2]];
  const x = norm(cross(f, [0, 1, 0]));
  const y = cross(z, x);
  return [x[0], x[1], x[2], 0, y[0], y[1], y[2], 0, z[0], z[1], z[2], 0, eye[0], eye[1], eye[2], 1];
}

function cross(a: ScanVec3, b: ScanVec3): ScanVec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function norm(a: ScanVec3): ScanVec3 {
  const l = Math.hypot(a[0], a[1], a[2]);
  return [a[0] / l, a[1] / l, a[2] / l];
}

/** A small seeded generator (mulberry32): uniform in [0, 1). */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type SceneOptions = {
  widthIn?: number;
  heightIn?: number;
  /** The wall is the plane z = wallZ, facing +z (the cameras are at z >= 0). */
  wallZ?: number;
  /** Where the window's centre is on the wall (x, y), metres. */
  center?: [number, number];
  /** The cameras' positions for the regular frames (looking at the window's centre). */
  regular?: ScanVec3[];
  /** Close-ups of the corners (0..4 of them, in corner order). */
  closeups?: ScanCorner[];
  /** Uniform noise on every mark, +/- this many pixels. */
  noisePx?: number;
  seed?: number;
  /** The window's true corners moved by these vectors (metres): a skewed or lifted corner. */
  cornerOffsets?: Partial<Record<ScanCorner, ScanVec3>>;
  /** The wall plane the phone reports (default the true one). `null`: none. */
  wall?: ScanWall | null;
  /** Marks added or moved after the fact: [frameId, corner, dx, dy] in pixels. */
  nudges?: [string, ScanCorner, number, number][];
  /** Leave these corners unmarked in these frames: `frameId:corner`. */
  drop?: string[];
};

export type Scene = {
  frames: ScanFrame[];
  marks: ScanMark[];
  wall: ScanWall | null;
  truth: { cornersM: ScanVec3[]; widthIn: number; heightIn: number };
  /** Where the corners really are (the truth, moved by `cornerOffsets`): what the marks were projected from. */
  actualM: ScanVec3[];
};

export const REGULAR_EYES: ScanVec3[] = [
  [-1.4, 1.2, 0],
  [-0.7, 1.55, 0.2],
  [0, 1.3, 0],
  [0.8, 1.65, 0.1],
  [1.5, 1.2, 0],
];

/** The default scene: a 34.625 x 55.75 in window seen from 5 regular frames and 4 close-ups. */
export function buildScene(o: SceneOptions = {}): Scene {
  const widthIn = o.widthIn ?? 34.625;
  const heightIn = o.heightIn ?? 55.75;
  const wallZ = o.wallZ ?? -3;
  const [cx, cy] = o.center ?? [0, 1.4];
  const w = widthIn * M_PER_IN;
  const h = heightIn * M_PER_IN;
  const base: ScanVec3[] = [
    [cx - w / 2, cy + h / 2, wallZ],
    [cx + w / 2, cy + h / 2, wallZ],
    [cx + w / 2, cy - h / 2, wallZ],
    [cx - w / 2, cy - h / 2, wallZ],
  ];
  const actual = base.map((p, i) => {
    const d = o.cornerOffsets?.[i as ScanCorner];
    return d === undefined ? p : ([p[0] + d[0], p[1] + d[1], p[2] + d[2]] as ScanVec3);
  });
  const frames: ScanFrame[] = [];
  const regular = o.regular ?? REGULAR_EYES;
  regular.forEach((eye, i) => {
    frames.push({
      frameId: `r${i + 1}`,
      kind: 'regular',
      corner: null,
      uploadId: uuid(100 + i),
      imageWidth: 1920,
      imageHeight: 1440,
      cameraTransform: lookAt(eye, [cx, cy, wallZ]),
      intrinsics: SCENE_INTRINSICS,
    });
  });
  // A close-up sits 0.6 m from the wall, a little to the side and above/below, looking at its corner
  (o.closeups ?? [0, 1, 2, 3]).forEach((corner, i) => {
    const p = base[corner]!;
    const sx = corner === 0 || corner === 3 ? -0.18 : 0.18;
    const sy = corner === 0 || corner === 1 ? 0.12 : -0.12;
    frames.push({
      frameId: `c${i + 1}`,
      kind: 'closeup',
      corner,
      uploadId: uuid(200 + i),
      imageWidth: 1920,
      imageHeight: 1440,
      cameraTransform: lookAt([p[0] + sx, p[1] + sy, wallZ + 0.6], p),
      intrinsics: SCENE_INTRINSICS,
    });
  });
  const rand = seeded(o.seed ?? 1);
  const noise = o.noisePx ?? 0;
  const marks: ScanMark[] = [];
  for (const f of frames) {
    for (const c of SCAN_CORNERS) {
      // A regular frame marks all four corners; a close-up marks its own corner
      if (f.kind === 'closeup' && f.corner !== c) continue;
      if (o.drop?.includes(`${f.frameId}:${c}`)) continue;
      const proj = scanProject(actual[c]!, f.cameraTransform, f.intrinsics);
      if (proj === null) throw new Error(`corner ${c} is behind frame ${f.frameId}`);
      if (proj[0] < 0 || proj[1] < 0 || proj[0] > f.intrinsics.width || proj[1] > f.intrinsics.height) throw new Error(`corner ${c} is outside frame ${f.frameId}: ${proj.join(',')}`);
      const nudge = o.nudges?.find((n) => n[0] === f.frameId && n[1] === c);
      marks.push({
        frameId: f.frameId,
        corner: c,
        x: round(proj[0] + (rand() * 2 - 1) * noise + (nudge?.[2] ?? 0)),
        y: round(proj[1] + (rand() * 2 - 1) * noise + (nudge?.[3] ?? 0)),
        source: f.kind === 'closeup' ? 'snap' : 'ai',
      });
    }
  }
  const wall: ScanWall | null = o.wall === undefined ? { point: [cx, cy, wallZ], normal: [0, 0, 1] } : o.wall;
  return { frames, marks, wall, truth: { cornersM: base, widthIn, heightIn }, actualM: actual };
}

const round = (v: number): number => Math.round(v * 100) / 100;

/** A UUID-shaped id from a number (the upload ids a test scene uses). */
export function uuid(n: number): string {
  const hex = n.toString(16).padStart(12, '0');
  return `00000000-0000-4000-8000-${hex}`;
}

/** Where the (true) corners land on a frame's image, for drawing a synthetic photo. */
export function projectedCorners(scene: Scene, frame: ScanFrame): ([number, number] | null)[] {
  return scene.actualM.map((p) => scanProject(p, frame.cameraTransform, frame.intrinsics));
}
