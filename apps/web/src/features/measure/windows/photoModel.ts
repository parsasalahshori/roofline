import {
  DEFAULT_FOCAL_35MM,
  focalPxFrom35mm,
  sizeFromKnownSide,
  sizeFromReference,
  WINDOW_PHOTO_REFERENCES,
  windowSizeClass,
  type PhotoWindow,
  type PhotoWindowInput,
  type Quad,
  type WindowPhotoUpload,
} from '@roofline/shared';

/** The window's corners to start from: the photo inset 15% on every side (TL, TR, BR, BL, photo pixels). */
export function seedWindowQuad(w: number, h: number): Quad {
  const x0 = w * 0.15;
  const x1 = w * 0.85;
  const y0 = h * 0.15;
  const y1 = h * 0.85;
  return [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ];
}

/** The paper's corners to start from: a small upright sheet in the middle of the photo, in the paper's proportions. */
export function seedPaperQuad(w: number, h: number, aspect = 8.5 / 11): Quad {
  const ph = Math.min(h * 0.18, (w * 0.18) / aspect);
  const pw = ph * aspect;
  const cx = w / 2;
  const cy = h / 2;
  return [
    [cx - pw / 2, cy - ph / 2],
    [cx + pw / 2, cy - ph / 2],
    [cx + pw / 2, cy + ph / 2],
    [cx - pw / 2, cy + ph / 2],
  ];
}

const round1 = (v: number) => Math.round(v * 10) / 10;

/**
 * The window's size worked out here, with the same math the server uses: from the paper on the glass, or from its own
 * corners and the side measured by hand. Null when the corners (or the typed side) cannot give a size.
 */
export function sizePhotoWindow(input: Pick<PhotoWindowInput, 'corners' | 'scale'>, upload: Pick<WindowPhotoUpload, 'widthPx' | 'heightPx' | 'focal35mm'>): { widthIn: number; heightIn: number } | null {
  const s = input.scale;
  let size: { widthIn: number; heightIn: number } | null;
  if (s.kind === 'reference') {
    const ref = WINDOW_PHOTO_REFERENCES[s.reference];
    size = sizeFromReference(input.corners, s.corners, ref.widthIn, ref.heightIn);
  } else {
    if (!(s.inches > 0)) return null;
    const focalPx = focalPxFrom35mm(upload.focal35mm ?? DEFAULT_FOCAL_35MM, upload.widthPx, upload.heightPx);
    size = sizeFromKnownSide(input.corners, upload.widthPx, upload.heightPx, s.side, s.inches, focalPx);
  }
  if (size === null || !Number.isFinite(size.widthIn) || !Number.isFinite(size.heightIn) || size.widthIn <= 0 || size.heightIn <= 0) return null;
  return { widthIn: round1(size.widthIn), heightIn: round1(size.heightIn) };
}

/**
 * The photographed windows as the screen shows them: the server's sized window when it has the same corners and
 * scale as on screen (its value wins), else the size worked out here. A window that cannot be sized yet is left out.
 */
export function livePhotoWindows(
  inputs: readonly PhotoWindowInput[],
  server: readonly PhotoWindow[] | undefined,
  uploads: readonly WindowPhotoUpload[],
): (PhotoWindow & { fromServer: boolean })[] {
  const byId = new Map((server ?? []).map((w) => [w.id, w]));
  return inputs.flatMap((input) => {
    const saved = byId.get(input.id);
    if (saved !== undefined && JSON.stringify([saved.corners, saved.scale]) === JSON.stringify([input.corners, input.scale])) {
      return [{ ...saved, label: input.label ?? saved.label, fromServer: true }] as (PhotoWindow & { fromServer: boolean })[];
    }
    const upload = uploads.find((u) => u.id === input.uploadId);
    if (upload === undefined) return [];
    const size = sizePhotoWindow(input, upload);
    if (size === null) return [];
    return [{ ...input, ...size, sizeClass: windowSizeClass(size.widthIn, size.heightIn), quality: 'good' as const, fromServer: false }];
  });
}
