import { cleanup, render, screen, within } from '@testing-library/react';
import type { BaselineBreakdownRow, RecentTask, RuleSentence } from '@roofline/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { agentPage } from '../src/copy/agents.ts';
import { TASK_KIND_LABEL, TASK_STATUS_LABEL } from '../src/copy/status.ts';
import { RECENT_SHOWN, RecentTasks } from '../src/features/agents/RecentTasks.tsx';
import { RulesList } from '../src/features/agents/RulesList.tsx';
import { TimeBreakdown } from '../src/features/agents/TimeBreakdown.tsx';
import { renderAt, stubApi } from './helpers.tsx';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function task(overrides: Partial<RecentTask> = {}): RecentTask {
  return {
    id: 't1',
    kind: 'send_proposal',
    title: 'Sent a proposal for 2208 Willow St',
    status: 'done',
    createdAt: '2026-10-12T20:05:00Z',
    minutesSaved: null,
    href: '/approvals/t1',
    ...overrides,
  } as RecentTask;
}

function showTasks(tasks: RecentTask[], timezone = 'America/Chicago') {
  const api = stubApi({ 'GET /api/company': () => ({ body: { id: 'c1', name: 'A', timezone } }) });
  renderAt(<RecentTasks agent="storm_scout" tasks={tasks} />);
  return api;
}

describe('RecentTasks', () => {
  it('names the link by its content: what the task was and its state, in plain words', async () => {
    showTasks([task()]);
    const link = await screen.findByRole('link');
    expect(link.getAttribute('aria-label')).toBeNull();
    expect(within(link).getByText('Sent a proposal for 2208 Willow St')).toBeTruthy();
    expect(within(link).getByText(TASK_STATUS_LABEL.done)).toBeTruthy();
    expect(link.textContent).not.toContain('send_proposal');
  });

  it('shows what each task was, so rows of one kind can be told apart', async () => {
    showTasks([
      task({ id: 'a', title: 'Booked an inspection at 1105 Main St', href: null }),
      task({ id: 'b', title: 'Booked an inspection at 5402 Aspen Grove Rd', href: null }),
    ]);
    expect(await screen.findByText('Booked an inspection at 1105 Main St')).toBeTruthy();
    expect(screen.getByText('Booked an inspection at 5402 Aspen Grove Rd')).toBeTruthy();
  });

  it('keeps a house number with its street where a line breaks', async () => {
    showTasks([task({ title: 'Booked an inspection at 305 Ridgeway Dr', href: null })]);
    const title = await screen.findByText('Booked an inspection at 305 Ridgeway Dr');
    expect(title.textContent).toContain('305\u00A0Ridgeway');
  });

  it('lists the ten newest and sends the rest to the Feed, filtered to this agent', async () => {
    const many = Array.from({ length: 12 }, (_, index) => task({ id: `t${index}`, title: `Task number ${index}`, href: null }));
    showTasks(many);
    expect(await screen.findByText('Task number 0')).toBeTruthy();
    expect(screen.getAllByRole('listitem')).toHaveLength(RECENT_SHOWN);
    expect(screen.queryByText('Task number 10')).toBeNull();
    expect(screen.getByRole('link', { name: agentPage.recentSeeAll }).getAttribute('href')).toBe('/agents/feed?agent=storm_scout');
  });

  it('has no link to the Feed when everything fits', async () => {
    showTasks([task({ href: null }), task({ id: 't2', href: null })]);
    await screen.findAllByText('Sent a proposal for 2208 Willow St');
    expect(screen.queryByRole('link', { name: agentPage.recentSeeAll })).toBeNull();
  });

  it('writes the saved time as hours, with no second estimate mark', async () => {
    showTasks([task({ minutesSaved: 30, href: null })]);
    expect(await screen.findByText('about 0.5 hours')).toBeTruthy();
    expect(screen.queryByText(/\(estimate\)/)).toBeNull();
  });

  it('writes times in the company time zone', async () => {
    showTasks([task()], 'America/Los_Angeles');
    expect(await screen.findByText('Oct 12, 1:05 PM')).toBeTruthy();
  });
});

describe('task kind words', () => {
  it('has words for every real task kind (the approvals screens use them)', () => {
    const kinds = ['storm_plan', 'send_storm_plan', 'create_ad_campaign', 'send_proposal', 'order_exact_report', 'exact_report'];
    // Front Desk live tasks and G1's agents (Claims, Scheduler, Follow-up).
    kinds.push('call', 'text_conversation', 'claims_nudges', 'claims_reply_noted', 'claims_adjuster_visit');
    kinds.push('claim_packet', 'reminders', 'no_show', 'weather_moves', 'follow_ups', 'stuck_nudges', 'proposal_call_rep');
    for (const kind of kinds) {
      expect(Object.hasOwn(TASK_KIND_LABEL, kind)).toBe(true);
    }
  });
});

describe('RulesList', () => {
  it('turns link labels into links and leaves link-less rules as plain text', () => {
    const rules: RuleSentence[] = [
      { text: 'Texts after 5 days', links: [{ label: '5 days', href: '/settings/x' }] },
      { text: 'Never texts at night', links: [] },
    ];
    renderAt(<RulesList rules={rules} />);
    const items = screen.getAllByRole('listitem');
    expect(within(items[0]!).getByRole('link', { name: '5 days' }).getAttribute('href')).toBe('/settings/x');
    expect(items[1]!.textContent).toBe('Never texts at night');
    expect(within(items[1]!).queryByRole('link')).toBeNull();
  });
});

describe('TimeBreakdown', () => {
  it('writes units with a thousands separator', () => {
    const rows = [{ baseline: 'sms', units: 1234, minutes: 60 }] as unknown as BaselineBreakdownRow[];
    render(<TimeBreakdown rows={rows} />);
    expect(screen.getByText('1,234')).toBeTruthy();
  });
});
