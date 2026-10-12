import { cleanup, screen, within } from '@testing-library/react';
import { TASK_STATUSES } from '@roofline/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StormWindow } from '../src/features/storm/StormWindow.tsx';
import { storm } from '../src/copy/storm.ts';
import { makeTask, renderAt, stubApi, SHELL_ROUTES, STORM_LAYER_KEY } from './helpers.tsx';

const OLDER = {
  id: 's-old',
  placeName: 'Maple Ridge',
  day: '2026-10-01',
  maxIn: 1,
  status: 'final',
  customersHit: 1,
  homesHit: 40,
  planTaskId: null,
  planStatus: null,
};
const NEWER = {
  id: 's-new',
  placeName: 'Oak Park',
  day: '2026-10-09',
  maxIn: 1.75,
  status: 'provisional',
  customersHit: 12,
  homesHit: 130,
  planTaskId: 't9',
  planStatus: 'running',
};

function layerBody(stale: boolean) {
  return {
    swaths: { type: 'FeatureCollection', features: [] },
    spots: { type: 'FeatureCollection', features: [] },
    newestRunAt: null,
    stale,
  };
}

function stubStorms(storms: unknown[], stale = false) {
  return stubApi({
    ...SHELL_ROUTES,
    'GET /api/storms': () => ({ body: { storms } }),
    [STORM_LAYER_KEY]: () => ({ body: layerBody(stale) }),
  });
}

describe('Storm list', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('lists storms with radar-estimated sizes', async () => {
    const api = stubStorms([OLDER, NEWER]);
    renderAt(<StormWindow />);

    const list = await screen.findByRole('region', { name: storm.listHeading });
    expect(await within(list).findByText(storm.upTo('1.75'))).toBeInTheDocument();
    expect(within(list).getByText(storm.upTo('1.00'))).toBeInTheDocument();
    expect(within(list).getByText(storm.customersHit(12))).toBeInTheDocument();
    expect(within(list).getByText(storm.homesHit(130))).toBeInTheDocument();
    expect(within(list).getByText(storm.customersHit(1))).toBeInTheDocument();
    expect(within(list).getByText(storm.planStatus['running'] as string)).toBeInTheDocument();
    expect(within(list).getByText(storm.noPlan)).toBeInTheDocument();
    for (const size of within(list).getAllByText(/^Up to/)) expect(size.textContent).toContain('radar-estimated');
    const days = within(list).getAllByText(/^2026-10-/).map((node) => node.textContent);
    expect(days).toEqual(['2026-10-09', '2026-10-01']);
    const links = within(list).getAllByRole('link', { name: storm.viewStorm });
    expect(links.map((link) => link.getAttribute('href'))).toEqual(['/storm/s-new', '/storm/s-old']);
    expect(api.unexpected).toEqual([]);
  });

  it('has a label for every plan status', () => {
    expect(Object.keys(storm.planStatus).sort()).toEqual([...TASK_STATUSES].sort());
  });

  it.each(Object.entries(storm.planStatus))('a storm whose plan is %s shows %s', async (status, label) => {
    stubStorms([{ ...NEWER, planStatus: status }]);
    renderAt(<StormWindow />);
    const list = await screen.findByRole('region', { name: storm.listHeading });
    expect(within(list).getByText(label)).toBeInTheDocument();
  });

  it('shows the behind banner when stale and not otherwise', async () => {
    stubStorms([NEWER], true);
    renderAt(<StormWindow />);
    expect(await screen.findByText(storm.staleBanner)).toBeInTheDocument();
    cleanup();

    stubStorms([NEWER], false);
    renderAt(<StormWindow />);
    await screen.findByText(storm.upTo('1.75'));
    expect(screen.queryByText(storm.staleBanner)).not.toBeInTheDocument();
  });

  it('shows the empty state when there are no storms', async () => {
    stubStorms([]);
    renderAt(<StormWindow />);
    expect(await screen.findByText(storm.empty)).toBeInTheDocument();
  });

  it('does not show the empty state when there are storms', async () => {
    stubStorms([NEWER]);
    renderAt(<StormWindow />);
    await screen.findByText(storm.upTo('1.75'));
    expect(screen.queryByText(storm.empty)).not.toBeInTheDocument();
  });

  it('keeps the two-click approve: one approve link to the newest plan', async () => {
    stubApi({
      ...SHELL_ROUTES,
      'GET /api/approvals': () => ({ body: { count: 1, tasks: [makeTask({ id: 't9', title: 'Storm plan for Oak Park' })] } }),
      'GET /api/storms': () => ({ body: { storms: [NEWER] } }),
    });
    renderAt(<StormWindow />);
    await screen.findByText(storm.upTo('1.75'));
    const approve = screen.getByRole('link', { name: storm.approve });
    expect(approve).toHaveAttribute('href', '/storm/plans/t9');
  });
});
