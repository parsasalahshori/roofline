import type { GeoJSONSource, MapGeoJSONFeature, MapLayerMouseEvent, MapMouseEvent, Map as MapLibreMap } from 'maplibre-gl';
import { LAYER, SOURCE } from './layers.ts';
import type { PickedPin } from './types.ts';

/** How far a click on a cluster zooms in, in zoom levels, for the server's clusters. */
const SERVER_CLUSTER_ZOOM_STEP = 2;

/** The single-pin hit layers: a click on either opens the nearest pin under it. */
const PIN_HIT_LAYERS: readonly string[] = [LAYER.customersHit, LAYER.jobsHit];

/** The layers that show a pointer cursor: the pin hit layers and both kinds of cluster. */
const CURSOR_LAYERS: readonly string[] = [
  LAYER.customersHit,
  LAYER.jobsHit,
  LAYER.clusters,
  LAYER.customerClusters,
  LAYER.jobClusters,
];

/** A listener bound to one layer (cursor and cluster events). */
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

/**
 * The pin a feature stands for, read from its properties; null when the feature is not a usable pin.
 */
function pickedPin(feature: MapGeoJSONFeature): PickedPin | null {
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

/**
 * The feature whose point projects nearest the click, in screen pixels. Features that are not points
 * are skipped; the first one wins a tie. Undefined when no point is in the list.
 */
export function nearestFeature(
  features: readonly MapGeoJSONFeature[],
  point: { x: number; y: number },
  project: (lngLat: [number, number]) => { x: number; y: number },
): MapGeoJSONFeature | undefined {
  let best: MapGeoJSONFeature | undefined;
  let bestDistance = Infinity;
  for (const feature of features) {
    const lngLat = pointOf(feature);
    if (!lngLat) continue;
    const at = project(lngLat);
    const distance = (at.x - point.x) ** 2 + (at.y - point.y) ** 2;
    if (distance < bestDistance) {
      best = feature;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * A click anywhere on the map opens the nearest single pin under it. The hit layers overlap, so one
 * click can reach a customer and a job; this reads both and calls `onPick` once, for the nearer.
 */
function pinClickHandler(map: MapLibreMap, onPick: (pin: PickedPin) => void): (event: MapMouseEvent) => void {
  return (event) => {
    const layers = PIN_HIT_LAYERS.filter((id) => map.getLayer(id));
    if (layers.length === 0) return;
    const features = map.queryRenderedFeatures(event.point, { layers });
    const feature = nearestFeature(features, event.point, (lngLat) => map.project(lngLat));
    if (!feature) return;
    const pin = pickedPin(feature);
    if (pin) onPick(pin);
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
 * Wires clicks and pointer cursors on the pin hit layers and the cluster layers. The pin click is one
 * listener on the map (not on a layer), which reads the hit layers and picks the nearest pin. Returns a
 * function that removes every listener it added.
 */
export function bindMapInteractions(map: MapLibreMap, onPick: (pin: PickedPin) => void): () => void {
  const onPinClick = pinClickHandler(map, onPick);
  const bindings: Binding[] = [
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
  map.on('click', onPinClick);

  return () => {
    for (const binding of bindings) {
      map.off(binding.type, binding.layer, binding.handler);
    }
    map.off('click', onPinClick);
  };
}
