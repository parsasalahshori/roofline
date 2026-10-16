// A window photo made ready to upload, in the browser, before it is sent:
// - JPEG or PNG up to 12 MB: sent as it is (its EXIF goes with it).
// - Bigger (50-200 MP phones): drawn smaller (long side 4032 px) and saved as JPEG. The camera's focal length and
//   capture time are copied into a fresh EXIF block, so the measuring sheet's sizes and their ± stay right (the server
//   reads the focal length from the photo; a 35 mm-equivalent focal length does not change when the photo is scaled).
// - HEIC (iPhone "High Efficiency", Samsung "High efficiency pictures"): converted to JPEG where the browser can open
//   it (Safari can, with the same EXIF copy); refused with what to change on the phone where it cannot (Chrome).
// The server has no HEIC decoder (sharp's prebuilt libvips reads AVIF but not HEIC's HEVC), so this is the only place
// a HEIC can become a JPEG.

/** What the upload takes (the server refuses more). */
export const PHOTO_MAX_BYTES = 12 * 1024 * 1024;
/** Long side of a photo drawn smaller (a 12 MP phone photo's own size; the measuring engine reads 4096 at most). */
export const PHOTO_MAX_SIDE = 4032;

export type PhotoKind = 'jpeg' | 'png' | 'heic';
export type PhotoExif = { orientation: number | null; focal35mm: number | null; takenAt: string | null };

/** What the first bytes say the file is. */
export function sniffPhoto(b: Uint8Array): PhotoKind | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((v, i) => b[i] === v)) return 'png';
  if (b.length >= 12 && String.fromCharCode(b[4]!, b[5]!, b[6]!, b[7]!) === 'ftyp') {
    const brand = String.fromCharCode(b[8]!, b[9]!, b[10]!, b[11]!);
    if (['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1', 'heim', 'heis'].includes(brand)) return 'heic';
  }
  return null;
}

/** The kind from the file's type or name, when its bytes do not say (a test file, an odd camera app). */
function declaredKind(file: Pick<File, 'type' | 'name'>): PhotoKind | null {
  const t = file.type.toLowerCase();
  if (t === 'image/jpeg' || t === 'image/jpg') return 'jpeg';
  if (t === 'image/png') return 'png';
  if (t === 'image/heic' || t === 'image/heif' || /\.(heic|heif)$/i.test(file.name)) return 'heic';
  if (t === '' && /\.(jpe?g)$/i.test(file.name)) return 'jpeg';
  return null;
}

/** The EXIF the sizing uses, from a TIFF block (the bytes after "Exif\0\0"). */
export function readTiffExif(t: Uint8Array): PhotoExif {
  const out: PhotoExif = { orientation: null, focal35mm: null, takenAt: null };
  if (t.length < 8) return out;
  const le = t[0] === 0x49 && t[1] === 0x49;
  if (!le && !(t[0] === 0x4d && t[1] === 0x4d)) return out;
  const v = new DataView(t.buffer, t.byteOffset, t.byteLength);
  const u16 = (o: number) => (o + 2 <= t.length ? v.getUint16(o, le) : 0);
  const u32 = (o: number) => (o + 4 <= t.length ? v.getUint32(o, le) : 0);
  const entries = (ifd: number, each: (tag: number, type: number, count: number, at: number) => void) => {
    if (ifd <= 0 || ifd + 2 > t.length) return;
    const n = Math.min(u16(ifd), 500);
    for (let i = 0; i < n; i++) {
      const e = ifd + 2 + 12 * i;
      if (e + 12 > t.length) return;
      each(u16(e), u16(e + 2), u32(e + 4), e + 8);
    }
  };
  let exifIfd = 0;
  entries(u32(4), (tag, type, _count, at) => {
    if (tag === 0x0112 && type === 3) out.orientation = u16(at);
    if (tag === 0x8769) exifIfd = u32(at);
  });
  entries(exifIfd, (tag, type, count, at) => {
    if (tag === 0xa405 && type === 3) {
      const f = u16(at);
      if (f >= 8 && f <= 600) out.focal35mm = f;
    }
    if (tag === 0x9003 && type === 2 && count >= 19) {
      const off = count > 4 ? u32(at) : at;
      if (off + 19 <= t.length) out.takenAt = String.fromCharCode(...t.subarray(off, off + 19));
    }
  });
  if (out.orientation !== null && !(out.orientation >= 1 && out.orientation <= 8)) out.orientation = null;
  return out;
}

