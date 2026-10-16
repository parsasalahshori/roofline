import { cleanup, screen, waitFor } from '@testing-library/react';
import { DEFAULT_WINDOW_ORDER_SETTINGS, resolveOrderSettings, type WindowOrderSettingsPatch } from '@roofline/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { factoryOrders } from '../src/copy/factoryOrders.ts';
import { tiers } from '../src/copy/tiers.ts';
import { FactoryOrdersSection, patchOf } from '../src/features/settings/FactoryOrdersSection.tsx';
import { ACCOUNT, renderAt, SHELL_ROUTES, stubApi } from './helpers.tsx';

let api: ReturnType<typeof stubApi>;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  expect(api?.unexpected ?? []).toEqual([]);
});

const GET = 'GET /api/window-order-settings';
const PUT = 'PUT /api/window-order-settings';

/** The API as it answers: GET the stored changes over the standard values; PUT replaces the stored changes. */
function orderApi(role: 'owner' | 'office' = 'owner', stored: WindowOrderSettingsPatch = {}) {
  let current = stored;
  const account = role === 'owner' ? ACCOUNT : { ...ACCOUNT, role: 'office' as const };
  api = stubApi({
    ...SHELL_ROUTES,
    'GET /api/auth/me': () => ({ body: account }),
    [GET]: () => ({ body: resolveOrderSettings(current) }),
    [PUT]: ({ body }) => {
      current = body as WindowOrderSettingsPatch;
      return { body: resolveOrderSettings(current) };
    },
  });
  return api;
}

const sentBodies = () => api.calls.filter((call) => call.key === PUT).map((call) => call.body);

describe('Settings Prices: factory orders', () => {
  it('shows the settings in force and sends only what differs from the standard values', async () => {
    orderApi('owner', { widthDeductionIn: 0.5 });
    const { user } = renderAt(<FactoryOrdersSection />, '/settings/prices');

    const width = await screen.findByLabelText(factoryOrders.widthDeduction);
    expect(width).toHaveValue(0.5);
    await user.clear(width);
    await user.type(width, '0.375');
    await user.selectOptions(screen.getByLabelText(factoryOrders.style), 'casement');
    const largest = screen.getByLabelText(factoryOrders.limit.maxWidthIn);
    expect(largest).toHaveValue(36);
    await user.clear(largest);
    await user.type(largest, '40');
    await user.click(screen.getByRole('button', { name: tiers.save }));

    await waitFor(() => expect(api.count(PUT)).toBe(1));
    expect(sentBodies()[0]).toEqual({ widthDeductionIn: 0.375, limits: { casement: { maxWidthIn: 40 } } });
    expect(await screen.findByText(tiers.saved)).toBeInTheDocument();
  });

  it('checks ranges and min against max before sending, naming a wrong style that is not on screen', async () => {
    orderApi();
    const { user } = renderAt(<FactoryOrdersSection />, '/settings/prices');

    const factor = await screen.findByLabelText(factoryOrders.uncertaintyFactor);
    await user.clear(factor);
    await user.type(factor, '5');
    const smallest = screen.getByLabelText(factoryOrders.limit.minWidthIn);
    await user.clear(smallest);
    await user.type(smallest, '60');
    await user.selectOptions(screen.getByLabelText(factoryOrders.style), 'picture');
    await user.click(screen.getByRole('button', { name: tiers.save }));

    expect(await screen.findByText(factoryOrders.range(0, 3))).toBeInTheDocument();
    expect(screen.getByText(factoryOrders.otherStyleWrong('double-hung'))).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText(factoryOrders.style), 'double-hung');
    expect(screen.getByText(factoryOrders.minOverMax)).toBeInTheDocument();
    expect(api.count(PUT)).toBe(0);
  });

  it('goes back to the standard values with an empty body', async () => {
    orderApi('owner', { roundingIn: 0.25 });
    const { user } = renderAt(<FactoryOrdersSection />, '/settings/prices');

    const rounding = await screen.findByLabelText(factoryOrders.rounding);
    expect(rounding).toHaveValue('0.25');
    await user.click(screen.getByRole('button', { name: factoryOrders.useDefaults }));

    await waitFor(() => expect(api.count(PUT)).toBe(1));
    expect(sentBodies()[0]).toEqual({});
    await waitFor(() => expect(screen.getByLabelText(factoryOrders.rounding)).toHaveValue('0.125'));
  });

  it('is read-only for office', async () => {
    orderApi('office');
    renderAt(<FactoryOrdersSection />, '/settings/prices');

    expect(await screen.findByLabelText(factoryOrders.widthDeduction)).toBeDisabled();
    expect(screen.getByText(tiers.officeReadOnly)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: tiers.save })).toBeNull();
    expect(screen.queryByRole('button', { name: factoryOrders.useDefaults })).toBeNull();
  });

  it('patchOf is empty for the standard values', () => {
    expect(patchOf(DEFAULT_WINDOW_ORDER_SETTINGS)).toEqual({});
  });
});
