import { instantEstimate } from '@roofline/shared';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
// RouterProvider from 'react-router', not 'react-router/dom': under Vitest the two load as separate copies of the router
import { RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient, Providers } from '../src/app/providers.tsx';
import { createAppRouter } from '../src/app/router.tsx';
import { dock, WINDOW_COPY } from '../src/copy/dock.ts';
import { estimator } from '../src/copy/estimator.ts';
import { homeowner } from '../src/copy/homeowner.ts';
import { measure } from '../src/copy/measure.ts';
import { prices } from '../src/copy/prices.ts';
import { proposals } from '../src/copy/proposals.ts';
import { tiers } from '../src/copy/tiers.ts';
import type { MeasurementView } from '../src/features/measure/types.ts';
import { ACCOUNT, type Routes, SHELL_ROUTES, stubApi, where } from './helpers.tsx';

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

vi.mock('maplibre-gl', () => ({
  Map: class {
    constructor() {
      throw new Error('no webgl');
    }
  },
  Marker: class {},
  NavigationControl: class {},
}));

const MEASUREMENT: MeasurementView = {
  id: 'm1',
  propertyId: 'pr1',
  jobId: null,
  kind: 'estimate',
  method: 'outline',
  drawMode: false,
  outline: null,
  structures: [],
  pitchX12: 6,
  overhangFt: 1,
  valleyFt: 0,
  center: [-97.7, 30.3],
  estimate: instantEstimate({ outline: [], pitchX12: 6, overhangFt: 1, valleyFt: 0 }),
  locked: false,
};

let api: ReturnType<typeof stubApi>;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  expect(api?.unexpected ?? []).toEqual([]);
});

/** A signed-in person whose shell reads answer "nothing", unless a test gives its own answers. */
function signedInApi(account = ACCOUNT, overrides: Routes = {}) {
  api = stubApi({ ...SHELL_ROUTES, 'GET /api/auth/me': () => ({ body: account }), ...overrides });
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

describe('E1 windows', () => {
  it.each([
    ['/estimator', estimator.comingSoon],
    ['/estimator/proposals/p1', proposals.comingSoon],
  ])('%s shows its placeholder', async (path, copy) => {
    signedInApi();
    renderApp(path);

    expect(await screen.findByText(copy)).toBeInTheDocument();
  });

  it('/estimator/measure/m1 opens the measure window', async () => {
    signedInApi(ACCOUNT, { 'GET /api/measurements/m1': () => ({ body: MEASUREMENT }) });
    renderApp('/estimator/measure/m1');

    expect(await screen.findByText(measure.numbersTitle)).toBeInTheDocument();
  });

  it('/p/abc renders without a session and without the shell', async () => {
    api = stubApi({
      'GET /api/auth/me': () => ({ status: 401, body: { error: 'Sign in first.' } }),
      'GET /api/public/proposals/abc': () => ({ status: 404, body: { error: homeowner.goneTitle } }),
    });
    const { router } = renderApp('/p/abc');

    expect(await screen.findByText(homeowner.goneTitle)).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: dock.label })).toBeNull();
    expect(document.querySelector('[data-map-mock]')).toBeNull();
    expect(where(router)).toBe('/p/abc');
  });

  it('the dock Estimator has no Coming soon note', async () => {
    signedInApi();
    renderApp('/estimator');
    const dockNav = await screen.findByRole('navigation', { name: dock.label });

    expect(dockLink(dockNav, WINDOW_COPY.estimator.title).textContent ?? '').not.toContain(dock.comingSoon);
    expect(dockLink(dockNav, WINDOW_COPY.storm.title).textContent ?? '').toContain(dock.comingSoon);
  });

  it('Settings Prices shows the three E1 sections', async () => {
    signedInApi();
    renderApp('/settings/prices');

    expect(await screen.findByText(tiers.tiersComingSoon)).toBeInTheDocument();
    expect(await screen.findByText(tiers.financingComingSoon)).toBeInTheDocument();
    expect(await screen.findByText(tiers.estimateComingSoon)).toBeInTheDocument();
    expect(await screen.findByText(prices.comingSoon)).toBeInTheDocument();
  });
});
