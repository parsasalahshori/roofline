import { cleanup, screen, within } from '@testing-library/react';
import { DEFAULT_TIER_TEMPLATES, defaultPricebook, type PricebookView, DEFAULT_WINDOW_ORDER_SETTINGS } from '@roofline/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { prices } from '../src/copy/prices.ts';
import { settings } from '../src/copy/settings.ts';
import { PricesTab } from '../src/features/settings/PricesTab.tsx';
import { ACCOUNT, renderAt, SHELL_ROUTES, stubApi } from './helpers.tsx';

/** The E1 Estimator sections under the price list load their own data (E1 Task 18). */
const ESTIMATOR_ROUTES = {
  'GET /api/tier-templates': () => ({ body: { templates: DEFAULT_TIER_TEMPLATES.map((t) => ({ ...t, addOns: [...t.addOns], highlights: [...t.highlights] })) } }),
  'GET /api/estimator/settings': () => ({ body: { defaultPitchX12: 6, overhangFt: 1, proposalValidDays: 30, aerialMeasure: false, aerialConfigured: false, estimateChangeClause: true, financingAprBps: null, financingTermMonths: null } }),
  'GET /api/instant-quote/settings': () => ({ body: { enabled: false, slug: null, products: ['windows', 'roof'], rangePct: 12, dailyCap: 50, embedOrigins: [], booking: false, accentColor: null, pageUrl: null } }),
  'GET /api/window-order-settings': () => ({ body: DEFAULT_WINDOW_ORDER_SETTINGS }),
};

const DEFAULTS = { wastePercent: 12, markupPercent: 25, taxPercent: 0, material: 'architectural' } as const;

function view(overrides: Partial<PricebookView> = {}): PricebookView {
  return { prices: defaultPricebook, defaults: DEFAULTS, isExample: false, ...overrides };
}

let api: ReturnType<typeof stubApi>;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  expect(api?.unexpected ?? []).toEqual([]);
});

