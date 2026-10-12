import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { doors } from '../src/copy/doors.ts';
import { isIos, navigateUrl } from '../src/features/storm/routes/navigate.ts';
import { RouteView } from '../src/features/storm/routes/RouteView.tsx';
import styles from '../src/features/storm/routes/RouteView.module.css';
import type { DoorStop, RouteDetailView } from '../src/features/storm/routes/types.ts';
import { renderAt, stubApi } from './helpers.tsx';

// The map is not what these tests check; the real one needs WebGL.
vi.mock('../src/features/storm/routes/RouteMap.tsx', () => ({ RouteMap: () => null }));

// The outcome buttons are another package's; the stub shows which stop the card hands it.
vi.mock('../src/features/storm/routes/DoorOutcome.tsx', async () => {
  const { createElement } = await import('react');
  return {
    DoorOutcome: (props: { routeId: string; stop: { address: string } }) =>
      createElement('div', { 'data-testid': 'outcome-stub' }, props.stop.address),
  };
});

let api: ReturnType<typeof stubApi>;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, 'geolocation');
  expect(api?.unexpected ?? []).toEqual([]);
});

const ROUTE = {
  id: 'r1',
  companyStormId: 'cs1',
  stormId: 'st1',
  userId: 'u1',
  name: 'Omaha · Route 1',
  status: 'in_progress',
  stops: 3,
  doneStops: 1,
} as const;

function stop(position: number, overrides: Partial<DoorStop> = {}): DoorStop {
  return {
    id: `s${position}`,
    routeId: 'r1',
    position,
    footprintId: null,
    propertyId: null,
    address: addressOf(position),
    lat: 41.2565,
    lng: -95.9345,
    hailIn: 1.75,
    outcome: null,
    outcomeAt: null,
    outcomeBy: null,
    createdCustomerId: null,
    createdJobId: null,
    ...overrides,
  };
}

const addressOf = (position: number): string => `${100 + position} Elm St`;

/** Stops given out of order, so the view has to sort them by position. */
function routeWith(stops: DoorStop[]): RouteDetailView {
  return { route: { ...ROUTE, stops: stops.length, doneStops: stops.filter((s) => s.outcome !== null).length }, stops };
}

const GOOGLE = 'https://www.google.com/maps/dir/?api=1&destination=41.2565,-95.9345';
const APPLE = 'https://maps.apple.com/?daddr=41.2565,-95.9345';

describe('navigate links', () => {
  it('uses the Apple form on iPhone and the Google form elsewhere', () => {
    expect(isIos('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)')).toBe(true);
    expect(isIos('Mozilla/5.0 (Linux; Android 14; Pixel 8)')).toBe(false);
    expect(navigateUrl({ lat: 41.2565, lng: -95.9345 }, true)).toBe(APPLE);
    expect(navigateUrl({ lat: 41.2565, lng: -95.9345 }, false)).toBe(GOOGLE);
  });
});

