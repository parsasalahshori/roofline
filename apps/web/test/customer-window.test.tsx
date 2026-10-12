import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
// RouterProvider from 'react-router', not 'react-router/dom': under Vitest the two load as separate copies of the router
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CustomerView } from '@roofline/shared';
import { createQueryClient, Providers } from '../src/app/providers.tsx';
import { create } from '../src/copy/create.ts';
import { customers } from '../src/copy/customers.ts';
import { jobs } from '../src/copy/jobs.ts';
import { CustomerWindow } from '../src/features/customers/CustomerWindow.tsx';
import { ACCOUNT, stubApi, where } from './helpers.tsx';

let api: ReturnType<typeof stubApi>;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  expect(api?.unexpected ?? []).toEqual([]);
});

/** A customer with one located home, one home not on the map, a job, and an inspection booked. */
function makeView(overrides: { customer?: Partial<CustomerView['customer']>; can?: Partial<CustomerView['can']> } = {}): CustomerView {
  return {
    customer: {
      id: 'c1',
      displayName: 'Dana Homeowner',
      firstName: 'Dana',
      lastName: 'Homeowner',
      phones: [
        { e164: '+15551230001', label: 'Mobile', primary: true },
        { e164: '+15551230002', label: null, primary: false },
      ],
      emails: ['dana@example.com'],
      tags: ['storm'],
      consent: 'written',
      doNotContact: false,
      source: 'manual',
      archived: false,
      createdAt: '2026-09-01T12:00:00.000Z',
      ...overrides.customer,
    },
    homes: [
      { id: 'p1', addressLine: '12 Oak Street', city: 'Plano', state: 'TX', zip: '75024', located: true, jobs: [{ id: 'j1', stage: 'lead' }] },
      { id: 'p2', addressLine: '98 Pine Road', city: 'Frisco', state: 'TX', zip: '75034', located: false, jobs: [] },
    ],
    jobs: [
      {
        id: 'j1',
        customerId: 'c1',
        customerName: 'Dana Homeowner',
        propertyId: 'p1',
        addressLine: '12 Oak Street',
        stage: 'lead',
        valueCents: null,
        assigned: null,
        daysInStage: 2,
        stuck: false,
        nextStep: null,
        nextStepOn: null,
        updatedAt: '2026-10-10T12:00:00.000Z',
      },
    ],
    upcoming: [
      {
        id: 'a1',
        kind: 'inspection',
        title: 'Roof inspection',
        status: 'scheduled',
        startsAt: '2026-10-14T15:00:00.000Z',
        endsAt: '2026-10-14T16:00:00.000Z',
        allDay: false,
        assigned: null,
        jobId: 'j1',
        customerId: 'c1',
        customerName: 'Dana Homeowner',
        propertyId: 'p1',
        addressLine: '12 Oak Street',
        notes: null,
        source: 'manual',
        sync: 'none',
        canEdit: true,
      },
    ],
    can: { edit: true, changeConsent: true, archive: true, ...overrides.can },
  };
}

/** The customer's window, routed the way the app routes it, with the signed-in person and the company's zone answered. */
function signedInApi(view: CustomerView = makeView(), overrides: Record<string, () => { status?: number; body?: unknown }> = {}) {
  api = stubApi({
    'GET /api/auth/me': () => ({ body: ACCOUNT }),
    'GET /api/company': () => ({ body: { id: 'c1', name: 'Summit Roofing', timezone: 'America/Chicago' } }),
    'GET /api/customers/c1/view': () => ({ body: view }),
    'GET /api/timeline?customerId=c1': () => ({ body: { items: [], nextBefore: null } }),
    ...overrides,
  });
  return api;
}

function renderWindow(path = '/customers/c1') {
  const queryClient = createQueryClient();
  queryClient.setDefaultOptions({ queries: { retry: false } });
  const router = createMemoryRouter([{ path: '/customers/:customerId', element: <CustomerWindow /> }], { initialEntries: [path] });
  render(
    <Providers client={queryClient}>
      <RouterProvider router={router} />
    </Providers>,
  );
  return { router, queryClient, user: userEvent.setup() };
}

/** A named section of the window, found by its heading. */
const section = (name: string) => screen.findByRole('region', { name });

