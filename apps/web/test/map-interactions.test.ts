import { describe, expect, it, vi } from 'vitest';
import type { Map as MapLibreMap } from 'maplibre-gl';
import { bindMapInteractions } from '../src/shell/map/interactions.ts';
import type { PickedPin } from '../src/shell/map/types.ts';

type Listener = (event: unknown) => void;

/*
 * A hand-made stand-in for the MapLibre map: layer listeners are kept per (event, layer) so a test can
 * fire them, and the canvas, zoom and sources are plain fakes.
 */
function fakeMap() {
  const listeners: { type: string; layer: string; handler: Listener }[] = [];
  const canvas = { style: { cursor: '' } };
  const customersSource = {
    getClusterExpansionZoom: vi.fn<(clusterId: number) => Promise<number>>(() => Promise.resolve(13)),
  };
  const jobsSource = {
    getClusterExpansionZoom: vi.fn<(clusterId: number) => Promise<number>>(() => Promise.resolve(13)),
  };
  const sources: Record<string, unknown> = { customers: customersSource, jobs: jobsSource };

  const on = vi.fn((type: string, layer: string, handler: Listener) => {
    listeners.push({ type, layer, handler });
  });
  const off = vi.fn((type: string, layer: string, handler: Listener) => {
    const index = listeners.findIndex((entry) => entry.type === type && entry.layer === layer && entry.handler === handler);
    if (index >= 0) listeners.splice(index, 1);
  });
  const easeTo = vi.fn();
  const getZoom = vi.fn(() => 10);

  const map = {
    on,
    off,
    easeTo,
    getZoom,
    getCanvas: () => canvas,
    getSource: (id: string) => sources[id],
  };

  function fire(type: string, layer: string, event: unknown): void {
    for (const entry of listeners.filter((item) => item.type === type && item.layer === layer)) {
      entry.handler(event);
    }
  }

  return {
    map: map as unknown as MapLibreMap,
    listeners,
    canvas,
    customersSource,
    jobsSource,
    on,
    off,
    easeTo,
    getZoom,
    fire,
  };
}

function pointFeature(properties: Record<string, unknown> | null, coordinates: [number, number]) {
  return { type: 'Feature', properties, geometry: { type: 'Point', coordinates } };
}

