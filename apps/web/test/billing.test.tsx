import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
// RouterProvider from 'react-router', not 'react-router/dom': under Vitest the two load as separate copies of the router
import { RouterProvider } from 'react-router';
import { afterEach, expect, it, vi } from 'vitest';
import type { BillingView, PlanSummary } from '@roofline/shared';
import type { Account } from '../src/api/types.ts';
import { createQueryClient, Providers } from '../src/app/providers.tsx';
import { createAppRouter } from '../src/app/router.tsx';
import { billing } from '../src/copy/billing.ts';
import { go } from '../src/features/billing/api.ts';
import { ACCOUNT, COMPANY, type Routes, SHELL_ROUTES, stubApi, where } from './helpers.tsx';

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
  vi.restoreAllMocks();
  expect(api?.unexpected ?? []).toEqual([]);
});

type Status = Account['company']['status'];
type Role = Account['role'];

const STARTER: PlanSummary = {
  key: 'starter',
  name: 'Starter',
  monthlyPriceCents: 19900,
  included: { aiCallMinutes: 300, smsSegments: 1000 },
  overageCents: { aiCallMinute: 25, smsSegment: 2 },
};

const GROWTH: PlanSummary = {
  key: 'growth',
  name: 'Growth',
  monthlyPriceCents: 49900,
  included: { aiCallMinutes: 900, smsSegments: 3000 },
  overageCents: { aiCallMinute: 20, smsSegment: 2 },
};

const CHECKOUT_URL = 'https://checkout.stripe.test/c/cs_fake_1';
const PORTAL_URL = 'https://billing.stripe.test/p/session_fake_1';

/** A BillingView as the owner's billing read sends it. Pass what differs. */
function billingView(overrides: Partial<BillingView> = {}): BillingView {
  return {
    status: 'active',
    planKey: null,
    planName: null,
    trialEndsAt: null,
    hasPaymentMethod: false,
    canOpenPortal: false,
    periodStart: '2026-10-01T00:00:00.000Z',
    usage: [],
    plans: [STARTER],
    ...overrides,
  };
}

/** The signed-in account, with its company at `status` and its role as given. */
function accountWith(status: Status, role: Role): Account {
  return { ...ACCOUNT, role, company: { ...COMPANY, status } };
}

/**
 * A signed-in user. An owner gets the billing read answered with `view`; anyone else gets no billing
 * route, so a call to it shows up as unexpected.
 */
