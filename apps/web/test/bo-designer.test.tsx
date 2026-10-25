import type { BackofficeQuote } from '@roofline/shared';
import { QueryClient } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Providers } from '../src/app/providers.tsx';
import { QuoteEditor } from '../src/features/backoffice/designer/QuoteEditor.tsx';
import { previewQuote } from '../src/features/backoffice/designer/pricing.ts';
import { backofficeDesigner as copy } from '../src/copy/backofficeDesigner.ts';
import { catalogFixture, makeQuote } from './bo-designer-fixtures.ts';

type Put = { url: string; body: Record<string, unknown> };

function mockApi(initial: BackofficeQuote = makeQuote()) {
  const puts: Put[] = [];
  let latest = initial;
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (url.endsWith('/api/backoffice/catalog')) return json(catalogFixture);
    if (url.includes('/api/backoffice/quotes/q1') && init?.method === 'PUT') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      puts.push({ url, body });
      latest = { ...latest, ...(body as Partial<BackofficeQuote>) };
      return json(latest);
    }
    if (url.includes('/api/backoffice/quotes/q1')) return json(latest);
    return new Response('{}', { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { puts, fetchMock };
}

function renderEditor() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <Providers client={client}>
      <MemoryRouter initialEntries={['/backoffice/quotes/q1']}>
        <Routes>
          <Route path="/backoffice/quotes/:quoteId" element={<QuoteEditor />} />
        </Routes>
      </MemoryRouter>
    </Providers>,
  );
}

