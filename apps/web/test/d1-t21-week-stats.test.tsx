import { cleanup, render, screen, within } from '@testing-library/react';
import type { FrontDeskWeekStats } from '@roofline/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Providers, createQueryClient } from '../src/app/providers.tsx';
import { frontDeskInbox } from '../src/copy/front-desk-inbox.ts';
import { WeekStats } from '../src/features/front-desk/WeekStats.tsx';
import { stubApi } from './helpers.tsx';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const STATS: FrontDeskWeekStats = {
  weekStart: '2026-10-05',
  answered: 12,
  booked: 4,
  transferred: 3,
  messages: 5,
  spam: 2,
  firstReplyMsP50: null,
  guardBlocks: 0,
  aiMinutesUsed: 212,
  aiMinutesIncluded: 500,
};

function renderStats() {
  const queryClient = createQueryClient();
  queryClient.setDefaultOptions({ queries: { retry: false } });
  render(
    <Providers client={queryClient}>
      <WeekStats />
    </Providers>,
  );
}

/** The description list of the tile whose label is `label`. */
function tile(label: string): HTMLElement {
  const dl = screen.getByText(label).closest('dl');
  if (!dl) throw new Error(`No tile for ${label}`);
  return dl;
}

describe('WeekStats', () => {
  it('shows the week heading and one tile per number, with AI minutes as used of included', async () => {
    stubApi({ 'GET /api/front-desk/stats': () => ({ body: STATS }) });
    renderStats();

    expect(await screen.findByText('212 of 500 minutes')).toBeTruthy();
    expect(screen.getByRole('heading', { name: frontDeskInbox.stats.title })).toBeTruthy();
    expect(screen.getByText(frontDeskInbox.stats.aiMinutes)).toBeTruthy();

    expect(within(tile(frontDeskInbox.stats.answered)).getByText('12')).toBeTruthy();
    expect(within(tile(frontDeskInbox.stats.booked)).getByText('4')).toBeTruthy();
    expect(within(tile(frontDeskInbox.stats.transferred)).getByText('3')).toBeTruthy();
    expect(within(tile(frontDeskInbox.stats.messages)).getByText('5')).toBeTruthy();
    expect(within(tile(frontDeskInbox.stats.spam)).getByText('2')).toBeTruthy();
  });

  it('shows minutes used alone when the plan has no included minutes', async () => {
    stubApi({ 'GET /api/front-desk/stats': () => ({ body: { ...STATS, aiMinutesIncluded: null } }) });
    renderStats();

    expect(await screen.findByText('212 minutes')).toBeTruthy();
    expect(screen.queryByText(/ of /)).toBeNull();
  });

  it('shows the load error text when the stats cannot be read', async () => {
    stubApi({ 'GET /api/front-desk/stats': () => ({ status: 500, body: { error: 'boom' } }) });
    renderStats();

    expect(await screen.findByText(frontDeskInbox.stats.loadError)).toBeTruthy();
  });
});
