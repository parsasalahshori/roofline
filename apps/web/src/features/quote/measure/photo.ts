import { preparePhoto as prepare } from '../../measure/windows/preparePhoto.ts';

export type CardPhoto = { ok: true; blob: Blob } | { ok: false; reason: 'type' | 'heic' | 'too-big' };

/**
 * The card photo to send: the measuring page's own preparation (windows/preparePhoto.ts). A JPEG or PNG under the limit
 * goes as the camera made it, EXIF and all; a bigger one is drawn smaller with the camera's focal length copied into the
 * new file (the server reads the lens from it, and the sizes depend on it); a HEIC is turned into a JPEG where the browser
 * can open it, and refused where it cannot. `maxBytes` is the company's limit: a result over it is "too big".
 */
export async function preparePhoto(file: File, maxBytes: number): Promise<CardPhoto> {
  const p = await prepare(file);
  if (!p.ok) return p;
  return p.file.size <= maxBytes ? { ok: true, blob: p.file } : { ok: false, reason: 'too-big' };
}
