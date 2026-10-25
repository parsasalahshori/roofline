import type { HouseVisual } from '@roofline/shared';
import { QueryClient } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Providers } from '../src/app/providers.tsx';
import { backofficeDesigner as copy } from '../src/copy/backofficeDesigner.ts';
import { applyHomography, cssMatrix3d, defaultCorners, homography, placementTransform, type Quad } from '../src/features/backoffice/visualizer/homography.ts';
import { quoteKey } from '../src/features/backoffice/designer/api.ts';
import { Visualizer } from '../src/features/backoffice/visualizer/Visualizer.tsx';
import { catalogFixture, makeQuote } from './bo-designer-fixtures.ts';

const t = copy.visualizer;

describe('homography', () => {
  const rect: Quad = [[0, 0], [400, 0], [400, 300], [0, 300]];
  const skew: Quad = [[120, 80], [520, 140], [490, 420], [90, 360]];

  it('maps each source corner exactly onto its photo corner', () => {
    const h = homography(rect, skew)!;
    rect.forEach((p, i) => {
      const [x, y] = applyHomography(h, p);
      expect(x).toBeCloseTo(skew[i]![0], 6);
      expect(y).toBeCloseTo(skew[i]![1], 6);
    });
  });

  it('keeps straight lines straight and maps the middle inside the quad', () => {
    const h = homography(rect, skew)!;
    const [cx, cy] = applyHomography(h, [200, 150]);
    expect(cx).toBeGreaterThan(90);
    expect(cx).toBeLessThan(520);
    expect(cy).toBeGreaterThan(80);
    expect(cy).toBeLessThan(420);
  });

  it('is the identity for the same rectangle', () => {
    const h = homography(rect, rect)!;
    expect(applyHomography(h, [123, 45])[0]).toBeCloseTo(123, 6);
    expect(applyHomography(h, [123, 45])[1]).toBeCloseTo(45, 6);
  });

  it('refuses points on a line', () => {
    expect(homography(rect, [[0, 0], [10, 10], [20, 20], [30, 30]])).toBeNull();
  });

  it('builds a CSS matrix3d in column order that carries the same maths', () => {
    const h = homography(rect, skew)!;
    const css = cssMatrix3d(h);
    const m = css.slice('matrix3d('.length, -1).split(',').map(Number);
    expect(m).toHaveLength(16);
    // column-major: x' = m0 x + m4 y + m12, y' = m1 x + m5 y + m13, w = m3 x + m7 y + m15
    const apply = (x: number, y: number) => {
      const w = m[3]! * x + m[7]! * y + m[15]!;
      return [(m[0]! * x + m[4]! * y + m[12]!) / w, (m[1]! * x + m[5]! * y + m[13]!) / w];
    };
    skew.forEach((q, i) => {
      const [x, y] = apply(...(rect[i] as [number, number]));
      expect(x).toBeCloseTo(q[0], 4);
      expect(y).toBeCloseTo(q[1], 4);
    });
  });

  it('maps a placement (0..1 of the photo) onto the stage in px', () => {
    const css = placementTransform({ x: 10, y: 10, w: 380, h: 280 }, [[0.1, 0.2], [0.5, 0.2], [0.5, 0.6], [0.1, 0.6]], 1000, 500)!;
    const m = css.slice('matrix3d('.length, -1).split(',').map(Number);
    const w = m[3]! * 10 + m[7]! * 10 + m[15]!;
    expect((m[0]! * 10 + m[4]! * 10 + m[12]!) / w).toBeCloseTo(100, 4);
    expect((m[1]! * 10 + m[5]! * 10 + m[13]!) / w).toBeCloseTo(100, 4);
  });

  it('starts a placement the unit shape inside the photo', () => {
    const c = defaultCorners(0.6, 4 / 3);
    const w = (c[1][0] - c[0][0]) * 4;
    const h = (c[3][1] - c[0][1]) * 3;
    expect(w / h).toBeCloseTo(0.6, 3);
    for (const [x, y] of c) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(1);
    }
  });
});

type Put = { body: { photoUploadId: string | null; placements: HouseVisual['placements'] } };

function mockApi(visual: HouseVisual = { quoteId: 'q1', photoUploadId: 'photo-1', placements: [], updatedAt: '2026-10-20T10:00:00.000Z' }) {
  const puts: Put[] = [];
  let latest = visual;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (url.endsWith('/api/backoffice/catalog')) return json(catalogFixture);
      if (url.endsWith('/visual') && init?.method === 'PUT') {
        const body = JSON.parse(String(init.body)) as Put['body'];
        puts.push({ body });
        latest = { ...latest, ...body };
        return json(latest);
      }
      if (url.endsWith('/visual')) return json(latest);
      if (url.includes('/api/backoffice/quotes/q1')) return json(makeQuote());
      return new Response('{}', { status: 404 });
    }),
  );
  return { puts };
}

