import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient, Providers } from '../src/app/providers.tsx';
import { measure } from '../src/copy/measure.ts';
import { RequestsList } from '../src/features/measure/lift/RequestsList.tsx';

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ proposals: [], total: 0 }), { status: 200, headers: { 'content-type': 'application/json' } })),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderEmpty() {
  const client = createQueryClient();
  client.setDefaultOptions({ queries: { retry: false } });
  render(
    <Providers client={client}>
      <RouterProvider router={createMemoryRouter([{ path: '*', element: <RequestsList selectedId="" /> }], { initialEntries: ['/estimator'] })} />
    </Providers>,
  );
}

describe('RequestsList with no request yet', () => {
  it('says how to start one and has the button that does it, which puts the cursor in the search', async () => {
    renderEmpty();
    expect(await screen.findByText(measure.requestsEmpty)).toBeInTheDocument();
    expect(screen.getByText(measure.requestsEmptyHint)).toBeInTheDocument();
    const search = screen.getByRole('searchbox', { name: measure.requestsSearch });
    expect(search).not.toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: measure.requestsEmptyAction }));
    expect(search).toHaveFocus();
  });

  it('is titled Requests, short enough not to wrap beside the count', async () => {
    renderEmpty();
    await screen.findByText(measure.requestsEmpty);
    expect(screen.getByRole('heading', { name: measure.requestsTitle })).toBeInTheDocument();
    expect(measure.requestsTitle).toBe('Requests');
  });
});
