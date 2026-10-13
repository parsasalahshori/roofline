import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentCard as AgentCardData } from '@roofline/shared';
import { Providers, createQueryClient } from '../src/app/providers.tsx';
import { agentsDash } from '../src/copy/agents.ts';
import { AgentCard } from '../src/features/agents/AgentCard.tsx';
import { ACCOUNT, SHELL_ROUTES, stubApi } from './helpers.tsx';

const NOW = Date.parse('2026-10-13T06:41:00.000Z');

function fixture(over: Partial<AgentCardData> = {}): AgentCardData {
  return {
    agent: 'storm_scout',
    status: 'on',
    finishedToday: 636,
    successRate: 0.92,
    notApproved30d: 3,
    minutesThisMonth: 1860,
    last14Days: Array.from({ length: 14 }, (_, i) => ({ date: `2026-10-${String(i + 1).padStart(2, '0')}`, finished: i % 3 })),
    waitingCount: 0,
    ...over,
  };
}

function show(card: AgentCardData, over: { isOwner?: boolean; selected?: boolean; onSelect?: () => void; minutes?: number | null; latest?: { text: string; at: string } | null } = {}) {
  stubApi({ ...SHELL_ROUTES, 'GET /api/auth/me': () => ({ body: ACCOUNT }) });
  const router = createMemoryRouter([
    {
      path: '/',
      element: (
        <ul>
          <AgentCard
            card={card}
            minutesThisWeek={over.minutes === undefined ? 1080 : over.minutes}
            latest={over.latest === undefined ? { text: 'Scored 636 roofs in last night’s hail path', at: '2026-10-13T03:41:00.000Z' } : over.latest}
            selected={over.selected ?? false}
            onSelect={over.onSelect ?? (() => undefined)}
            isOwner={over.isOwner ?? true}
            now={NOW}
          />
        </ul>
      ),
    },
  ]);
  return render(
    <Providers client={createQueryClient()}>
      <RouterProvider router={router} />
    </Providers>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('AgentCard', () => {
  it('shows the big number, success, hours saved and the latest action with its age', () => {
    show(fixture());
    expect(screen.getByText('636')).toBeTruthy();
    expect(screen.getByText(agentsDash.tasksTodayLine)).toBeTruthy();
    expect(screen.getByText('92%')).toBeTruthy();
    expect(screen.getByText(`18 ${agentsDash.hoursUnit}`)).toBeTruthy();
    expect(screen.getByText('Scored 636 roofs in last night’s hail path')).toBeTruthy();
    expect(screen.getByText('3 hr ago')).toBeTruthy();
    expect(screen.getByText(agentsDash.running)).toBeTruthy();
    expect(screen.getByRole('img', { name: new RegExp(agentsDash.cardSparkLabel) })).toBeTruthy();
  });

  it('says no runs yet when the success rate is not known', () => {
    show(fixture({ successRate: null }));
    expect(screen.getByText(agentsDash.noSuccess)).toBeTruthy();
    expect(screen.queryByText(/%/)).toBeNull();
  });

  it('says nothing yet when there is no latest action', () => {
    show(fixture(), { latest: null });
    expect(screen.getByText(agentsDash.latestNone)).toBeTruthy();
  });

  it('marks the selected card and picks on a click', async () => {
    const onSelect = vi.fn();
    show(fixture(), { selected: true, onSelect });
    expect(screen.getByRole('article').getAttribute('data-selected')).toBe('true');
    const pick = screen.getByRole('button', { name: /Storm Scout/ });
    expect(pick.getAttribute('aria-pressed')).toBe('true');
    await userEvent.setup().click(pick);
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('shows Paused with the switch off', () => {
    show(fixture({ status: 'paused' }));
    expect(screen.getByText(agentsDash.paused)).toBeTruthy();
    expect(screen.getByRole('switch', { name: `Storm Scout ${agentsDash.running}` }).getAttribute('aria-checked')).toBe('false');
  });

  it('shows no switch to someone who cannot change it', () => {
    show(fixture(), { isOwner: false });
    expect(screen.queryByRole('switch')).toBeNull();
  });

  it('a coming soon card has no switch and no numbers beyond zero', () => {
    show(fixture({ status: 'coming_soon', agent: 'claims', finishedToday: 0, successRate: null }));
    expect(screen.getByText(agentsDash.comingSoon)).toBeTruthy();
    expect(screen.queryByRole('switch')).toBeNull();
  });
});
