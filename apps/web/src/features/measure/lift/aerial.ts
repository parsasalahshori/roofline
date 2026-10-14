import type { StyleSpecification } from 'maplibre-gl';
import { useEffect, useState } from 'react';
import { mapStyle } from '../../../shell/map/mapStyle.ts';
import type { MapEnv } from '../../../shell/map/types.ts';
import { googleSatelliteStyle } from './googleTiles.ts';

const IMAGERY_IDENTIFY = 'https://services.arcgisonline.com/arcgis/rest/services/World_Imagery/MapServer/identify';

/**
 * Measure always shows a photo: the shared map style in satellite mode, asked for the free aerial photos when the
 * build names no imagery (a MapTiler key still wins and gives its hybrid style).
 */
export function measureStyle(env: MapEnv): StyleSpecification | string {
  // Google's photos are the sharpest we have; they win whenever a Google key and a tile session are ready.
  const google = googleSatelliteStyle();
  if (google !== null) return google;
  return mapStyle({ ...env, imagery: 'aerial' }, 'satellite');
}

/** True when the free aerial is drawn (no key), so its capture date can be looked up. */
export function usesFreeAerial(env: MapEnv): boolean {
  return (env.maptilerKey ?? '').trim() === '';
}

/** Reads "3/13/2025" or "20250313" into a date; anything else is no date. */
export function parseCaptureDate(raw: unknown): Date | null {
  if (typeof raw !== 'string') return null;
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(raw.trim());
  if (us) return new Date(Number(us[3]), Number(us[1]) - 1, Number(us[2]));
  const ymd = /^(\d{4})(\d{2})(\d{2})$/.exec(raw.trim());
  if (ymd) return new Date(Number(ymd[1]), Number(ymd[2]) - 1, Number(ymd[3]));
  return null;
}

type IdentifyAnswer = { results?: { attributes?: Record<string, unknown> }[] };

/**
 * When the aerial photo under this point was taken, from the imagery service's own record of its sources; null
 * until known, or when the service has no date for it (the chip then leaves the date out).
 */
export function useImageryDate(lng: number, lat: number, enabled: boolean): Date | null {
  const [date, setDate] = useState<Date | null>(null);
  useEffect(() => {
    if (!enabled || typeof fetch !== 'function') return;
    const controller = new AbortController();
    const d = 0.002;
    const query = new URLSearchParams({
      geometry: `${lng},${lat}`,
      geometryType: 'esriGeometryPoint',
      sr: '4326',
      layers: 'all',
      tolerance: '1',
      mapExtent: `${lng - d},${lat - d},${lng + d},${lat + d}`,
      imageDisplay: '400,400,96',
      returnGeometry: 'false',
      f: 'json',
    });
    fetch(`${IMAGERY_IDENTIFY}?${query.toString()}`, { signal: controller.signal })
      .then((res) => (res.ok ? (res.json() as Promise<IdentifyAnswer>) : null))
      .then((answer) => {
        const found = (answer?.results ?? [])
          .map((r) => parseCaptureDate(r.attributes?.SRC_DATE2) ?? parseCaptureDate(r.attributes?.['DATE (YYYYMMDD)']))
          .find((when): when is Date => when !== null);
        if (found) setDate(found);
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [lng, lat, enabled]);
  return date;
}
