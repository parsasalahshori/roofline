import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
// RouterProvider from 'react-router', not 'react-router/dom': under Vitest the two load as separate copies of the router
import { RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { keys } from '../src/api/keys.ts';
import { createQueryClient, Providers } from '../src/app/providers.tsx';
import { createAppRouter } from '../src/app/router.tsx';
import type { CompanyBody } from '../src/api/types.ts';
import { setup, setupItems } from '../src/copy/setup.ts';
import { SETUP_ITEM_KEYS, type SetupItemKey, type SetupItemView, type SetupView } from '@roofline/shared';
import { ACCOUNT, SHELL_ROUTES, stubApi } from './helpers.tsx';

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

/** The default state of each step, in the order the API sends them. Four later-spec steps say what they come with. */
const DEFAULTS: Record<SetupItemKey, Omit<SetupItemView, 'key'>> = {
  company_basics: { status: 'done', comingWith: null, skippable: false, data: {} },
  import_customers: { status: 'todo', comingWith: null, skippable: true, data: {} },
  texting_registration: { status: 'waiting', comingWith: null, skippable: false, data: {} },
  invite_team: { status: 'todo', comingWith: null, skippable: true, data: {} },
  payment_method: { status: 'done', comingWith: null, skippable: false, data: {} },
  prices_and_tiers: { status: 'todo', comingWith: null, skippable: false, data: {} },
  connect_calendar: { status: 'todo', comingWith: 'calendar', skippable: false, data: {} },
  phone_number: { status: 'todo', comingWith: 'front_desk', skippable: false, data: {} },
  connect_ads: { status: 'todo', comingWith: 'storm_scout', skippable: false, data: {} },
};

/** A nine-step checklist: the defaults, with `changes` for the steps a test cares about. */
function viewOf(progress = { done: 2, total: 5 }, changes: Partial<Record<SetupItemKey, Partial<Omit<SetupItemView, 'key'>>>> = {}): SetupView {
  return {
    progress,
    items: SETUP_ITEM_KEYS.map((key) => ({ key, ...DEFAULTS[key], ...changes[key] })),
  };
}

/** The company as the server sends it, with the two fields the basics sheet reads. */
const COMPANY: CompanyBody = {
  id: 'c1',
  name: 'Summit Roofing',
  slug: 'summit-roofing',
  status: 'active',
  legalName: null,
  phone: '+14025551234',
  email: 'office@summit.example',
  website: 'https://summit.example',
  addressStreet: '12 Main St',
  addressCity: 'Omaha',
  addressState: 'NE',
  addressZip: '68102',
  timezone: 'America/Chicago',
  logoUrl: null,
  located: false,
  serviceAreaMiles: null,
};

/** A signed-in owner (or the given role) whose Setup reads answer with `view`, unless a test gives its own answers. */
function signedInApi(view: SetupView, overrides: Parameters<typeof stubApi>[0] = {}, role: 'owner' | 'office' | 'rep' = 'owner') {
  api = stubApi({
    ...SHELL_ROUTES,
    'GET /api/auth/me': () => ({ body: { ...ACCOUNT, role } }),
    'GET /api/setup': () => ({ body: view }),
    'GET /api/company': () => ({ body: COMPANY }),
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

/** The checklist, found by the name the copy gives it. */
const stepList = () => screen.findByRole('list', { name: setup.listLabel });

/** The row of one step, found by its title from the copy. */
async function rowOf(title: string) {
  const list = await stepList();
  return within(list).getByText(title).closest('li') as HTMLElement;
}

describe('setup tab', () => {
  it('lists nine steps with their chips', async () => {
    signedInApi(viewOf());
    renderApp('/settings/setup');

    const list = await stepList();
    expect(within(list).getAllByRole('listitem')).toHaveLength(9);
    expect(screen.getByText('Waiting on phone carriers (usually 10–15 days)')).toBeInTheDocument();
  });

  it('later steps say what they come with', async () => {
    signedInApi(viewOf());
    renderApp('/settings/setup');

    await stepList();
    expect(screen.queryByText('Coming with the Estimator')).not.toBeInTheDocument();
    expect(screen.queryByText('Coming with the calendar')).not.toBeInTheDocument();
    expect(screen.queryByText('Coming with Front Desk')).not.toBeInTheDocument();
    expect(screen.getByText('Coming with Storm Scout')).toBeInTheDocument();
  });

  it('the phone number step links the owner to the forwarding guide', async () => {
    signedInApi(viewOf());
    renderApp('/settings/setup');

    const row = await rowOf(setupItems.phone_number.title);
    expect(within(row).getByRole('link', { name: setup.actions.forwardCalls })).toHaveAttribute(
      'href',
      '/settings/front-desk#forwarding',
    );
  });

  it('the owner skips the import and the ring moves', async () => {
    const before = viewOf({ done: 1, total: 5 }, { payment_method: { status: 'todo' } });
    const after = viewOf({ done: 2, total: 5 }, { import_customers: { status: 'skipped' } });
    signedInApi(before, {
      'POST /api/setup/import_customers/skip': () => ({ body: after }),
    });
    const { user } = renderApp('/settings/setup');

    expect(await screen.findByRole('link', { name: '1 of 5 setup steps done' })).toBeInTheDocument();
    const row = await rowOf(setupItems.import_customers.title);
    await user.click(within(row).getByRole('button', { name: setup.actions.skip }));

    await waitFor(() => expect(api.count('POST /api/setup/import_customers/skip')).toBe(1));
    expect(await screen.findByRole('link', { name: '2 of 5 setup steps done' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: '1 of 5 setup steps done' })).toBeNull();
  });

  it('the calendar step links to Connections for every member', async () => {
    for (const role of ['owner', 'rep'] as const) {
      signedInApi(viewOf(), {}, role);
      renderApp('/settings/setup');

      const list = await stepList();
      const row = within(list).getByRole('heading', { name: setupItems.connect_calendar.title }).closest('li') as HTMLElement;
      const action = within(row).getByRole('link', { name: setup.actions.connectCalendar });
      expect(action, role).toHaveAttribute('href', '/settings/connections');
      expect(api.unexpected, role).toEqual([]);
      cleanup();
    }
  });

  it('office sees no buttons', async () => {
    signedInApi(viewOf(), {}, 'office');
    renderApp('/settings/setup');

    await stepList();
    expect(screen.queryByText('Import customers')).toBeNull();
    expect(screen.queryByText('Skip for now')).toBeNull();
    expect(screen.getByText('Your owner finishes setup.')).toBeInTheDocument();
  });

  it('a rejected registration offers Fix and resubmit', async () => {
    signedInApi(
      viewOf({ done: 2, total: 5 }, { texting_registration: { status: 'in_progress', data: { rejected: true } } }),
    );
    renderApp('/settings/setup');

    const fix = await screen.findByRole('link', { name: 'Fix and resubmit' });
    expect(fix).toHaveAttribute('href', '/settings/setup/texting');
    expect(screen.getByText('Needs a fix')).toBeInTheDocument();
  });

  it('the ring hides when setup is done', async () => {
    signedInApi(viewOf({ done: 5, total: 5 }));
    renderApp('/settings/setup');

    await stepList();
    expect(screen.queryByRole('link', { name: /setup steps done/ })).toBeNull();
  });

  it('the basics sheet places the company and sets the radius', async () => {
    signedInApi(viewOf(undefined, { company_basics: { status: 'todo' } }), {
      'POST /api/company/locate': () => ({ body: { located: true } }),
      'PUT /api/company/service-area': () => ({ body: { ...COMPANY, serviceAreaMiles: 20 } }),
    });
    const { user } = renderApp('/settings/setup');

    const row = await rowOf(setupItems.company_basics.title);
    await user.click(within(row).getByRole('button', { name: setup.actions.checkDetails }));

    const dialog = await screen.findByRole('dialog', { name: setup.sheet.title });
    api.routes['GET /api/company'] = () => ({ body: { ...COMPANY, located: true } });
    await user.click(within(dialog).getByRole('button', { name: setup.sheet.placeOnMap }));
    await waitFor(() => expect(api.count('POST /api/company/locate')).toBe(1));

    await user.selectOptions(within(dialog).getByLabelText(setup.sheet.radiusLabel), setup.radius(20));
    await waitFor(() => expect(api.sent('PUT /api/company/service-area')).toEqual([{ radiusMiles: 20 }]));
  });

  it('placing the company and setting the radius both refresh the map area', async () => {
    signedInApi(viewOf(undefined, { company_basics: { status: 'todo' } }), {
      'POST /api/company/locate': () => ({ body: { located: true } }),
      'PUT /api/company/service-area': () => ({ body: { ...COMPANY, serviceAreaMiles: 20 } }),
    });
    const { user, queryClient } = renderApp('/settings/setup');
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const mapAreaCalls = () => invalidate.mock.calls.filter(([filters]) => filters?.queryKey === keys.mapArea).length;

    const row = await rowOf(setupItems.company_basics.title);
    await user.click(within(row).getByRole('button', { name: setup.actions.checkDetails }));
    const dialog = await screen.findByRole('dialog', { name: setup.sheet.title });

    await user.click(within(dialog).getByRole('button', { name: setup.sheet.placeOnMap }));
    await waitFor(() => expect(mapAreaCalls()).toBe(1));

    await user.selectOptions(within(dialog).getByLabelText(setup.sheet.radiusLabel), setup.radius(20));
    await waitFor(() => expect(mapAreaCalls()).toBe(2));
  });
});
