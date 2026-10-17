import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient, Providers } from '../src/app/providers.tsx';
import { mapCopy } from '../src/copy/map.ts';
import { storm } from '../src/copy/storm.ts';
import { StormDetail } from '../src/features/storm/StormDetail.tsx';
import { hailFillExpression } from '../src/shell/map/stormLayer.ts';
import { ACCOUNT, SHELL_ROUTES, stubApi, where } from './helpers.tsx';
import type { Routes } from './helpers.tsx';

const fakeMaps = vi.hoisted(() => [] as Array<{ on: ReturnType<typeof vi.fn>; addLayer: ReturnType<typeof vi.fn> }>);

vi.mock('maplibre-gl', () => {
  class FakeMap {
    constructor() {
      fakeMaps.push(this);
    }
    on = vi.fn();
    addSource = vi.fn();
    addLayer = vi.fn();
    getSource = vi.fn();
    fitBounds = vi.fn();
    remove = vi.fn();
    addControl = vi.fn();
  }
  return { Map: FakeMap, NavigationControl: class {} };
});

const NO_RESULTS = {
  textsSent: 0,
  textsDelivered: 0,
  replies: 0,
  yesReplies: 0,
  emailsSent: 0,
  unsubscribes: 0,
  doorsKnocked: 0,
  wantsCheck: 0,
  adSpendCents: 0,
  adMaxCents: 0,
  adClicks: 0,
  landingRequests: 0,
  inspectionsBooked: 0,
};

function detail(plan: { taskId: string; status: string } | null) {
  return {
    storm: {
      id: 's1',
      placeName: 'Maple Ridge',
      day: '2026-10-10',
      maxIn: 1.75,
      status: 'final',
      customersHit: 12,
      homesHit: 340,
      planTaskId: plan?.taskId ?? null,
      planStatus: plan?.status ?? null,
    },
    swath: {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          geometry: { type: 'MultiPolygon', coordinates: [[[[-96, 41], [-95.9, 41], [-95.9, 41.1], [-96, 41]]]] },
          properties: { thresholdIn: 0.75 },
        },
      ],
    },
    results: NO_RESULTS,
    plan,
  };
}

function setup(options: { role?: 'owner' | 'office' | 'rep'; plan?: { taskId: string; status: string } | null; extra?: Routes } = {}) {
  const { role = 'owner', plan = { taskId: 't1', status: 'draft' }, extra = {} } = options;
  const api = stubApi({
    ...SHELL_ROUTES,
    'GET /api/auth/me': () => ({ body: { ...ACCOUNT, role } }),
    'GET /api/storms/s1': () => ({ body: detail(plan) }),
    'POST /api/storms/s1/dismiss': () => ({ body: { ok: true } }),
    'POST /api/storms/s1/plan': () => ({ body: { taskId: 't2' } }),
    ...extra,
  });
  const queryClient = createQueryClient();
  queryClient.setDefaultOptions({ queries: { retry: false } });
  const router = createMemoryRouter(
    [
      { path: 'storm/:id', element: <StormDetail /> },
      { path: 'storm', element: <p>list</p> },
    ],
    { initialEntries: ['/storm/s1'] },
  );
  render(
    <Providers client={queryClient}>
      <RouterProvider router={router} />
    </Providers>,
  );
  return { api, router, user: userEvent.setup() };
}

