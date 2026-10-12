import { cleanup, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentValues } from '@roofline/shared';
import { agentRules } from '../src/copy/agents.ts';
import { errors } from '../src/copy/errors.ts';
import { AgentRules } from '../src/features/settings/AgentRules.tsx';
import { renderAt, stubApi } from './helpers.tsx';

const DEFAULTS: AgentValues = {
  claimsNudgeDays: [3, 5, 7],
  weatherRainPct: 60,
  weatherGustMph: 25,
  reminderHour: 15,
  followupDays: [3, 4],
  leadFollowupDays: 2,
  reviewLink: null,
  reviewDelayDays: 3,
  followupReviews: true,
  followupLeads: true,
  followupProposals: true,
};

let api: ReturnType<typeof stubApi>;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  expect(api?.unexpected ?? []).toEqual([]);
});

describe('agent rules form', () => {
  it('renders the defaults from a stubbed fetch', async () => {
    api = stubApi({
      'GET /api/agent-values': () => ({ body: DEFAULTS }),
    });
    renderAt(<AgentRules />);

    expect(await screen.findByLabelText(agentRules.rainLabel)).toHaveValue(60);
    expect(screen.getByLabelText(agentRules.gustLabel)).toHaveValue(25);
    expect(screen.getByLabelText(agentRules.hourLabel)).toHaveValue(15);
    expect(screen.getByLabelText(agentRules.nudgeDayLabels[0])).toHaveValue(3);
    expect(screen.getByLabelText(agentRules.nudgeDayLabels[1])).toHaveValue(5);
    expect(screen.getByLabelText(agentRules.nudgeDayLabels[2])).toHaveValue(7);
    expect(screen.getByLabelText(agentRules.followupDayLabels[0])).toHaveValue(3);
    expect(screen.getByLabelText(agentRules.followupDayLabels[1])).toHaveValue(4);
    expect(screen.getByLabelText(agentRules.leadDaysLabel)).toHaveValue(2);
    expect(screen.getByLabelText(agentRules.reviewDelayLabel)).toHaveValue(3);
    expect(screen.getByLabelText(agentRules.reviewLinkLabel)).toHaveValue('');
    expect(screen.getByRole('checkbox', { name: agentRules.reviewsLabel })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: agentRules.leadsLabel })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: agentRules.proposalsLabel })).toBeChecked();
    expect(api.count('GET /api/agent-values')).toBe(1);
  });

  it('saves a changed rain percent', async () => {
    api = stubApi({
      'GET /api/agent-values': () => ({ body: DEFAULTS }),
      'PATCH /api/agent-values': () => ({ body: { ...DEFAULTS, weatherRainPct: 40 } }),
    });
    const { user } = renderAt(<AgentRules />);
    const rain = await screen.findByLabelText(agentRules.rainLabel);
    await user.clear(rain);
    await user.type(rain, '40');
    await user.click(screen.getByRole('button', { name: agentRules.save }));

    await screen.findByText(agentRules.saved);
    expect(api.sent('PATCH /api/agent-values')).toEqual([{ weatherRainPct: 40 }]);
    expect(screen.getByLabelText(agentRules.rainLabel)).toHaveValue(40);
  });

  it('shows a field error from a 400 with field', async () => {
    const message = 'Please enter a percent from 0 to 100.';
    api = stubApi({
      'GET /api/agent-values': () => ({ body: DEFAULTS }),
      'PATCH /api/agent-values': () => ({ status: 400, body: { error: message, field: 'weatherRainPct' } }),
    });
    const { user } = renderAt(<AgentRules />);
    const rain = await screen.findByLabelText(agentRules.rainLabel);
    await user.clear(rain);
    await user.type(rain, '150');
    await user.click(screen.getByRole('button', { name: agentRules.save }));

    await waitFor(() => expect(screen.getByText(message)).toBeInTheDocument());
    expect(screen.getAllByText(message)).toHaveLength(1);
    expect(rain).toHaveAttribute('aria-invalid', 'true');
    expect(rain).toHaveAccessibleDescription(expect.stringContaining(message));
  });

  it('tells an office member only the owner can see the rules', async () => {
    api = stubApi({
      'GET /api/agent-values': () => ({ status: 403, body: { error: 'Your role can’t do that.' } }),
    });
    renderAt(<AgentRules />);

    expect(await screen.findByText(agentRules.ownerOnly)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: errors.tryAgain })).toBeNull();
  });
});
