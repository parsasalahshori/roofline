import type { Feature, FeatureCollection, Point } from 'geojson';
import type { PinsResult } from '../../api/types.ts';
import type { Bbox } from './types.ts';

/** Above this many points on screen, the customers and jobs sources cluster in the browser. */
export const CLIENT_CLUSTER_ABOVE = 200;

/** What MapLibre's `getBounds()` answers with, as far as we use it. */
export type BoundsLike = { getWest(): number; getSouth(): number; getEast(): number; getNorth(): number };

export function emptyFeatureCollection(): FeatureCollection {
  return { type: 'FeatureCollection', features: [] };
}

/** One point feature at [lng, lat] carrying `properties`. */
function pointFeature(lng: number, lat: number, properties: Record<string, unknown>): Feature<Point> {
  return { type: 'Feature', geometry: { type: 'Point', coordinates: [lng, lat] }, properties };
}

function collectionOf(features: Feature<Point>[]): FeatureCollection {
  return { type: 'FeatureCollection', features };
}

export function toFeatureCollections(result: PinsResult): {
  customers: FeatureCollection;
  jobs: FeatureCollection;
  clusters: FeatureCollection;
} {
  if (result.mode === 'clusters') {
    return {
      customers: emptyFeatureCollection(),
      jobs: emptyFeatureCollection(),
      clusters: collectionOf(
        result.clusters.map((cluster) =>
          pointFeature(cluster.lng, cluster.lat, { kind: 'cluster', layer: cluster.layer, count: cluster.count }),
        ),
      ),
    };
  }
  return {
    customers: collectionOf(
      result.customers.map((customer) =>
        pointFeature(customer.lng, customer.lat, {
          kind: 'customer',
          id: customer.customerId,
          customerId: customer.customerId,
          propertyId: customer.propertyId,
          name: customer.name,
          addressLine: customer.addressLine,
        }),
      ),
    ),
    jobs: collectionOf(
      result.jobs.map((job) =>
        pointFeature(job.lng, job.lat, {
          kind: 'job',
          id: job.jobId,
          jobId: job.jobId,
          customerId: job.customerId,
          propertyId: job.propertyId,
          name: job.name,
          addressLine: job.addressLine,
          stage: job.stage,
          stageLabel: job.stageLabel,
        }),
      ),
    ),
    clusters: emptyFeatureCollection(),
  };
}

/** True when the answer is in `points` mode and holds more than CLIENT_CLUSTER_ABOVE points (customers plus jobs). */
export function needsClientClustering(result: PinsResult | undefined): boolean {
  return (
    result !== undefined && result.mode === 'points' && result.customers.length + result.jobs.length > CLIENT_CLUSTER_ABOVE
  );
}

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

/** Rounds to 4 decimals. A negative zero (from rounding a tiny negative) comes back as a plain zero. */
function round4(value: number): number {
  const rounded = Math.round(value * 10000) / 10000;
  return rounded === 0 ? 0 : rounded;
}

/** The visible box as [west, south, east, north]: clamped to valid longitudes and latitudes, rounded to 4 decimals. */
export function normalizeBbox(bounds: BoundsLike): Bbox {
  return [
    round4(clamp(bounds.getWest(), -180, 180)),
    round4(clamp(bounds.getSouth(), -90, 90)),
    round4(clamp(bounds.getEast(), -180, 180)),
    round4(clamp(bounds.getNorth(), -90, 90)),
  ];
}
