import { instantEstimate } from '@roofline/shared';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
// RouterProvider from 'react-router', not 'react-router/dom': under Vitest the two load as separate copies of the router
import { RouterProvider } from 'react-router';
import { DEFAULT_TIER_TEMPLATES, defaultPricebook } from '@roofline/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient, Providers } from '../src/app/providers.tsx';
import { createAppRouter } from '../src/app/router.tsx';
import { dock, WINDOW_COPY } from '../src/copy/dock.ts';
import { estimator } from '../src/copy/estimator.ts';
import { homeowner } from '../src/copy/homeowner.ts';
import { measure } from '../src/copy/measure.ts';
import { prices } from '../src/copy/prices.ts';
import { proposals } from '../src/copy/proposals.ts';
import type { MeasurementView } from '../src/features/measure/types.ts';
import { estimateCopy, financeCopy } from '../src/copy/financeEstimate.ts';
import { tierEditor } from '../src/copy/tiersEditor.ts';
import type { EstimatorSettings } from '@roofline/shared';
import { ACCOUNT, proposalListRoutes, type Routes, SHELL_ROUTES, stubApi, where } from './helpers.tsx';

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
  overhangFt: 1,
  center: [-97.7, 30.3],
  estimate: instantEstimate({ outline: [], pitchX12: 6, overhangFt: 1, valleyFt: 0 }),
  facets: null,
  providerRef: null,
  notes: null,
  createdAt: '2026-10-12T12:00:00.000Z',
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
  it('/estimator shows the address box', async () => {
    signedInApi(ACCOUNT, proposalListRoutes());
    renderApp('/estimator');

    expect(await screen.findByLabelText(estimator.addressLabel)).toBeInTheDocument();
  });

  it('/estimator/measure/m1 opens the measure window', async () => {
    signedInApi(ACCOUNT, { 'GET /api/measurements/m1': () => ({ body: MEASUREMENT }) });
    renderApp('/estimator/measure/m1');

    expect(await screen.findByText(measure.numbersTitle)).toBeInTheDocument();
  });

  it('/estimator/proposals/p1 shows the proposal', async () => {
    signedInApi(ACCOUNT, {
      'GET /api/proposals/p1': () => ({
        body: {
          id: 'p1', number: 'P-0001', status: 'draft', jobId: 'j1', customer: { id: 'c1', name: 'Maria Lopez', phone: null },
          address: '12 Oak St', measurementId: 'm1', basis: 'exact', options: [], messageBody: '', validUntil: '2026-11-12',
          sentAt: null, views: { count: 0, first: null, last: null }, signed: null, declined: null, taskId: null, replacedById: null, canEdit: true,
        },
      }),
      'GET /api/pricebook': () => ({ status: 403, body: { error: 'Not allowed.' } }),
      'GET /api/company': () => ({ body: { id: 'c1', name: 'Summit Roofing', slug: 'summit-roofing', status: 'active', timezone: 'America/Chicago' } }),
    });
    renderApp('/estimator/proposals/p1');

    expect(await screen.findByText(proposals.title('P-0001'))).toBeInTheDocument();
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
    signedInApi(ACCOUNT, proposalListRoutes());
    renderApp('/estimator');
    const dockNav = await screen.findByRole('navigation', { name: dock.label });

    expect(dockLink(dockNav, WINDOW_COPY.estimator.title).textContent ?? '').not.toContain(dock.comingSoon);
    expect(dockLink(dockNav, WINDOW_COPY.storm.title).textContent ?? '').not.toContain(dock.comingSoon);
    expect(dockLink(dockNav, WINDOW_COPY['front-desk'].title).textContent ?? '').toContain(dock.comingSoon);
  });

  it('Settings Prices shows the three E1 sections', async () => {
    const settingsBody: EstimatorSettings = {
      defaultPitchX12: 6,
      overhangFt: 1,
      proposalValidDays: 30,
      aerialMeasure: false,
      aerialConfigured: false,
      estimateChangeClause: true,
      financingAprBps: null,
      financingTermMonths: null,
    };
    signedInApi(ACCOUNT, {
      'GET /api/tier-templates': () => ({ body: { templates: DEFAULT_TIER_TEMPLATES.map((t) => ({ ...t, addOns: [...t.addOns], highlights: [...t.highlights] })) } }),
      'GET /api/estimator/settings': () => ({ body: settingsBody }),
      'GET /api/pricebook': () => ({ body: { prices: defaultPricebook, defaults: { wastePercent: 12, markupPercent: 25, taxPercent: 0, material: 'architectural' }, isExample: false } }),
    });
    renderApp('/settings/prices');

    expect(await screen.findByRole('heading', { name: tierEditor.title })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: financeCopy.title })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: estimateCopy.title })).toBeInTheDocument();
    expect(await screen.findByLabelText(prices.fields.permit)).toBeInTheDocument();
  });
});
