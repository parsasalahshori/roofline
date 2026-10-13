import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
// RouterProvider from 'react-router', not 'react-router/dom': under Vitest the two load as separate copies of the router
import { RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient, Providers } from '../src/app/providers.tsx';
import { createAppRouter } from '../src/app/router.tsx';
import { dock, WINDOW_COPY } from '../src/copy/dock.ts';
import { connections } from '../src/copy/connections.ts';
import { doors } from '../src/copy/doors.ts';
import { settings } from '../src/copy/settings.ts';
import { storm } from '../src/copy/storm.ts';
import { ACCOUNT, proposalListRoutes, type Routes, SHELL_ROUTES, stubApi, where } from './helpers.tsx';

// The route map needs maplibre-gl, which these tests never need. RouteMap is package B's component.
vi.mock('../src/features/storm/routes/RouteMap.tsx', () => ({ RouteMap: () => null }));

// The real map loads maplibre-gl, which these tests never need. The stand-in has two pins that open a job and a customer.
vi.mock('../src/shell/map/MapView.tsx', async () => {
  const { createElement } = await import('react');
  return {
    MapView: (props: { onOpen: (target: { kind: 'customer' | 'job'; id: string }) => void }) =>
      createElement(
        'div',
        { 'data-map-mock': true },
        createElement('button', { type: 'button', onClick: () => props.onOpen({ kind: 'job', id: 'j9' }) }, 'job pin'),
        createElement('button', { type: 'button', onClick: () => props.onOpen({ kind: 'customer', id: 'c9' }) }, 'customer pin'),
      ),
  };
});

vi.mock('../src/features/storm/StormSwathMap.tsx', () => ({ StormSwathMap: () => null }));

const DETAIL = {
  storm: {
    id: 's1',
    placeName: 'Maple Ridge',
    day: '2026-10-10',
    maxIn: 1.75,
    status: 'final',
    customersHit: 12,
    homesHit: 340,
    planTaskId: null,
    planStatus: null,
  },
  swath: { type: 'FeatureCollection', features: [] },
  results: {
    textsSent: 0,
    textsDelivered: 0,
    replies: 0,
    yesReplies: 0,
    emailsSent: 0,
    unsubscribes: 0,
    doorsKnocked: 0,
    wantsCheck: 0,
    adSpendCents: 0,
    adMaxCents: 0,
    adClicks: 0,
    landingRequests: 0,
    inspectionsBooked: 0,
  },
  plan: null,
};

const CALENDAR_NONE = { provider: null, status: null, accountEmail: null, calendarId: null, calendarName: null, lastSyncedAt: null, configured: { google: false, microsoft: false } };
const COMPANY = { id: 'c1', name: 'Summit Roofing', slug: 'summit-roofing', status: 'active', legalName: null, phone: null, email: null, website: null, addressStreet: null, addressCity: null, addressState: null, addressZip: null, timezone: 'America/Chicago', logoUrl: null, located: false, serviceAreaMiles: null };

let api: ReturnType<typeof stubApi>;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  expect(api?.unexpected ?? []).toEqual([]);
});

/** A signed-in person whose shell reads answer "nothing", unless a test gives its own answers. */
function signedInApi(account = ACCOUNT, overrides: Routes = {}) {
  api = stubApi({
    ...SHELL_ROUTES,
    'GET /api/auth/me': () => ({ body: account }),
    // The Connections tab reads the ad accounts too; none are linked unless a test says so
    'GET /api/ads/accounts': () => ({ body: { accounts: [], managerId: null, businessId: null } }),
    // C1's calendar card on Connections, the company read in Settings and E1's proposals list in the Estimator
    'GET /api/calendar/connection': () => ({ body: CALENDAR_NONE }),
    'GET /api/company': () => ({ body: COMPANY }),
    ...proposalListRoutes(),
    ...overrides,
  });
  return api;
}