/** Lets the promise chain in a click handler settle. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

const JOB_PROPERTIES = {
  kind: 'job',
  id: 'job-1',
  jobId: 'job-1',
  customerId: 'cust-1',
  propertyId: 'prop-1',
  name: 'Ada Lovelace',
  addressLine: '12 Oak St',
  stage: 'proposal',
  stageLabel: 'Proposal',
};

describe('pin clicks', () => {
  it('reports a clicked job with its stage and position', () => {
    const fake = fakeMap();
    const onPick = vi.fn<(pin: PickedPin) => void>();
    bindMapInteractions(fake.map, onPick);

    fake.fire('click', 'jobs', { features: [pointFeature(JOB_PROPERTIES, [-96.8, 32.9])] });

    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick).toHaveBeenCalledWith({
      kind: 'job',
      id: 'job-1',
      name: 'Ada Lovelace',
      addressLine: '12 Oak St',
      stage: 'proposal',
      stageLabel: 'Proposal',
      lngLat: [-96.8, 32.9],
    });
  });

  it('reports a clicked customer as a customer with no stage', () => {
    const fake = fakeMap();
    const onPick = vi.fn<(pin: PickedPin) => void>();
    bindMapInteractions(fake.map, onPick);

    fake.fire('click', 'customers', {
      features: [
        pointFeature({ kind: 'customer', id: 'cust-9', customerId: 'cust-9', name: 'Grace Hopper', addressLine: '4 Pine Rd' }, [
          -96.5, 32.6,
        ]),
      ],
    });

    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick.mock.calls[0]?.[0]).toEqual({
      kind: 'customer',
      id: 'cust-9',
      name: 'Grace Hopper',
      addressLine: '4 Pine Rd',
      stage: null,
      stageLabel: null,
      lngLat: [-96.5, 32.6],
    });
  });

  it('ignores a click that has no feature under it', () => {
    const fake = fakeMap();
    const onPick = vi.fn<(pin: PickedPin) => void>();
    bindMapInteractions(fake.map, onPick);

    fake.fire('click', 'customers', { features: [] });
    fake.fire('click', 'jobs', {});

    expect(onPick).not.toHaveBeenCalled();
  });

  it('ignores a pin with no properties or with a shape other than a point', () => {
    const fake = fakeMap();
    const onPick = vi.fn<(pin: PickedPin) => void>();
    bindMapInteractions(fake.map, onPick);

    fake.fire('click', 'jobs', { features: [pointFeature(null, [-96.8, 32.9])] });
    fake.fire('click', 'jobs', {
      features: [{ type: 'Feature', properties: JOB_PROPERTIES, geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] } }],
    });

    expect(onPick).not.toHaveBeenCalled();
  });
});

describe('cluster clicks', () => {
  it('zooms two levels in on a server cluster, centred on it', () => {
    const fake = fakeMap();
    bindMapInteractions(fake.map, vi.fn());

    fake.fire('click', 'clusters', {
      features: [pointFeature({ kind: 'cluster', layer: 'customers', count: 40 }, [-96.9, 32.7])],
    });

    expect(fake.easeTo).toHaveBeenCalledTimes(1);
    expect(fake.easeTo).toHaveBeenCalledWith({ center: [-96.9, 32.7], zoom: 12 });
  });

  it('opens a client cluster to the zoom where it splits, asking the customers source', async () => {
    const fake = fakeMap();
    bindMapInteractions(fake.map, vi.fn());

    fake.fire('click', 'customers-clusters', {
      features: [pointFeature({ cluster: true, cluster_id: 7, point_count: 30 }, [-96.7, 32.8])],
    });

    expect(fake.customersSource.getClusterExpansionZoom).toHaveBeenCalledWith(7);
    await settle();
    expect(fake.easeTo).toHaveBeenCalledWith({ center: [-96.7, 32.8], zoom: 13 });
  });

  it('asks the jobs source about a job cluster', async () => {
    const fake = fakeMap();
    bindMapInteractions(fake.map, vi.fn());

    fake.fire('click', 'jobs-clusters', {
      features: [pointFeature({ cluster: true, cluster_id: 3, point_count: 5 }, [-96.6, 32.5])],
    });

    expect(fake.jobsSource.getClusterExpansionZoom).toHaveBeenCalledWith(3);
    expect(fake.customersSource.getClusterExpansionZoom).not.toHaveBeenCalled();
    await settle();
    expect(fake.easeTo).toHaveBeenCalledWith({ center: [-96.6, 32.5], zoom: 13 });
  });

  it('stays quiet when the zoom cannot be worked out', async () => {
    const fake = fakeMap();
    fake.customersSource.getClusterExpansionZoom.mockImplementationOnce(() => Promise.reject(new Error('gone')));
    bindMapInteractions(fake.map, vi.fn());

    fake.fire('click', 'customers-clusters', {
      features: [pointFeature({ cluster: true, cluster_id: 7, point_count: 30 }, [-96.7, 32.8])],
    });

    await settle();
    expect(fake.easeTo).not.toHaveBeenCalled();
  });

  it('does not ask for a zoom when the cluster has no numeric id', () => {
    const fake = fakeMap();
    bindMapInteractions(fake.map, vi.fn());

    fake.fire('click', 'customers-clusters', {
      features: [pointFeature({ cluster: true, cluster_id: 'seven' }, [-96.7, 32.8])],
    });

    expect(fake.customersSource.getClusterExpansionZoom).not.toHaveBeenCalled();
    expect(fake.easeTo).not.toHaveBeenCalled();
  });
});

describe('pointer cursor', () => {
  it('shows a pointer over every clickable layer and clears it on leave', () => {
    const fake = fakeMap();
    bindMapInteractions(fake.map, vi.fn());

    for (const layer of ['customers', 'jobs', 'clusters', 'customers-clusters', 'jobs-clusters']) {
      fake.fire('mouseenter', layer, {});
      expect(fake.canvas.style.cursor).toBe('pointer');
      fake.fire('mouseleave', layer, {});
      expect(fake.canvas.style.cursor).toBe('');
    }
  });

  it('sets the pointer on a job and clears it when the mouse leaves', () => {
    const fake = fakeMap();
    bindMapInteractions(fake.map, vi.fn());

    fake.fire('mouseenter', 'jobs', {});
    expect(fake.canvas.style.cursor).toBe('pointer');
    fake.fire('mouseleave', 'jobs', {});
    expect(fake.canvas.style.cursor).toBe('');
  });
});

describe('unbinding', () => {
  it('returns a function that removes every listener it added', () => {
    const fake = fakeMap();
    const onPick = vi.fn<(pin: PickedPin) => void>();
    const unbind = bindMapInteractions(fake.map, onPick);

    const added = fake.on.mock.calls.map((call) => ({ type: call[0], layer: call[1], handler: call[2] }));
    expect(added.length).toBeGreaterThan(0);

    unbind();

    expect(fake.off).toHaveBeenCalledTimes(added.length);
    for (const entry of added) {
      expect(fake.off).toHaveBeenCalledWith(entry.type, entry.layer, entry.handler);
    }
    expect(fake.listeners).toEqual([]);

    fake.fire('click', 'jobs', { features: [pointFeature(JOB_PROPERTIES, [-96.8, 32.9])] });
    expect(onPick).not.toHaveBeenCalled();
  });
});