describe('route view', () => {
  it('shows stops in order and the first open stop as current', async () => {
    const stops = [stop(3), stop(1, { outcome: 'not_home' }), stop(2)];
    api = stubApi({ 'GET /api/routes/r1': () => ({ body: routeWith(stops) }) });
    renderAt(<RouteView routeId="r1" />, '/storm/routes/r1');

    const list = await screen.findByRole('list');
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveTextContent(addressOf(1));
    expect(items[1]).toHaveTextContent(addressOf(2));
    expect(items[2]).toHaveTextContent(addressOf(3));
    expect(items[0]).toHaveTextContent(doors.doneMark);
    expect(items[1]).toHaveAttribute('data-current');

    const current = screen.getByRole('region', { name: doors.doorOf(2, 3) });
    expect(within(current).getByText(addressOf(2), { selector: 'p' })).toBeInTheDocument();
    expect(within(current).getByText(doors.hailLine(1.75))).toBeInTheDocument();
    expect(within(current).getByRole('link', { name: doors.navigate })).toHaveAttribute('href', GOOGLE);
    expect(within(current).getByRole('link', { name: doors.navigate })).toHaveAttribute('target', '_blank');
    expect(within(current).getByRole('link', { name: doors.navigate })).toHaveAttribute('rel', 'noopener noreferrer');

    expect(screen.getByTestId('outcome-stub')).toHaveTextContent(addressOf(2));
  });

  it('shows the done state when every stop has an outcome', async () => {
    const stops = [stop(1, { outcome: 'not_home' }), stop(2, { outcome: 'not_interested' })];
    api = stubApi({ 'GET /api/routes/r1': () => ({ body: routeWith(stops) }) });
    renderAt(<RouteView routeId="r1" />, '/storm/routes/r1');

    expect(await screen.findByText(doors.routeDone)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: doors.backToRoutes })).toHaveAttribute('href', '/storm/routes');
    expect(screen.queryByTestId('outcome-stub')).toBeNull();
  });

  it('shows the no-address copy when a stop has a null address', async () => {
    const stops = [stop(1, { outcome: 'not_home' }), stop(2, { address: null, hailIn: null })];
    api = stubApi({ 'GET /api/routes/r1': () => ({ body: routeWith(stops) }) });
    renderAt(<RouteView routeId="r1" />, '/storm/routes/r1');

    const current = await screen.findByRole('region', { name: doors.doorOf(2, 2) });
    expect(within(current).getByText(doors.noAddress, { selector: 'p' })).toBeInTheDocument();
    expect(screen.getByRole('list')).toHaveTextContent(doors.noAddress);
    expect(document.body).not.toHaveTextContent(/Radar-estimated hail/);
  });

  it('still shows the hail line when the size is known', async () => {
    const stops = [stop(1, { hailIn: 2.5 })];
    api = stubApi({ 'GET /api/routes/r1': () => ({ body: routeWith(stops) }) });
    renderAt(<RouteView routeId="r1" />, '/storm/routes/r1');

    const current = await screen.findByRole('region', { name: doors.doorOf(1, 1) });
    expect(within(current).getByText(doors.hailLine(2.5))).toBeInTheDocument();
  });

  it('never shows an owner name', async () => {
    const stops = [stop(1, { ownerName: 'Pat Owner' } as Partial<DoorStop>), stop(2, { ownerName: 'Lee Owner' } as Partial<DoorStop>)];
    api = stubApi({ 'GET /api/routes/r1': () => ({ body: routeWith(stops) }) });
    renderAt(<RouteView routeId="r1" />, '/storm/routes/r1');

    await screen.findByRole('list');
    expect(document.body).not.toHaveTextContent('Pat Owner');
    expect(document.body).not.toHaveTextContent('Lee Owner');
  });

  it('asks the browser for the position only when available', async () => {
    const watchPosition = vi.fn(() => 7);
    const clearWatch = vi.fn();
    Object.defineProperty(navigator, 'geolocation', { configurable: true, value: { watchPosition, clearWatch } });
    api = stubApi({ 'GET /api/routes/r1': () => ({ body: routeWith([stop(1)]) }) });
    renderAt(<RouteView routeId="r1" />, '/storm/routes/r1');

    await screen.findByRole('list');
    expect(watchPosition).toHaveBeenCalledTimes(1);
    expect(clearWatch).not.toHaveBeenCalled();
    cleanup();
    expect(clearWatch).toHaveBeenCalledWith(7);
  });

  it('works without geolocation', async () => {
    Reflect.deleteProperty(navigator, 'geolocation');
    api = stubApi({ 'GET /api/routes/r1': () => ({ body: routeWith([stop(1)]) }) });
    renderAt(<RouteView routeId="r1" />, '/storm/routes/r1');

    expect(await screen.findByRole('list')).toBeInTheDocument();
  });

  it('shows the loading skeleton while the route loads', () => {
    api = stubApi({ 'GET /api/routes/r1': () => ({ body: routeWith([stop(1)]) }) });
    renderAt(<RouteView routeId="r1" />, '/storm/routes/r1');

    expect(screen.getByRole('status', { name: doors.routeLoading })).toBeInTheDocument();
  });

  it('shows the error line when the route cannot be read', async () => {
    api = stubApi({ 'GET /api/routes/r1': () => ({ status: 500, body: { error: 'boom' } }) });
    renderAt(<RouteView routeId="r1" />, '/storm/routes/r1');

    expect(await screen.findByText(doors.routeError)).toBeInTheDocument();
  });

  it('keeps the layout inside a 375px phone', async () => {
    const css = readFileSync(join(import.meta.dirname, '../src/features/storm/routes/RouteView.module.css'), 'utf8');
    expect(css).toContain('min-width: 0');
    for (const match of css.matchAll(/(?<![\w-])width:\s*(\d+)px/g)) {
      expect(Number(match[1])).toBeLessThanOrEqual(375);
    }
    api = stubApi({ 'GET /api/routes/r1': () => ({ body: routeWith([stop(1)]) }) });
    renderAt(<RouteView routeId="r1" />, '/storm/routes/r1');

    const list = await screen.findByRole('list');
    expect(list.parentElement).toHaveClass(styles.view);
  });
});
