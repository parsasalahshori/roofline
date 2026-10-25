import type { BackofficeOrder, BackofficeSettings, ProductCatalog } from '@roofline/shared';
import { ORDER_STAGES } from '@roofline/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
// RouterProvider from 'react-router', not 'react-router/dom': under Vitest the two load as separate copies of the router
import { RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient, Providers } from '../src/app/providers.tsx';
import { createAppRouter } from '../src/app/router.tsx';
import { backoffice as copy } from '../src/copy/backoffice.ts';
import { rail } from '../src/copy/rail.ts';
import { ACCOUNT, type Routes, SHELL_ROUTES, stubApi } from './helpers.tsx';

vi.mock('../src/shell/map/MapView.tsx', async () => {
  const { createElement } = await import('react');
  return { MapView: () => createElement('div', { 'data-map-mock': true }) };
});

let api: ReturnType<typeof stubApi>;
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  expect(api?.unexpected ?? []).toEqual([]);
});

const tier = (good: number, better: number, best: number) => ({ good, better, best });

const CATALOG: ProductCatalog = {
  version: 3,
  products: [
    {
      id: 'p1',
      kind: 'window',
      name: 'WinChoice 5000 Double Hung',
      description: 'Our best seller',
      openings: ['hung-sash', 'fixed'],
      shapes: ['rect'],
      limits: { minWidthIn: 12, maxWidthIn: 72, minHeightIn: 12, maxHeightIn: 96, maxUnitedIn: 150 },
      maxSections: 3,
      price: { kind: 'united-inch', breaks: [{ maxUi: 80, cents: tier(30000, 36000, 42000) }, { maxUi: 120, cents: tier(40000, 47000, 54000) }] },
      perExtraSectionCents: tier(5000, 6000, 7000),
      archived: false,
    },
  ],
  options: [{ id: 'o1', group: 'exterior-color', label: 'Bronze exterior', value: 'bronze', adder: { per: 'unit', cents: 2500 }, productIds: [], isDefault: false, archived: false }],
  accessories: [{ id: 'a1', label: 'Permit', per: 'job', cents: 15000, autoAdd: true, archived: false }],
  tiers: { good: { label: 'Good', note: 'Solid' }, better: { label: 'Better', note: 'Popular' }, best: { label: 'Best', note: 'Top' } },
  markupPercent: 10,
  maxRepDiscountPercent: 5,
};

const TEMPLATES = ORDER_STAGES.map((stage) => ({
  stage,
  enabled: stage === 'shipped',
  sms: stage === 'shipped' ? 'Hi {first}, your windows ship {date}. {company}' : '',
  emailSubject: stage === 'shipped' ? 'Shipping {date}' : '',
  emailBody: stage === 'shipped' ? 'Dear {first}, on {date} we ship.' : '',
}));
const SETTINGS: BackofficeSettings = { templates: TEMPLATES, stuckDays: { built: 3, ordered: 10 } };

const order = (over: Partial<BackofficeOrder>): BackofficeOrder => ({
  id: 'ord1',
  jobId: 'j1',
  quoteId: 'q1',
  customerName: 'Jordan Reyes',
  address: '12 Oak St, Springdale AR',
  stage: 'built',
  units: 4,
  totalCents: 523400,
  daysInStage: 5,
  windowOrderId: null,
  events: [
    { id: 'e1', stage: 'built', at: '2026-10-20T15:00:00Z', byUserName: 'Casey', note: 'Checked out', plannedFor: null, notified: { sms: 'skipped-no-consent', email: 'sent' } },
  ],
  ...over,
});

const BOARD = [order({}), order({ id: 'ord2', customerName: 'Pat Lee', stage: 'built', daysInStage: 1 }), order({ id: 'ord3', customerName: 'Sam Roe', stage: 'sold', daysInStage: 40 })];

function signedIn(account: Record<string, unknown>, routes: Routes = {}) {
  api = stubApi({
    ...SHELL_ROUTES,
    'GET /api/auth/me': () => ({ body: account }),
    'GET /api/backoffice/catalog': () => ({ body: CATALOG }),
    'GET /api/backoffice/settings': () => ({ body: SETTINGS }),
    'GET /api/backoffice/orders': () => ({ body: { orders: BOARD } }),
    'GET /api/backoffice/orders/ord1': () => ({ body: BOARD[0] }),
    'GET /api/backoffice/quotes': () => ({ body: { quotes: [] } }),
    ...routes,
  });
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
  return { router, user: userEvent.setup() };
}

