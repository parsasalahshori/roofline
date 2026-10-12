import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { apiFetch } from '../../api/client.ts';
import { keys } from '../../api/keys.ts';
import type { Bbox } from '../../api/types.ts';
import type { StormLayerResponse } from './layerTypes.ts';

/** How many days of storms the map layer shows. */
export const STORM_LAYER_DAYS = 7;

/**
 * The hail swaths and spotter reports for a map view. Nothing is asked until the map has told us its
 * box and zoom, or while the layer is off. The last answer stays while the next one loads.
 */
export function useStormLayer(bbox: Bbox | null, zoom: number | null, enabled: boolean) {
  const bboxKey = bbox === null ? null : bbox.join(',');
  const roundedZoom = zoom === null ? null : Math.min(22, Math.max(0, Math.round(zoom)));
  return useQuery({
    queryKey: keys.stormLayer(bboxKey ?? '', roundedZoom ?? 0, STORM_LAYER_DAYS),
    queryFn: ({ signal }) =>
      apiFetch<StormLayerResponse>(
        `/api/map/storm-layer?bbox=${bboxKey}&zoom=${roundedZoom}&days=${STORM_LAYER_DAYS}`,
        { signal },
      ),
    enabled: enabled && bboxKey !== null && roundedZoom !== null,
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });
}