describe('StormDetail', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('names the storm over its day, with the numbers in a strip: size from radar, customers and homes hit', async () => {
    setup();
    expect(await screen.findByRole('heading', { level: 1, name: 'Maple Ridge' })).toBeInTheDocument();
    const main = screen.getByRole('main', { name: storm.crumbStorm });
    expect(within(main).getByText('Saturday, October 10')).toBeInTheDocument();
    // The hail key also says "Hail size" (to a screen reader): the tile is the one with a number in it
    const tile = (label: string) =>
      within(main)
        .getAllByText(label)
        .map((node) => node.closest('dl'))
        .find((dl): dl is HTMLDListElement => dl !== null) as HTMLElement;
    expect(within(tile(storm.hailSizeLabel)).getByText('1.75')).toBeInTheDocument();
    expect(within(tile(storm.hailSizeLabel)).getByText(storm.hailUnit)).toBeInTheDocument();
    expect(within(tile(storm.hailSizeLabel)).getByText(storm.hailSizeMeta('Ping-pong'))).toBeInTheDocument();
    expect(within(tile(storm.customersHitLabel)).getByText('12')).toBeInTheDocument();
    expect(within(tile(storm.homesHitLabel)).getByText('340')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: storm.mapLabel })).toBeInTheDocument();
    // The trail back to the list
    expect(screen.getByRole('link', { name: storm.crumbStorm })).toHaveAttribute('href', '/storm');
  });

  it('shows the shared hail legend over the map', async () => {
    setup();
    const legend = await screen.findByRole('region', { name: mapCopy.hailLegend });
    const items = within(legend).getAllByRole('listitem');
    expect(items.map((item) => item.textContent)).toEqual([...mapCopy.hailSizeNames]);
  });

  it('says where the plan stands, in a tag and a sentence', async () => {
    setup({ plan: { taskId: 't1', status: 'draft' } });
    const panel = await screen.findByRole('region', { name: storm.planHeadingDetail });
    expect(within(panel).getByText(storm.planStatus.draft)).toBeInTheDocument();
    expect(within(panel).getByText(storm.planPanelWaiting)).toBeInTheDocument();
    cleanup();

    setup({ plan: null });
    const none = await screen.findByRole('region', { name: storm.planHeadingDetail });
    expect(within(none).getByText(storm.noPlan)).toBeInTheDocument();
    expect(within(none).getByText(storm.planPanelNone)).toBeInTheDocument();
  });

  it('colours the swath with the shell hail expression', async () => {
    fakeMaps.length = 0;
    setup();
    await screen.findByRole('region', { name: storm.mapLabel });
    const map = fakeMaps.at(-1);
    const load = map?.on.mock.calls.find((call) => call[0] === 'load')?.[1] as (() => void) | undefined;
    expect(load).toBeTypeOf('function');
    load?.();
    const layer = map?.addLayer.mock.calls[0]?.[0] as { paint: Record<string, unknown> };
    expect(layer.paint['fill-color']).toEqual(hailFillExpression());
  });

  it('links to the plan', async () => {
    setup();
    expect(await screen.findByRole('link', { name: storm.openPlan })).toHaveAttribute('href', '/storm/plans/t1');
  });

  it('dismiss asks first', async () => {
    const { api, router, user } = setup();
    await user.click(await screen.findByRole('button', { name: storm.dismiss }));
    expect(screen.getByRole('alertdialog', { name: storm.dismissConfirmTitle })).toBeInTheDocument();
    expect(screen.getByText(storm.dismissConfirmBody)).toBeInTheDocument();
    expect(api.count('POST /api/storms/s1/dismiss')).toBe(0);
    await user.click(screen.getByRole('button', { name: storm.dismissConfirm }));
    await vi.waitFor(() => {
      expect(where(router)).toBe('/storm');
    });
    expect(api.count('POST /api/storms/s1/dismiss')).toBe(1);
  });

  it('a failed dismiss says why and stays', async () => {
    const { router, user } = setup({ extra: { 'POST /api/storms/s1/dismiss': () => ({ status: 500, body: { error: 'Nope' } }) } });
    await user.click(await screen.findByRole('button', { name: storm.dismiss }));
    await user.click(screen.getByRole('button', { name: storm.dismissConfirm }));
    expect(await screen.findByText('Nope')).toBeInTheDocument();
    expect(where(router)).toBe('/storm/s1');
  });

  it('keep it cancels', async () => {
    const { api, user } = setup();
    await user.click(await screen.findByRole('button', { name: storm.dismiss }));
    await user.click(screen.getByRole('button', { name: storm.dismissCancel }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(api.count('POST /api/storms/s1/dismiss')).toBe(0);
  });

  it('a rep sees no dismiss', async () => {
    const { api } = setup({ role: 'rep', plan: null });
    await screen.findByRole('heading', { level: 1, name: 'Maple Ridge' });
    await vi.waitFor(() => {
      expect(api.count('GET /api/auth/me')).toBeGreaterThan(0);
    });
    expect(screen.queryByRole('button', { name: storm.dismiss })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: storm.redraft })).not.toBeInTheDocument();
  });

  it('no plan shows draft button', async () => {
    const { api, user } = setup({ plan: null });
    await user.click(await screen.findByRole('button', { name: storm.redraft }));
    await vi.waitFor(() => {
      expect(api.count('POST /api/storms/s1/plan')).toBe(1);
    });
  });

  it.each([
    ['expired', true, false],
    ['declined', true, false],
    ['draft', true, true],
    ['running', false, true],
  ])('a %s plan: redraft button %s, open plan %s', async (status, redraftShown, openShown) => {
    setup({ plan: { taskId: 't1', status } });
    await screen.findByRole('heading', { level: 1, name: 'Maple Ridge' });
    await vi.waitFor(() => {
      expect(screen.queryByRole('button', { name: storm.redraft }) !== null).toBe(redraftShown);
    });
    expect(screen.queryByRole('link', { name: storm.openPlan }) !== null).toBe(openShown);
  });

  it('shows the API message when drafting is refused', async () => {
    const message = 'Storm Scout is paused. Turn it back on in Agents to draft a plan.';
    const { user } = setup({
      plan: null,
      extra: { 'POST /api/storms/s1/plan': () => ({ status: 409, body: { error: message } }) },
    });
    await user.click(await screen.findByRole('button', { name: storm.redraft }));
    expect(await screen.findByText(message)).toBeInTheDocument();
  });

  it('unknown storm', async () => {
    setup({ extra: { 'GET /api/storms/s1': () => ({ status: 404, body: { error: 'Not found' } }) } });
    expect(await screen.findByText(storm.notFound)).toBeInTheDocument();
  });
});