function renderVisualizer() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <Providers client={client}>
      <MemoryRouter initialEntries={['/backoffice/quotes/q1/visual']}>
        <Routes>
          <Route path="/backoffice/quotes/:quoteId/visual" element={<Visualizer />} />
        </Routes>
      </MemoryRouter>
    </Providers>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('Visualizer', () => {
  it('takes a photo with the camera input and offers the library too', async () => {
    mockApi({ quoteId: 'q1', photoUploadId: null, placements: [], updatedAt: '' });
    renderVisualizer();
    expect(await screen.findByText(t.emptyTitle)).toBeInTheDocument();
    const camera = screen.getByTestId('camera-input');
    expect(camera).toHaveAttribute('accept', 'image/*');
    expect(camera).toHaveAttribute('capture', 'environment');
    expect(screen.getByTestId('library-input')).toHaveAttribute('accept', 'image/*');
    expect(screen.getByTestId('library-input')).not.toHaveAttribute('capture');
  });

  it('adds a placement per unit, lays it on the photo and saves once', async () => {
    const { puts } = mockApi();
    renderVisualizer();
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(`${t.add}: Kitchen`) }));
    fireEvent.click(screen.getByRole('button', { name: new RegExp(`${t.add}: Bath`) }));
    expect(screen.getAllByTestId('warped-unit')).toHaveLength(2);
    expect(screen.getAllByTestId('warped-unit')[0]!.style.transform).toMatch(/^matrix3d\(/);
    // four corners per placed unit, 44 px hit areas by CSS, on top of the photo
    expect(screen.getAllByRole('slider')).toHaveLength(8);
    await waitFor(() => expect(puts).toHaveLength(1), { timeout: 4000 });
    expect(puts[0]!.body.placements.map((p) => p.designId)).toEqual(['d-kitchen', 'd-bath']);
    expect(puts[0]!.body.photoUploadId).toBe('photo-1');
    for (const p of puts[0]!.body.placements) expect(p.corners).toHaveLength(4);
  });

  it('moves a corner by keyboard and by pointer, within the photo, and the PUT carries it', async () => {
    const { puts } = mockApi({ quoteId: 'q1', photoUploadId: 'photo-1', placements: [{ id: 'pl1', designId: 'd-kitchen', corners: [[0.2, 0.2], [0.4, 0.2], [0.4, 0.6], [0.2, 0.6]] }], updatedAt: '' });
    renderVisualizer();
    const corner = await screen.findByRole('slider', { name: t.cornerLabel('Kitchen', 'top left') });
    fireEvent.keyDown(corner, { key: 'ArrowRight', shiftKey: true });
    expect(screen.getByRole('slider', { name: t.cornerLabel('Kitchen', 'top left') })).toHaveAttribute('aria-valuenow', '0.21');
    const stage = screen.getByRole('group', { name: t.stage });
    stage.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 1000, bottom: 750, width: 1000, height: 750, toJSON: () => ({}) });
    const br = screen.getByRole('slider', { name: t.cornerLabel('Kitchen', 'bottom right') });
    fireEvent.pointerDown(br, { pointerId: 1, clientX: 400, clientY: 450 });
    fireEvent.pointerMove(br, { pointerId: 1, clientX: 1500, clientY: -100 });
    fireEvent.pointerUp(br, { pointerId: 1 });
    expect(screen.getByRole('slider', { name: t.cornerLabel('Kitchen', 'bottom right') })).toHaveAttribute('aria-valuenow', '1');
    await waitFor(() => expect(puts).toHaveLength(1), { timeout: 4000 });
    const corners = puts[0]!.body.placements[0]!.corners;
    expect(corners[0]![0]).toBeCloseTo(0.21, 6);
    expect(corners[2]).toEqual([1, 0]);
  });

  it('shows the photo alone for Before, and resets a placement', async () => {
    mockApi({ quoteId: 'q1', photoUploadId: 'photo-1', placements: [{ id: 'pl1', designId: 'd-kitchen', corners: [[0.1, 0.1], [0.2, 0.1], [0.2, 0.2], [0.1, 0.2]] }], updatedAt: '' });
    renderVisualizer();
    await screen.findByTestId('warped-unit');
    fireEvent.click(screen.getByRole('radio', { name: t.before }));
    expect(screen.queryByTestId('warped-unit')).toBeNull();
    expect(screen.queryAllByRole('slider')).toHaveLength(0);
    fireEvent.click(screen.getByRole('radio', { name: t.after }));
    const before = screen.getByRole('slider', { name: t.cornerLabel('Kitchen', 'top left') }).getAttribute('aria-valuenow');
    fireEvent.click(screen.getByRole('button', { name: t.resetLabel('Kitchen') }));
    expect(screen.getByRole('slider', { name: t.cornerLabel('Kitchen', 'top left') }).getAttribute('aria-valuenow')).not.toBe(before);
    fireEvent.click(screen.getByRole('button', { name: t.removeLabel('Kitchen') }));
    expect(screen.queryByTestId('warped-unit')).toBeNull();
  });

  it('shows a changed unit on the photo (the drawing follows the quote)', async () => {
    mockApi({ quoteId: 'q1', photoUploadId: 'photo-1', placements: [{ id: 'pl1', designId: 'd-great', corners: [[0.1, 0.1], [0.6, 0.1], [0.6, 0.4], [0.1, 0.4]] }], updatedAt: '' });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <Providers client={client}>
        <MemoryRouter initialEntries={['/backoffice/quotes/q1/visual']}>
          <Routes>
            <Route path="/backoffice/quotes/:quoteId/visual" element={<Visualizer />} />
          </Routes>
        </MemoryRouter>
      </Providers>,
    );
    const unit = await screen.findByTestId('warped-unit');
    expect(unit.querySelectorAll('[data-role=section]')).toHaveLength(3);
    expect(unit.querySelectorAll('[data-role=opening-symbol]')).toHaveLength(0);
    // the editor writes its draft to the same cache entry: one section now
    const quote = makeQuote();
    const merged = { ...quote, designs: quote.designs.map((d) => (d.id === 'd-great' ? { ...d, layout: { kind: 'section' as const, id: 'only', opening: 'fixed' as const, grid: '' } } : d)) };
    act(() => client.setQueryData(quoteKey('q1'), merged));
    await waitFor(() => expect(screen.getByTestId('warped-unit').querySelectorAll('[data-role=section]')).toHaveLength(1));
  });
});
