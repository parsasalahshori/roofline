import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { liftFeed } from '../src/copy/liftFeed.ts';
import { AiFeedCard } from '../src/features/today/lift/AiFeedCard.tsx';
import { CrewWeatherCard } from '../src/features/today/lift/CrewWeatherCard.tsx';
import { renderAt, stubApi } from './helpers.tsx';

let api: ReturnType<typeof stubApi>;

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  expect(api?.unexpected ?? []).toEqual([]);
});

const DAYS = [
  { date: '2026-10-12', highF: 74, precipChancePercent: 5, icon: 'sun', risky: false, installs: 0 },
  { date: '2026-10-13', highF: 77, precipChancePercent: 10, icon: 'cloud', risky: false, installs: 1 },
  { date: '2026-10-14', highF: 68, precipChancePercent: 80, icon: 'rain', risky: true, installs: 3 },
  { date: '2026-10-15', highF: 71, precipChancePercent: 20, icon: 'sun', risky: false, installs: 0 },
  { date: '2026-10-16', highF: 71, precipChancePercent: 10, icon: 'sun', risky: false, installs: 0 },
  { date: '2026-10-17', highF: 73, precipChancePercent: 5, icon: 'sun', risky: false, installs: 0 },
];

describe('CrewWeatherCard', () => {
  it('shows six day tiles, the risky one amber, the chip and the Scheduler line', async () => {
    api = stubApi({
      'GET /api/weather/outlook': () => ({ body: { outlook: { today: '2026-10-12', days: DAYS, atRisk: 3, worstDate: '2026-10-14' } } }),
    });
    renderAt(<CrewWeatherCard />);
    expect(await screen.findByText(liftFeed.atRisk(3))).toBeInTheDocument();
    const tiles = within(screen.getByRole('list', { name: liftFeed.weatherDaysLabel })).getAllByRole('listitem');
    expect(tiles).toHaveLength(6);
    expect(tiles.map((tile) => tile.getAttribute('data-risky'))).toEqual(['false', 'false', 'true', 'false', 'false', 'false']);
    expect(within(tiles[0]!).getByText(liftFeed.today)).toBeInTheDocument();
    expect(within(tiles[2]!).getByText('Wed')).toBeInTheDocument();
    expect(within(tiles[2]!).getByText(liftFeed.high(68))).toBeInTheDocument();
    expect(within(tiles[2]!).getByText(liftFeed.rain(80))).toBeInTheDocument();
    expect(screen.getByText(liftFeed.schedulerCanMove(3, 'Wednesday'))).toBeInTheDocument();
  });

  it('has no chip and no Scheduler line when no job is at risk', async () => {
    const calm = DAYS.map((day) => ({ ...day, risky: false, installs: 0 }));
    api = stubApi({
      'GET /api/weather/outlook': () => ({ body: { outlook: { today: '2026-10-12', days: calm, atRisk: 0, worstDate: null } } }),
    });
    renderAt(<CrewWeatherCard />);
    expect(await screen.findByRole('list', { name: liftFeed.weatherDaysLabel })).toBeInTheDocument();
    expect(screen.queryByText(/at risk/)).toBeNull();
    expect(screen.queryByText(/Scheduler can move/)).toBeNull();
  });

  it('says 1 job and 1 tear-off in the singular', () => {
    expect(liftFeed.atRisk(1)).toBe('1 job at risk');
    expect(liftFeed.schedulerCanMove(1, 'Monday')).toBe('Scheduler can move 1 tear-off off Monday and text each homeowner.');
  });

  it('shows a loading state, then nothing when there is no forecast', async () => {
    api = stubApi({ 'GET /api/weather/outlook': () => ({ body: { outlook: null } }) });
    const { queryClient } = renderAt(<CrewWeatherCard />);
    expect(screen.getByLabelText(liftFeed.weatherLoading)).toBeInTheDocument();
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));
    expect(screen.queryByRole('region')).toBeNull();
    expect(screen.queryByText(liftFeed.weatherTitle)).toBeNull();
  });

  it('renders nothing when the forecast cannot be read', async () => {
    api = stubApi({ 'GET /api/weather/outlook': () => ({ status: 500, body: { error: 'down' } }) });
    const { queryClient } = renderAt(<CrewWeatherCard />);
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));
    expect(screen.queryByText(liftFeed.weatherTitle)).toBeNull();
  });
});

