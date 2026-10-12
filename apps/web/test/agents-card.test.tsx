import { cleanup, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import { moneyLabel, type AgentCard as AgentCardData } from '@roofline/shared';
import { AgentCard } from '../src/features/agents/AgentCard.tsx';

function fixture(over: Partial<AgentCardData> = {}): AgentCardData {
  return {
    agent: 'storm_scout',
    status: 'on',
    finishedToday: 4,
    successRate: 0.92,
    notApproved30d: 3,
    minutesThisMonth: 1860,
    last14Days: Array.from({ length: 14 }, (_, i) => ({ date: `2026-10-${String(i + 1).padStart(2, '0')}`, finished: i % 3 })),
    waitingCount: 0,
    ...over,
  };
}

function show(card: AgentCardData) {
  const router = createMemoryRouter([{ path: '/', element: <AgentCard card={card} hourlyRateCents={2800} /> }]);
  return render(<RouterProvider router={router} />);
}

afterEach(() => cleanup());

describe('AgentCard', () => {
  it('shows honest estimates for an on card', () => {
    show(fixture());
    expect(screen.getByText(/about 31 hours/)).toBeTruthy();
    expect(screen.getAllByText(/\(estimate\)/).length).toBeGreaterThan(0);
    expect(screen.getByText(moneyLabel(1860, 2800))).toBeTruthy();
    expect(screen.getByText('92%')).toBeTruthy();
    expect(screen.getByText('Not approved: 3')).toBeTruthy();
  });

  it('says there are not enough runs when the rate is null', () => {
    show(fixture({ successRate: null }));
    expect(screen.getByText('Not enough runs yet')).toBeTruthy();
    expect(screen.queryByText(/%/)).toBeNull();
  });

  it('shows no numbers on a coming soon card', () => {
    show(fixture({ status: 'coming_soon', agent: 'claims', minutesThisMonth: 0, successRate: null, notApproved30d: 0, finishedToday: 0 }));
    expect(screen.getAllByText('Coming soon').length).toBeGreaterThan(0);
    expect(screen.queryByText(/\(estimate\)/)).toBeNull();
    expect(screen.queryByText(/≈/)).toBeNull();
  });

  it('links to the agent page with the agent name', () => {
    show(fixture());
    const link = screen.getByRole('link', { name: 'Storm Scout' });
    expect(link.getAttribute('href')).toBe('/agents/storm-scout');
  });

  it('labels the status chip', () => {
    const { unmount } = show(fixture({ status: 'paused' }));
    expect(screen.getByText('Paused')).toBeTruthy();
    unmount();
    show(fixture({ status: 'waiting', waitingCount: 2 }));
    expect(screen.getAllByText('Waiting on you').length).toBeGreaterThan(0);
  });
});
