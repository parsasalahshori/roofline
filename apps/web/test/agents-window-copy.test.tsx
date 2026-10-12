import { cleanup, render, screen } from '@testing-library/react';
import type { AgentCard as AgentCardData } from '@roofline/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { RouterProvider, createMemoryRouter } from 'react-router';
import { Providers, createQueryClient } from '../src/app/providers.tsx';
import { agentsWindow } from '../src/copy/agents.ts';
import { AgentCard } from '../src/features/agents/AgentCard.tsx';

afterEach(cleanup);

function card(over: Partial<AgentCardData>): AgentCardData {
  return { agent: 'estimator', status: 'on', finishedToday: 3, successRate: 0.9, notApproved30d: 1, minutesThisMonth: 600, last14Days: [], waitingCount: 0, ...over };
}

function show(c: AgentCardData) {
  const router = createMemoryRouter([{ path: '*', element: <AgentCard card={c} hourlyRateCents={2800} /> }], { initialEntries: ['/'] });
  const { container } = render(
    <Providers client={createQueryClient()}>
      <RouterProvider router={router} />
    </Providers>,
  );
  return container;
}

describe('estimate copy', () => {
  it('marks every time and money figure on a live card as an estimate', () => {
    const container = show(card({}));
    // Fails until the real AgentCard (package A) lands; the track lead reruns after merge.
    const lines = [...container.querySelectorAll('p')].filter((p) => /about|≈/.test(p.textContent ?? ''));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line.textContent).toContain(agentsWindow.estimate);
    expect(container.textContent).toMatch(/about \d+ hours?/);
    expect(container.textContent).toContain('≈');
  });

  it('shows no figures on a coming soon card', () => {
    const container = show(card({ status: 'coming_soon', finishedToday: 0, successRate: null, notApproved30d: 0, minutesThisMonth: 0 }));
    expect(container.textContent).not.toMatch(/about|≈/);
    expect(container.textContent).not.toContain(agentsWindow.estimate);
    expect(screen.queryAllByText(agentsWindow.comingSoon).length).toBeGreaterThan(0);
  });
});