/** A JPEG's EXIF (its APP1 "Exif" segment), or null without one. */
export function readJpegExif(b: Uint8Array): PhotoExif | null {
  let i = 2;
  while (i + 4 <= b.length && b[i] === 0xff) {
    const marker = b[i + 1]!;
    if (marker === 0xda || marker === 0xd9) return null;
    const len = (b[i + 2]! << 8) | b[i + 3]!;
    if (marker === 0xe1 && len >= 8 && String.fromCharCode(b[i + 4]!, b[i + 5]!, b[i + 6]!, b[i + 7]!) === 'Exif') return readTiffExif(b.subarray(i + 10, i + 2 + len));
    if (len < 2) return null;
    i += 2 + len;
  }
  return null;
}

/** Where a HEIC keeps its EXIF item (ISO-BMFF meta box: iinf names it "Exif", iloc says where it is). */
export function heicExifLocation(b: Uint8Array): { offset: number; length: number } | null {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const box = (at: number, end: number): { type: string; start: number; end: number } | null => {
    if (at + 8 > end) return null;
    let size = v.getUint32(at);
    let head = 8;
    if (size === 1) {
      if (at + 16 > end) return null;
      size = Number(v.getBigUint64(at + 8));
      head = 16;
    } else if (size === 0) size = end - at;
    if (size < head || at + size > end) return null;
    return { type: String.fromCharCode(b[at + 4]!, b[at + 5]!, b[at + 6]!, b[at + 7]!), start: at + head, end: at + size };
  };
  const children = (start: number, end: number) => {
    const out: { type: string; start: number; end: number }[] = [];
    for (let at = start; at < end; ) {
      const x = box(at, end);
      if (x === null) break;
      out.push(x);
      at = x.end;
    }
    return out;
  };
  const meta = children(0, b.length).find((x) => x.type === 'meta');
  if (meta === undefined) return null;
  const inMeta = children(meta.start + 4, meta.end);
  const iinf = inMeta.find((x) => x.type === 'iinf');
  const iloc = inMeta.find((x) => x.type === 'iloc');
  if (iinf === undefined || iloc === undefined) return null;
  // The Exif item's id.
  const iinfVersion = b[iinf.start]!;
  const infeAt = iinf.start + 4 + (iinfVersion === 0 ? 2 : 4);
  let exifId: number | null = null;
  for (const infe of children(infeAt, iinf.end)) {
    if (infe.type !== 'infe') continue;
    const ver = b[infe.start]!;
    if (ver < 2) continue;
    const idAt = infe.start + 4;
    const id = ver === 2 ? v.getUint16(idAt) : v.getUint32(idAt);
    const typeAt = idAt + (ver === 2 ? 2 : 4) + 2;
    if (String.fromCharCode(b[typeAt]!, b[typeAt + 1]!, b[typeAt + 2]!, b[typeAt + 3]!) === 'Exif') exifId = id;
  }
  if (exifId === null) return null;
  // Its extent in iloc.
  const ver = b[iloc.start]!;
  let p = iloc.start + 4;
  const offSize = b[p]! >> 4;
  const lenSize = b[p]! & 15;
  const baseSize = b[p + 1]! >> 4;
  const idxSize = ver === 1 || ver === 2 ? b[p + 1]! & 15 : 0;
  p += 2;
  const read = (n: number) => {
    let x = 0;
    for (let k = 0; k < n; k++) x = x * 256 + b[p + k]!;
    p += n;
    return x;
  };
  const count = ver < 2 ? read(2) : read(4);
  for (let i = 0; i < count && p < iloc.end; i++) {
    const id = ver < 2 ? read(2) : read(4);
    if (ver === 1 || ver === 2) read(2); // construction method
    read(2); // data reference index
    const base = read(baseSize);
    const extents = read(2);
    let first: { offset: number; length: number } | null = null;
    for (let e = 0; e < extents; e++) {
      if (idxSize > 0) read(idxSize);
      const offset = read(offSize);
      const length = read(lenSize);
      if (first === null) first = { offset: base + offset, length };
    }
    if (id === exifId && first !== null) return first;
  }
  return null;
}

