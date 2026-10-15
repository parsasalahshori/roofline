import { writeArrayBuffer } from 'geotiff';

/** GeoTIFFs the way Google sends them (float32 heights, byte mask, 3-band photo) on a UTM grid, for tests. */

export const ORIGIN = [563000, 3845900] as const;

type Grid = { width: number; height: number; pixelM?: number; epsg?: number; origin?: readonly [number, number] };

function geo(g: Grid): Record<string, unknown> {
  const px = g.pixelM ?? 0.1;
  const [x, y] = g.origin ?? ORIGIN;
  return { width: g.width, height: g.height, ModelPixelScale: [px, px, 0], ModelTiepoint: [0, 0, 0, x, y, 0], ProjectedCSTypeGeoKey: g.epsg ?? 32615, GTModelTypeGeoKey: 1, GTRasterTypeGeoKey: 1 };
}

export function heightTiff(g: Grid, at: (i: number) => number): ArrayBuffer {
  const data = new Float32Array(g.width * g.height).map((_, i) => at(i));
  return writeArrayBuffer(data, { ...geo(g), BitsPerSample: [32], SampleFormat: [3], GDAL_NODATA: '-9999' } as Parameters<typeof writeArrayBuffer>[1]);
}

export function maskTiff(g: Grid, at: (i: number) => number): ArrayBuffer {
  const data = new Uint8Array(g.width * g.height).map((_, i) => at(i));
  return writeArrayBuffer(data, geo(g) as Parameters<typeof writeArrayBuffer>[1]);
}

export function rgbTiff(g: Grid): ArrayBuffer {
  const data = new Uint8Array(g.width * g.height * 3).fill(120);
  return writeArrayBuffer(data, { ...geo(g), SamplesPerPixel: 3, BitsPerSample: [8, 8, 8], PhotometricInterpretation: 2 } as Parameters<typeof writeArrayBuffer>[1]);
}

/** Seeded random numbers (Park-Miller), so fuzzing is the same every run. */
export function rng(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}
