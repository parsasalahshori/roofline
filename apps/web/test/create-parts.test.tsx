import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient, Providers } from '../src/app/providers.tsx';
import { create } from '../src/copy/create.ts';
import { common } from '../src/copy/common.ts';
import { AddHomeSheet } from '../src/features/create/AddHomeSheet.tsx';
import { AddressFields, EMPTY_ADDRESS, type AddressValue } from '../src/features/create/AddressFields.tsx';
import { CustomerPicker } from '../src/features/create/CustomerPicker.tsx';
import { FormActions } from '../src/features/create/FormActions.tsx';
import type { CustomerRecord } from '../src/features/create/api.ts';
import { stubApi } from './helpers.tsx';
import { chooseFromListbox } from './crm-helpers.ts';

let api: ReturnType<typeof stubApi> | undefined;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  expect(api?.unexpected ?? []).toEqual([]);
  api = undefined;
});

/** Renders `ui` under the app's providers, with a query cache that does not retry, so a stubbed failure shows at once. */
function renderWithProviders(ui: ReactElement) {
  const queryClient = createQueryClient();
  queryClient.setDefaultOptions({ queries: { retry: false } });
  render(<Providers client={queryClient}>{ui}</Providers>);
  return userEvent.setup();
}

/** The Field wrapper around a labelled control, found from the control itself. */
function fieldBox(label: string): HTMLElement {
  const box = screen.getByLabelText(label).closest('[data-invalid]');
  if (!(box instanceof HTMLElement)) throw new Error(`No field box for ${label}`);
  return box;
}

describe('address fields', () => {
  it('address fields lists all states and reports errors under their fields', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <AddressFields
        value={EMPTY_ADDRESS}
        onChange={onChange}
        errors={{ addressLine: 'a', city: 'b', state: 'c', zip: 'd' }}
      />,
    );

    expect(fieldBox(create.address.street)).toContainElement(screen.getByText('a'));
    expect(fieldBox(create.address.city)).toContainElement(screen.getByText('b'));
    expect(fieldBox(create.address.state)).toContainElement(screen.getByText('c'));
    expect(fieldBox(create.address.zip)).toContainElement(screen.getByText('d'));

    // The state is a Listbox: its list opens under the control and holds the empty choice, then every state by name
    const state = screen.getByLabelText(create.address.state);
    expect(state).toHaveTextContent(create.address.statePlaceholder);
    await user.click(state);
    const list = await screen.findByRole('listbox', { name: create.address.state });
    const options = within(list).getAllByRole('option');
    expect(options.length).toBeGreaterThanOrEqual(51);
    expect(within(list).getByRole('option', { name: 'Texas' })).toBeInTheDocument();
    expect(options[0]).toHaveTextContent(create.address.statePlaceholder);
  });

  it('each control reports its change with the whole address', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    const value: AddressValue = { addressLine: '', city: 'Dallas', state: '', zip: '' };
    render(<AddressFields value={value} onChange={onChange} />);

    await user.type(screen.getByLabelText(create.address.street), '1');
    expect(onChange).toHaveBeenLastCalledWith({ ...value, addressLine: '1' });

    await chooseFromListbox(user, create.address.state, 'Texas');
    expect(onChange).toHaveBeenLastCalledWith({ ...value, state: 'TX' });
  });
});

describe('customer picker', () => {
  it('typing in the picker searches and picking a customer selects it', async () => {
    const ann: CustomerRecord = { id: 'c1', displayName: 'Ann Smith', firstName: null, lastName: null };
    api = stubApi({ 'GET /api/customers?q=smi&limit=8': () => ({ body: { customers: [ann], total: 1 } }) });
    const onSelect = vi.fn();
    const user = renderWithProviders(<CustomerPicker selected={null} onSelect={onSelect} />);

    await user.type(screen.getByLabelText(create.newJob.searchCustomer), 'smi');
    await user.click(await screen.findByRole('button', { name: 'Ann Smith' }, { timeout: 15000 }));

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(ann);
    expect(api.count('GET /api/customers?q=smi&limit=8')).toBe(1);
  });

  it('the empty search box says what to type', () => {
    api = stubApi({});
    renderWithProviders(<CustomerPicker selected={null} onSelect={vi.fn()} />);

    expect(screen.getByLabelText(create.newJob.searchCustomer)).toHaveAttribute('placeholder', create.newJob.searchPlaceholder);
  });

  it('picker shows no matches text', async () => {
    api = stubApi({ 'GET /api/customers?q=zzz&limit=8': () => ({ body: { customers: [], total: 0 } }) });
    const user = renderWithProviders(<CustomerPicker selected={null} onSelect={vi.fn()} />);

    await user.type(screen.getByLabelText(create.newJob.searchCustomer), 'zzz');

    expect(await screen.findByText(create.newJob.noMatches, undefined, { timeout: 15000 })).toBeInTheDocument();
  });

  it('a selected customer shows its name and Change clears the choice', async () => {
    const onSelect = vi.fn();
    const user = renderWithProviders(
      <CustomerPicker selected={{ id: 'c1', displayName: 'Ann Smith', firstName: null, lastName: null }} onSelect={onSelect} />,
    );

    expect(screen.getByText('Ann Smith')).toBeInTheDocument();
    expect(screen.queryByLabelText(create.newJob.searchCustomer)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: create.newJob.changeCustomer }));

    expect(onSelect).toHaveBeenCalledWith(null);
  });
});