/** A HEIC Exif item's payload (4-byte offset to the TIFF header, then the TIFF) as EXIF. */
export function readHeicExifItem(item: Uint8Array): PhotoExif | null {
  if (item.length < 12) return null;
  const skip = new DataView(item.buffer, item.byteOffset, item.byteLength).getUint32(0);
  return 4 + skip < item.length ? readTiffExif(item.subarray(4 + skip)) : null;
}

/** "2026:10:15 12:34:56" kept as EXIF writes it (19 characters), else null. */
const exifDate = (s: string | null) => (s !== null && /^\d{4}:\d{2}:\d{2} \d{2}:\d{2}:\d{2}$/.test(s) ? s : null);

/** An APP1 EXIF segment for a JPEG the browser drew upright: Orientation 1, the focal length, the capture time. */
export function exifApp1(e: Pick<PhotoExif, 'focal35mm' | 'takenAt'>): Uint8Array {
  const date = exifDate(e.takenAt);
  const exifTags: [number, number, number, number | number[]][] = [];
  if (e.focal35mm !== null) exifTags.push([0xa405, 3, 1, Math.round(e.focal35mm)]);
  if (date !== null) exifTags.push([0x9003, 2, 20, [...date].map((c) => c.charCodeAt(0)).concat(0)]);
  // Big-endian TIFF: header (8) | IFD0: Orientation, ExifIFD pointer | Exif IFD | data
  const ifd0Size = 2 + 2 * 12 + 4;
  const exifAt = 8 + ifd0Size;
  const exifSize = 2 + exifTags.length * 12 + 4;
  let dataAt = exifAt + exifSize;
  const tiff: number[] = [0x4d, 0x4d, 0, 42, 0, 0, 0, 8];
  const u16 = (n: number) => [(n >> 8) & 255, n & 255];
  const u32 = (n: number) => [(n >>> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255];
  tiff.push(...u16(2), ...u16(0x0112), ...u16(3), ...u32(1), ...u16(1), 0, 0, ...u16(0x8769), ...u16(4), ...u32(1), ...u32(exifAt), ...u32(0));
  const data: number[] = [];
  tiff.push(...u16(exifTags.length));
  for (const [tag, type, count, value] of exifTags) {
    tiff.push(...u16(tag), ...u16(type), ...u32(count));
    if (Array.isArray(value)) {
      tiff.push(...u32(dataAt));
      data.push(...value);
      dataAt += value.length;
    } else tiff.push(...u16(value), 0, 0);
  }
  tiff.push(...u32(0), ...data);
  const body = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
  return new Uint8Array([0xff, 0xe1, ...u16(body.length + 2), ...body]);
}

/** A JPEG with `app1` put in after its SOI (and after a JFIF APP0, if the encoder wrote one). */
export function withExif(jpeg: Uint8Array, app1: Uint8Array): Uint8Array {
  let at = 2;
  if (jpeg[2] === 0xff && jpeg[3] === 0xe0) at = 4 + ((jpeg[4]! << 8) | jpeg[5]!);
  const out = new Uint8Array(jpeg.length + app1.length);
  out.set(jpeg.subarray(0, at), 0);
  out.set(app1, at);
  out.set(jpeg.subarray(at), at + app1.length);
  return out;
}

/** The browser's image decoder and canvas, behind a seam (tests and the iPhone app's web view differ). */
export type PhotoCodec = {
  /** The photo drawn upright with its long side at most `maxSide`, as JPEG at `quality`; null when the browser cannot open it. */
  toJpeg(file: Blob, maxSide: number, quality: number): Promise<Uint8Array | null>;
};

async function bytesOf(blob: Blob, start = 0, end = blob.size): Promise<Uint8Array> {
  const part = blob.slice(start, end);
  if (typeof part.arrayBuffer === 'function') return new Uint8Array(await part.arrayBuffer());
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(new Uint8Array(r.result as ArrayBuffer));
    r.onerror = () => reject(r.error ?? new Error('read'));
    r.readAsArrayBuffer(part);
  });
}

