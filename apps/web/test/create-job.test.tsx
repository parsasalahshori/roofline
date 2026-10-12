import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
// RouterProvider from 'react-router', not 'react-router/dom': under Vitest the two load as separate copies of the router
import { RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient, Providers } from '../src/app/providers.tsx';
import { createAppRouter } from '../src/app/router.tsx';
import { create } from '../src/copy/create.ts';
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

let api: ReturnType<typeof stubApi>;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  expect(api?.unexpected ?? []).toEqual([]);
});

/** The signed-in person (ACCOUNT unless a test gives its own) and the shell's reads, plus the given routes. */
function signedInApi(account = ACCOUNT, overrides: Routes = {}) {
  api = stubApi({ ...SHELL_ROUTES, 'GET /api/auth/me': () => ({ body: account }), ...overrides });
  return api;
}

/** Renders the app at a path and returns the router, so a test can check where it navigated. */
async function renderNewJob(path: string) {
  const queryClient = createQueryClient();
  queryClient.setDefaultOptions({ queries: { retry: false } });
  const router = createAppRouter({ initialEntries: [path] });
  render(
    <Providers client={queryClient}>
      <RouterProvider router={router} />
    </Providers>,
  );
  return { router, user: userEvent.setup() };
}

/** Ann Lee, who has one home on Oak Street. The customer answer is the flat customer record the server sends. */
const ANN_ROUTES: Routes = {
  'GET /api/customers/c7': () => ({
    body: { id: 'c7', displayName: 'Ann Lee', firstName: 'Ann', lastName: 'Lee' },
  }),
  'GET /api/properties?customerId=c7': () => ({
    body: {
      properties: [{ id: 'p3', customerId: 'c7', addressLine: '12 Oak St', city: 'Austin', state: 'TX', zip: '78701', lat: 30.2, lng: -97.7 }],
      total: 1,
    },
  }),
};

/** The field box (the element carrying data-invalid) that holds a labelled control. */
function fieldBox(label: string): HTMLElement {
  const box = screen.getByLabelText(label).closest('[data-invalid]');
  if (!(box instanceof HTMLElement)) throw new Error(`No field box for ${label}`);
  return box;
}

const submitButton = () => screen.getByRole('button', { name: create.newJob.submit });

