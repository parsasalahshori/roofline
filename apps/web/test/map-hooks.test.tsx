import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useMapArea, useMapPins } from '../src/api/hooks.ts';
import type { MapArea, PinsResult } from '../src/api/types.ts';
import { createQueryClient } from '../src/app/providers.tsx';
import type { Bbox } from '../src/shell/map/types.ts';

const AREA: MapArea = { serviceArea: null, bounds: [-97.5, 32.5, -96.2, 33.3] };

const PINS_A: PinsResult = {
  mode: 'points',
  customers: [{ propertyId: 'p1', customerId: 'c1', lng: -97, lat: 33, name: 'Ada Lovelace', addressLine: '12 Oak St' }],
  jobs: [],
};

const PINS_B: PinsResult = {
  mode: 'points',
  customers: [{ propertyId: 'p2', customerId: 'c2', lng: -96.5, lat: 32.6, name: 'Grace Hopper', addressLine: '4 Elm Ave' }],
  jobs: [],
};

const BOX_A: Bbox = [-97.1, 32.5, -96.4, 33.1];
const BOX_B: Bbox = [-96.9, 32.4, -96.1, 33];

/** A response the way the server sends one: JSON with a 200. */
const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

let client: QueryClient;

/** Gives each hook a fresh query cache, so one test's answers never reach the next. */
function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

/** The URL fetch was asked for on each call, in order. */
function requestedUrls(fetchMock: { mock: { calls: unknown[][] } }): unknown[] {
  return fetchMock.mock.calls.map((call) => call[0]);
}

beforeEach(() => {
  client = createQueryClient();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('useMapArea', () => {
  it('asks for the service area and returns the answer', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(json(AREA)));
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useMapArea(), { wrapper });

    await waitFor(() => expect(result.current.data).toEqual(AREA));
    expect(requestedUrls(fetchMock)).toEqual(['/api/map/area']);
  });
});

describe('useMapPins', () => {
  it('asks for the pins inside the box and returns the answer', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(json(PINS_A)));
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useMapPins([-97.1, 32.5, -96.4, 33.1]), { wrapper });

    await waitFor(() => expect(result.current.data).toEqual(PINS_A));
    expect(requestedUrls(fetchMock)).toEqual(['/api/map/pins?bbox=-97.1,32.5,-96.4,33.1&layers=customers,jobs']);
  });

  it('asks for nothing while there is no box yet', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(json(PINS_A)));
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useMapPins(null), { wrapper });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.fetchStatus).toBe('idle');
    expect(result.current.data).toBeUndefined();
  });

  it('keeps the last answer, marked as placeholder, while the next box loads', async () => {
    let answerSecond: ((response: Response) => void) | undefined;
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      if (String(input).includes('bbox=-96.9,')) {
        return new Promise<Response>((resolve) => {
          answerSecond = resolve;
        });
      }
      return Promise.resolve(json(PINS_A));
    });
    vi.stubGlobal('fetch', fetchMock);

    const { result, rerender } = renderHook(({ bbox }: { bbox: Bbox | null }) => useMapPins(bbox), {
      wrapper,
      initialProps: { bbox: BOX_A },
    });
    await waitFor(() => expect(result.current.data).toEqual(PINS_A));
    expect(result.current.isPlaceholderData).toBe(false);

    rerender({ bbox: BOX_B });

    await waitFor(() => expect(requestedUrls(fetchMock)).toHaveLength(2));
    expect(result.current.data).toEqual(PINS_A);
    expect(result.current.isPlaceholderData).toBe(true);

    await act(async () => {
      answerSecond?.(json(PINS_B));
    });

    await waitFor(() => expect(result.current.data).toEqual(PINS_B));
    expect(result.current.isPlaceholderData).toBe(false);
    expect(requestedUrls(fetchMock)[1]).toBe('/api/map/pins?bbox=-96.9,32.4,-96.1,33&layers=customers,jobs');
  });
});
