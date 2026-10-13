import type { ProposalStatus } from '@roofline/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient, Providers } from '../src/app/providers.tsx';
import { measure } from '../src/copy/measure.ts';
import { RequestsList } from '../src/features/measure/lift/RequestsList.tsx';
import { requestStatus } from '../src/features/measure/lift/requests.ts';

function proposal(id: string, status: ProposalStatus, name: string, address: string, measurementId: string, squares?: number) {
  return {
    id,
    number: `P-${id}`,
    status,
    jobId: 'j1',
    customer: { id: 'c1', name, phone: null },
    address,
    measurementId,
    basis: 'estimate',
    options:
      squares === undefined
        ? []
        : [{ id: `o-${id}`, tier: 'good', name: 'Good', scope: { material: 'architectural' }, calculation: { roofSquares: squares } }],
    messageBody: '',
    validUntil: '2026-11-12',
    sentAt: null,
    views: { count: 0, first: null, last: null },
    signed: null,
    declined: null,
    taskId: null,
    replacedById: null,
    canEdit: true,
  };
}

const ROWS = {
  draft: [proposal('1', 'draft', 'Mei Abernathy', '605 Catalpa St', 'm1', 28.25)],
  sent: [proposal('2', 'sent', 'Carmen Castellano', '410 Trails Ave', 'm2', 32.3)],
  signed: [proposal('3', 'signed', 'Graham Mendel', '416 Transom Ct', 'm3')],
};

let urls: string[];
let posts: { address?: string }[];

function Where() {
  return <p data-testid="where">{useLocation().pathname}</p>;
}

function renderList(selectedId = 'm1') {
  const queryClient = createQueryClient();
  queryClient.setDefaultOptions({ queries: { retry: false } });
  const router = createMemoryRouter(
    [
      {
        path: '*',
        element: (
          <>
            <RequestsList selectedId={selectedId} />
            <Where />
          </>
        ),
      },
    ],
    { initialEntries: ['/estimator/measure/m1'] },
  );
  render(
    <Providers client={queryClient}>
      <RouterProvider router={router} />
    </Providers>,
  );
}

