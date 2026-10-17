/** The longest side a re-sized photo gets (a 12 megapixel phone photo is about 4000 px). */
const RESIZED_SIDE = 3200;

/**
 * The photo to send. Sent as it came (the camera's JPEG, with its EXIF: the server reads the lens from it) unless it is
 * over the server's size limit; then it is drawn smaller (upright) and sent as a new JPEG. Null when it cannot be read.
 */
export async function preparePhoto(file: File, maxBytes: number): Promise<Blob | null> {
  if (file.size <= maxBytes) return file;
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const scale = Math.min(1, RESIZED_SIDE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const ctx = canvas.getContext('2d');
    if (ctx === null) return null;
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.88));
    return blob !== null && blob.size <= maxBytes ? blob : null;
  } catch {
    return null;
  }
}
