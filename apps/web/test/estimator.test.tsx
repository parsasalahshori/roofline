import { instantEstimate, type ProposalStatus } from '@roofline/shared';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
// RouterProvider from 'react-router', not 'react-router/dom': under Vitest the two load as separate copies of the router
import { RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient, Providers } from '../src/app/providers.tsx';
import { createAppRouter } from '../src/app/router.tsx';
import { estimator } from '../src/copy/estimator.ts';
import type { MeasurementView } from '../src/features/measure/types.ts';
import { ACCOUNT, makeTask, proposalListRoutes, type Routes, SHELL_ROUTES, stubApi, where } from './helpers.tsx';

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

function proposal(id: string, number: string, status: ProposalStatus, name = 'Maria Lopez', address = '12 Oak St') {
  return {
    id, number, status, jobId: 'j1', customer: { id: 'c1', name, phone: null },
    address, measurementId: 'm1', basis: 'exact', options: [], messageBody: '', validUntil: '2026-11-12',
    sentAt: null, views: { count: 0, first: null, last: null }, signed: null, declined: null, taskId: null, replacedById: null, canEdit: true,
  };
}

const FIVE = [
  proposal('p1', 'P-0001', 'draft'),
  proposal('p2', 'P-0002', 'ready', 'Dana Fox', '9 Pine Ln'),
  proposal('p3', 'P-0003', 'sent'),
  proposal('p4', 'P-0004', 'viewed'),
  proposal('p5', 'P-0005', 'signed'),
];

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

function group(title: string): HTMLElement {
  const section = screen.getByRole('heading', { name: title }).closest('section');
  if (!section) throw new Error('no section');
  return section;
}

const HOME = { id: 'pr1', customerId: 'c1', addressLine: '12 Oak St', city: 'Austin', state: 'TX', zip: '78701', lat: 30.3, lng: -97.7 };

/** Routes for the make-proposal flow that ends on the approval review. */
function flowRoutes(extra: Routes = {}): Routes {
  return {
    ...proposalListRoutes(),
    'POST /api/measurements': () => ({ body: measurement('m1', false) }),
    'POST /api/proposals': () => ({ body: proposal('p1', 'P-0001', 'draft') }),
    'POST /api/proposals/p1/send': () => ({ body: { taskId: 't1' } }),
    'GET /api/approvals/t1': () => ({ body: makeTask({ id: 't1', status: 'draft', steps: [] }) }),
    ...extra,
  };
}