const ON = { ...ACCOUNT, backofficeEnabled: true };

describe('back office navigation', () => {
  it('shows the Back office entry when the company has it and the role may use it', async () => {
    signedIn(ON);
    renderApp('/');
    const nav = await screen.findByRole('navigation', { name: rail.label });
    expect(await within(nav).findByRole('link', { name: copy.nav })).toHaveAttribute('href', '/backoffice');
  });

  it('shows it to a rep too, but not when the company has it off', async () => {
    signedIn({ ...ON, role: 'rep' });
    renderApp('/');
    expect(await within(await screen.findByRole('navigation', { name: rail.label })).findByRole('link', { name: copy.nav })).toBeInTheDocument();
    cleanup();
    signedIn({ ...ACCOUNT, backofficeEnabled: false });
    renderApp('/');
    const nav = await screen.findByRole('navigation', { name: rail.label });
    await within(nav).findByRole('link', { name: 'Jobs' });
    expect(within(nav).queryByRole('link', { name: copy.nav })).toBeNull();
  });

  it('sends a person home from the back office when it is off, and a rep away from Settings', async () => {
    signedIn({ ...ACCOUNT, backofficeEnabled: false });
    const { router } = renderApp('/backoffice/products');
    await waitFor(() => expect(router.state.location.pathname).toBe('/'));
    cleanup();
    signedIn({ ...ON, role: 'rep' });
    const second = renderApp('/backoffice/settings');
    await waitFor(() => expect(second.router.state.location.pathname).toBe('/backoffice'));
  });
});

describe('products and pricing', () => {
  it('edits a price break and saves the whole price book in cents', async () => {
    signedIn(ON, { 'PUT /api/backoffice/catalog': ({ body }) => ({ body: { ...(body as ProductCatalog), version: 4 } }) });
    const { user } = renderApp('/backoffice/products');
    await user.click(await screen.findByRole('button', { name: copy.products.editFor('WinChoice 5000 Double Hung') }));
    const good = await screen.findByLabelText(copy.products.breakPrice(1, 'Good'));
    await user.clear(good);
    await user.type(good, '312.50');
    await user.click(screen.getByRole('button', { name: copy.products.sheetDone }));
    await user.click(await screen.findByRole('button', { name: copy.products.save }));
    await screen.findByText(copy.products.savedVersion(4));
    const sent = api.sent('PUT /api/backoffice/catalog')[0] as ProductCatalog;
    expect(sent.products[0]!.price).toEqual({
      kind: 'united-inch',
      breaks: [{ maxUi: 80, cents: tier(31250, 36000, 42000) }, { maxUi: 120, cents: tier(40000, 47000, 54000) }],
    });
    expect(sent.version).toBe(3);
  });

  it('shows an inline message and blocks the save when a product has no name', async () => {
    signedIn(ON);
    const { user } = renderApp('/backoffice/products');
    await user.click(await screen.findByRole('button', { name: copy.products.editFor('WinChoice 5000 Double Hung') }));
    await user.clear(await screen.findByLabelText(copy.products.fields.name));
    expect(await screen.findByText(copy.products.errors.nameEmpty)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: copy.products.sheetDone }));
    expect(await screen.findByRole('button', { name: copy.products.save })).toBeDisabled();
    expect(api.count('PUT /api/backoffice/catalog')).toBe(0);
  });

  it('adds a size row and a number that is not a number is flagged', async () => {
    signedIn(ON);
    const { user } = renderApp('/backoffice/products');
    await user.click(await screen.findByRole('button', { name: copy.products.editFor('WinChoice 5000 Double Hung') }));
    await user.click(await screen.findByRole('button', { name: copy.products.addBreak }));
    const upTo = await screen.findByLabelText(copy.products.breakUpTo(3));
    expect(upTo).toHaveValue('130');
    await user.clear(upTo);
    await user.type(upTo, 'abc');
    expect(await screen.findByText(copy.products.errors.number)).toBeInTheDocument();
  });

  it('prices a unit at Good, Better and Best in the price check', async () => {
    signedIn(ON);
    const { user } = renderApp('/backoffice/products');
    await user.click(await screen.findByRole('radio', { name: copy.products.sections.check }));
    // 36 + 60 = 96 united inches: the second row, then the 10 percent markup
    expect(await screen.findByTestId('check-good')).toHaveTextContent('$440.00');
    expect(screen.getByTestId('check-best')).toHaveTextContent('$594.00');
  });

  it('is read-only for a rep', async () => {
    signedIn({ ...ON, role: 'rep' });
    renderApp('/backoffice/products');
    await screen.findByText(copy.products.readOnly);
    expect(screen.queryByRole('button', { name: copy.products.addProduct })).toBeNull();
    expect(screen.queryByRole('button', { name: copy.products.archiveFor('WinChoice 5000 Double Hung') })).toBeNull();
  });
});

