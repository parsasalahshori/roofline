import { tokens } from '@roofline/ui';
import type { Feature, FeatureCollection, MultiPolygon } from 'geojson';
import type { GeoJSONSource, LayerSpecification, Map as MapLibreMap, SourceSpecification } from 'maplibre-gl';
import { hailFillExpression } from './stormLayer.ts';

/*
 * The map's sources and layers. Two groups are added in order: BASE (the storm swath, the service area
 * and the server clusters) and PINS (customers and jobs, clustered in the browser when there are many).
 * Each single-pin group has a transparent 40px hit layer right after its visible 7px pin, so a tap on a
 * phone finds the pin; clicks read the hit layers, not the visible pins.
 * The storm swath source is filled later by Storm Scout and is only ever reset by a style swap.
 */

/** The ids of the GeoJSON sources this app adds to the map. */
export const SOURCE = {
  serviceArea: 'service-area',
  customers: 'customers',
  jobs: 'jobs',
  clusters: 'clusters',
  stormSwath: 'storm-swath',
  stormSpots: 'storm-spots',
} as const;

/** The ids of the layers this app adds. Count labels (only when the style has glyphs) are `<cluster layer id>-count`. */
export const LAYER = {
  stormSwathFill: 'storm-swath-fill',
  stormSwathOutline: 'storm-swath-outline',
  /** Spotter-report circles (source `storm-spots`); no hit layer. */
  stormSpots: 'storm-spots',
  serviceArea: 'service-area',
  /** Server clusters (source `clusters`). */
  clusters: 'clusters',
  /** Client clusters of the `customers` source. */
  customerClusters: 'customers-clusters',
  /** Client clusters of the `jobs` source. */
  jobClusters: 'jobs-clusters',
  /** Single customer pins (source `customers`). */
  customers: 'customers',
  /** Transparent 40px hit layer over the single customer pins; added right after `customers`. */
  customersHit: 'customers-hit',
  /** Single job pins (source `jobs`). */
  jobs: 'jobs',
  /** Transparent 40px hit layer over the single job pins; added right after `jobs`. */
  jobsHit: 'jobs-hit',
} as const;

/** Opacity of the hail swath fill. */
export const HAIL_FILL_OPACITY = 0.7;

/** Everything the layers draw. */
export type MapData = {
  serviceArea: MultiPolygon | null;
  customers: FeatureCollection;
  jobs: FeatureCollection;
  clusters: FeatureCollection;
  /** True: the `customers` and `jobs` sources cluster in the browser. */
  clustering: boolean;
};

/** The count labels, present only when the style has glyphs. */
const COUNT_LAYER = {
  clusters: 'clusters-count',
  customerClusters: 'customers-clusters-count',
  jobClusters: 'jobs-clusters-count',
} as const;

/** Client clusters merge the points of a source that sit this many pixels apart. */
const CLIENT_CLUSTER_RADIUS = 40;

/** Every layer this module can add, so that removal leaves none behind. */
const LAYER_IDS: readonly string[] = [
  LAYER.stormSwathFill,
  LAYER.stormSwathOutline,
  LAYER.stormSpots,
  LAYER.serviceArea,
  LAYER.clusters,
  COUNT_LAYER.clusters,
  LAYER.customerClusters,
  LAYER.jobClusters,
  LAYER.customers,
  LAYER.customersHit,
  LAYER.jobs,
  LAYER.jobsHit,
  COUNT_LAYER.customerClusters,
  COUNT_LAYER.jobClusters,
];

/** Every source this module can add. */
const SOURCE_IDS: readonly string[] = [
  SOURCE.stormSwath,
  SOURCE.stormSpots,
  SOURCE.serviceArea,
  SOURCE.clusters,
  SOURCE.customers,
  SOURCE.jobs,
];

/** The clustering flag that each map's customers and jobs sources were built with. */
const installedClustering = new WeakMap<object, boolean>();

function empty(): FeatureCollection {
  return { type: 'FeatureCollection', features: [] };
}

function serviceAreaCollection(area: MultiPolygon | null): FeatureCollection {
  if (area === null) return empty();
  const feature: Feature = { type: 'Feature', geometry: area, properties: {} };
  return { type: 'FeatureCollection', features: [feature] };
}

/** The layer objects are written as plain literals; MapLibre's types reject array expressions, hence the cast. */
function asLayer(spec: Record<string, unknown>): LayerSpecification {
  return spec as unknown as LayerSpecification;
}

/** The colour of a job pin, by its stage. Anything unknown takes the lead blue. */
function stageColor(): unknown[] {
  return [
    'match',
    ['get', 'stage'],
    'lead',
    tokens['stage-lead'],
    'inspection',
    tokens['stage-inspection'],
    'proposal',
    tokens['stage-proposal'],
    'won',
    tokens['stage-won'],
    'installed',
    tokens['stage-won'],
    'lost',
    tokens.text,
    tokens['stage-lead'],
  ];
}