describe('Estimator window', () => {
  it('groups the proposals', async () => {
    signedInApi(proposalListRoutes(FIVE));
    renderApp();

    expect(await screen.findByText('P-0001')).toBeInTheDocument();
    const review = within(group(estimator.groups.review));
    expect(review.getByText('P-0001')).toBeInTheDocument();
    expect(review.getByText('P-0002')).toBeInTheDocument();
    expect(review.queryByText('P-0003')).toBeNull();
    const out = within(group(estimator.groups.out));
    expect(out.getByText('P-0003')).toBeInTheDocument();
    expect(out.getByText('P-0004')).toBeInTheDocument();
    const signed = within(group(estimator.groups.signed));
    expect(signed.getByText('P-0005')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /P-0005/ })).toHaveAttribute('href', '/estimator/proposals/p5');
    for (const key of ['review', 'out', 'signed'] as const) {
      expect(within(group(estimator.groups[key])).queryByText(estimator.emptyGroup)).toBeNull();
    }
  });

  it('has Declined and Expired groups', async () => {
    signedInApi(proposalListRoutes([...FIVE, proposal('p6', 'P-0006', 'declined'), proposal('p7', 'P-0007', 'expired', 'Sam Roe')]));
    renderApp();

    expect(await screen.findByText('P-0006')).toBeInTheDocument();
    expect(within(group(estimator.groups.declined)).getByText('P-0006')).toBeInTheDocument();
    expect(within(group(estimator.groups.expired)).getByText('P-0007')).toBeInTheDocument();
  });

  it('pages a group with Show more so nothing past 50 disappears', async () => {
    const many = Array.from({ length: 60 }, (_, i) => proposal(`s${i}`, `S-${String(i).padStart(4, '0')}`, 'signed'));
    signedInApi({
      ...proposalListRoutes(),
      'GET /api/proposals?status=signed': () => ({ body: { proposals: many.slice(0, 50), total: 60 } }),
      'GET /api/proposals?status=signed&offset=50': () => ({ body: { proposals: many.slice(50), total: 60 } }),
    });
    const { user } = renderApp();

    await screen.findByText('S-0000');
    expect(screen.queryByText('S-0059')).toBeNull();
    const section = within(group(estimator.groups.signed));
    await user.click(section.getByRole('button', { name: estimator.showMore }));
    expect(await screen.findByText('S-0059')).toBeInTheDocument();
    expect(section.queryByRole('button', { name: estimator.showMore })).toBeNull();
  });

  it('searches proposals by name or address with the server filter', async () => {
    signedInApi({ ...proposalListRoutes(FIVE), ...proposalListRoutes([FIVE[1] as (typeof FIVE)[number]], 'Dana') });
    const { user } = renderApp();

    await screen.findByText('P-0001');
    await user.type(screen.getByLabelText(estimator.findLabel), 'Dana');
    await waitFor(() => expect(screen.queryByText('P-0001')).toBeNull());
    expect(await screen.findByText('P-0002')).toBeInTheDocument();
    expect(api.calls.map((c) => c.key)).toContain('GET /api/proposals?status=ready&q=Dana');
  });

  it('shows the server message when Make proposal is refused', async () => {
    signedInApi(
      flowRoutes({
        'GET /api/properties?q=12%20Oak&limit=8': () => ({ body: { properties: [HOME], total: 1 } }),
        'POST /api/proposals': () => ({ status: 403, body: { error: 'Your role cannot do that.' } }),
      }),
    );
    const { user } = renderApp();

    await user.type(await screen.findByLabelText(estimator.addressLabel), '12 Oak');
    await user.click(await screen.findByRole('button', { name: /12 Oak St/ }));
    await user.click(screen.getByRole('button', { name: estimator.makeProposal }));
    expect(await screen.findByText('Your role cannot do that.')).toBeInTheDocument();
  });

  it('shows the empty note for a group with nothing in it', async () => {
    signedInApi(proposalListRoutes(FIVE.slice(0, 4)));
    renderApp();

    await screen.findByText('P-0001');
    expect(within(group(estimator.groups.signed)).getByText(estimator.emptyGroup)).toBeInTheDocument();
    expect(within(group(estimator.groups.review)).queryByText(estimator.emptyGroup)).toBeNull();
  });

  it('Make proposal posts measure, build and send in order and opens the review', async () => {
    signedInApi(
      flowRoutes({
        'GET /api/properties?q=12%20Oak&limit=8': () => ({ body: { properties: [HOME], total: 1 } }),
      }),
    );
    const { router, user } = renderApp();

    await user.type(await screen.findByLabelText(estimator.addressLabel), '12 Oak');
    await user.click(await screen.findByRole('button', { name: /12 Oak St/ }));
    await user.click(screen.getByRole('button', { name: estimator.makeProposal }));

    await waitFor(() => expect(where(router)).toBe('/approvals/t1'));
    expect(api.calls.map((c) => c.key).filter((k) => k.startsWith('POST /api/m') || k.startsWith('POST /api/p'))).toEqual([
      'POST /api/measurements',
      'POST /api/proposals',
      'POST /api/proposals/p1/send',
    ]);
    expect(api.sent('POST /api/measurements')).toEqual([{ propertyId: 'pr1' }]);
    expect(api.sent('POST /api/proposals')).toEqual([{ measurementId: 'm1' }]);
  });

  it('a saved home nobody owns asks for the customer and sends it', async () => {
    signedInApi(
      flowRoutes({
        'GET /api/properties?q=12%20Oak&limit=8': () => ({ body: { properties: [{ ...HOME, customerId: null }], total: 1 } }),
      }),
    );
    const { router, user } = renderApp();

    await user.type(await screen.findByLabelText(estimator.addressLabel), '12 Oak');
    await user.click(await screen.findByRole('button', { name: /12 Oak St/ }));
    expect(screen.getByRole('button', { name: estimator.makeProposal })).toBeDisabled();
    await user.type(screen.getByLabelText(estimator.customerName), 'Dana Fox');
    await user.type(screen.getByLabelText(estimator.customerPhone), '5125550100');
    await user.click(screen.getByRole('button', { name: estimator.makeProposal }));

    await waitFor(() => expect(where(router)).toBe('/approvals/t1'));
    expect(api.sent('POST /api/measurements')).toEqual([{ propertyId: 'pr1' }]);
    expect(api.sent('POST /api/proposals')).toEqual([
      { measurementId: 'm1', customer: { name: 'Dana Fox', phone: '5125550100', askedByText: false } },
    ]);
  });

  it('opens draw mode when the outline is not found', async () => {
    signedInApi(
      flowRoutes({
        'GET /api/properties?q=12%20Oak&limit=8': () => ({ body: { properties: [HOME], total: 1 } }),
        'POST /api/measurements': () => ({ body: measurement('m2', true) }),
        'GET /api/measurements/m2': () => ({ body: measurement('m2', true) }),
      }),
    );
    const { router, user } = renderApp();

    await user.type(await screen.findByLabelText(estimator.addressLabel), '12 Oak');
    await user.click(await screen.findByRole('button', { name: /12 Oak St/ }));
    await user.click(screen.getByRole('button', { name: estimator.makeProposal }));

    await waitFor(() => expect(where(router)).toBe('/estimator/measure/m2'));
    expect(api.count('POST /api/proposals')).toBe(0);
    expect(router.state.location.state).toEqual({});
  });

  it('draw mode carries the new customer in router state', async () => {
    signedInApi(
      flowRoutes({
        'GET /api/properties?q=12%20Oak&limit=8': () => ({ body: { properties: [{ ...HOME, customerId: null }], total: 1 } }),
        'POST /api/measurements': () => ({ body: measurement('m2', true) }),
        'GET /api/measurements/m2': () => ({ body: measurement('m2', true) }),
      }),
    );
    const { router, user } = renderApp();

    await user.type(await screen.findByLabelText(estimator.addressLabel), '12 Oak');
    await user.click(await screen.findByRole('button', { name: /12 Oak St/ }));
    await user.type(screen.getByLabelText(estimator.customerName), 'Dana Fox');
    await user.type(screen.getByLabelText(estimator.customerPhone), '5125550100');
    await user.click(screen.getByRole('button', { name: estimator.makeProposal }));

    await waitFor(() => expect(where(router)).toBe('/estimator/measure/m2'));
    expect(router.state.location.state).toEqual({ customer: { name: 'Dana Fox', phone: '5125550100', askedByText: false } });
  });

  async function fillAddress(user: ReturnType<typeof userEvent.setup>, tick: boolean) {
    await user.type(await screen.findByLabelText(estimator.addressLabel), '99 Elm Rd, Austin TX{Enter}');
    await user.type(await screen.findByLabelText(estimator.customerName), 'Dana Fox');
    await user.type(screen.getByLabelText(estimator.customerPhone), '5125550100');
    if (tick) await user.click(screen.getByLabelText(estimator.askedByText));
    await user.click(screen.getByRole('button', { name: estimator.makeProposal }));
  }

  const ADDRESS_SEARCH = 'GET /api/properties?q=99%20Elm%20Rd%2C%20Austin%20TX&limit=8';

  it('a typed address sends the address and the new customer with askedByText', async () => {
    signedInApi(
      flowRoutes({
        [ADDRESS_SEARCH]: () => ({ body: { properties: [], total: 0 } }),
        'POST /api/measurements': () => ({ body: measurement('m3', false) }),
      }),
    );
    const { router, user } = renderApp();
    await fillAddress(user, true);

    await waitFor(() => expect(where(router)).toBe('/approvals/t1'));
    expect(api.sent('POST /api/measurements')).toEqual([{ address: '99 Elm Rd, Austin TX' }]);
    expect(api.sent('POST /api/proposals')).toEqual([
      { measurementId: 'm3', customer: { name: 'Dana Fox', phone: '5125550100', askedByText: true } },
    ]);
  });

  it('sends askedByText false when the box is not ticked', async () => {
    signedInApi(
      flowRoutes({
        [ADDRESS_SEARCH]: () => ({ body: { properties: [], total: 0 } }),
        'POST /api/measurements': () => ({ body: measurement('m3', false) }),
      }),
    );
    const { router, user } = renderApp();
    await fillAddress(user, false);

    await waitFor(() => expect(where(router)).toBe('/approvals/t1'));
    expect(api.sent('POST /api/proposals')).toEqual([
      { measurementId: 'm3', customer: { name: 'Dana Fox', phone: '5125550100', askedByText: false } },
    ]);
  });

  it('a failed send retries without measuring or building again', async () => {
    let sendCalls = 0;
    signedInApi(
      flowRoutes({
        'GET /api/properties?q=12%20Oak&limit=8': () => ({ body: { properties: [HOME], total: 1 } }),
        'POST /api/proposals/p1/send': () =>
          sendCalls++ === 0 ? { status: 500, body: { error: 'boom' } } : { body: { taskId: 't1' } },
      }),
    );
    const { router, user } = renderApp();

    await user.type(await screen.findByLabelText(estimator.addressLabel), '12 Oak');
    await user.click(await screen.findByRole('button', { name: /12 Oak St/ }));
    await user.click(screen.getByRole('button', { name: estimator.makeProposal }));
    expect(await screen.findByText(estimator.makeFailed)).toHaveAttribute('role', 'alert');
    await user.click(await screen.findByRole('button', { name: estimator.makeProposal }));

    await waitFor(() => expect(where(router)).toBe('/approvals/t1'));
    expect(api.count('POST /api/measurements')).toBe(1);
    expect(api.count('POST /api/proposals')).toBe(1);
    expect(api.count('POST /api/proposals/p1/send')).toBe(2);
  });

  it('Make proposal stays disabled until name and phone are filled', async () => {
    signedInApi(flowRoutes({ [ADDRESS_SEARCH]: () => ({ body: { properties: [], total: 0 } }) }));
    const { user } = renderApp();

    await user.type(await screen.findByLabelText(estimator.addressLabel), '99 Elm Rd, Austin TX{Enter}');
    const button = await screen.findByRole('button', { name: estimator.makeProposal });
    expect(button).toBeDisabled();
    await user.type(screen.getByLabelText(estimator.customerName), 'Dana Fox');
    expect(button).toBeDisabled();
    await user.type(screen.getByLabelText(estimator.customerPhone), '5125550100');
    expect(button).toBeEnabled();
  });

  it('shows the error and re-enables Make proposal when a step fails', async () => {
    signedInApi(
      flowRoutes({
        'GET /api/properties?q=12%20Oak&limit=8': () => ({ body: { properties: [HOME], total: 1 } }),
        'POST /api/measurements': () => ({ status: 500, body: { error: 'boom' } }),
      }),
    );
    const { router, user } = renderApp();

    await user.type(await screen.findByLabelText(estimator.addressLabel), '12 Oak');
    await user.click(await screen.findByRole('button', { name: /12 Oak St/ }));
    await user.click(screen.getByRole('button', { name: estimator.makeProposal }));

    const note = await screen.findByText(estimator.makeFailed);
    expect(note).toHaveAttribute('role', 'alert');
    expect(screen.getByRole('button', { name: estimator.makeProposal })).toBeEnabled();
    expect(where(router)).toBe('/estimator');
    expect(api.count('POST /api/proposals')).toBe(0);
  });

  it('shows the no-homes note when the search finds nothing', async () => {
    signedInApi(
      flowRoutes({
        'GET /api/properties?q=12%20Oak&limit=8': () => ({ body: { properties: [], total: 0 } }),
      }),
    );
    const { user } = renderApp();

    await user.type(await screen.findByLabelText(estimator.addressLabel), '12 Oak');
    expect(await screen.findByText(estimator.noHomes)).toBeInTheDocument();
  });

  it('shows the lists note when proposals fail to load', async () => {
    signedInApi({ ...proposalListRoutes(), 'GET /api/proposals?status=signed': () => ({ status: 500, body: { error: 'boom' } }) });
    renderApp();

    expect(await screen.findByText(estimator.listsFailed)).toBeInTheDocument();
  });
});
