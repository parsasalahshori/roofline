import { cleanup, render, screen } from '@testing-library/react';
import type { AgentCard as AgentCardData } from '@roofline/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { RouterProvider, createMemoryRouter } from 'react-router';
import { Providers, createQueryClient } from '../src/app/providers.tsx';
import { agentsCommon } from '../src/copy/agents.ts';
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
    const lines = [...container.querySelectorAll('p')].filter((p) => /about|less than|≈/.test(p.textContent ?? ''));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line.textContent).toContain(agentsCommon.estimate);
    expect(container.textContent).toMatch(/about \d+ hours?/);
    expect(container.textContent).toContain('≈');
  });

  it('says less than half an hour for a few minutes, with the estimate marker', () => {
    const container = show(card({ minutesThisMonth: 5 }));
    expect(container.textContent).toContain('less than half an hour');
    expect(container.textContent).not.toContain('about 0');
    const line = [...container.querySelectorAll('p')].find((p) => /less than/.test(p.textContent ?? ''));
    expect(line?.textContent).toContain(agentsCommon.estimate);
  });

  it('shows no figures on a coming soon card', () => {
    const container = show(card({ status: 'coming_soon', finishedToday: 0, successRate: null, notApproved30d: 0, minutesThisMonth: 0 }));
    expect(container.textContent).not.toMatch(/about|less than|≈/);
    expect(container.textContent).not.toContain(agentsCommon.estimate);
    expect(screen.queryAllByText(agentsCommon.comingSoon).length).toBeGreaterThan(0);
  });
});