function renderApp(path: string) {
  const queryClient = createQueryClient();
  queryClient.setDefaultOptions({ queries: { retry: false } });
  const router = createAppRouter({ initialEntries: [path] });
  render(
    <Providers client={queryClient}>
      <RouterProvider router={router} />
    </Providers>,
  );
  return { router, queryClient, user: userEvent.setup() };
}

/** A dock link by its label. Its name also holds the "Coming soon" note and any badge, so only the start of the name is matched. */
function dockLink(dockNav: HTMLElement, label: string) {
  return within(dockNav).getByRole('link', { name: new RegExp('^' + label) });
}

describe('S1 Storm windows', () => {
  it('/storm/routes shows the empty line when the rep has no routes', async () => {
    const api = signedInApi(ACCOUNT, { 'GET /api/routes/mine': () => ({ body: { routes: [] } }) });
    renderApp('/storm/routes');

    expect(await screen.findByText(doors.myRoutesEmpty)).toBeInTheDocument();
    expect(api.count('GET /api/storms/routes')).toBe(0);
  });

  it('/storm/routes/r1 shows that route', async () => {
    signedInApi(ACCOUNT, {
      'GET /api/routes/r1': () => ({
        body: {
          route: {
            id: 'r1',
            companyStormId: 'cs1',
            stormId: 'st1',
            userId: 'u1',
            name: 'Omaha · Route 1 (Sam)',
            status: 'ready',
            stops: 0,
            doneStops: 0,
          },
          stops: [],
        },
      }),
    });
    renderApp('/storm/routes/r1');

    expect(await screen.findByRole('heading', { name: 'Omaha · Route 1 (Sam)' })).toBeInTheDocument();
  });

  it('/storm shows the storms list', async () => {
    signedInApi();
    renderApp('/storm');

    expect(await screen.findByText(storm.empty)).toBeInTheDocument();
  });

  it('/storm/s1 shows that storm', async () => {
    signedInApi(ACCOUNT, { 'GET /api/storms/s1': () => ({ body: DETAIL }) });
    renderApp('/storm/s1');

    expect(await screen.findByRole('heading', { level: 1, name: 'Maple Ridge' })).toBeInTheDocument();
  });

  it('the dock Storm opens /storm', async () => {
    // It starts on the Estimator, which lists proposals by status (E1's per-status groups).
    signedInApi(ACCOUNT, proposalListRoutes());
    const { router, user } = renderApp('/estimator');
    const dockNav = await screen.findByRole('navigation', { name: dock.label });
    const link = dockLink(dockNav, WINDOW_COPY.storm.title);

    expect(link.textContent ?? '').not.toContain(dock.comingSoon);
    expect(link.getAttribute('href')).toBe('/storm');
    await user.click(link);

    await waitFor(() => expect(where(router)).toBe('/storm'));
  });

  it.each([
    ['owner', ACCOUNT],
    ['office', { ...ACCOUNT, role: 'office' as const }],
  ])('Settings shows the Storm tab for %s', async (_role, account) => {
    signedInApi(account);
    renderApp('/settings/connections');
    const tabs = await screen.findByRole('navigation', { name: settings.tabsLabel });

    expect(within(tabs).getByRole('link', { name: settings.tabs.storm })).toBeInTheDocument();
  });

  it('Settings hides the Storm tab from a rep', async () => {
    signedInApi({ ...ACCOUNT, role: 'rep' });
    renderApp('/settings/connections');
    const tabs = await screen.findByRole('navigation', { name: settings.tabsLabel });

    expect(within(tabs).queryByRole('link', { name: settings.tabs.storm })).toBeNull();
  });

  it('Settings Connections shows the ad slot', async () => {
    signedInApi();
    renderApp('/settings/connections');

    expect(await screen.findByRole('heading', { name: connections.googleAds })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: connections.meta })).toBeInTheDocument();
    expect(screen.getAllByText(connections.later)).toHaveLength(1);
  });
});