describe('settings prices tab', () => {
  it('owner saves prices in dollars', async () => {
    api = stubApi({
      ...SHELL_ROUTES,
      ...ESTIMATOR_ROUTES,
      'GET /api/auth/me': () => ({ body: ACCOUNT }),
      'GET /api/pricebook': () => ({ body: view() }),
      'PUT /api/pricebook': () => ({ body: view({ prices: { ...defaultPricebook, permit: 300 } }) }),
    });
    const { user } = renderAt(<PricesTab />, '/settings/prices');
    // A price is read as a table row; Edit opens its box
    await user.click(await screen.findByRole('button', { name: prices.editFor(prices.fields.permit) }));
    const permit = screen.getByLabelText(prices.fields.permit);
    await user.clear(permit);
    await user.type(permit, '300');
    expect(screen.getByText(prices.edited)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: prices.save }));

    await screen.findByText(prices.saved);
    expect(api.sent('PUT /api/pricebook')[0]).toEqual({
      prices: { ...defaultPricebook, permit: 300 },
      defaults: { wastePercent: 12, markupPercent: 25, taxPercent: 0, material: 'architectural' },
    });
  });

  it('office sees prices read-only', async () => {
    api = stubApi({
      ...SHELL_ROUTES,
      ...ESTIMATOR_ROUTES,
      'GET /api/auth/me': () => ({ body: { ...ACCOUNT, role: 'office' } }),
      'GET /api/pricebook': () => ({ body: view() }),
    });
    renderAt(<PricesTab />, '/settings/prices');
    const permit = (await screen.findByText(prices.fields.permit)).closest('tr') as HTMLElement;

    // C1's price list is words and numbers in a table, with no box and no Edit; E1's Estimator sections below it use disabled boxes
    expect(permit).toHaveTextContent('$250.00');
    expect(screen.queryByRole('button', { name: /^Edit / })).toBeNull();
    expect(screen.queryByLabelText(prices.fields.permit)).toBeNull();
    for (const input of screen.getAllByRole('spinbutton')) {
      expect(input.hasAttribute('readonly') || input.hasAttribute('disabled')).toBe(true);
    }
    expect((screen.getByText(prices.fields.material).closest('tr') as HTMLElement)).toHaveTextContent(prices.materialOptions.architectural);
    expect(screen.getByText(prices.ownerOnly)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: prices.save })).toBeNull();
  });

  it('example prices show the info banner', async () => {
    api = stubApi({
      ...SHELL_ROUTES,
      ...ESTIMATOR_ROUTES,
      'GET /api/auth/me': () => ({ body: ACCOUNT }),
      'GET /api/pricebook': () => ({ body: view({ isExample: true }) }),
    });
    renderAt(<PricesTab />, '/settings/prices');
    await screen.findByText(prices.fields.permit);
    expect(screen.getByText(prices.exampleBanner)).toBeInTheDocument();
    cleanup();

    api.routes['GET /api/pricebook'] = () => ({ body: view({ isExample: false }) });
    renderAt(<PricesTab />, '/settings/prices');
    await screen.findByText(prices.fields.permit);
    expect(screen.queryByText(prices.exampleBanner)).toBeNull();
  });

  it('a field error from the server sits under the field', async () => {
    const message = 'Enter an amount.';
    api = stubApi({
      ...SHELL_ROUTES,
      ...ESTIMATOR_ROUTES,
      'GET /api/auth/me': () => ({ body: ACCOUNT }),
      'GET /api/pricebook': () => ({ body: view() }),
      'PUT /api/pricebook': () => ({ status: 400, body: { error: message, field: 'prices.permit' } }),
    });
    const { user } = renderAt(<PricesTab />, '/settings/prices');
    await user.click(await screen.findByRole('button', { name: prices.editFor(prices.fields.permit) }));
    const permit = screen.getByLabelText(prices.fields.permit);
    await user.clear(permit);
    await user.type(permit, '300');
    await user.click(screen.getByRole('button', { name: prices.save }));

    // Exactly one match: the message sits under the field and is not also a toast
    await screen.findByText(message);
    expect(screen.getAllByText(message)).toHaveLength(1);
    expect(screen.getByLabelText(prices.fields.permit)).toHaveAttribute('aria-invalid', 'true');
    // The other prices keep what they were, and Save stays for another try
    expect((screen.getByText(prices.fields.architecturalBundle).closest('tr') as HTMLElement)).toHaveTextContent('$42.00');
    expect(screen.getByRole('button', { name: prices.save })).toBeInTheDocument();
  });

  it('Done closes a row and keeps what was typed; Discard puts every price back', async () => {
    api = stubApi({
      ...SHELL_ROUTES,
      ...ESTIMATOR_ROUTES,
      'GET /api/auth/me': () => ({ body: ACCOUNT }),
      'GET /api/pricebook': () => ({ body: view() }),
    });
    const { user } = renderAt(<PricesTab />, '/settings/prices');
    const permitRow = () => screen.getByText(prices.fields.permit).closest('tr') as HTMLElement;

    // Nothing has changed, so there is no bar
    await screen.findByText(prices.fields.permit);
    expect(screen.queryByRole('group', { name: settings.saveBar.label })).toBeNull();

    await user.click(screen.getByRole('button', { name: prices.editFor(prices.fields.permit) }));
    const permit = screen.getByLabelText(prices.fields.permit);
    await user.clear(permit);
    await user.type(permit, '325.5');
    await user.click(screen.getByRole('button', { name: prices.doneFor(prices.fields.permit) }));

    // The row reads $325.50 in mono, is marked as edited, and the bar waits at the foot of the form
    expect(screen.queryByLabelText(prices.fields.permit)).toBeNull();
    expect(permitRow()).toHaveTextContent('$325.50');
    expect(within(permitRow()).getByText(prices.edited)).toBeInTheDocument();
    const bar = screen.getByRole('group', { name: settings.saveBar.label });

    await user.click(within(bar).getByRole('button', { name: settings.saveBar.discard }));
    expect(permitRow()).toHaveTextContent('$250.00');
    expect(within(permitRow()).queryByText(prices.edited)).toBeNull();
    expect(screen.queryByRole('group', { name: settings.saveBar.label })).toBeNull();
    expect(api.count('PUT /api/pricebook')).toBe(0);
  });

  it('the default material and the percentages are saved with the prices', async () => {
    api = stubApi({
      ...SHELL_ROUTES,
      ...ESTIMATOR_ROUTES,
      'GET /api/auth/me': () => ({ body: ACCOUNT }),
      'GET /api/pricebook': () => ({ body: view() }),
      'PUT /api/pricebook': ({ body }) => ({ body: { prices: (body as PricebookView).prices, defaults: (body as PricebookView).defaults, isExample: false } }),
    });
    const { user } = renderAt(<PricesTab />, '/settings/prices');

    await user.click(await screen.findByRole('button', { name: prices.editFor(prices.fields.markupPercent) }));
    const markup = screen.getByLabelText(prices.fields.markupPercent);
    await user.clear(markup);
    await user.type(markup, '30');
    await user.click(screen.getByLabelText(prices.fields.material));
    await user.click(screen.getByRole('option', { name: prices.materialOptions.metal }));
    await user.click(screen.getByRole('button', { name: prices.save }));

    await screen.findByText(prices.saved);
    expect(api.sent('PUT /api/pricebook')[0]).toEqual({
      prices: defaultPricebook,
      defaults: { wastePercent: 12, markupPercent: 30, taxPercent: 0, material: 'metal' },
    });
    // Saved: the rows read as saved, with no box open and no bar
    expect((screen.getByText(prices.fields.markupPercent).closest('tr') as HTMLElement)).toHaveTextContent('30%');
    expect(screen.queryByRole('group', { name: settings.saveBar.label })).toBeNull();
  });
});
