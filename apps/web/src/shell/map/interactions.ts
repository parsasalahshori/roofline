import type { GeoJSONSource, MapGeoJSONFeature, MapLayerMouseEvent, Map as MapLibreMap } from 'maplibre-gl';
import { LAYER, SOURCE } from './layers.ts';
import type { PickedPin } from './types.ts';

/** How far a click on a cluster zooms in, in zoom levels, for the server's clusters. */
const SERVER_CLUSTER_ZOOM_STEP = 2;

/** The layers that show a pointer cursor: the pins and both kinds of cluster. */
const CURSOR_LAYERS: readonly string[] = [LAYER.customers, LAYER.jobs, LAYER.clusters, LAYER.customerClusters, LAYER.jobClusters];

type Binding = {
  type: 'click' | 'mouseenter' | 'mouseleave';
  layer: string;
  handler: (event: MapLayerMouseEvent) => void;
};

/** The point a feature sits on, as [lng, lat], or null when it is not a point. */
function pointOf(feature: MapGeoJSONFeature): [number, number] | null {
  const geometry = feature.geometry;
  if (geometry.type !== 'Point') return null;
  return [geometry.coordinates[0], geometry.coordinates[1]];
}

/** The pin under a click, read from its feature; null when the feature is not a usable pin. */
function pickedPin(event: MapLayerMouseEvent): PickedPin | null {
  const feature = event.features?.[0];
  if (!feature) return null;
  const properties: Record<string, unknown> | null = feature.properties;
  const lngLat = pointOf(feature);
  if (!properties || !lngLat) return null;

  return {
    kind: properties.kind === 'job' ? 'job' : 'customer',
    id: String(properties.id),
    name: String(properties.name ?? ''),
    addressLine: String(properties.addressLine ?? ''),
    stage: typeof properties.stage === 'string' ? properties.stage : null,
    stageLabel: typeof properties.stageLabel === 'string' ? properties.stageLabel : null,
    lngLat,
  };
}

/** A click on a server cluster zooms in two levels, centred on it. */
function zoomIntoServerCluster(map: MapLibreMap, event: MapLayerMouseEvent): void {
  const feature = event.features?.[0];
  if (!feature) return;
  const center = pointOf(feature);
  if (!center) return;
  map.easeTo({ center, zoom: map.getZoom() + SERVER_CLUSTER_ZOOM_STEP });
}

/**
 * A click on a browser cluster zooms to the level where that cluster splits apart. A failed lookup
 * leaves the map where it is.
 */
function zoomIntoClientCluster(map: MapLibreMap, event: MapLayerMouseEvent, sourceId: string): void {
  const feature = event.features?.[0];
  if (!feature) return;
  const properties: Record<string, unknown> | null = feature.properties;
  const clusterId = properties?.cluster_id;
  if (typeof clusterId !== 'number') return;
  const center = pointOf(feature);
  if (!center) return;
  const source = map.getSource<GeoJSONSource>(sourceId);
  if (!source) return;

  source
    .getClusterExpansionZoom(clusterId)
    .then((zoom) => {
      map.easeTo({ center, zoom });
    })
    .catch(() => undefined);
}

function setCursor(map: MapLibreMap, cursor: string): void {
  map.getCanvas().style.cursor = cursor;
}

/**
 * Wires clicks and pointer cursors on the pin and cluster layers. Returns a function that removes
 * every listener it added.
 */
export function bindMapInteractions(map: MapLibreMap, onPick: (pin: PickedPin) => void): () => void {
  const bindings: Binding[] = [
    {
      type: 'click',
      layer: LAYER.customers,
      handler: (event) => {
        const pin = pickedPin(event);
        if (pin) onPick(pin);
      },
    },
    {
      type: 'click',
      layer: LAYER.jobs,
      handler: (event) => {
        const pin = pickedPin(event);
        if (pin) onPick(pin);
      },
    },
    {
      type: 'click',
      layer: LAYER.clusters,
      handler: (event) => {
        zoomIntoServerCluster(map, event);
      },
    },
    {
      type: 'click',
      layer: LAYER.customerClusters,
      handler: (event) => {
        zoomIntoClientCluster(map, event, SOURCE.customers);
      },
    },
    {
      type: 'click',
      layer: LAYER.jobClusters,
      handler: (event) => {
        zoomIntoClientCluster(map, event, SOURCE.jobs);
      },
    },
  ];

  for (const layer of CURSOR_LAYERS) {
    bindings.push({
      type: 'mouseenter',
      layer,
      handler: () => {
        setCursor(map, 'pointer');
      },
    });
    bindings.push({
      type: 'mouseleave',
      layer,
      handler: () => {
        setCursor(map, '');
      },
    });
  }

  for (const binding of bindings) {
    map.on(binding.type, binding.layer, binding.handler);
  }

  return () => {
    for (const binding of bindings) {
      map.off(binding.type, binding.layer, binding.handler);
    }
  };
}
