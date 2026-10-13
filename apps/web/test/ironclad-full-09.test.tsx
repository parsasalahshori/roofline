import { act, cleanup, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { BillingView } from '@roofline/shared';
import { SignUp } from '../src/features/signup/SignUp.tsx';
import { BillingTab } from '../src/features/billing/BillingTab.tsx';
import { PlanPicker } from '../src/features/billing/PlanPicker.tsx';
import { ACCOUNT, renderAt, stubApi } from './helpers.tsx';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const view: BillingView = {
  status: 'trial', planKey: null, planName: null, trialEndsAt: null,
  hasPaymentMethod: false, canOpenPortal: false, periodStart: '2026-10-01T00:00:00.000Z', usage: [],
  plans: ['small', 'large'].map((key) => ({
    key, name: key, monthlyPriceCents: 10000,
    included: { aiCallMinutes: 100, smsSegments: 200 },
    overageCents: { aiCallMinute: 20, smsSegment: 2 },
  })),
};

it('lets a new owner revisit account details without losing company input or sending signup', async () => {
  const api = stubApi({ 'GET /api/auth/config': () => ({ body: { googleClientId: null } }) });
  const { user } = renderAt(<SignUp />);
  await user.type(screen.getByLabelText('Your name'), 'Pat Roofer');
  await user.type(screen.getByLabelText('Email'), 'pat@example.test');
  await user.type(screen.getByLabelText('Password'), 'correct-horse-battery');
  await user.click(screen.getByRole('button', { name: 'Continue' }));
  await user.type(screen.getByLabelText('Company name'), 'Pat Roofing');
  await user.click(screen.getByRole('button', { name: 'Back to your details' }));
  expect(screen.getByLabelText('Your name')).toHaveValue('Pat Roofer');
  expect(screen.getByLabelText('Email')).toHaveValue('pat@example.test');
  await user.click(screen.getByRole('button', { name: 'Continue' }));
  expect(screen.getByLabelText('Company name')).toHaveValue('Pat Roofing');
  expect(api.count('POST /api/auth/signup')).toBe(0);
  expect(api.unexpected).toEqual([]);
});

it('recovers a failed billing read using the existing query', async () => {
  let failed = true;
  const api = stubApi({
    'GET /api/auth/me': () => ({ body: ACCOUNT }),
    'GET /api/billing': () => failed ? { status: 503, body: { error: 'Billing is temporarily unavailable.' } } : { body: view },
  });
  const { user } = renderAt(<BillingTab />);
  expect(await screen.findByText('Billing is temporarily unavailable.')).toBeInTheDocument();
  failed = false;
  await user.click(screen.getByRole('button', { name: 'Try again' }));
  expect(await screen.findByRole('heading', { name: 'No plan yet' })).toBeInTheDocument();
  expect(api.count('GET /api/billing')).toBe(2);
  expect(api.unexpected).toEqual([]);
});

it.each([false, true])('locks all plan choices while a billing action is pending (subscribed: %s)', async (subscribed) => {
  let resolve!: (response: Response) => void;
  const fetch = vi.fn(() => new Promise<Response>((done) => { resolve = done; }));
  vi.stubGlobal('fetch', fetch);
  const { user } = renderAt(<PlanPicker view={{ ...view, hasPaymentMethod: subscribed }} />);
  const buttons = screen.getAllByRole('button', { name: subscribed ? 'Switch to this plan' : 'Pick this plan' });
  await user.click(buttons[0]!);
  await waitFor(() => expect(buttons[1]).toBeDisabled());
  await user.click(buttons[1]!);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0]).toEqual([
    subscribed ? '/api/billing/plan' : '/api/billing/checkout',
    expect.objectContaining({ method: 'POST', body: JSON.stringify({ planKey: 'small' }) }),
  ]);
  await act(async () => resolve(new Response(JSON.stringify({ error: 'Please try again.' }), { status: 503 })));
  await waitFor(() => expect(buttons[1]).toBeEnabled());
  expect(await screen.findByText('Please try again.')).toBeInTheDocument();
});

it('keeps import navigation tied to the selected import when moving between uploaded files', async () => {
  const { render } = await import('@testing-library/react');
  const { createMemoryRouter, RouterProvider } = await import('react-router');
  const { createQueryClient, Providers } = await import('../src/app/providers.tsx');
  const { ImportWizard } = await import('../src/features/imports/ImportWizard.tsx');
  const makeImport = (id: string) => ({
    id, fileName: `${id}.csv`, status: 'uploaded', headers: ['Name', 'Phone'], mapping: { name: 0, phone: 1 },
    rowCount: 0, preview: [], progress: { processed: 0, total: 0 },
    counts: { total: 0, new: 0, updated: 0, skipped: 0, skippedBy: { noName: 0, noContact: 0, badPhone: 0, duplicate: 0 },
      consent: { attested: 0, express: 0, unchanged: 0, optedOutKept: 0 }, jobs: 0, processed: 0, located: 0, notLocated: 0 },
    consentAttested: false, startedAt: null, finishedAt: null, errorPlain: null, skippedDownloadUrl: null,
  });
  const api = stubApi({
    'GET /api/imports/i1?attested=false': () => ({ body: makeImport('i1') }),
    'GET /api/imports/i2?attested=false': () => ({ body: makeImport('i2') }),
    'PATCH /api/imports/i1': () => ({ body: makeImport('i1') }),
  });
  const router = createMemoryRouter([{ path: '/imports/:importId', element: <ImportWizard /> }], { initialEntries: ['/imports/i1'] });
  render(<Providers client={createQueryClient()}><RouterProvider router={router} /></Providers>);
  const { default: userEvent } = await import('@testing-library/user-event');
  const user = userEvent.setup();
  await screen.findByRole('heading', { name: 'Match your columns' });
  await user.click(screen.getByRole('button', { name: 'Next' }));
  await screen.findByRole('heading', { name: 'Here is what will happen' });
  expect(screen.getByRole('list', { name: 'Import steps' }).querySelector('[aria-current="step"]')).toHaveTextContent('Preview');
  expect(api.sent('PATCH /api/imports/i1')).toEqual([{ mapping: { name: 0, phone: 1 } }]);
  await act(async () => { await router.navigate('/imports/i2'); });
  await screen.findByRole('heading', { name: 'Match your columns' });
  expect(screen.getByRole('list', { name: 'Import steps' }).querySelector('[aria-current="step"]')).toHaveTextContent('Match columns');
  expect(api.count('POST /api/imports/i1/start')).toBe(0);
  expect(api.unexpected).toEqual([]);
});