describe('orders', () => {
  it('draws a column per stage and marks only the order past its limit as stuck', async () => {
    signedIn(ON);
    renderApp('/backoffice/orders');
    const board = await screen.findByRole('group', { name: copy.orders.boardLabel });
    expect(within(board).getAllByRole('region')).toHaveLength(ORDER_STAGES.length);
    const built = within(board).getByRole('region', { name: copy.stages.built });
    const jordan = within(built).getByRole('link', { name: copy.orders.openOrder('Jordan Reyes') });
    const pat = within(built).getByRole('link', { name: copy.orders.openOrder('Pat Lee') });
    expect(within(jordan).getByText(copy.orders.stuck)).toBeInTheDocument();
    expect(within(pat).queryByText(copy.orders.stuck)).toBeNull();
    // Sold has no limit set: never stuck, however long
    const sold = within(board).getByRole('region', { name: copy.stages.sold });
    expect(within(sold).queryByText(copy.orders.stuck)).toBeNull();
  });

  it('filters by search', async () => {
    signedIn(ON);
    const { user } = renderApp('/backoffice/orders');
    await screen.findByRole('group', { name: copy.orders.boardLabel });
    await user.type(screen.getByLabelText(copy.orders.search), 'pat');
    expect(screen.queryByRole('link', { name: copy.orders.openOrder('Jordan Reyes') })).toBeNull();
    expect(screen.getByRole('link', { name: copy.orders.openOrder('Pat Lee') })).toBeInTheDocument();
  });

  it('shows the timeline in plain words', async () => {
    signedIn(ON);
    renderApp('/backoffice/orders/ord1');
    const timeline = await screen.findByRole('list', { name: copy.orders.timelineLabel });
    expect(within(timeline).getByText('Checked out')).toBeInTheDocument();
    expect(within(timeline).getByText(copy.orders.sms['skipped-no-consent'])).toBeInTheDocument();
    expect(within(timeline).getByText(copy.orders.email.sent)).toBeInTheDocument();
  });

  it('moves an order to the next stage with a preview and sends the move', async () => {
    signedIn(ON, { 'PATCH /api/backoffice/orders/ord1/stage': ({ body }) => ({ body: order({ stage: (body as { stage: BackofficeOrder['stage'] }).stage }) }) });
    const { user } = renderApp('/backoffice/orders/ord1');
    await user.click(await screen.findByRole('button', { name: copy.orders.moveNext(copy.stages.shipped) }));
    const dialog = await screen.findByRole('dialog', { name: copy.orders.moveTitle });
    fireEvent.change(within(dialog).getByLabelText(copy.orders.movePlanned), { target: { value: '2026-11-03' } });
    await user.type(within(dialog).getByLabelText(copy.orders.moveNote), 'Truck 4');
    // {first}, {date} and {company} are filled in; the homeowner status line comes from HOMEOWNER_STAGE_FOR
    expect(within(dialog).getByText(`Hi Jordan, your windows ship Nov 3. ${ACCOUNT.company.name}`)).toBeInTheDocument();
    expect(within(dialog).getByText(copy.orders.moveAppLine(copy.homeownerStages.shipped))).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: copy.orders.moveSubmit }));
    await waitFor(() => expect(api.sent('PATCH /api/backoffice/orders/ord1/stage')).toHaveLength(1));
    expect(api.sent('PATCH /api/backoffice/orders/ord1/stage')[0]).toEqual({ stage: 'shipped', note: 'Truck 4', plannedFor: '2026-11-03', notify: true });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('turns the notice off for a stage with no message', async () => {
    signedIn(ON, { 'PATCH /api/backoffice/orders/ord1/stage': () => ({ body: order({ stage: 'measured' }) }) });
    const { user } = renderApp('/backoffice/orders/ord1');
    await user.click(await screen.findByRole('button', { name: copy.orders.moveTo }));
    const dialog = await screen.findByRole('dialog', { name: copy.orders.moveTitle });
    await user.selectOptions(within(dialog).getByLabelText(copy.orders.moveStage), 'measured');
    expect(within(dialog).getByText(copy.orders.moveNoTemplate)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: copy.orders.moveSubmit }));
    await waitFor(() => expect(api.sent('PATCH /api/backoffice/orders/ord1/stage')).toHaveLength(1));
    expect(api.sent('PATCH /api/backoffice/orders/ord1/stage')[0]).toEqual({ stage: 'measured', note: '', plannedFor: null, notify: false });
  });
});

