import { cleanup, screen } from '@testing-library/react';
import { DEFAULT_TIER_TEMPLATES, defaultPricebook, type PricebookView, DEFAULT_WINDOW_ORDER_SETTINGS } from '@roofline/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { prices } from '../src/copy/prices.ts';
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
    const permit = await screen.findByLabelText(prices.fields.permit);
    await user.clear(permit);
    await user.type(permit, '300');
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
    await screen.findByLabelText(prices.fields.permit);

    // C1's price list uses readonly; E1's Estimator sections below it use disabled: both mean office cannot change them
    for (const input of screen.getAllByRole('spinbutton')) {
      expect(input.hasAttribute('readonly') || input.hasAttribute('disabled')).toBe(true);
    }
    expect(screen.getByLabelText(prices.fields.permit)).toHaveValue(250);
    expect(screen.getByLabelText(prices.fields.material)).toBeDisabled();
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
    await screen.findByLabelText(prices.fields.permit);
    expect(screen.getByText(prices.exampleBanner)).toBeInTheDocument();
    cleanup();

    api.routes['GET /api/pricebook'] = () => ({ body: view({ isExample: false }) });
    renderAt(<PricesTab />, '/settings/prices');
    await screen.findByLabelText(prices.fields.permit);
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
    const permit = await screen.findByLabelText(prices.fields.permit);
    await user.clear(permit);
    await user.type(permit, '300');
    await user.click(screen.getByRole('button', { name: prices.save }));

    // Exactly one match: the message sits under the field and is not also a toast
    await screen.findByText(message);
    expect(screen.getAllByText(message)).toHaveLength(1);
    expect(screen.getByLabelText(prices.fields.permit)).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText(prices.fields.architecturalBundle)).toHaveValue(42);
    expect(screen.getByRole('button', { name: prices.save })).toBeInTheDocument();
  });
});
