import { instantEstimate, type ProposalStatus } from '@roofline/shared';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
// RouterProvider from 'react-router', not 'react-router/dom': under Vitest the two load as separate copies of the router
import { RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient, Providers } from '../src/app/providers.tsx';
import { createAppRouter } from '../src/app/router.tsx';
import { measure } from '../src/copy/measure.ts';
import { WINDOW_COPY } from '../src/copy/dock.ts';
import type { MeasurementView } from '../src/features/measure/types.ts';
import { ACCOUNT, proposalListRoutes, type Routes, SHELL_ROUTES, stubApi, where } from './helpers.tsx';

// The real map loads maplibre-gl, which these tests never need.
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

let api: ReturnType<typeof stubApi>;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  expect(api?.unexpected ?? []).toEqual([]);
});

function measurement(id: string, drawMode: boolean): MeasurementView {
  return {
    id,
    propertyId: 'pr1',
    jobId: null,
    kind: 'estimate',
    method: 'outline',
    drawMode,
    hasCustomer: true,
    roof: null,
    section: null,
    outline: null,
    structures: [],
    overhangFt: 1,
    center: [-97.7, 30.3],
    estimate: instantEstimate({ outline: [], pitchX12: 6, overhangFt: 1, valleyFt: 0 }),
    locked: false,
    facets: null,
    providerRef: null,
    notes: null,
    createdAt: '2026-10-12T12:00:00.000Z',
  };
}

function proposal(id: string, number: string, status: ProposalStatus, name = 'Maria Lopez', address = '12 Oak St', measurementId = 'm1') {
  return {
    id, number, status, jobId: 'j1', customer: { id: 'c1', name, phone: null },
    address, measurementId, basis: 'exact', options: [], messageBody: '', validUntil: '2026-11-12',
    sentAt: null, views: { count: 0, first: null, last: null }, signed: null, declined: null, taskId: null, replacedById: null, canEdit: true,
  };
}

function signedInApi(overrides: Routes = {}) {
  api = stubApi({ ...SHELL_ROUTES, 'GET /api/auth/me': () => ({ body: ACCOUNT }), ...overrides });
  return api;
}

function renderApp(path = '/estimator') {
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

describe('/estimator is the Measure window', () => {
  it('opens the first request, replacing /estimator in the history', async () => {
    signedInApi({
      ...proposalListRoutes([
        proposal('p1', 'P-0001', 'draft', 'Maria Lopez', '12 Oak St', 'm1'),
        proposal('p2', 'P-0002', 'draft', 'Dana Fox', '9 Pine Ln', 'm2'),
      ]),
      'GET /api/measurements/m1': () => ({ body: measurement('m1', false) }),
    });
    const { router } = renderApp();

    await waitFor(() => expect(where(router)).toBe('/estimator/measure/m1'));
    // Back does not land on the redirect again: /estimator was replaced
    expect(router.state.historyAction).toBe('REPLACE');
    const dialog = screen.getByRole('dialog', { name: WINDOW_COPY.estimator.title });
    expect(within(dialog).getByRole('searchbox', { name: measure.requestsSearch })).toBeInTheDocument();
    expect(within(dialog).getAllByText(measure.subtitle).length).toBeGreaterThan(0);
    expect(within(dialog).getByText('Dana Fox')).toBeInTheDocument();
    // None of the old page
    expect(screen.queryByText('Find a proposal')).toBeNull();
  });

  it('is named Measure, in the dialog and the dock', async () => {
    signedInApi(proposalListRoutes());
    renderApp();

    expect(WINDOW_COPY.estimator.title).toBe('Measure');
    expect(await screen.findByRole('dialog', { name: 'Measure' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /^Measure/ })).toHaveAttribute('href', '/estimator');
  });

  it('says what to do when there is no request to open', async () => {
    signedInApi(proposalListRoutes());
    const { router } = renderApp();

    expect(await screen.findByText(measure.pickRequest)).toBeInTheDocument();
    expect(where(router)).toBe('/estimator');
  });

  it('measures a typed address from /estimator: the search offers it and opens the new measurement', async () => {
    signedInApi({
      ...proposalListRoutes(),
      ...proposalListRoutes([], '99 Elm Rd'),
      'POST /api/measurements': () => ({ body: measurement('m3', false) }),
      'GET /api/measurements/m3': () => ({ body: measurement('m3', false) }),
    });
    const { router, user } = renderApp();
    await user.type(await screen.findByRole('searchbox', { name: measure.requestsSearch }), '99 Elm Rd');
    await user.click(await screen.findByRole('button', { name: measure.measureNew('99 Elm Rd') }));

    await waitFor(() => expect(where(router)).toBe('/estimator/measure/m3'));
    expect(api.sent('POST /api/measurements')).toEqual([{ address: '99 Elm Rd' }]);
  });

  it('keeps sent and signed proposals reachable from their rows, and no link for a draft', async () => {
    signedInApi({
      ...proposalListRoutes([
        proposal('p1', 'P-0001', 'draft', 'Maria Lopez', '12 Oak St', 'm1'),
        proposal('p3', 'P-0003', 'sent', 'Carmen Castellano', '410 Truss Ave', 'm3'),
        proposal('p5', 'P-0005', 'signed', 'Graham Mendel', '416 Transom Ct', 'm5'),
      ]),
      'GET /api/measurements/m1': () => ({ body: measurement('m1', false) }),
    });
    const { router } = renderApp();
    await waitFor(() => expect(where(router)).toBe('/estimator/measure/m1'));

    const sent = await screen.findByRole('link', { name: measure.proposalLinkLabel('Carmen Castellano') });
    expect(sent).toHaveAttribute('href', '/estimator/proposals/p3');
    expect(screen.getByRole('link', { name: measure.proposalLinkLabel('Graham Mendel') })).toHaveAttribute('href', '/estimator/proposals/p5');
    expect(screen.queryByRole('link', { name: measure.proposalLinkLabel('Maria Lopez') })).toBeNull();
    // The row itself opens the measurement
    expect(screen.getByText('Carmen Castellano').closest('a')).toHaveAttribute('href', '/estimator/measure/m3');
  });
});
