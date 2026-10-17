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
  phone_number: { status: 'todo', comingWith: null, skippable: false, data: {} },
  connect_ads: { status: 'todo', comingWith: null, skippable: false, data: {} },
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

  it('sets the steps that are not in the count apart, after the five that are', async () => {
    signedInApi(viewOf());
    renderApp('/settings/setup');

    const list = await stepList();
    // The divider is not a row, so the list still has its nine steps
    expect(within(list).getAllByRole('listitem')).toHaveLength(9);
    const divider = within(list).getByText(setup.laterHeading).closest('li') as HTMLElement;
    expect(within(divider).getByText(setup.laterNote)).toBeInTheDocument();
    // Five steps come before it, four after
    const everything = Array.from(list.children);
    expect(everything.indexOf(divider)).toBe(5);
    expect(everything).toHaveLength(10);
  });

  it('no step says it is coming later: every feature has shipped', async () => {
    signedInApi(viewOf());
    renderApp('/settings/setup');

    await stepList();
    expect(screen.queryByText(/^Coming with/)).not.toBeInTheDocument();
  });

  it('the ad accounts step links the owner to Connections', async () => {
    signedInApi(viewOf());
    renderApp('/settings/setup');

    const row = await rowOf(setupItems.connect_ads.title);
    expect(within(row).getByRole('link', { name: setup.actions.connectAds })).toHaveAttribute('href', '/settings/connections');
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

    // The area is a track of choices inside the sheet; the one in use (40 miles when none is set) is picked
    const area = within(dialog).getByRole('radiogroup', { name: setup.sheet.radiusLabel });
    expect(within(area).getByRole('radio', { name: setup.radius(40) })).toHaveAttribute('aria-checked', 'true');
    await user.click(within(area).getByRole('radio', { name: setup.radius(20) }));
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

    await user.click(within(dialog).getByRole('radio', { name: setup.radius(20) }));
    await waitFor(() => expect(mapAreaCalls()).toBe(2));
  });

  it('the first step still to do carries the one primary action; the others are outlined', async () => {
    signedInApi(viewOf());
    renderApp('/settings/setup');

    // company basics is done, so the import is next
    const next = within(await rowOf(setupItems.import_customers.title)).getByRole('link', { name: setup.actions.importCustomers });
    expect(next).toHaveAttribute('data-variant', 'primary');
    const later = within(await rowOf(setupItems.invite_team.title)).getByRole('link', { name: setup.actions.invite });
    expect(later).toHaveAttribute('data-variant', 'default');
    expect(document.querySelectorAll('[data-variant="primary"]').length).toBe(1);
  });

  it('every step shows its state as a tag with its words', async () => {
    signedInApi(
      viewOf(undefined, {
        invite_team: { status: 'in_progress' },
        prices_and_tiers: { status: 'skipped' },
        texting_registration: { status: 'in_progress', data: { rejected: true } },
      }),
    );
    renderApp('/settings/setup');

    const tagOf = async (title: string, words: string) => expect(within(await rowOf(title)).getByText(words)).toBeInTheDocument();
    await tagOf(setupItems.company_basics.title, setup.chips.done);
    await tagOf(setupItems.import_customers.title, setup.chips.todo);
    await tagOf(setupItems.invite_team.title, setup.chips.in_progress);
    await tagOf(setupItems.prices_and_tiers.title, setup.chips.skipped);
    await tagOf(setupItems.texting_registration.title, setup.chips.rejected);
  });

  it('a done step leads on to where it can be looked at, with a Review that names the step', async () => {
    signedInApi(viewOf());
    const { user } = renderApp('/settings/setup');

    // Payment is done: its row has no Add a card, and a Review to Billing
    const payment = await rowOf(setupItems.payment_method.title);
    expect(within(payment).queryByRole('link', { name: setup.actions.addCard })).toBeNull();
    expect(within(payment).getByRole('link', { name: setup.actions.reviewFor(setupItems.payment_method.title) })).toHaveAttribute(
      'href',
      '/settings/billing',
    );
    // A registration waiting on the carriers has nothing to press, but can be looked at
    const texting = await rowOf(setupItems.texting_registration.title);
    expect(within(texting).queryByRole('link', { name: setup.actions.start })).toBeNull();
    expect(within(texting).getByRole('link', { name: setup.actions.reviewFor(setupItems.texting_registration.title) })).toHaveAttribute(
      'href',
      '/settings/setup/texting',
    );
    // The company on the map is done too: its Review opens the same sheet as Check details
    const basics = await rowOf(setupItems.company_basics.title);
    await user.click(within(basics).getByRole('button', { name: setup.actions.reviewFor(setupItems.company_basics.title) }));
    expect(await screen.findByRole('dialog', { name: setup.sheet.title })).toBeInTheDocument();
  });

  it('office has no Review, only the calendar step that is every member\'s own', async () => {
    signedInApi(viewOf(), {}, 'office');
    renderApp('/settings/setup');

    await stepList();
    expect(screen.queryByRole('link', { name: /^Review / })).toBeNull();
    expect(screen.getByRole('link', { name: setup.actions.connectCalendar })).toBeInTheDocument();
  });

  it('the checklist is a panel with the ring and its words at the head', async () => {
    signedInApi(viewOf({ done: 2, total: 5 }));
    renderApp('/settings/setup');

    const panel = await screen.findByRole('region', { name: setup.heading });
    expect(within(panel).getByText('2 of 5 setup steps done')).toBeInTheDocument();
    expect(within(panel).getByRole('list', { name: setup.listLabel })).toBeInTheDocument();
  });
});
