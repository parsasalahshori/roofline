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
    setLngLat() {
      return this;
    }
    addTo() {
      return this;
    }
    remove() {}
  }
  return { FakeMap, FakeMarker };
});

vi.mock('maplibre-gl', () => ({
  Map: fake.FakeMap,
  Marker: fake.FakeMarker,
}));

function stop(id: string, position: number, lat: number, lng: number): DoorStop {
  return { id, position, address: `${position} Main St`, lat, lng, hailIn: 1.25, outcome: null };
}

const stops: DoorStop[] = [stop('s1', 1, 32.8, -96.9), stop('s2', 2, 32.85, -96.85)];

describe('RouteMap fit', () => {
  beforeEach(() => {
    fake.FakeMap.instances.length = 0;
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
});