describe('back office settings', () => {
  it('previews a template live and saves the whole settings', async () => {
    signedIn(ON, { 'PUT /api/backoffice/settings': ({ body }) => ({ body }) });
    const { user } = renderApp('/backoffice/settings');
    const sms = await screen.findByLabelText(copy.settings.templateSms('Shipped'));
    expect(screen.getByTestId('preview-sms-shipped')).toHaveTextContent('Hi Jordan, your windows ship June 12. WinChoice');
    await user.clear(sms);
    await user.type(sms, 'On the truck, {{first}!');
    expect(screen.getByTestId('preview-sms-shipped')).toHaveTextContent('On the truck, Jordan!');
    const days = screen.getByLabelText(copy.settings.stuckDays('Built'));
    await user.clear(days);
    await user.type(days, '4');
    await user.click(screen.getByRole('button', { name: copy.settings.save }));
    await waitFor(() => expect(api.sent('PUT /api/backoffice/settings')).toHaveLength(1));
    const sent = api.sent('PUT /api/backoffice/settings')[0] as BackofficeSettings;
    expect(sent.templates.find((tpl) => tpl.stage === 'shipped')!.sms).toBe('On the truck, {first}!');
    expect(sent.stuckDays).toEqual({ built: 4, ordered: 10 });
  });
});

describe('back office home', () => {
  it('starts a quote from a job and opens it', async () => {
    signedIn(ON, {
      'GET /api/jobs/board': () => ({ body: { columns: [{ stage: 'lead', count: 1, totalCents: null, jobs: [{ id: 'j1', customerName: 'Jordan Reyes', addressLine: '12 Oak St' }] }], lost: { count: 0 } } }),
      'POST /api/backoffice/quotes': () => ({ body: { id: 'q9' } }),
      // The new quote opens in the designer, which loads it; this test only follows the navigation.
      'GET /api/backoffice/quotes/q9': () => ({ status: 404, body: { error: 'Not found' } }),
      'GET /api/backoffice/catalog': () => ({ status: 404, body: { error: 'Not found' } }),
    });
    const { user, router } = renderApp('/backoffice');
    await user.click(await screen.findByRole('button', { name: copy.home.newQuote }));
    const dialog = await screen.findByRole('dialog', { name: copy.home.newQuoteTitle });
    await user.selectOptions(await within(dialog).findByLabelText(copy.home.pickJob), 'j1');
    await user.click(within(dialog).getByRole('button', { name: copy.home.startQuote }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/backoffice/quotes/q9'));
    expect(api.sent('POST /api/backoffice/quotes')[0]).toEqual({ jobId: 'j1' });
  });

  it('counts orders by stage with the stuck ones', async () => {
    signedIn(ON);
    renderApp('/backoffice');
    expect(await screen.findByText(copy.home.totalStuck(1))).toBeInTheDocument();
    expect(await screen.findByText(copy.home.stuckCount(1))).toBeInTheDocument();
  });
});
