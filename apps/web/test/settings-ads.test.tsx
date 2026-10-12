import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdAccount } from '../src/api/types.ts';
import { connections } from '../src/copy/connections.ts';
import { ConnectionsTab } from '../src/features/settings/ConnectionsTab.tsx';
import { ACCOUNT, renderAt, type Routes, stubApi } from './helpers.tsx';

/*
 * The ad account cards under Settings, Connections. The ad API is built later (Task 16); these
 * tests answer its shapes from a small in-memory list the answers change.
 */

const MANAGER = '123-456-7890';
const BUSINESS = '984512300012345';

let api: ReturnType<typeof stubApi>;
let accounts: AdAccount[];
let role: 'owner' | 'office';

beforeEach(() => {
  accounts = [];
  role = 'owner';
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  expect(api?.unexpected ?? []).toEqual([]);
});

function account(overrides: Partial<AdAccount> & Pick<AdAccount, 'id' | 'platform' | 'externalAccountId'>): AdAccount {
  return { status: 'pending', name: null, reason: null, linkedAt: null, ...overrides };
}

/** The answers of the ad API, reading and changing `accounts`. `extra` replaces any of them. */
function adRoutes(extra: Routes = {}): Routes {
  return {
    'GET /api/auth/me': () => ({ body: { ...ACCOUNT, role } }),
    'GET /api/ads/accounts': () => ({ body: { accounts, managerId: MANAGER, businessId: BUSINESS } }),
    // C1's calendar card and the company read on the same Settings tab
    'GET /api/calendar/connection': () => ({ body: { provider: null, status: null, accountEmail: null, calendarId: null, calendarName: null, lastSyncedAt: null, configured: { google: false, microsoft: false } } }),
    'GET /api/company': () => ({ body: { id: 'c1', name: 'Summit Roofing', slug: 'summit-roofing', status: 'active', legalName: null, phone: null, email: null, website: null, addressStreet: null, addressCity: null, addressState: null, addressZip: null, timezone: 'America/Chicago', logoUrl: null, located: false, serviceAreaMiles: null } }),
    'POST /api/ads/accounts/google': ({ body }) => {
      const customerId = (body as { customerId: string }).customerId;
      const created = account({ id: 'g1', platform: 'google', externalAccountId: customerId });
      accounts = [...accounts, created];
      return { status: 201, body: { account: created, instructions: { managerId: MANAGER } } };
    },
    'POST /api/ads/accounts/meta': ({ body }) => {
      const adAccountId = (body as { adAccountId: string }).adAccountId;
      const created = account({ id: 'm1', platform: 'meta', externalAccountId: adAccountId, reason: 'access' });
      accounts = [...accounts, created];
      return { status: 201, body: { account: created } };
    },
    'POST /api/ads/accounts/g1/check': () => {
      accounts = accounts.map((row) => (row.id === 'g1' ? { ...row, status: 'active' as const, reason: null } : row));
      return { body: accounts.find((row) => row.id === 'g1') };
    },
    'POST /api/ads/accounts/m1/check': () => {
      accounts = accounts.map((row) => (row.id === 'm1' ? { ...row, status: 'active' as const, reason: null } : row));
      return { body: accounts.find((row) => row.id === 'm1') };
    },
    'DELETE /api/ads/accounts/g1': () => {
      accounts = accounts.map((row) => (row.id === 'g1' ? { ...row, status: 'revoked' as const } : row));
      return { body: accounts.find((row) => row.id === 'g1') };
    },
    ...extra,
  };
}

/** The Google card (a region named by its heading) and the Meta card. */
const googleCard = () => screen.findByRole('region', { name: connections.googleAds });
const metaCard = () => screen.findByRole('region', { name: connections.meta });

function renderConnections() {
  api = stubApi(adRoutes());
  return renderAt(<ConnectionsTab />, '/settings/connections');
}

