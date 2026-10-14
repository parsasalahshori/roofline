import type { Map as MapLibreMap } from 'maplibre-gl';
import type { MeasurementView } from '../types.ts';
import { usesGoogleImagery } from './googleTiles.ts';

/*
 * Google's true-ortho photo under a roof measured in 3D: the Data Layers photo the height map came from, so the
 * measured outline, faces and lines sit exactly on it (the map's own satellite tiles are another capture, leaning
 * and shifted). It covers the roof and a margin; the map's photos stay round it. Shown only over Google's own map
 * tiles (the Solar API terms ask for Solar results on a Google map).
 */

export const ROOF_PHOTO_SOURCE = 'roof-photo-src';
export const ROOF_PHOTO_LAYER = 'roof-photo';

export type RoofPhoto = NonNullable<MeasurementView['roofPhoto']>;

/** The photo to show for this measurement, or null (none, or not over Google's tiles). */
export function roofPhotoFor(m: MeasurementView, googleTiles: boolean = usesGoogleImagery()): RoofPhoto | null {
  const photo = m.roofPhoto ?? null;
  return photo !== null && googleTiles && photo.corners.length === 4 ? photo : null;
}

/** Adds the photo above the map's photos (call before the roof's own layers, so they draw on top). */
export function addRoofPhoto(instance: MapLibreMap, photo: RoofPhoto | null): boolean {
  if (photo === null) return false;
  try {
    instance.addSource(ROOF_PHOTO_SOURCE, { type: 'image', url: photo.url, coordinates: photo.corners });
    instance.addLayer({ id: ROOF_PHOTO_LAYER, type: 'raster', source: ROOF_PHOTO_SOURCE, paint: { 'raster-fade-duration': 0 } });
    return true;
  } catch {
    // The map may be going away; the map's own photo still shows.
    return false;
  }
}
