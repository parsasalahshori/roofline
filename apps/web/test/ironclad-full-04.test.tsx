import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient, Providers } from '../src/app/providers.tsx';
import { createAppRouter } from '../src/app/router.tsx';
import { calculateQuote, defaultPricebook, defaultScope, type QuoteView } from '@roofline/shared';
import { quotes } from '../src/copy/quotes.ts';
import { QuoteWindow } from '../src/features/quotes/QuoteWindow.tsx';
import { estimator } from '../src/copy/estimator.ts';
import { ACCOUNT, proposalListRoutes, SHELL_ROUTES, stubApi } from './helpers.tsx';

vi.mock('../src/shell/map/MapView.tsx', () => ({ MapView: () => null }));

let api: ReturnType<typeof stubApi>;
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  expect(api?.unexpected ?? []).toEqual([]);
});

function renderEstimator() {
  const client = createQueryClient();
  client.setDefaultOptions({ queries: { retry: false } });
  const router = createAppRouter({ initialEntries: ['/estimator'] });
  render(<Providers client={client}><RouterProvider router={router} /></Providers>);
  return userEvent.setup();
}

describe('Ironclad estimator entry', () => {
  it('offers a visible address action without measuring, sending, or assuming text consent', async () => {
    api = stubApi({
      ...SHELL_ROUTES,
      ...proposalListRoutes(),
      'GET /api/auth/me': () => ({ body: ACCOUNT }),
      'GET /api/properties?q=99%20Elm%20Rd&limit=8': () => ({ body: { properties: [], total: 0 } }),
    });
    const user = renderEstimator();
    const action = await screen.findByRole('button', { name: 'Use this address' });
    expect(action).toBeDisabled();
    await user.type(screen.getByLabelText(estimator.addressLabel), '99 Elm Rd');
    await user.click(action);
    expect(await screen.findByLabelText(estimator.customerName)).toHaveValue('');
    expect(screen.getByLabelText(estimator.askedByText)).not.toBeChecked();
    expect(screen.getByRole('button', { name: estimator.makeProposal })).toBeDisabled();
    expect(api.calls.filter(({ key }) => key.startsWith('POST /api/measurements') || key.startsWith('POST /api/proposals'))).toHaveLength(0);
  });

  it('makes a failed saved-home lookup visible and retryable without creating a proposal', async () => {
    let failed = true;
    api = stubApi({
      ...SHELL_ROUTES,
      ...proposalListRoutes(),
      'GET /api/auth/me': () => ({ body: ACCOUNT }),
      'GET /api/properties?q=99%20Elm%20Rd&limit=8': () => failed
        ? { status: 503, body: { error: 'Unavailable' } }
        : { body: { properties: [], total: 0 } },
    });
    const user = renderEstimator();
    await user.type(await screen.findByLabelText(estimator.addressLabel), '99 Elm Rd');
    await screen.findByText('Saved homes could not load. You can retry or use the full address.');
    failed = false;
    await user.click(screen.getByRole('button', { name: 'Retry home search' }));
    await waitFor(() => expect(screen.queryByText('Saved homes could not load. You can retry or use the full address.')).not.toBeInTheDocument());
    expect(api.calls.filter(({ key }) => key.startsWith('POST /api/measurements') || key.startsWith('POST /api/proposals'))).toHaveLength(0);
  });
});


describe('Ironclad quote save feedback', () => {
  it('keeps unsaved feedback after a refused save and clears it only after the server accepts the draft', async () => {
    const quote: QuoteView = {
      id: 'q1', jobId: 'j1', number: 'Q-0001', status: 'draft',
      measurement: { source: 'manual', areaSqFt: defaultScope.areaSqFt, areaType: 'surface', pitch: 6, notes: null },
      scope: defaultScope, prices: defaultPricebook, calculation: calculateQuote(defaultScope, defaultPricebook),
      notes: null, validUntil: '2026-11-12T00:00:00.000Z', createdAt: '2026-10-12T12:00:00.000Z', finalizedAt: null, canEdit: true,
    };
    let refused = true;
    api = stubApi({
      'GET /api/company': () => ({ body: { timezone: 'America/Chicago' } }),
      'GET /api/quotes/q1': () => ({ body: quote }),
      'PATCH /api/quotes/q1': () => refused
        ? { status: 403, body: { error: 'This company is read-only.' } }
        : { body: { ...quote, notes: 'Replace flashing' } },
    });
    const client = createQueryClient();
    client.setDefaultOptions({ queries: { retry: false } });
    const router = createMemoryRouter([{ path: '/jobs/:jobId/quotes/:quoteId', element: <QuoteWindow /> }], {
      initialEntries: ['/jobs/j1/quotes/q1'],
    });
    render(<Providers client={client}><RouterProvider router={router} /></Providers>);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText(quotes.notes), 'Replace flashing');
    expect(screen.getByText(quotes.unsaved)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: quotes.save }));
    await screen.findByText('This company is read-only.');
    expect(screen.getByText(quotes.unsaved)).toBeInTheDocument();
    refused = false;
    await user.click(screen.getByRole('button', { name: quotes.save }));
    await waitFor(() => expect(screen.queryByText(quotes.unsaved)).not.toBeInTheDocument());
    expect(api.sent('PATCH /api/quotes/q1')).toHaveLength(2);
    expect(api.sent('PATCH /api/quotes/q1')[1]).toMatchObject({ scope: defaultScope, notes: 'Replace flashing' });
  });
});
