import type { BackofficeOrder, BackofficeQuote } from '@roofline/shared';
import { QueryClient } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Providers } from '../src/app/providers.tsx';
import { backofficeDesigner as copy } from '../src/copy/backofficeDesigner.ts';
import { QuoteEditor } from '../src/features/backoffice/designer/QuoteEditor.tsx';
import { previewQuote } from '../src/features/backoffice/designer/pricing.ts';
import { ACCOUNT } from './helpers.tsx';
import { catalogFixture, designsFixture, makeQuote } from './bo-designer-fixtures.ts';

/*
 * Deciding on a quote in the editor: an over-the-limit discount is approved by the office or the owner, then the customer's
 * yes makes the order; an accepted quote is locked; a failed save can be tried again.
 */

type Call = { method: string; url: string; body: unknown };
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'Content-Type': 'application/json' } });

const ORDER = { id: 'ord1', quoteId: 'q1', stage: 'sold' } as BackofficeOrder;

function mockApi(o: { quote?: BackofficeQuote; role?: 'owner' | 'office' | 'rep'; failPutTimes?: number } = {}) {
  const calls: Call[] = [];
  let latest = o.quote ?? makeQuote();
  let failures = o.failPutTimes ?? 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, url, body });
      if (url.endsWith('/api/auth/me')) return json({ ...ACCOUNT, role: o.role ?? 'owner', company: { ...ACCOUNT.company, backofficeEnabled: true } });
      if (url.endsWith('/api/backoffice/catalog')) return json(catalogFixture);
      if (url.endsWith('/quotes/q1') && method === 'PUT') {
        if (failures > 0) {
          failures -= 1;
          return json({ error: 'Nope' }, 500);
        }
        latest = { ...latest, ...(body as Partial<BackofficeQuote>), ...previewQuote(body as BackofficeQuote, catalogFixture) };
        return json(latest);
      }
      if (url.endsWith('/quotes/q1/approve-discount')) {
        latest = { ...latest, discountApprovedPercent: latest.discountPercent, discountApprovedBy: 'Brandon Pruitt' };
        return json(latest);
      }
      if (url.endsWith('/quotes/q1/accept')) return json(ORDER, 201);
      if (url.endsWith('/quotes/q1')) return json(latest);
      return json({}, 404);
    }),
  );
  return calls;
}

function renderEditor() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <Providers client={client}>
      <MemoryRouter initialEntries={['/backoffice/quotes/q1']}>
        <Routes>
          <Route path="/backoffice/quotes/:quoteId" element={<QuoteEditor />} />
          <Route path="/backoffice/orders/:orderId" element={<p>The order page</p>} />
        </Routes>
      </MemoryRouter>
    </Providers>,
  );
}

const setDiscount = (value: string) => fireEvent.change(screen.getByRole('textbox', { name: copy.discount }), { target: { value } });

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('the quote editor: the customer answer', () => {
  it('does not offer Accepted in the status control (only the accept button makes it)', async () => {
    mockApi();
    renderEditor();
    await screen.findByTestId('grand-total');
    const labels = screen.getAllByRole('radio').map((r) => r.textContent);
    expect(labels).not.toContain(copy.statuses.accepted);
    expect(labels).toEqual(expect.arrayContaining([copy.statuses.draft, copy.statuses.presented, copy.statuses.declined]));
  });

  it('saves the discount, approves it, then accepts and opens the order', async () => {
    const calls = mockApi({ role: 'office' });
    renderEditor();
    await screen.findByTestId('grand-total');
    const accept = () => screen.getByRole('button', { name: copy.acceptQuote });
    expect(accept()).toBeEnabled();

    setDiscount('15');
    expect(accept()).toBeDisabled();
    expect(screen.getByText(copy.acceptNeedsApproval)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: copy.approveDiscount }));

    await waitFor(() => expect(screen.getByText(copy.discountApprovedBy('Brandon Pruitt', 15))).toBeInTheDocument());
    const names = calls.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${c.url}`);
    // The discount is saved before it is approved, so the server approves the number on screen
    expect(names).toEqual(['PUT /api/backoffice/quotes/q1', 'POST /api/backoffice/quotes/q1/approve-discount']);
    expect(calls.find((c) => c.method === 'PUT')!.body).toMatchObject({ discountPercent: 15 });
    expect(accept()).toBeEnabled();

    // Raising the discount past what was approved asks again
    setDiscount('20');
    expect(accept()).toBeDisabled();
    setDiscount('15');
    expect(accept()).toBeEnabled();

    fireEvent.click(accept());
    expect(await screen.findByText('The order page')).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/quotes/q1/accept'))).toBe(true);
  });

  it('shows a rep that the office has to approve, with no approve button', async () => {
    mockApi({ role: 'rep' });
    renderEditor();
    await screen.findByTestId('grand-total');
    setDiscount('15');
    expect(await screen.findAllByText(copy.needsApprovalShort)).not.toHaveLength(0);
    expect(screen.queryByRole('button', { name: copy.approveDiscount })).toBeNull();
    expect(screen.getByRole('button', { name: copy.acceptQuote })).toBeDisabled();
  });

  it('will not accept a quote with no windows', async () => {
    mockApi({ quote: makeQuote([]) });
    renderEditor();
    await screen.findByTestId('grand-total');
    expect(screen.getByRole('button', { name: copy.acceptQuote })).toBeDisabled();
    expect(screen.getByText(copy.acceptNeedsDrawings)).toBeInTheDocument();
  });

  it('locks an accepted quote: a banner with the order, no accept or add-unit button, and units do not open', async () => {
    mockApi({ quote: makeQuote(designsFixture, { status: 'accepted', orderId: 'ord1' }) });
    renderEditor();
    await screen.findByTestId('grand-total');
    expect(screen.getByText(copy.lockedBanner)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: copy.openOrder })).toHaveAttribute('href', '/backoffice/orders/ord1');
    expect(screen.queryByRole('button', { name: copy.acceptQuote })).toBeNull();
    expect(screen.queryByRole('button', { name: new RegExp(copy.addUnit) })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: copy.openUnit('Kitchen') }));
    expect(screen.queryByRole('complementary')).toBeNull();
  });

  it('tries a failed save again when asked', async () => {
    const calls = mockApi({ failPutTimes: 1 });
    renderEditor();
    await screen.findByTestId('grand-total');
    setDiscount('3');
    fireEvent.click(await screen.findByRole('button', { name: copy.tryAgain }, { timeout: 3000 }));
    await waitFor(() => expect(screen.getByText(copy.saved)).toBeInTheDocument());
    const puts = calls.filter((c) => c.method === 'PUT');
    expect(puts).toHaveLength(2);
    expect(puts[1]!.body).toMatchObject({ discountPercent: 3 });
  });
});