/** Decodes with createImageBitmap (EXIF orientation applied), else an <img>; draws on a canvas; encodes JPEG. */
export const browserCodec: PhotoCodec = {
  async toJpeg(file, maxSide, quality) {
    if (typeof document === 'undefined') return null;
    let source: ImageBitmap | HTMLImageElement | null = null;
    let url: string | null = null;
    try {
      if (typeof createImageBitmap === 'function') {
        try {
          source = await createImageBitmap(file, { imageOrientation: 'from-image' });
        } catch {
          source = null;
        }
      }
      if (source === null) {
        url = URL.createObjectURL(file);
        const img = new Image();
        img.src = url;
        await img.decode();
        source = img;
      }
      const w = source instanceof HTMLImageElement ? source.naturalWidth : source.width;
      const h = source instanceof HTMLImageElement ? source.naturalHeight : source.height;
      if (!(w > 0 && h > 0)) return null;
      const k = Math.min(1, maxSide / Math.max(w, h));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(w * k));
      canvas.height = Math.max(1, Math.round(h * k));
      const ctx = canvas.getContext('2d');
      if (ctx === null) return null;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
      // Frees the canvas's memory at once (Safari keeps it otherwise).
      canvas.width = 0;
      canvas.height = 0;
      return blob === null ? null : await bytesOf(blob);
    } catch {
      return null;
    } finally {
      if (source !== null && !(source instanceof HTMLImageElement)) source.close();
      if (url !== null) URL.revokeObjectURL(url);
    }
  },
};

export type Prepared =
  | { ok: true; file: File; converted: 'none' | 'smaller' | 'heic' }
  | { ok: false; reason: 'type' | 'heic' | 'too-big' };

/** The photo as it will be uploaded, or why it cannot be. */
export async function preparePhoto(file: File, codec: PhotoCodec = browserCodec): Promise<Prepared> {
  const head = await bytesOf(file, 0, Math.min(file.size, 256 * 1024)).catch(() => new Uint8Array(0));
  const kind = sniffPhoto(head) ?? declaredKind(file);
  if (kind === null) return { ok: false, reason: 'type' };
  if (kind !== 'heic' && file.size <= PHOTO_MAX_BYTES) return { ok: true, file, converted: 'none' };
  // The camera data to carry over.
  let exif: PhotoExif | null = null;
  if (kind === 'jpeg') exif = readJpegExif(head);
  else if (kind === 'heic') {
    const at = heicExifLocation(head);
    if (at !== null && at.length < 1024 * 1024 && at.offset + at.length <= file.size) exif = readHeicExifItem(await bytesOf(file, at.offset, at.offset + at.length).catch(() => new Uint8Array(0)));
  }
  for (const [side, quality] of [
    [PHOTO_MAX_SIDE, 0.92],
    [PHOTO_MAX_SIDE, 0.82],
    [3024, 0.82],
  ] as const) {
    const jpeg = await codec.toJpeg(file, side, quality);
    // A JPEG or PNG the browser cannot draw this big (memory) is "too big"; a HEIC it cannot open at all is "heic"
    if (jpeg === null) return { ok: false, reason: kind === 'heic' ? 'heic' : 'too-big' };
    const out = exif !== null && (exif.focal35mm !== null || exif.takenAt !== null) ? withExif(jpeg, exifApp1(exif)) : jpeg;
    if (out.length > PHOTO_MAX_BYTES) continue;
    const name = file.name.replace(/\.(heic|heif|png|jpe?g)$/i, '') + '.jpg';
    return { ok: true, file: new File([out as BlobPart], name, { type: 'image/jpeg', lastModified: file.lastModified }), converted: kind === 'heic' ? 'heic' : 'smaller' };
  }
  return { ok: false, reason: 'too-big' };
}