const NOW = new Date('2026-10-12T15:00:00.000Z');
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();

describe('AiFeedCard', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });

  it('lists the latest six actions with a dot per agent, who and how long ago, and the working chip', async () => {
    const items = Array.from({ length: 8 }, (_, i) => ({
      id: `f${i}`,
      agent: i % 2 === 0 ? 'front_desk' : 'estimator',
      kind: 'text',
      text: `Did thing ${i}`,
      at: ago(i === 0 ? 0 : i * 70),
      href: null,
    }));
    api = stubApi({
      'GET /api/agents/feed': () => ({ body: { items, nextCursor: null } }),
      'GET /api/tasks/summary': () => ({ body: { working: 2 } }),
    });
    renderAt(<AiFeedCard />);
    expect(await screen.findByText('Did thing 0')).toBeInTheDocument();
    const rows = within(screen.getByRole('list', { name: liftFeed.feedListLabel })).getAllByRole('listitem');
    expect(rows).toHaveLength(6);
    expect(rows[0]).toHaveAttribute('data-agent', 'front_desk');
    expect(rows[1]).toHaveAttribute('data-agent', 'estimator');
    expect(within(rows[0]!).getByText('Front Desk, just now')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('Estimator, 1 hr ago')).toBeInTheDocument();
    expect(screen.queryByText('Did thing 6')).toBeNull();
    expect(await screen.findByText(liftFeed.working(2))).toBeInTheDocument();
  });

  it('has no working chip when nothing is working', async () => {
    api = stubApi({
      'GET /api/agents/feed': () => ({ body: { items: [{ id: 'f1', agent: 'storm_scout', kind: 'x', text: 'Scanned hail', at: ago(5), href: null }], nextCursor: null } }),
      'GET /api/tasks/summary': () => ({ body: { working: 0 } }),
    });
    const { queryClient } = renderAt(<AiFeedCard />);
    expect(await screen.findByText('Scanned hail')).toBeInTheDocument();
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));
    expect(screen.queryByText(/working/)).toBeNull();
    expect(screen.getByText('Storm Scout, 5 min ago')).toBeInTheDocument();
  });

  it('shows a loading state, then an empty line', async () => {
    api = stubApi({
      'GET /api/agents/feed': () => ({ body: { items: [], nextCursor: null } }),
      'GET /api/tasks/summary': () => ({ body: { working: 0 } }),
    });
    renderAt(<AiFeedCard />);
    expect(screen.getByRole('status', { name: liftFeed.feedLoading })).toBeInTheDocument();
    expect(await screen.findByText(liftFeed.feedEmpty)).toBeInTheDocument();
  });

  it('says so when the feed cannot be read', async () => {
    api = stubApi({
      'GET /api/agents/feed': () => ({ status: 500, body: { error: 'down' } }),
      'GET /api/tasks/summary': () => ({ body: { working: 0 } }),
    });
    renderAt(<AiFeedCard />);
    expect(await screen.findByText(liftFeed.feedLoadError)).toBeInTheDocument();
  });
});

describe('liftFeed.ago', () => {
  it('reads in minutes, hours and days', () => {
    const now = NOW.getTime();
    expect(liftFeed.ago(ago(0.2), now)).toBe('just now');
    expect(liftFeed.ago(ago(12), now)).toBe('12 min ago');
    expect(liftFeed.ago(ago(180), now)).toBe('3 hr ago');
    expect(liftFeed.ago(ago(60 * 24), now)).toBe('1 day ago');
    expect(liftFeed.ago(ago(60 * 24 * 3), now)).toBe('3 days ago');
    expect(liftFeed.ago('nope', now)).toBe('');
  });
});
