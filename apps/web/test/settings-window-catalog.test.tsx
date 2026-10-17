import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { resolveCatalog, type WindowCatalog } from '@roofline/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { tiers } from '../src/copy/tiers.ts';
import { windowCatalog as copy } from '../src/copy/windowCatalog.ts';
import { WindowCatalogSection } from '../src/features/settings/WindowCatalogSection.tsx';
import { ACCOUNT, renderAt, SHELL_ROUTES, stubApi } from './helpers.tsx';

let api: ReturnType<typeof stubApi>;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  expect(api?.unexpected ?? []).toEqual([]);
});

const GET = 'GET /api/window-catalog';
const PUT = 'PUT /api/window-catalog';

function catalogApi(role: 'owner' | 'office' = 'owner', start: WindowCatalog = resolveCatalog(null)) {
  let current = start;
  const account = role === 'owner' ? ACCOUNT : { ...ACCOUNT, role: 'office' as const };
  api = stubApi({
    ...SHELL_ROUTES,
    'GET /api/auth/me': () => ({ body: account }),
    [GET]: () => ({ body: { catalog: current } }),
    [PUT]: ({ body }) => {
      current = (body as { catalog: WindowCatalog }).catalog;
      return { body: { catalog: current } };
    },
  });
  return api;
}

const sent = () => api.calls.filter((c) => c.key === PUT).map((c) => (c.body as { catalog: WindowCatalog }).catalog);

describe('Settings Prices: windows catalog', () => {
  it('shows the standard catalog, and sends tier names, notes, a price, the included list, trust facts, an offer and financing as the catalog record', async () => {
    catalogApi();
    const { user } = renderAt(<WindowCatalogSection />, '/settings/prices');
    await user.type(await screen.findByLabelText(copy.levelLabel('Good')), 'Replenish');
    await user.type(screen.getByLabelText(copy.levelNote('Good')), '1-year warranty');
    // The price grid: small, Good
    const cell = screen.getByLabelText(copy.priceCell(copy.sizeNames.small, 'Replenish'));
    expect(cell).toHaveValue(450);
    await user.clear(cell);
    await user.type(cell, '380');
    // What every window includes: one per line
    await user.type(screen.getByLabelText(copy.includedLabel), 'Argon gas fill{Enter}FlexScreen');
    // Trust, offer, financing
    await user.type(screen.getByLabelText(copy.ratingValue), '4.9');
    await user.type(screen.getByLabelText(copy.ratingCount), '2400');
    await user.type(screen.getByLabelText(copy.ratingSource), 'homeowners');
    await user.click(screen.getByRole('checkbox', { name: copy.ratingPlus }));
    await user.type(screen.getByLabelText(copy.badge(1)), 'A+ BBB');
    await user.type(screen.getByLabelText(copy.offerText), 'October special');
    await user.type(screen.getByLabelText(copy.offerUrl), 'https://winchoice.com/terms');
    await user.type(screen.getByLabelText(copy.financingText), 'Financing available');
    await user.type(screen.getByLabelText(copy.adders.frostedCents), '{Backspace}45');
    await user.click(screen.getByRole('button', { name: tiers.save }));

    await waitFor(() => expect(api.count(PUT)).toBe(1));
    const c = sent()[0]!;
    expect(c.tiers[0]).toMatchObject({ tier: 'good', label: 'Replenish', note: '1-year warranty' });
    expect(c.tiers[0]!.priceCents.small).toBe(38_000);
    expect(c.tiers[1]!.label).toBeUndefined();
    expect(c.included).toEqual(['Argon gas fill', 'FlexScreen']);
    expect(c.trust).toEqual({ rating: { value: 4.9, count: 2400, plus: true, source: 'homeowners' }, sinceYear: null, license: null, badges: ['A+ BBB'] });
    expect(c.offer).toEqual({ title: 'October special', termsUrl: 'https://winchoice.com/terms' });
    expect(c.financing).toEqual({ text: 'Financing available', url: null });
    expect(c.adders.frostedCents).toBe(4_500);
    expect(await screen.findByText(tiers.saved)).toBeInTheDocument();
  });

  it('the style grid moves the price for a choice, and a choice priced at the visit has no row there', async () => {
    catalogApi();
    const { user } = renderAt(<WindowCatalogSection />, '/settings/prices');
    const grid = within(await screen.findByRole('table', { name: copy.stylePricesTitle }));
    // Four choices, the last one priced at the visit: three rows
    expect(grid.getAllByRole('row')).toHaveLength(1 + 3);
    const sideways = screen.getByLabelText(copy.stylePriceCell('Slides sideways', 'Good'));
    await user.clear(sideways);
    await user.type(sideways, '-20');
    await user.click(screen.getByRole('button', { name: tiers.save }));
    await waitFor(() => expect(api.count(PUT)).toBe(1));
    expect(sent()[0]!.styleAdjustCents).toEqual({ sideways: { good: -2_000 } });
  });

  it('checks the form before sending: a rating needs all its parts, a link must be https, a price must be an amount', async () => {
    catalogApi();
    const { user } = renderAt(<WindowCatalogSection />, '/settings/prices');
    await user.type(await screen.findByLabelText(copy.ratingValue), '4.9');
    await user.type(screen.getByLabelText(copy.financingUrl), 'http://x.test');
    await user.type(screen.getByLabelText(copy.financingText), 'Financing');
    const price = screen.getByLabelText(copy.priceCell(copy.sizeNames.small, 'Good'));
    await user.clear(price);
    await user.click(screen.getByRole('button', { name: tiers.save }));
    expect(await screen.findByText(copy.countRange)).toBeInTheDocument();
    expect(screen.getByText(copy.needsRatingParts)).toBeInTheDocument();
    expect(screen.getByText(copy.httpsOnly)).toBeInTheDocument();
    expect(screen.getByText(copy.money)).toBeInTheDocument();
    expect(api.count(PUT)).toBe(0);
  });

  it('office can read it but not change it', async () => {
    catalogApi('office');
    renderAt(<WindowCatalogSection />, '/settings/prices');
    expect(await screen.findByText(tiers.officeReadOnly)).toBeInTheDocument();
    expect(screen.getByLabelText(copy.levelLabel('Good'))).toBeDisabled();
    expect(screen.queryByRole('button', { name: copy.useDefaults })).toBeNull();
  });
});
