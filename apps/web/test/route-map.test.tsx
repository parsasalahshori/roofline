import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RouteMap } from '../src/features/storm/routes/RouteMap.tsx';
import type { DoorStop } from '../src/features/storm/routes/types.ts';

/* A stand-in for MapLibre's Map and Marker (jsdom has no WebGL). Only fitBounds is checked here. */
const fake = vi.hoisted(() => {
  class FakeMap {
    static instances: FakeMap[] = [];
    fitBounds = vi.fn();
    remove = vi.fn();
    constructor() {
      FakeMap.instances.push(this);
    }
  }
  class FakeMarker {
    static instances: FakeMarker[] = [];
    setLngLat = vi.fn(() => this);
    addTo = vi.fn(() => this);
    remove = vi.fn();
    constructor() {
      FakeMarker.instances.push(this);
    }
  }
  return { FakeMap, FakeMarker };
});

vi.mock('maplibre-gl', () => ({
  Map: fake.FakeMap,
  Marker: fake.FakeMarker,
}));

function stop(id: string, position: number, lat: number, lng: number): DoorStop {
  return { id, routeId: 'r1', position, footprintId: null, propertyId: null, address: `${position} Main St`, lat, lng, hailIn: 1.25, outcome: null, outcomeAt: null, outcomeBy: null, createdCustomerId: null, createdJobId: null };
}

const stops: DoorStop[] = [stop('s1', 1, 32.8, -96.9), stop('s2', 2, 32.85, -96.85)];

describe('RouteMap fit', () => {
  beforeEach(() => {
    fake.FakeMap.instances.length = 0;
    fake.FakeMarker.instances.length = 0;
  });

  it('keeps the doors clear of the attribution along the foot of the map', () => {
    render(<RouteMap stops={stops} currentStopId={stops[0].id} position={null} />);
    expect(fake.FakeMap.instances[0].fitBounds).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ padding: { top: 32, right: 32, bottom: 72, left: 32 } }));
  });

  it('fits the view once for a route, not on every move of the rep', () => {
    const { rerender } = render(<RouteMap stops={stops} currentStopId={stops[0].id} position={null} />);
    rerender(<RouteMap stops={stops} currentStopId={stops[0].id} position={{ lat: 32.9, lng: -96.8 }} />);
    rerender(<RouteMap stops={stops} currentStopId={stops[0].id} position={{ lat: 32.91, lng: -96.81 }} />);
    expect(fake.FakeMap.instances[0].fitBounds).toHaveBeenCalledTimes(1);
  });

  it('does not refit for a new array with the same coordinates or a new current door', () => {
    const { rerender } = render(<RouteMap stops={stops} currentStopId={stops[0].id} position={null} />);
    rerender(<RouteMap stops={[...stops]} currentStopId={stops[1].id} position={null} />);
    expect(fake.FakeMap.instances[0].fitBounds).toHaveBeenCalledTimes(1);
  });

  it('refits when the door coordinates change', () => {
    const { rerender } = render(<RouteMap stops={stops} currentStopId={stops[0].id} position={null} />);
    const moved = [stop('s1', 1, 32.7, -96.95), stop('s2', 2, 32.85, -96.85)];
    rerender(<RouteMap stops={moved} currentStopId={moved[0].id} position={null} />);
    expect(fake.FakeMap.instances[0].fitBounds).toHaveBeenCalledTimes(2);
  });

  it('moves the rep dot without rebuilding the door markers', () => {
    const { rerender } = render(<RouteMap stops={stops} currentStopId={stops[0].id} position={{ lat: 32.9, lng: -96.8 }} />);
    const created = fake.FakeMarker.instances.length;
    expect(created).toBe(stops.length + 1);
    const doors = fake.FakeMarker.instances.slice(0, stops.length);
    const dot = fake.FakeMarker.instances[stops.length];
    rerender(<RouteMap stops={stops} currentStopId={stops[0].id} position={{ lat: 32.91, lng: -96.81 }} />);
    expect(fake.FakeMarker.instances.length).toBe(created);
    for (const marker of doors) expect(marker.remove).not.toHaveBeenCalled();
    expect(dot.setLngLat).toHaveBeenLastCalledWith([-96.81, 32.91]);
    expect(dot.remove).not.toHaveBeenCalled();
  });

  it('removes the rep dot when the position goes away', () => {
    const { rerender } = render(<RouteMap stops={stops} currentStopId={stops[0].id} position={{ lat: 32.9, lng: -96.8 }} />);
    const dot = fake.FakeMarker.instances[stops.length];
    rerender(<RouteMap stops={stops} currentStopId={stops[0].id} position={null} />);
    expect(dot.remove).toHaveBeenCalledTimes(1);
  });
});