describe('QuoteEditor', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('shows the customer, address, a card per unit with its price, and all three tier totals', async () => {
    mockApi();
    renderEditor();
    expect(await screen.findByRole('heading', { name: 'Dana Whitfield' })).toBeInTheDocument();
    expect(screen.getByText('4417 Larkspur Lane, Little Rock, AR')).toBeInTheDocument();
    for (const name of ['Great room', 'Kitchen', 'Bath']) expect(screen.getByRole('button', { name: copy.openUnit(name) })).toBeInTheDocument();
    const radios = within(screen.getByRole('radiogroup', { name: copy.tier })).getAllByRole('radio');
    expect(radios.map((r) => r.textContent)).toEqual([expect.stringContaining('Good'), expect.stringContaining('Better'), expect.stringContaining('Best')]);
  });

  it('shows the same totals as the pricing helper', async () => {
    mockApi();
    renderEditor();
    const quote = makeQuote();
    const expected = previewQuote(quote, catalogFixture);
    const money = (c: number) => (c / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
    expect(await screen.findByTestId('grand-total')).toHaveTextContent(money(expected.totals.better.totalCents));
    const radios = within(screen.getByRole('radiogroup', { name: copy.tier })).getAllByRole('radio');
    expect(radios[0]).toHaveTextContent(money(expected.totals.good.totalCents));
    expect(radios[2]).toHaveTextContent(money(expected.totals.best.totalCents));
    fireEvent.click(radios[2]!);
    expect(screen.getByTestId('grand-total')).toHaveTextContent(money(expected.totals.best.totalCents));
  });

  it('sends one debounced PUT with the latest draft', async () => {
    const { puts } = mockApi();
    renderEditor();
    await screen.findByRole('heading', { name: 'Dana Whitfield' });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const discount = screen.getByRole('textbox', { name: copy.discount });
    fireEvent.change(discount, { target: { value: '2' } });
    fireEvent.change(discount, { target: { value: '5' } });
    fireEvent.click(within(screen.getByRole('radiogroup', { name: copy.tier })).getAllByRole('radio')[0]!);
    expect(puts).toHaveLength(0);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(puts).toHaveLength(0);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    vi.useRealTimers();
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]!.body).toMatchObject({ discountPercent: 5, tier: 'good' });
    await waitFor(() => expect(screen.getByText(copy.saved)).toBeInTheDocument());
    expect(puts).toHaveLength(1);
  });

  it('adds, duplicates and deletes a unit', async () => {
    mockApi();
    renderEditor();
    await screen.findByRole('heading', { name: 'Dana Whitfield' });
    fireEvent.click(screen.getByRole('button', { name: new RegExp(copy.addUnit) }));
    expect(await screen.findByRole('complementary', { name: copy.unitEditor('Window 4') })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: new RegExp(copy.duplicateUnit) }));
    expect(await screen.findByRole('complementary', { name: copy.unitEditor(copy.copyOf('Window 4')) })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /^Edit / })).toHaveLength(5);
    fireEvent.click(screen.getByRole('button', { name: new RegExp(copy.deleteUnit) }));
    fireEvent.click(screen.getByRole('button', { name: new RegExp(copy.confirmDelete(copy.copyOf('Window 4'))) }));
    await waitFor(() => expect(screen.getAllByRole('button', { name: /^Edit / })).toHaveLength(4));
  });

  it('offers only products that are not archived', async () => {
    mockApi();
    renderEditor();
    fireEvent.click(await screen.findByRole('button', { name: copy.openUnit('Kitchen') }));
    const product = await screen.findByRole('combobox', { name: copy.fields.product });
    const labels = within(product).getAllByRole('option').map((o) => o.textContent);
    expect(labels).toEqual(['WinChoice 5000 Double Hung', 'WinChoice 3000 Slider', 'WinChoice 7000 Casement']);
  });

  it('splits the chosen section, resizes with the keyboard and merges back', async () => {
    mockApi();
    renderEditor();
    fireEvent.click(await screen.findByRole('button', { name: copy.openUnit('Bath') }));
    await screen.findByRole('complementary', { name: copy.unitEditor('Bath') });
    expect(screen.queryAllByRole('slider')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: copy.splitColumns }));
    const slider = await screen.findByRole('slider', { name: copy.dividerColumns(1) });
    expect(slider).toHaveAttribute('aria-valuenow', '12');
    fireEvent.keyDown(slider, { key: 'ArrowRight' });
    expect(screen.getByRole('slider', { name: copy.dividerColumns(1) })).toHaveAttribute('aria-valuenow', '12.125');
    fireEvent.keyDown(screen.getByRole('slider', { name: copy.dividerColumns(1) }), { key: 'ArrowRight', shiftKey: true });
    expect(screen.getByRole('slider', { name: copy.dividerColumns(1) })).toHaveAttribute('aria-valuenow', '13.125');
    expect(screen.getAllByRole('button', { name: /^Section \d of 2/ })).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: new RegExp(copy.mergeSections) }));
    await waitFor(() => expect(screen.queryAllByRole('slider')).toHaveLength(0));
  });

  it('drags a divider by touch/mouse, snapped to 1/8, with the page kept still', async () => {
    mockApi();
    renderEditor();
    fireEvent.click(await screen.findByRole('button', { name: copy.openUnit('Great room') }));
    const canvas = await screen.findByTestId('drawing-canvas');
    // 600 px for the drawing's width: inches per pixel = viewBox width / 600
    canvas.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 600, bottom: 300, width: 600, height: 300, toJSON: () => ({}) });
    const divider = screen.getByRole('slider', { name: copy.dividerColumns(1) });
    expect(divider).toHaveAttribute('aria-valuenow', '36');
    const style = getComputedStyle(divider);
    expect(divider.className).toMatch(/divider/);
    expect(style).toBeDefined();
    fireEvent.pointerDown(divider, { pointerId: 1, clientX: 100, clientY: 50 });
    fireEvent.pointerMove(divider, { pointerId: 1, clientX: 160, clientY: 50 });
    const moved = Number(screen.getByRole('slider', { name: copy.dividerColumns(1) }).getAttribute('aria-valuenow'));
    expect(moved).toBeGreaterThan(36);
    expect(moved * 8).toBe(Math.round(moved * 8));
    fireEvent.pointerUp(divider, { pointerId: 1 });
  });

  it('flags an over-the-limit discount as needing office approval', async () => {
    mockApi();
    renderEditor();
    await screen.findByTestId('grand-total');
    expect(screen.queryByText(copy.needsApprovalShort)).toBeNull();
    fireEvent.change(screen.getByRole('textbox', { name: copy.discount }), { target: { value: '15' } });
    expect(screen.getAllByText(copy.needsApprovalShort).length).toBeGreaterThan(0);
  });

  it('opens each document and the visualizer as links', async () => {
    mockApi();
    renderEditor();
    await screen.findByTestId('grand-total');
    expect(screen.getByRole('link', { name: copy.documents['factory-order'] })).toHaveAttribute('href', '/api/backoffice/quotes/q1/documents/factory-order');
    expect(screen.getByRole('link', { name: copy.documents.quote })).toHaveAttribute('target', '_blank');
    expect(screen.getByRole('link', { name: new RegExp(copy.openVisualizer) })).toHaveAttribute('href', '/backoffice/quotes/q1/visual');
  });

  it('shows the tempered suggestion from the safety answers and applies it', async () => {
    mockApi();
    renderEditor();
    fireEvent.click(await screen.findByRole('button', { name: copy.openUnit('Bath') }));
    const group = await screen.findByRole('radiogroup', { name: copy.safety.wetArea });
    fireEvent.click(within(group).getByRole('radio', { name: copy.yes }));
    expect(await screen.findByText(/Tempered glass suggested/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: copy.useTempered }));
    await waitFor(() => expect(screen.queryByText(/Tempered glass suggested/)).toBeNull());
    expect(screen.getByRole('combobox', { name: copy.optionGroups.tempered })).toHaveValue('t-temp');
  });
});