/**
 * The transparent hit circle over a single pin: 40px across (radius 20), invisible, and with the same
 * source and filter as the pin it sits on, so a click on it reads the same feature.
 */
function hitPaint(): Record<string, unknown> {
  return {
    'circle-radius': 20,
    'circle-opacity': 0,
    'circle-stroke-opacity': 0,
    'circle-color': tokens['pin-customer'],
  };
}

/** A cluster bubble sized by the number of points it holds, read from `countKey`. */
function clusterPaint(countKey: 'count' | 'point_count'): Record<string, unknown> {
  return {
    'circle-color': tokens.accent,
    'circle-radius': ['step', ['get', countKey], 16, 10, 20, 50, 26, 200, 32],
    'circle-stroke-width': 2,
    'circle-stroke-color': tokens.text,
  };
}

/** The number printed inside a cluster bubble. Only added when the style has glyphs. */
function countLabel(id: string, source: string, textField: unknown[], clustersOnly: boolean): LayerSpecification {
  return asLayer({
    id,
    type: 'symbol',
    source,
    ...(clustersOnly ? { filter: ['has', 'point_count'] } : {}),
    layout: {
      'text-field': textField,
      'text-font': ['Noto Sans Regular'],
      'text-size': 14,
    },
    paint: { 'text-color': tokens['accent-ink'] },
  });
}

function styleHasGlyphs(map: MapLibreMap): boolean {
  return Boolean(map.getStyle()?.glyphs);
}

function addSourceOnce(map: MapLibreMap, id: string, spec: SourceSpecification): void {
  if (!map.getSource(id)) map.addSource(id, spec);
}

function addLayerOnce(map: MapLibreMap, spec: LayerSpecification): void {
  if (!map.getLayer(spec.id)) map.addLayer(spec);
}

function addBaseGroup(map: MapLibreMap, data: MapData, hasGlyphs: boolean): void {
  addSourceOnce(map, SOURCE.stormSwath, { type: 'geojson', data: empty() });
  addLayerOnce(
    map,
    asLayer({
      id: LAYER.stormSwathFill,
      type: 'fill',
      source: SOURCE.stormSwath,
      paint: { 'fill-color': hailFillExpression(), 'fill-opacity': HAIL_FILL_OPACITY },
    }),
  );
  addLayerOnce(
    map,
    asLayer({
      id: LAYER.stormSwathOutline,
      type: 'line',
      source: SOURCE.stormSwath,
      // Not an outline: a wide, blurred line in the contour's own colour feathers the edge of each band.
      layout: { 'line-join': 'round' },
      paint: { 'line-color': hailFillExpression(), 'line-width': 22, 'line-blur': 20, 'line-opacity': 0.55 },
    }),
  );

  addSourceOnce(map, SOURCE.stormSpots, { type: 'geojson', data: empty() });
  addLayerOnce(
    map,
    asLayer({
      id: LAYER.stormSpots,
      type: 'circle',
      source: SOURCE.stormSpots,
      paint: {
        'circle-radius': 5,
        'circle-color': tokens['hail-5'],
        'circle-stroke-width': 2,
        'circle-stroke-color': tokens.surface,
      },
    }),
  );

  addSourceOnce(map, SOURCE.serviceArea, { type: 'geojson', data: serviceAreaCollection(data.serviceArea) });
  addLayerOnce(
    map,
    asLayer({
      id: LAYER.serviceArea,
      type: 'line',
      source: SOURCE.serviceArea,
      paint: { 'line-color': tokens.text, 'line-opacity': 0.5, 'line-width': 2 },
    }),
  );

  addSourceOnce(map, SOURCE.clusters, { type: 'geojson', data: data.clusters });
  addLayerOnce(
    map,
    asLayer({
      id: LAYER.clusters,
      type: 'circle',
      source: SOURCE.clusters,
      paint: clusterPaint('count'),
    }),
  );
  if (hasGlyphs) {
    addLayerOnce(map, countLabel(COUNT_LAYER.clusters, SOURCE.clusters, ['to-string', ['get', 'count']], false));
  }
}

