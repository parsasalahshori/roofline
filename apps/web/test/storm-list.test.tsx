import { cleanup, screen, within } from '@testing-library/react';
import { TASK_STATUSES } from '@roofline/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StormWindow } from '../src/features/storm/StormWindow.tsx';
import { storm } from '../src/copy/storm.ts';
import { ACCOUNT, makeTask, renderAt, stubApi, SHELL_ROUTES, STORM_LAYER_KEY } from './helpers.tsx';

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
    'GET /api/auth/me': () => ({ body: ACCOUNT }),
    'GET /api/storms': () => ({ body: { storms } }),
    [STORM_LAYER_KEY]: () => ({ body: layerBody(stale) }),
  });
}

describe('Storm list', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('lists storms newest first as a table: where and when, how big, how many it hit, and the plan', async () => {
    const api = stubStorms([OLDER, NEWER]);
    renderAt(<StormWindow />);

    const panel = await screen.findByRole('region', { name: storm.listHeading });
    const table = await within(panel).findByRole('table');
    expect(within(table).getAllByRole('columnheader').map((head) => head.textContent)).toEqual([
      storm.colStorm,
      storm.colHail,
      storm.colCustomers,
      storm.colHomes,
      storm.colPlan,
      storm.colActions,
    ]);
    const [newer, older] = within(table).getAllByRole('row').slice(1);
    // Where and when, then the size with what it is in a hand, then the counts, the plan and the buttons
    expect(within(newer!).getByText('Oak Park')).toBeInTheDocument();
    expect(within(newer!).getByText('Fri, Oct 9')).toBeInTheDocument();
    expect(within(newer!).getByText('1.75')).toBeInTheDocument();
    expect(within(newer!).getByText('Ping-pong')).toBeInTheDocument();
    expect(within(newer!).getAllByRole('cell').slice(2, 4).map((cell) => cell.textContent)).toEqual(['12', '130']);
    expect(within(newer!).getByText(storm.planStatus['running'] as string)).toBeInTheDocument();
    expect(within(older!).getByText('Maple Ridge')).toBeInTheDocument();
    expect(within(older!).getByText('Thu, Oct 1')).toBeInTheDocument();
    expect(within(older!).getByText('1.00')).toBeInTheDocument();
    expect(within(older!).getByText('Penny')).toBeInTheDocument();
    expect(within(older!).getAllByRole('cell').slice(2, 4).map((cell) => cell.textContent)).toEqual(['1', '40']);
    expect(within(older!).getByText(storm.noPlan)).toBeInTheDocument();
    // The count beside the title, and the note that sizes come from radar
    expect(within(panel).getByText(storm.count(2))).toBeInTheDocument();
    expect(within(panel).getByText(storm.radarNote)).toBeInTheDocument();
    const links = within(panel).getAllByRole('link', { name: storm.viewStorm });
    expect(links.map((link) => link.getAttribute('href'))).toEqual(['/storm/s-new', '/storm/s-old']);
    expect(api.unexpected).toEqual([]);
  });

  it('names a storm by its day when the radar gave it no place', async () => {
    stubStorms([{ ...NEWER, placeName: null }]);
    renderAt(<StormWindow />);
    const panel = await screen.findByRole('region', { name: storm.listHeading });
    expect(await within(panel).findByText('Fri, Oct 9')).toBeInTheDocument();
  });

  it('offers See plan only while the plan waits for a yes', async () => {
    stubStorms([{ ...NEWER, planStatus: 'draft' }, { ...OLDER, planTaskId: 't3', planStatus: 'done' }]);
    renderAt(<StormWindow />);
    const panel = await screen.findByRole('region', { name: storm.listHeading });
    const links = await within(panel).findAllByRole('link', { name: storm.seePlan });
    expect(links.map((link) => link.getAttribute('href'))).toEqual(['/storm/plans/t9']);
  });

  it('is a list of blocks, not a table, on a phone', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: true,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
    stubStorms([OLDER, NEWER]);
    renderAt(<StormWindow />);

    const panel = await screen.findByRole('region', { name: storm.listHeading });
    const items = await within(panel).findAllByRole('listitem');
    expect(within(panel).queryByRole('table')).toBeNull();
    expect(items).toHaveLength(2);
    expect(within(items[0]!).getByText('Oak Park')).toBeInTheDocument();
    expect(within(items[0]!).getByText(storm.customersHit(12))).toBeInTheDocument();
    expect(within(items[0]!).getByText(storm.homesHit(130))).toBeInTheDocument();
    expect(within(items[0]!).getByRole('link', { name: storm.viewStorm })).toHaveAttribute('href', '/storm/s-new');
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
    await screen.findByText('Oak Park');
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
    await screen.findByText('Oak Park');
    expect(screen.queryByText(storm.empty)).not.toBeInTheDocument();
  });

  it('keeps the two-click approve: one approve link to the newest plan', async () => {
    stubApi({
      ...SHELL_ROUTES,
      'GET /api/auth/me': () => ({ body: ACCOUNT }),
      'GET /api/approvals': () => ({ body: { count: 1, tasks: [makeTask({ id: 't9', title: 'Storm plan for Oak Park' })] } }),
      'GET /api/storms': () => ({ body: { storms: [NEWER] } }),
    });
    renderAt(<StormWindow />);
    await screen.findByText('Oak Park');
    const approve = await screen.findByRole('link', { name: storm.approve });
    expect(approve).toHaveAttribute('href', '/storm/plans/t9');
  });
});
