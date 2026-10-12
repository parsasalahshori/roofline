import { cleanup, render, screen, waitFor } from '@testing-library/react';
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

/** A signed-in owner on the New customer screen, with the shell's reads answering "nothing" and the given routes. */
async function renderNewCustomer(routes: Routes = {}) {
  api = stubApi({ ...SHELL_ROUTES, 'GET /api/auth/me': () => ({ body: ACCOUNT }), ...routes });
  const queryClient = createQueryClient();
  queryClient.setDefaultOptions({ queries: { retry: false } });
  const router = createAppRouter({ initialEntries: ['/customers/new'] });
  render(
    <Providers client={queryClient}>
      <RouterProvider router={router} />
    </Providers>,
  );
  await screen.findByLabelText(create.newCustomer.firstName);
  return { router, user: userEvent.setup() };
}

/** The customer creation answer the server gives: id c9. */
const CUSTOMER_C9: Routes[string] = () => ({ body: { id: 'c9', displayName: 'Ann Lee', firstName: 'Ann', lastName: 'Lee' } });

/** The Field wrapper that holds a labelled control, so a message can be checked to sit under it. */
function fieldBox(label: string, index = 0): HTMLElement {
  const controls = screen.getAllByLabelText(label);
  const box = controls[index]?.closest('[data-invalid]');
  if (!(box instanceof HTMLElement)) throw new Error(`No field box for ${label}`);
  return box;
}

const saveButton = () => screen.getByRole('button', { name: create.newCustomer.save });