describe('New job screen', () => {
  it('new job with an existing customer and home posts once and navigates', async () => {
    signedInApi(ACCOUNT, {
      ...ANN_ROUTES,
      'POST /api/jobs': () => ({ body: { id: 'j5' } }),
    });
    const { router, user } = await renderNewJob('/jobs/new?customerId=c7');

    // The home list loads and its first home is the default
    expect(await screen.findByLabelText(create.newJob.pickHome)).toHaveValue('p3');

    await user.click(submitButton());

    await waitFor(() => expect(where(router)).toBe('/jobs/j5'));
    expect(api.count('POST /api/jobs')).toBe(1);
    expect(api.sent('POST /api/jobs')).toEqual([
      { customerId: 'c7', propertyId: 'p3', stage: 'lead', source: 'manual', assignedUserId: 'u1' },
    ]);
    expect(api.count('POST /api/customers')).toBe(0);
    expect(api.count('POST /api/properties')).toBe(0);
  });

  it('inline new customer path creates customer, property, then job', async () => {
    signedInApi(ACCOUNT, {
      'POST /api/customers': () => ({ body: { id: 'c9', displayName: 'Ben Cruz', firstName: null, lastName: null } }),
      'POST /api/properties': () => ({
        body: { id: 'p9', customerId: 'c9', addressLine: '40 Pine Rd', city: 'Dallas', state: 'TX', zip: '75201', lat: 32.8, lng: -96.8 },
      }),
      'POST /api/jobs': () => ({ body: { id: 'j6' } }),
    });
    const { router, user } = await renderNewJob('/jobs/new');

    await user.click(await screen.findByRole('button', { name: create.newJob.newCustomer }));
    await user.type(screen.getByLabelText(create.newJob.newCustomerName), 'Ben Cruz');
    await user.type(screen.getByLabelText(create.newJob.newCustomerPhone), '2145550100');
    await user.type(screen.getByLabelText(create.newJob.newCustomerEmail), 'ben@example.com');

    // The address fields are filled in through AddressFields (package C)
    await user.type(screen.getByLabelText(create.address.street), '40 Pine Rd');
    await user.type(screen.getByLabelText(create.address.city), 'Dallas');
    await user.type(screen.getByLabelText(create.address.zip), '75201');
    await user.selectOptions(screen.getByLabelText(create.address.state), 'TX');

    await user.click(submitButton());

    await waitFor(() => expect(where(router)).toBe('/jobs/j6'));
    const order = api.calls.map((call) => call.key).filter((key) => key.startsWith('POST '));
    expect(order).toEqual(['POST /api/customers', 'POST /api/properties', 'POST /api/jobs']);
    expect(api.sent('POST /api/customers')[0]).toMatchObject({ displayName: 'Ben Cruz' });
    expect(api.sent('POST /api/properties')[0]).toMatchObject({ customerId: 'c9', addressLine: '40 Pine Rd' });
    expect(api.sent('POST /api/jobs')[0]).toMatchObject({ customerId: 'c9', propertyId: 'p9' });
  });

  it('a rep rep field is fixed to themselves', async () => {
    signedInApi({ ...ACCOUNT, role: 'rep' }, {
      ...ANN_ROUTES,
      'POST /api/jobs': () => ({ body: { id: 'j5' } }),
    });
    const { router, user } = await renderNewJob('/jobs/new?customerId=c7');

    const rep = await screen.findByLabelText(create.newJob.rep);
    expect(rep).toHaveAttribute('readonly');
    expect(rep).toHaveValue(create.newJob.repYou);

    await user.click(submitButton());

    await waitFor(() => expect(where(router)).toBe('/jobs/j5'));
    expect(api.sent('POST /api/jobs')[0]).toMatchObject({ assignedUserId: 'u1' });
  });

  it('field errors land under their fields', async () => {
    const message = 'Please enter the job value in cents, as a whole number.';
    signedInApi(ACCOUNT, {
      ...ANN_ROUTES,
      'POST /api/jobs': () => ({ status: 400, body: { error: message, field: 'valueCents' } }),
    });
    const { router, user } = await renderNewJob('/jobs/new?customerId=c7');

    await screen.findByLabelText(create.newJob.pickHome);
    await user.type(screen.getByLabelText(create.newJob.value), '250');
    await user.click(submitButton());

    await waitFor(() => expect(within(fieldBox(create.newJob.value)).getByText(message)).toBeInTheDocument());
    expect(api.sent('POST /api/jobs')[0]).toMatchObject({ valueCents: 25000 });
    expect(where(router)).toBe('/jobs/new?customerId=c7');
  });

  it('changing the customer drops the home picked for the old one', async () => {
    signedInApi(ACCOUNT, {
      ...ANN_ROUTES,
      'GET /api/properties?customerId=c7': () => ({
        body: {
          properties: [
            { id: 'p3', customerId: 'c7', addressLine: '12 Oak St', city: 'Austin', state: 'TX', zip: '78701', lat: 30.2, lng: -97.7 },
            { id: 'p4', customerId: 'c7', addressLine: '8 Elm St', city: 'Austin', state: 'TX', zip: '78702', lat: 30.3, lng: -97.7 },
          ],
          total: 2,
        },
      }),
      'GET /api/customers?q=bo&limit=8': () => ({
        body: { customers: [{ id: 'c8', displayName: 'Bo Diaz', firstName: null, lastName: null }], total: 1 },
      }),
      'GET /api/properties?customerId=c8': () => ({
        body: {
          properties: [{ id: 'b1', customerId: 'c8', addressLine: '5 Ash Ln', city: 'Austin', state: 'TX', zip: '78703', lat: 30.25, lng: -97.75 }],
          total: 1,
        },
      }),
      'POST /api/jobs': () => ({ body: { id: 'j7' } }),
    });
    const { router, user } = await renderNewJob('/jobs/new?customerId=c7');

    // The first home is the default; the person picks the second one for Ann
    const homeSelect = await screen.findByLabelText(create.newJob.pickHome);
    expect(homeSelect).toHaveValue('p3');
    await user.selectOptions(homeSelect, 'p4');

    // Changing the customer drops p4, and the new customer's only home is the one that is chosen
    await user.click(screen.getByRole('button', { name: create.newJob.changeCustomer }));
    await user.type(screen.getByLabelText(create.newJob.searchCustomer), 'bo');
    await user.click(await screen.findByRole('button', { name: 'Bo Diaz' }, { timeout: 15000 }));

    await waitFor(() => expect(screen.getByLabelText(create.newJob.pickHome)).toHaveValue('b1'));
    await user.click(submitButton());

    await waitFor(() => expect(where(router)).toBe('/jobs/j7'));
    expect(api.sent('POST /api/jobs')).toEqual([
      { customerId: 'c8', propertyId: 'b1', stage: 'lead', source: 'manual', assignedUserId: 'u1' },
    ]);
    expect(api.count('POST /api/properties')).toBe(0);
  });

  it('all eight sources are offered as words', async () => {
    signedInApi(ACCOUNT, ANN_ROUTES);
    await renderNewJob('/jobs/new?customerId=c7');

    const source = await screen.findByLabelText(create.newJob.source);
    const names = within(source)
      .getAllByRole('option')
      .map((option) => option.textContent);
    expect(names).toEqual(['Storm', 'Call', 'Text', 'Web', 'Referral', 'Import', 'Manual', 'Front Desk']);
    expect(source).toHaveValue('manual');
  });

  it('the stage select offers only Lead, Inspection and Proposal', async () => {
    signedInApi(ACCOUNT, ANN_ROUTES);
    await renderNewJob('/jobs/new?customerId=c7');

    const stage = await screen.findByLabelText(create.newJob.stage);
    const names = within(stage)
      .getAllByRole('option')
      .map((option) => option.textContent);
    expect(names).toEqual(['Lead', 'Inspection', 'Proposal']);
    expect(stage).toHaveValue('lead');
  });
});