beforeEach(() => {
  urls = [];
  posts = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === 'POST' && url === '/api/measurements') {
        posts.push(JSON.parse(String(init.body)) as { address?: string });
        const address = posts[posts.length - 1]?.address ?? '';
        if (address.includes('nowhere')) return new Response(JSON.stringify({ error: 'We could not find that address.' }), { status: 400, headers: { 'content-type': 'application/json' } });
        return new Response(JSON.stringify({ id: 'mnew' }), { status: 201, headers: { 'content-type': 'application/json' } });
      }
      urls.push(url);
      const params = new URL(url, 'http://x').searchParams;
      const status = params.get('status') as keyof typeof ROWS;
      const q = (params.get('q') ?? '').toLowerCase();
      const all = ROWS[status] ?? [];
      const proposals = all.filter((p) => q === '' || p.customer.name.toLowerCase().includes(q) || p.address.toLowerCase().includes(q));
      return new Response(JSON.stringify({ proposals, total: proposals.length }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('RequestsList', () => {
  it('shows each request with its address, material, status chip and squares, and the count', async () => {
    renderList();
    const mei = (await screen.findByText('Mei Abernathy')).closest('a') as HTMLElement;
    expect(within(mei).getByText('605 Catalpa St')).toBeInTheDocument();
    expect(within(mei).getByText(measure.materials.architectural)).toBeInTheDocument();
    expect(within(mei).getByText(measure.status.new_lead)).toBeInTheDocument();
    expect(within(mei).getByText('28.3 sq')).toBeInTheDocument();
    const carmen = screen.getByText('Carmen Castellano').closest('a') as HTMLElement;
    expect(within(carmen).getByText(measure.status.estimate_sent)).toBeInTheDocument();
    // No material or squares known: neither is drawn
    const graham = screen.getByText('Graham Mendel').closest('a') as HTMLElement;
    expect(within(graham).getByText(measure.status.signed)).toBeInTheDocument();
    expect(within(graham).queryByText(/ sq$/)).toBeNull();
    expect(screen.getByLabelText(measure.requestsCount(3))).toHaveTextContent('3');
  });

  it('links a sent or signed request to its proposal page, and a draft to none', async () => {
    renderList();
    await screen.findByText('Mei Abernathy');
    expect(screen.getByRole('link', { name: measure.proposalLinkLabel('Carmen Castellano') })).toHaveAttribute('href', '/estimator/proposals/2');
    expect(screen.getByRole('link', { name: measure.proposalLinkLabel('Graham Mendel') })).toHaveAttribute('href', '/estimator/proposals/3');
    expect(screen.queryByRole('link', { name: measure.proposalLinkLabel('Mei Abernathy') })).toBeNull();
  });

  it('highlights the open request', async () => {
    renderList('m2');
    await screen.findByText('Mei Abernathy');
    expect(screen.getByText('Carmen Castellano').closest('a')).toHaveAttribute('aria-current', 'true');
    expect(screen.getByText('Mei Abernathy').closest('a')).not.toHaveAttribute('aria-current');
  });

  it('opens a request in the measure window when clicked', async () => {
    renderList();
    fireEvent.click(await screen.findByText('Graham Mendel'));
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/estimator/measure/m3'));
  });

  it('searches by name or address on the server, and says when nothing matches', async () => {
    renderList();
    await screen.findByText('Mei Abernathy');
    const box = screen.getByRole('searchbox', { name: measure.requestsSearch });
    fireEvent.change(box, { target: { value: 'Catalpa' } });
    await waitFor(() => expect(urls.some((u) => u.includes('q=Catalpa'))).toBe(true));
    await waitFor(() => expect(screen.queryByText('Carmen Castellano')).toBeNull());
    expect(screen.getByText('Mei Abernathy')).toBeInTheDocument();
    fireEvent.change(box, { target: { value: 'zzzz' } });
    expect(await screen.findByText(measure.requestsNoMatches)).toBeInTheDocument();
  });

  it('offers to measure a typed address that matches no request, and opens the new measurement', async () => {
    renderList();
    await screen.findByText('Mei Abernathy');
    expect(screen.queryByRole('button', { name: /Measure a new roof/ })).toBeNull();
    fireEvent.change(screen.getByRole('searchbox', { name: measure.requestsSearch }), { target: { value: '12 Elm St' } });
    const offer = await screen.findByRole('button', { name: measure.measureNew('12 Elm St') });
    fireEvent.click(offer);
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/estimator/measure/mnew'));
    expect(posts).toEqual([{ address: '12 Elm St' }]);
  });

  it('does not offer a new measurement when a request matches', async () => {
    renderList();
    await screen.findByText('Mei Abernathy');
    fireEvent.change(screen.getByRole('searchbox', { name: measure.requestsSearch }), { target: { value: 'Catalpa' } });
    await waitFor(() => expect(screen.queryByText('Carmen Castellano')).toBeNull());
    expect(screen.queryByRole('button', { name: /Measure a new roof/ })).toBeNull();
  });

  it('says plainly when the address cannot be found', async () => {
    renderList();
    await screen.findByText('Mei Abernathy');
    fireEvent.change(screen.getByRole('searchbox', { name: measure.requestsSearch }), { target: { value: '1 nowhere rd' } });
    fireEvent.click(await screen.findByRole('button', { name: measure.measureNew('1 nowhere rd') }));
    expect(await screen.findByText('We could not find that address.')).toBeInTheDocument();
    expect(screen.getByTestId('where')).toHaveTextContent('/estimator/measure/m1');
  });

  it('says so when the list cannot load', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'boom' }), { status: 500, headers: { 'content-type': 'application/json' } })));
    renderList();
    expect(await screen.findByText(measure.requestsFailed)).toHaveAttribute('role', 'alert');
  });
});

describe('requestStatus', () => {
  it('maps proposal states to the four chips', () => {
    expect(requestStatus('draft', 'estimate')).toBe('new_lead');
    expect(requestStatus('ready', 'estimate')).toBe('new_lead');
    expect(requestStatus('sent', 'estimate')).toBe('estimate_sent');
    expect(requestStatus('viewed', 'exact')).toBe('estimate_sent');
    expect(requestStatus('draft', 'exact')).toBe('inspection');
    expect(requestStatus('signed', 'exact')).toBe('signed');
  });
});