function addPinGroup(map: MapLibreMap, data: MapData, hasGlyphs: boolean): void {
  const clusterOptions: { cluster?: boolean; clusterRadius?: number } = data.clustering
    ? { cluster: true, clusterRadius: CLIENT_CLUSTER_RADIUS }
    : {};
  addSourceOnce(map, SOURCE.customers, { type: 'geojson', data: data.customers, ...clusterOptions });
  addSourceOnce(map, SOURCE.jobs, { type: 'geojson', data: data.jobs, ...clusterOptions });

  addLayerOnce(
    map,
    asLayer({
      id: LAYER.customerClusters,
      type: 'circle',
      source: SOURCE.customers,
      filter: ['has', 'point_count'],
      paint: clusterPaint('point_count'),
    }),
  );
  addLayerOnce(
    map,
    asLayer({
      id: LAYER.jobClusters,
      type: 'circle',
      source: SOURCE.jobs,
      filter: ['has', 'point_count'],
      paint: clusterPaint('point_count'),
    }),
  );
  addLayerOnce(
    map,
    asLayer({
      id: LAYER.customers,
      type: 'circle',
      source: SOURCE.customers,
      filter: ['!', ['has', 'point_count']],
      paint: {
        'circle-color': tokens['pin-customer'],
        'circle-radius': 7,
        'circle-stroke-width': 2,
        'circle-stroke-color': tokens.surface,
      },
    }),
  );
  addLayerOnce(
    map,
    asLayer({
      id: LAYER.customersHit,
      type: 'circle',
      source: SOURCE.customers,
      filter: ['!', ['has', 'point_count']],
      paint: hitPaint(),
    }),
  );
  addLayerOnce(
    map,
    asLayer({
      id: LAYER.jobs,
      type: 'circle',
      source: SOURCE.jobs,
      filter: ['!', ['has', 'point_count']],
      paint: {
        'circle-color': stageColor(),
        'circle-radius': 7,
        'circle-stroke-width': 2,
        'circle-stroke-color': tokens.surface,
      },
    }),
  );
  addLayerOnce(
    map,
    asLayer({
      id: LAYER.jobsHit,
      type: 'circle',
      source: SOURCE.jobs,
      filter: ['!', ['has', 'point_count']],
      paint: hitPaint(),
    }),
  );
  if (hasGlyphs) {
    addLayerOnce(map, countLabel(COUNT_LAYER.customerClusters, SOURCE.customers, ['get', 'point_count_abbreviated'], true));
    addLayerOnce(map, countLabel(COUNT_LAYER.jobClusters, SOURCE.jobs, ['get', 'point_count_abbreviated'], true));
  }
}

/** Takes the PINS group down: its layers first (the sources cannot go while a layer uses them), then its sources. */
function removePinGroup(map: MapLibreMap): void {
  const layerIds = [
    COUNT_LAYER.customerClusters,
    COUNT_LAYER.jobClusters,
    LAYER.customerClusters,
    LAYER.jobClusters,
    LAYER.customers,
    LAYER.customersHit,
    LAYER.jobs,
    LAYER.jobsHit,
  ];
  for (const id of layerIds) {
    if (map.getLayer(id)) map.removeLayer(id);
  }
  for (const id of [SOURCE.customers, SOURCE.jobs]) {
    if (map.getSource(id)) map.removeSource(id);
  }
}

export function emptyMapData(): MapData {
  return {
    serviceArea: null,
    customers: empty(),
    jobs: empty(),
    clusters: empty(),
    clustering: false,
  };
}

/** Adds every source and layer, skipping any that already exists. Call it after every `style.load`. */
export function installMapLayers(map: MapLibreMap, data: MapData): void {
  const hasGlyphs = styleHasGlyphs(map);
  addBaseGroup(map, data, hasGlyphs);
  addPinGroup(map, data, hasGlyphs);
  installedClustering.set(map, data.clustering);
}

/** Removes every layer and then every source this module added. */
export function removeMapLayers(map: MapLibreMap): void {
  for (const id of LAYER_IDS) {
    if (map.getLayer(id)) map.removeLayer(id);
  }
  for (const id of SOURCE_IDS) {
    if (map.getSource(id)) map.removeSource(id);
  }
  installedClustering.delete(map);
}

/** Feeds new data to the sources already on the map; rebuilds them when `data.clustering` has changed. */
export function updateMapData(map: MapLibreMap, data: MapData): void {
  const installed = installedClustering.get(map);
  if (installed === undefined) return;

  map.getSource<GeoJSONSource>(SOURCE.serviceArea)?.setData(serviceAreaCollection(data.serviceArea));
  map.getSource<GeoJSONSource>(SOURCE.clusters)?.setData(data.clusters);

  if (installed === data.clustering) {
    map.getSource<GeoJSONSource>(SOURCE.customers)?.setData(data.customers);
    map.getSource<GeoJSONSource>(SOURCE.jobs)?.setData(data.jobs);
    return;
  }

  removePinGroup(map);
  addPinGroup(map, data, styleHasGlyphs(map));
  installedClustering.set(map, data.clustering);
}