describe('New customer', () => {
  it('new customer posts the customer then the property and navigates', async () => {
    const { router, user } = await renderNewCustomer({
      'POST /api/customers': CUSTOMER_C9,
      'POST /api/properties': () => ({
        body: { id: 'p9', customerId: 'c9', addressLine: '12 Oak St', city: 'Dallas', state: 'TX', zip: '75201', lat: 32.7, lng: -96.8 },
      }),
    });

    await user.type(screen.getByLabelText(create.newCustomer.firstName), 'Ann');
    await user.type(screen.getByLabelText(create.newCustomer.lastName), 'Lee');
    await user.type(screen.getByLabelText(create.address.street), '12 Oak St');
    await user.type(screen.getByLabelText(create.address.city), 'Dallas');
    await user.selectOptions(screen.getByLabelText(create.address.state), 'TX');
    await user.type(screen.getByLabelText(create.address.zip), '75201');
    await user.click(saveButton());

    await waitFor(() => expect(where(router)).toBe('/customers/c9'));
    const posts = api.calls.filter((call) => call.key.startsWith('POST')).map((call) => call.key);
    expect(posts).toEqual(['POST /api/customers', 'POST /api/properties']);
    expect(api.sent('POST /api/customers')[0]).toEqual({ displayName: 'Ann Lee', firstName: 'Ann', lastName: 'Lee' });
    expect(api.sent('POST /api/properties')[0]).toEqual({
      customerId: 'c9',
      addressLine: '12 Oak St',
      city: 'Dallas',
      state: 'TX',
      zip: '75201',
    });
  });

  it('the texting checkbox sends express consent', async () => {
    const first = await renderNewCustomer({ 'POST /api/customers': CUSTOMER_C9 });
    await first.user.type(screen.getByLabelText(create.newCustomer.firstName), 'Ann');
    await first.user.type(screen.getByLabelText(create.newCustomer.lastName), 'Lee');
    await first.user.click(saveButton());
    await waitFor(() => expect(where(first.router)).toBe('/customers/c9'));
    expect(api.sent('POST /api/customers')[0]).not.toHaveProperty('smsConsentStatus');

    cleanup();
    const second = await renderNewCustomer({ 'POST /api/customers': CUSTOMER_C9 });
    await second.user.type(screen.getByLabelText(create.newCustomer.firstName), 'Ann');
    await second.user.type(screen.getByLabelText(create.newCustomer.lastName), 'Lee');
    await second.user.click(await screen.findByRole('checkbox', { name: create.newCustomer.textConsent }));
    await second.user.click(saveButton());
    await waitFor(() => expect(where(second.router)).toBe('/customers/c9'));
    expect(api.sent('POST /api/customers')[0]).toMatchObject({ smsConsentStatus: 'express' });
  });

  it('a rep sees no texting checkbox and sends no consent', async () => {
    const { router, user } = await renderNewCustomer({
      'GET /api/auth/me': () => ({ body: { ...ACCOUNT, role: 'rep' } }),
      'POST /api/customers': () => ({ status: 201, body: { id: 'c9', displayName: 'Ann Lee', firstName: 'Ann', lastName: 'Lee' } }),
    });

    await user.type(screen.getByLabelText(create.newCustomer.firstName), 'Ann');
    await user.click(saveButton());

    await waitFor(() => expect(api.sent('POST /api/customers')).toHaveLength(1));
    expect(screen.queryByRole('checkbox', { name: create.newCustomer.textConsent })).toBeNull();
    expect(api.sent('POST /api/customers')[0]).not.toHaveProperty('smsConsentStatus');
    await waitFor(() => expect(where(router)).toBe('/customers/c9'));
  });

  it('a home that was not found shows the not-on-map toast', async () => {
    const { user } = await renderNewCustomer({
      'POST /api/customers': CUSTOMER_C9,
      'POST /api/properties': () => ({
        body: { id: 'p9', customerId: 'c9', addressLine: '12 Oak St', city: 'Dallas', state: 'TX', zip: '75201', lat: null, lng: null },
      }),
    });

    await user.type(screen.getByLabelText(create.newCustomer.firstName), 'Ann');
    await user.type(screen.getByLabelText(create.newCustomer.lastName), 'Lee');
    await user.type(screen.getByLabelText(create.address.street), '12 Oak St');
    await user.type(screen.getByLabelText(create.address.city), 'Dallas');
    await user.selectOptions(screen.getByLabelText(create.address.state), 'TX');
    await user.type(screen.getByLabelText(create.address.zip), '75201');
    await user.click(saveButton());

    expect(await screen.findByText(create.notOnMap)).toBeInTheDocument();
  });

  it('a home with no street shows the street error', async () => {
    const { router, user } = await renderNewCustomer({
      'POST /api/customers': () => ({ status: 201, body: { id: 'c9', displayName: 'Ann Lee', firstName: 'Ann', lastName: 'Lee' } }),
      'POST /api/properties': () => ({ status: 400, body: { error: 'Please enter the street address.', field: 'addressLine' } }),
    });

    await user.type(screen.getByLabelText(create.newCustomer.firstName), 'Ann');
    await user.type(screen.getByLabelText(create.address.city), 'Dallas');
    await user.click(saveButton());

    expect(await screen.findByText('Please enter the street address.')).toBeInTheDocument();
    expect(api.sent('POST /api/properties')).toHaveLength(1);
    expect(api.sent('POST /api/properties')[0]).toMatchObject({ addressLine: '', city: 'Dallas' });
    expect(where(router)).not.toBe('/customers/c9');
  });

  it('field errors land under their fields', async () => {
    const { user } = await renderNewCustomer({
      'POST /api/customers': () => ({ status: 400, body: { error: 'Please enter a name.', field: 'displayName' } }),
    });

    await user.type(screen.getByLabelText(create.newCustomer.firstName), 'Ann');
    await user.type(screen.getByLabelText(create.newCustomer.lastName), 'Lee');
    await user.click(saveButton());

    const message = await screen.findByText('Please enter a name.');
    expect(fieldBox(create.newCustomer.displayName)).toContainElement(message);

    api.routes['POST /api/customers'] = () => ({
      status: 409,
      body: { error: 'That phone number is already on another customer.', field: 'phones.0.number' },
    });
    await user.type(screen.getAllByLabelText(create.newCustomer.phone)[0] as HTMLElement, '555-0100');
    await user.click(saveButton());

    const phoneMessage = await screen.findByText('That phone number is already on another customer.');
    expect(fieldBox(create.newCustomer.phone, 0)).toContainElement(phoneMessage);
  });

  it('display name follows first and last name until edited', async () => {
    const { user } = await renderNewCustomer();
    const display = () => screen.getByLabelText<HTMLInputElement>(create.newCustomer.displayName);

    await user.type(screen.getByLabelText(create.newCustomer.firstName), 'Ann ');
    expect(display().value).toBe('Ann');
    await user.type(screen.getByLabelText(create.newCustomer.lastName), 'Lee');
    expect(display().value).toBe('Ann Lee');

    await user.clear(display());
    await user.type(display(), 'Annie');
    await user.type(screen.getByLabelText(create.newCustomer.lastName), 's');
    expect(display().value).toBe('Annie');
  });
});