describe('add home sheet', () => {
  /** Fills the address with a home in Dallas, TX. */
  async function fillHome(user: ReturnType<typeof userEvent.setup>) {
    await user.type(screen.getByLabelText(create.address.street), '12 Oak St');
    await user.type(screen.getByLabelText(create.address.city), 'Dallas');
    await chooseFromListbox(user, create.address.state, 'Texas');
    await user.type(screen.getByLabelText(create.address.zip), '75201');
  }

  it('add home sheet posts the property for the customer and calls onDone', async () => {
    api = stubApi({
      'POST /api/properties': () => ({
        body: { id: 'p9', customerId: 'c1', addressLine: '12 Oak St', city: 'Dallas', state: 'TX', zip: '75201', lat: 32.7, lng: -96.8 },
      }),
    });
    const onDone = vi.fn();
    const user = renderWithProviders(<AddHomeSheet customerId="c1" onDone={onDone} />);

    await fillHome(user);
    await user.click(screen.getByRole('button', { name: create.addHome.save }));

    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    const [body] = api.sent('POST /api/properties');
    expect(body).toEqual({ customerId: 'c1', addressLine: '12 Oak St', city: 'Dallas', state: 'TX', zip: '75201' });
    expect(body).not.toHaveProperty('lat');
    expect(body).not.toHaveProperty('lng');
  });

  it('add home sheet toasts when the home is not on the map', async () => {
    api = stubApi({
      'POST /api/properties': () => ({
        body: { id: 'p9', customerId: 'c1', addressLine: '12 Oak St', city: 'Dallas', state: 'TX', zip: '75201', lat: null, lng: null },
      }),
    });
    const user = renderWithProviders(<AddHomeSheet customerId="c1" onDone={vi.fn()} />);

    await fillHome(user);
    await user.click(screen.getByRole('button', { name: create.addHome.save }));

    expect(await screen.findByText(create.notOnMap)).toBeInTheDocument();
  });

  it('add home sheet shows field errors', async () => {
    api = stubApi({
      'POST /api/properties': () => ({ status: 400, body: { error: 'Enter a valid ZIP code.', field: 'zip' } }),
    });
    const onDone = vi.fn();
    const user = renderWithProviders(<AddHomeSheet customerId="c1" onDone={onDone} />);

    await fillHome(user);
    await user.click(screen.getByRole('button', { name: create.addHome.save }));

    const message = await screen.findByText('Enter a valid ZIP code.');
    expect(fieldBox(create.address.zip)).toContainElement(message);
    expect(onDone).not.toHaveBeenCalled();
  });

  it('the sheet closes through its close button and calls onDone', async () => {
    const onDone = vi.fn();
    const user = renderWithProviders(<AddHomeSheet customerId="c1" onDone={onDone} />);

    await user.click(screen.getByRole('button', { name: common.close }));

    expect(onDone).toHaveBeenCalledTimes(1);
  });
});

describe('the buttons at the foot of a create form', () => {
  /** matchMedia that answers the phone query with `phone` and everything else with no match. */
  function stubViewport(phone: boolean) {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: phone && query === '(max-width: 767.98px)',
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(() => false),
    }));
  }

  const parts = <FormActions className="bar" save={<button type="submit">Save it</button>} cancel={<a href="/back">Cancel it</a>} />;
  const order = () => Array.from(document.querySelector('.bar')?.children ?? []).map((child) => child.textContent);

  it('puts the main action first where there is room beside it', () => {
    stubViewport(false);
    render(parts);
    expect(order()).toEqual(['Save it', 'Cancel it']);
  });

  it('puts the way out first and the main action last on a phone, where the bar sits under the thumb', () => {
    stubViewport(true);
    render(parts);
    expect(order()).toEqual(['Cancel it', 'Save it']);
  });
});
