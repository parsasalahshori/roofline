import { cleanup, render, screen, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient, Providers } from '../src/app/providers.tsx';
import { doors } from '../src/copy/doors.ts';
import { errors } from '../src/copy/errors.ts';
import { storm } from '../src/copy/storm.ts';
import { StormDetail } from '../src/features/storm/StormDetail.tsx';
import { StormWindow } from '../src/features/storm/StormWindow.tsx';
import { RouteView } from '../src/features/storm/routes/RouteView.tsx';
import type { DoorStop } from '../src/features/storm/routes/types.ts';
import { ACCOUNT, SHELL_ROUTES, renderAt, stubApi } from './helpers.tsx';

vi.mock('../src/features/storm/StormSwathMap.tsx', () => ({ StormSwathMap: () => null }));
vi.mock('../src/features/storm/routes/RouteMap.tsx', () => ({ RouteMap: () => null }));

let api: ReturnType<typeof stubApi>;
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  expect(api.unexpected).toEqual([]);
});

const results = { textsSent: 0, textsDelivered: 0, replies: 0, yesReplies: 0, emailsSent: 0,
  unsubscribes: 0, doorsKnocked: 0, wantsCheck: 0, adSpendCents: 0, adMaxCents: 0,
  adClicks: 0, landingRequests: 0, inspectionsBooked: 0 };

describe('Ironclad storm response and field routes', () => {
  it.each(['draft', 'running'])('explains the %s plan without starting work from a read', async (status) => {
    api = stubApi({
      'GET /api/auth/me': () => ({ body: ACCOUNT }),
      'GET /api/storms/s1': () => ({ body: {
        storm: { id: 's1', placeName: 'Maple Ridge', day: '2026-10-10', maxIn: 1.75, customersHit: 12, homesHit: 340 },
        plan: { taskId: 't1', status }, swath: { type: 'FeatureCollection', features: [] }, results,
      } }),
    });
    const client = createQueryClient();
    client.setDefaultOptions({ queries: { retry: false } });
    render(<Providers client={client}><RouterProvider router={createMemoryRouter(
      [{ path: '/storm/:id', element: <StormDetail /> }], { initialEntries: ['/storm/s1'] },
    )} /></Providers>);
    const plan = await screen.findByRole('region', { name: storm.planHeadingDetail });
    expect(within(plan).getByText(storm.planStatus[status as 'draft' | 'running'])).toBeInTheDocument();
    expect(within(plan).getByRole('link', { name: storm.openPlan })).toHaveAttribute('href', '/storm/plans/t1');
    expect(screen.getByRole('link', { name: doors.myRoutesLink })).toHaveAttribute('href', '/storm/routes');
    expect(screen.getByText(storm.upTo('1.75'))).toBeInTheDocument();
    expect(api.calls.every((call) => call.key.startsWith('GET '))).toBe(true);
    if (status === 'running') expect(screen.queryByRole('button', { name: storm.redraft })).not.toBeInTheDocument();
  });

  it('lets a failed storm list be retried without discarding the route entry point', async () => {
    let failed = true;
    api = stubApi({ ...SHELL_ROUTES, 'GET /api/storms': () => failed
      ? { status: 503, body: { error: 'Unavailable' } } : { body: { storms: [] } } });
    const { user } = renderAt(<StormWindow />);
    await screen.findByText(storm.loadFailed);
    expect(screen.getByRole('link', { name: doors.myRoutesLink })).toBeInTheDocument();
    failed = false;
    await user.click(screen.getByRole('button', { name: errors.tryAgain }));
    expect(await screen.findByText(storm.empty)).toBeInTheDocument();
    expect(api.count('GET /api/storms')).toBe(2);
  });

  it('identifies the current door and preserves the saved outcome as the next door becomes current', async () => {
    const stops: DoorStop[] = [1, 2].map((position) => ({
      id: `s${position}`, routeId: 'r1', position, footprintId: null, propertyId: null,
      address: `${position} Elm St`, lat: 41.25, lng: -95.93, hailIn: 1.75,
      outcome: null, outcomeAt: null, outcomeBy: null, createdCustomerId: null, createdJobId: null,
    }));
    api = stubApi({
      'GET /api/routes/r1': () => ({ body: {
        route: { id: 'r1', name: 'Maple Ridge route', status: 'in_progress', stops: 2,
          doneStops: stops.filter((stop) => stop.outcome !== null).length }, stops,
      } }),
      'POST /api/routes/r1/stops/s1/outcome': () => {
        stops[0] = { ...stops[0]!, outcome: 'not_home' };
        return { body: { ok: true } };
      },
    });
    const { user } = renderAt(<RouteView routeId="r1" />);
    const list = await screen.findByRole('list');
    expect(within(list).getAllByRole('listitem')[0]).toHaveAttribute('aria-current', 'step');
    await user.click(screen.getByRole('button', { name: doors.outcomes.not_home }));
    await screen.findByRole('region', { name: doors.doorOf(2, 2) });
    const items = within(list).getAllByRole('listitem');
    expect(items[0]).toHaveTextContent(doors.outcomes.not_home);
    expect(items[1]).toHaveAttribute('aria-current', 'step');
    expect(api.sent('POST /api/routes/r1/stops/s1/outcome')).toEqual([{ outcome: 'not_home' }]);
    expect(screen.getByRole('link', { name: doors.backToRoutes })).toHaveAttribute('href', '/storm/routes');
  });
});