describe('settings: ad connections', () => {
  it('connections tab lists both ad accounts with Roofline ids in the steps', async () => {
    renderConnections();

    expect(await screen.findByRole('heading', { name: connections.googleAds })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: connections.meta })).toBeInTheDocument();
    expect(screen.getByText(connections.googleStepManager(MANAGER))).toBeInTheDocument();
    expect(screen.getByText(connections.metaStepBusiness(BUSINESS))).toBeInTheDocument();
  });

  it('google: connect with a customer ID, then pending status with Check again', async () => {
    const { user } = renderConnections();
    const google = await googleCard();

    await user.type(within(google).getByLabelText(connections.googleCustomerId), '123-456-7890');
    await user.click(within(google).getByRole('button', { name: connections.adConnect }));

    await waitFor(() => expect(api.sent('POST /api/ads/accounts/google')).toEqual([{ customerId: '123-456-7890' }]));
    expect(await within(google).findByText(connections.statuses.pending)).toBeInTheDocument();
    expect(within(google).getByRole('button', { name: connections.checkAgain })).toBeInTheDocument();
  });

  it('google: Check again turns the account active', async () => {
    accounts = [account({ id: 'g1', platform: 'google', externalAccountId: '1234567890' })];
    const { user } = renderConnections();
    const google = await googleCard();

    await user.click(await within(google).findByRole('button', { name: connections.checkAgain }));

    await waitFor(() => expect(api.count('POST /api/ads/accounts/g1/check')).toBe(1));
    expect(await within(google).findByText(connections.statuses.active)).toBeInTheDocument();
    expect(within(google).queryByRole('button', { name: connections.checkAgain })).toBeNull();
  });

  it('google: an ID that is not ten digits is refused before sending', async () => {
    const { user } = renderConnections();
    const google = await googleCard();
    const field = within(google).getByLabelText(connections.googleCustomerId);
    const connect = within(google).getByRole('button', { name: connections.adConnect });

    await user.type(field, '123-456-789');
    expect(connect).toBeDisabled();
    await user.click(connect);
    expect(api.sent('POST /api/ads/accounts/google')).toEqual([]);

    await user.clear(field);
    await user.type(field, '1234567890123');
    await user.click(within(google).getByRole('button', { name: connections.adConnect }));

    expect(await within(google).findByText(connections.googleIdInvalid)).toBeInTheDocument();
    expect(api.sent('POST /api/ads/accounts/google')).toEqual([]);
  });

  it('meta: connect with an ad account ID shows pending with the plain reason', async () => {
    const { user } = renderConnections();
    const meta = await metaCard();

    await user.type(within(meta).getByLabelText(connections.metaAdAccountId), 'act_123456789');
    await user.click(within(meta).getByRole('button', { name: connections.adConnect }));

    await waitFor(() => expect(api.sent('POST /api/ads/accounts/meta')).toEqual([{ adAccountId: 'act_123456789' }]));
    expect(await within(meta).findByText(connections.statuses.pending)).toBeInTheDocument();
    expect(within(meta).getByText(connections.reasons.access)).toBeInTheDocument();
  });

  it('meta: Check again turns the account active', async () => {
    accounts = [account({ id: 'm1', platform: 'meta', externalAccountId: 'act_123456789', reason: 'access' })];
    const { user } = renderConnections();
    const meta = await metaCard();

    await user.click(await within(meta).findByRole('button', { name: connections.checkAgain }));

    await waitFor(() => expect(api.count('POST /api/ads/accounts/m1/check')).toBe(1));
    expect(await within(meta).findByText(connections.statuses.active)).toBeInTheDocument();
    expect(within(meta).queryByText(connections.reasons.access)).toBeNull();
  });

  it('meta: server validation error shows under the field', async () => {
    const message = 'Enter the ad account ID as act_ and digits.';
    api = stubApi(
      adRoutes({
        'POST /api/ads/accounts/meta': () => ({ status: 400, body: { error: message, field: 'adAccountId' } }),
      }),
    );
    const { user } = renderAt(<ConnectionsTab />, '/settings/connections');
    const meta = await metaCard();

    await user.type(within(meta).getByLabelText(connections.metaAdAccountId), 'nope');
    await user.click(within(meta).getByRole('button', { name: connections.adConnect }));

    expect(await within(meta).findByText(message)).toBeInTheDocument();
    expect(within(meta).getByLabelText(connections.metaAdAccountId)).toHaveAttribute('aria-invalid', 'true');
  });

  it('remove an account', async () => {
    accounts = [account({ id: 'g1', platform: 'google', externalAccountId: '1234567890', status: 'active' })];
    const { user } = renderConnections();
    const google = await googleCard();

    await user.click(await within(google).findByRole('button', { name: connections.remove }));

    await waitFor(() => expect(api.sent('DELETE /api/ads/accounts/g1')).toEqual([undefined]));
    expect(await within(google).findByLabelText(connections.googleCustomerId)).toBeInTheDocument();
    expect(within(google).queryByText(connections.statuses.active)).toBeNull();
    expect(within(google).queryByText(connections.statuses.revoked)).toBeNull();
  });

  it('office sees status but no connect or remove controls', async () => {
    role = 'office';
    accounts = [
      account({ id: 'g1', platform: 'google', externalAccountId: '1234567890', status: 'active' }),
      account({ id: 'm1', platform: 'meta', externalAccountId: 'act_123456789', status: 'pending', reason: 'payment' }),
    ];
    renderConnections();
    const google = await googleCard();
    const meta = await metaCard();

    expect(within(google).getByText(connections.statuses.active)).toBeInTheDocument();
    expect(within(meta).getByText(connections.statuses.pending)).toBeInTheDocument();
    expect(within(meta).getByText(connections.reasons.payment)).toBeInTheDocument();
    for (const card of [google, meta]) {
      expect(within(card).queryByRole('button', { name: connections.adConnect })).toBeNull();
      expect(within(card).queryByRole('button', { name: connections.checkAgain })).toBeNull();
      expect(within(card).queryByRole('button', { name: connections.remove })).toBeNull();
    }
  });

  it('only one coming-soon line is shown', async () => {
    renderConnections();

    expect(await screen.findByRole('heading', { name: connections.googleAds })).toBeInTheDocument();
    expect(screen.getAllByText(connections.later)).toHaveLength(1);
    expect(screen.queryByText(/on their way/)).toBeNull();
  });
});