describe('the customer window', () => {
  it.each([
    ['none', 'No texting consent'],
    ['express', 'Texts about their own jobs only'],
    ['attested', 'OK to text'],
    ['written', 'OK to text'],
    ['revoked', 'Asked not to be texted'],
  ] as const)('the texting chip for consent %s reads "%s"', async (consent, words) => {
    signedInApi(makeView({ customer: { consent } }));
    renderWindow();

    expect(await screen.findByText(words, { exact: true })).toBeInTheDocument();
  });

  it('shows Do not contact when the customer is marked so', async () => {
    signedInApi(makeView({ customer: { doNotContact: true } }));
    renderWindow();

    expect(await screen.findByText(customers.doNotContact, { exact: true })).toBeInTheDocument();
  });

  it('does not show Do not contact for a customer who may be contacted', async () => {
    signedInApi(makeView());
    renderWindow();

    await screen.findByRole('heading', { name: 'Dana Homeowner' });
    expect(screen.queryByText(customers.doNotContact, { exact: true })).not.toBeInTheDocument();
  });

  it('renders each phone as a tel: link', async () => {
    signedInApi();
    renderWindow();

    const link = await screen.findByRole('link', { name: customers.window.callLabel('+15551230001') });
    expect(link).toHaveAttribute('href', 'tel:+15551230001');
    expect(link).toHaveTextContent('+15551230001');
  });

  it('a home not on the map says so, and Place on map posts the locate call for that home', async () => {
    signedInApi(
      makeView(),
      { 'POST /api/properties/p2/locate': () => ({ body: {} }) },
    );
    const { user } = renderWindow();

    expect(await screen.findByText(customers.window.notOnMap, { exact: true })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: customers.window.placeOnMap }));

    await waitFor(() => expect(api.count('POST /api/properties/p2/locate')).toBe(1));
    expect(await screen.findByText(customers.window.placedToast, { exact: true })).toBeInTheDocument();
  });

  it('Archive asks first: Keep customer sends nothing, Yes archive posts the archive call', async () => {
    signedInApi(makeView(), { 'POST /api/customers/c1/archive': () => ({ body: {} }) });
    const { user } = renderWindow();

    await user.click(await screen.findByRole('button', { name: customers.window.archive }));
    expect(screen.getByText(customers.window.archiveConfirm, { exact: true })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: customers.window.archiveNo }));
    expect(screen.queryByText(customers.window.archiveConfirm, { exact: true })).not.toBeInTheDocument();
    expect(api.count('POST /api/customers/c1/archive')).toBe(0);

    await user.click(screen.getByRole('button', { name: customers.window.archive }));
    await user.click(screen.getByRole('button', { name: customers.window.archiveYes }));

    await waitFor(() => expect(api.count('POST /api/customers/c1/archive')).toBe(1));
    expect(await screen.findByText(customers.window.archivedToast, { exact: true })).toBeInTheDocument();
  });

  it('an archived customer shows Restore, and Restore posts the unarchive call', async () => {
    signedInApi(makeView({ customer: { archived: true } }), { 'POST /api/customers/c1/unarchive': () => ({ body: {} }) });
    const { user } = renderWindow();

    expect(await screen.findByText(customers.window.archived, { exact: true })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: customers.window.restore }));

    await waitFor(() => expect(api.count('POST /api/customers/c1/unarchive')).toBe(1));
    expect(await screen.findByText(customers.window.restoredToast, { exact: true })).toBeInTheDocument();
    expect(api.count('POST /api/customers/c1/archive')).toBe(0);
  });

  it('the action links point at a new job, an appointment and Add a home', async () => {
    signedInApi();
    renderWindow();

    const actions = await screen.findByRole('group', { name: customers.window.actionsLabel });
    expect(within(actions).getByRole('link', { name: customers.window.newJob })).toHaveAttribute('href', '/jobs/new?customerId=c1');
    expect(within(actions).getByRole('link', { name: customers.window.bookAppointment })).toHaveAttribute('href', '/calendar/new?customerId=c1');
    expect(within(actions).getByRole('link', { name: customers.window.addHome })).toHaveAttribute('href', '/customers/c1?addHome=1');
  });

  it('mounts the timeline for this customer', async () => {
    signedInApi();
    renderWindow();

    await section(customers.window.timelineHeading);
    await waitFor(() => expect(api.count('GET /api/timeline?customerId=c1')).toBeGreaterThanOrEqual(1));
  });

  it('job rows show the stage chip', async () => {
    signedInApi();
    renderWindow();

    const jobRows = await section(customers.window.jobsHeading);
    expect(within(jobRows).getByRole('link', { name: jobs.stage.lead })).toBeInTheDocument();
  });

  it('opens the Add a home panel when the page is loaded with addHome=1', async () => {
    signedInApi();
    renderWindow('/customers/c1?addHome=1');

    expect(await screen.findByRole('dialog', { name: create.addHome.title })).toBeInTheDocument();
  });

  it('hides Archive when the person may not archive', async () => {
    signedInApi(makeView({ can: { archive: false } }));
    renderWindow();

    await screen.findByRole('heading', { name: 'Dana Homeowner' });
    expect(screen.queryByRole('button', { name: customers.window.archive })).not.toBeInTheDocument();
  });

  it('hides Edit when the person may not edit', async () => {
    signedInApi(makeView({ can: { edit: false } }));
    renderWindow();

    await screen.findByRole('heading', { name: 'Dana Homeowner' });
    expect(screen.queryByRole('button', { name: customers.window.edit })).not.toBeInTheDocument();
  });

  it('shows Edit when the person may edit', async () => {
    signedInApi();
    renderWindow();

    expect(await screen.findByRole('button', { name: customers.window.edit })).toBeInTheDocument();
  });

  it('a customer nobody has shows the not-found line', async () => {
    signedInApi(makeView(), { 'GET /api/customers/c1/view': () => ({ status: 404, body: { error: 'Not found' } }) });
    renderWindow();

    expect(await screen.findByText(customers.window.notFound, { exact: true })).toBeInTheDocument();
  });

  it('keeps the path when the page is loaded without the add-home flag', async () => {
    signedInApi();
    const { router } = renderWindow();

    await screen.findByRole('heading', { name: 'Dana Homeowner' });
    expect(where(router)).toBe('/customers/c1');
  });
});