function signedIn({
  status = 'active',
  role = 'owner',
  view = billingView(),
  routes = {},
}: { status?: Status; role?: Role; view?: BillingView; routes?: Routes } = {}) {
  api = stubApi({
    ...SHELL_ROUTES,
    'GET /api/auth/me': () => ({ body: accountWith(status, role) }),
    ...(role === 'owner' ? { 'GET /api/billing': () => ({ body: view }) } : {}),
    ...routes,
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

it('owner sees the plan, usage and plans', async () => {
  signedIn({
    view: billingView({
      usage: [
        { meter: 'sms_segment', used: 6, included: null },
        { meter: 'ai_call_minute', used: 12, included: 300 },
      ],
      plans: [STARTER],
    }),
  });
  renderApp('/settings/billing');

  expect(await screen.findByText(billing.noPlan)).toBeInTheDocument();
  expect(await screen.findByText('6 so far')).toBeInTheDocument();
  expect(screen.getAllByText('12 of 300 AI call minutes').length).toBeGreaterThan(0);
  expect(screen.getByText('$199/month')).toBeInTheDocument();
  expect(screen.getByText('Includes 300 AI call minutes and 1,000 text segments')).toBeInTheDocument();
});

it('Pick this plan goes to checkout', async () => {
  const assign = vi.spyOn(go, 'assign').mockImplementation(() => {});
  signedIn({
    view: billingView({ hasPaymentMethod: false, plans: [STARTER] }),
    routes: {
      'POST /api/billing/checkout': () => ({ body: { url: CHECKOUT_URL } }),
    },
  });
  const { user } = renderApp('/settings/billing');

  await user.click(await screen.findByRole('button', { name: billing.pickPlan }));

  await waitFor(() => expect(assign).toHaveBeenCalledWith(CHECKOUT_URL));
  expect(api.sent('POST /api/billing/checkout')).toEqual([{ planKey: 'starter' }]);
});

it('subscribed owners switch plans in place', async () => {
  signedIn({
    view: billingView({
      status: 'active',
      planKey: 'growth',
      planName: 'Growth',
      hasPaymentMethod: true,
      canOpenPortal: true,
      plans: [STARTER, GROWTH],
    }),
    routes: {
      'POST /api/billing/plan': () => ({ body: { ok: true } }),
    },
  });
  const { user } = renderApp('/settings/billing');

  await user.click(await screen.findByRole('button', { name: billing.switchPlan }));

  expect(await screen.findByText(billing.planChangeRequested)).toBeInTheDocument();
  expect(api.sent('POST /api/billing/plan')).toEqual([{ planKey: 'starter' }]);
});

it('office sees the owner-only note', async () => {
  signedIn({ role: 'office' });
  renderApp('/settings/billing');

  expect(await screen.findByText('Only the owner can see billing.')).toBeInTheDocument();
  expect(api.calls.some((call) => call.key === 'GET /api/billing')).toBe(false);
});

it('trial ended shows the pick-a-plan banner', async () => {
  signedIn({
    status: 'trial_ended',
    view: billingView({ status: 'trial_ended' }),
  });
  renderApp('/settings/billing');

  expect(await screen.findByRole('link', { name: 'Pick a plan to keep going' })).toBeInTheDocument();
  expect(screen.getByText(billing.banners.trialEnded)).toBeInTheDocument();
});

it('past due shows the payment banner, with Fix payment for the owner', async () => {
  const assign = vi.spyOn(go, 'assign').mockImplementation(() => {});
  signedIn({
    status: 'past_due',
    view: billingView({ status: 'past_due', canOpenPortal: true }),
    routes: {
      'POST /api/billing/portal': () => ({ body: { url: PORTAL_URL } }),
    },
  });
  const { user } = renderApp('/settings/billing');

  expect(
    await screen.findByText("Your payment didn't go through. Texts and calls are paused until it's fixed."),
  ).toBeInTheDocument();
  await user.click(await screen.findByRole('button', { name: 'Fix payment' }));

  await waitFor(() => expect(assign).toHaveBeenCalledWith(PORTAL_URL));
  expect(api.count('POST /api/billing/portal')).toBe(1);
});

it('past due tells an office user to ask the owner, with no Fix payment button', async () => {
  signedIn({ status: 'past_due', role: 'office' });
  renderApp('/settings/billing');

  expect(
    await screen.findByText("Your payment didn't go through. Texts and calls are paused until it's fixed."),
  ).toBeInTheDocument();
  expect(screen.getByText('Ask your owner to update the card.')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Fix payment' })).not.toBeInTheDocument();
});

it.each(['trial', 'active'] as const)('no banner while the company is %s', async (status) => {
  signedIn({ status, view: billingView({ status }) });
  renderApp('/settings/billing');

  expect(await screen.findByRole('heading', { name: billing.plansHeading })).toBeInTheDocument();
  expect(screen.queryByText(billing.banners.trialEnded)).not.toBeInTheDocument();
  expect(screen.queryByText(billing.banners.canceled)).not.toBeInTheDocument();
  expect(screen.queryByText(billing.banners.pastDue)).not.toBeInTheDocument();
  expect(screen.queryByRole('link', { name: billing.banners.pickPlan })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: billing.banners.fixPayment })).not.toBeInTheDocument();
});

it('thanks after checkout, once, and refreshes the plan', async () => {
  signedIn({ view: billingView({ planKey: 'starter', planName: 'Starter', hasPaymentMethod: true }) });
  const { router } = renderApp('/settings/billing');

  expect(await screen.findByRole('heading', { name: billing.plansHeading })).toBeInTheDocument();
  await waitFor(() => expect(api.count('GET /api/billing')).toBeGreaterThanOrEqual(1));
  const meBefore = api.count('GET /api/auth/me');
  const billingBefore = api.count('GET /api/billing');

  await act(async () => {
    await router.navigate('/settings/billing?checkout=done');
  });

  expect(await screen.findByText(billing.thanks)).toBeInTheDocument();
  await waitFor(() => expect(where(router)).toBe('/settings/billing'));
  expect(screen.getAllByText(billing.thanks)).toHaveLength(1);
  await waitFor(() => expect(api.count('GET /api/auth/me')).toBeGreaterThan(meBefore));
  await waitFor(() => expect(api.count('GET /api/billing')).toBeGreaterThan(billingBefore));
  expect(screen.getByRole('heading', { name: billing.plansHeading })).toBeInTheDocument();
});

it('shows the server message when checkout is refused', async () => {
  const assign = vi.spyOn(go, 'assign').mockImplementation(() => {});
  const message = 'Please confirm your email first. We sent you a link.';
  signedIn({
    view: billingView({ hasPaymentMethod: false, plans: [STARTER] }),
    routes: {
      'POST /api/billing/checkout': () => ({ status: 403, body: { error: message } }),
    },
  });
  const { user } = renderApp('/settings/billing');

  await user.click(await screen.findByRole('button', { name: billing.pickPlan }));

  expect(await screen.findByText(message)).toBeInTheDocument();
  expect(assign).not.toHaveBeenCalled();
});

it('shows the server message when the payment portal fails', async () => {
  vi.spyOn(go, 'assign').mockImplementation(() => {});
  signedIn({
    status: 'past_due',
    view: billingView({ status: 'past_due', canOpenPortal: true }),
    routes: {
      'POST /api/billing/portal': () => ({ status: 502, body: { error: 'X' } }),
    },
  });
  const { user } = renderApp('/settings/billing');

  await user.click(await screen.findByRole('button', { name: billing.banners.fixPayment }));

  expect(await screen.findByText('X')).toBeInTheDocument();
});

it('a canceled company can pick its old plan again', async () => {
  vi.spyOn(go, 'assign').mockImplementation(() => {});
  signedIn({
    status: 'canceled',
    view: billingView({
      status: 'canceled',
      planKey: 'growth',
      planName: 'Growth',
      hasPaymentMethod: false,
      plans: [STARTER, GROWTH],
    }),
    routes: {
      'POST /api/billing/checkout': () => ({ body: { url: CHECKOUT_URL } }),
    },
  });
  const { user } = renderApp('/settings/billing');

  const card = (await screen.findByRole('heading', { name: 'Growth', level: 4 })).closest('li') as HTMLElement;
  expect(within(card).queryByText(billing.yourPlan)).not.toBeInTheDocument();
  await user.click(within(card).getByRole('button', { name: billing.pickPlan }));

  await waitFor(() => expect(api.sent('POST /api/billing/checkout')).toEqual([{ planKey: 'growth' }]));
});

it('an active subscriber still sees Your plan on its own plan', async () => {
  signedIn({
    view: billingView({
      status: 'active',
      planKey: 'growth',
      planName: 'Growth',
      hasPaymentMethod: true,
      plans: [STARTER, GROWTH],
    }),
  });
  renderApp('/settings/billing');

  const card = (await screen.findByRole('heading', { name: 'Growth', level: 4 })).closest('li') as HTMLElement;
  expect(within(card).getByText(billing.yourPlan)).toBeInTheDocument();
});
