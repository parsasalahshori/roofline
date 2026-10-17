import { describe, expect, it } from 'vitest';
import type { PinsResult } from '../src/api/types.ts';
import {
  CLIENT_CLUSTER_ABOVE,
  emptyFeatureCollection,
  needsClientClustering,
  normalizeBbox,
  toFeatureCollections,
  type BoundsLike,
} from '../src/shell/map/pins.ts';

const POINTS: PinsResult = {
  mode: 'points',
  customers: [
    {
      propertyId: 'p1',
      customerId: 'c1',
      lng: -96.8,
      lat: 32.9,
      name: 'Ada Lovelace',
      addressLine: '12 Oak St',
    },
  ],
  jobs: [
    {
      jobId: 'j1',
      customerId: 'c1',
      propertyId: 'p1',
      stage: 'proposal',
      stageLabel: 'Proposal',
      lng: -96.7,
      lat: 32.8,
      name: 'Ada Lovelace',
      addressLine: '12 Oak St',
    },
  ],
};

const CLUSTERS: PinsResult = {
  mode: 'clusters',
  clusters: [
    { layer: 'customers', lng: -96.9, lat: 32.7, count: 120 },
    { layer: 'jobs', lng: -96.5, lat: 33, count: 30 },
  ],
  total: 150,
};

/** Bounds that report the given four edges, the way MapLibre's LngLatBounds does. */
function boundsOf(west: number, south: number, east: number, north: number): BoundsLike {
  return {
    getWest: () => west,
    getSouth: () => south,
    getEast: () => east,
    getNorth: () => north,
  };
}

/** `count` customer rows, each one a different place. */
function customerRows(count: number): Extract<PinsResult, { mode: 'points' }>['customers'] {
  return Array.from({ length: count }, (_, index) => ({
    propertyId: `p${index}`,
    customerId: `c${index}`,
    lng: -96,
    lat: 33,
    name: `Customer ${index}`,
    addressLine: `${index} Main St`,
  }));
}

/** A points answer with `count` customers and no jobs. */
function customers(count: number): PinsResult {
  return { mode: 'points', customers: customerRows(count), jobs: [] };
}

describe('toFeatureCollections', () => {
  it('makes one customer feature at [lng, lat] with the customer properties', () => {
    const { customers: collection } = toFeatureCollections(POINTS);
    expect(collection.type).toBe('FeatureCollection');
    expect(collection.features[0]).toEqual({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [-96.8, 32.9] },
      properties: {
        kind: 'customer',
        id: 'c1',
        customerId: 'c1',
        propertyId: 'p1',
        name: 'Ada Lovelace',
        addressLine: '12 Oak St',
      },
    });
  });

  it('makes one job feature at [lng, lat] with the job properties and its stage', () => {
    const { jobs } = toFeatureCollections(POINTS);
    expect(jobs.features).toHaveLength(1);
    expect(jobs.features[0]).toMatchObject({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [-96.7, 32.8] },
      properties: {
        kind: 'job',
        id: 'j1',
        jobId: 'j1',
        customerId: 'c1',
        propertyId: 'p1',
        name: 'Ada Lovelace',
        addressLine: '12 Oak St',
        stage: 'proposal',
        stageLabel: 'Proposal',
      },
    });
  });

  it('leaves the clusters empty for a points answer', () => {
    expect(toFeatureCollections(POINTS).clusters).toEqual({ type: 'FeatureCollection', features: [] });
  });

  it('makes one cluster feature per server cluster and keeps the input order', () => {
    const { clusters, customers: customerCollection, jobs } = toFeatureCollections(CLUSTERS);
    expect(clusters.features).toHaveLength(2);
    expect(clusters.features[0]).toEqual({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [-96.9, 32.7] },
      properties: { kind: 'cluster', layer: 'customers', count: 120 },
    });
    expect(clusters.features[1]).toMatchObject({
      geometry: { type: 'Point', coordinates: [-96.5, 33] },
      properties: { kind: 'cluster', layer: 'jobs', count: 30 },
    });
    expect(customerCollection.features).toHaveLength(0);
    expect(jobs.features).toHaveLength(0);
  });

  it('gives three empty collections for an empty points answer', () => {
    const empty = toFeatureCollections({ mode: 'points', customers: [], jobs: [] });
    expect(empty.customers).toEqual({ type: 'FeatureCollection', features: [] });
    expect(empty.jobs).toEqual({ type: 'FeatureCollection', features: [] });
    expect(empty.clusters).toEqual({ type: 'FeatureCollection', features: [] });
  });

  it('never returns the same collection object twice', () => {
    const first = toFeatureCollections(POINTS);
    const second = toFeatureCollections(POINTS);
    expect(first.customers).not.toBe(second.customers);
    expect(first.jobs).not.toBe(second.jobs);
    expect(first.clusters).not.toBe(first.customers);
    expect(first.clusters).not.toBe(first.jobs);
    expect(first.customers).not.toBe(first.jobs);
  });
});

describe('emptyFeatureCollection', () => {
  it('returns a new empty collection each call', () => {
    const first = emptyFeatureCollection();
    expect(first).toEqual({ type: 'FeatureCollection', features: [] });
    expect(emptyFeatureCollection()).not.toBe(first);
  });
});

describe('needsClientClustering', () => {
  it('is set above the threshold and not at it', () => {
    expect(CLIENT_CLUSTER_ABOVE).toBe(40);
    expect(needsClientClustering(customers(40))).toBe(false);
    expect(needsClientClustering(customers(41))).toBe(true);
  });

  it('counts customers and jobs together', () => {
    const mixed: PinsResult = {
      mode: 'points',
      customers: customerRows(25),
      jobs: Array.from({ length: 16 }, (_, index) => ({
        jobId: `j${index}`,
        customerId: 'c',
        propertyId: 'p',
        stage: 'lead' as const,
        stageLabel: 'Lead',
        lng: -96,
        lat: 33,
        name: 'Job',
        addressLine: 'Somewhere',
      })),
    };
    expect(needsClientClustering(mixed)).toBe(true);
  });

  it('is false for a clusters answer, however big the total', () => {
    expect(needsClientClustering({ ...CLUSTERS, total: 5000 })).toBe(false);
  });

  it('is false with no answer yet', () => {
    expect(needsClientClustering(undefined)).toBe(false);
  });
});

describe('normalizeBbox', () => {
  it('clamps west and east to the longitudes and south and north to the latitudes', () => {
    expect(normalizeBbox(boundsOf(-250.5, -95, 300, 91))).toEqual([-180, -90, 180, 90]);
  });

  it('rounds each edge to 4 decimals', () => {
    expect(normalizeBbox(boundsOf(-97.123456, 32.123456, -96.4, 33.1))).toEqual([-97.1235, 32.1235, -96.4, 33.1]);
  });

  it('returns a four-element array in west, south, east, north order', () => {
    const bbox = normalizeBbox(boundsOf(-97, 32, -96, 33));
    expect(bbox).toHaveLength(4);
    expect(bbox).toEqual([-97, 32, -96, 33]);
  });

  it('turns a rounded negative zero into a plain zero', () => {
    const bbox = normalizeBbox(boundsOf(-0.00001, 0, 0.00001, 0));
    expect(Object.is(bbox[0], 0)).toBe(true);
    expect(Object.is(bbox[2], 0)).toBe(true);
  });
});
