import { cleanup, render, screen, within } from '@testing-library/react';
import type { BaselineBreakdownRow, RecentTask, RuleSentence } from '@roofline/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TASK_KIND_LABEL } from '../src/copy/status.ts';
import { RecentTasks } from '../src/features/agents/RecentTasks.tsx';
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
    status: 'done',
    createdAt: '2026-10-12T20:05:00Z',
    minutesSaved: null,
    href: '/approvals/t1',
    ...overrides,
  } as RecentTask;
}

function showTasks(tasks: RecentTask[], timezone = 'America/Chicago') {
  const api = stubApi({ 'GET /api/company': () => ({ body: { id: 'c1', name: 'A', timezone } }) });
  renderAt(<RecentTasks tasks={tasks} />);
  return api;
}

describe('RecentTasks', () => {
  it('names the link by its content, in plain words', async () => {
    showTasks([task()]);
    const link = await screen.findByRole('link');
    expect(link.getAttribute('aria-label')).toBeNull();
    expect(within(link).getByText(TASK_KIND_LABEL['send_proposal']!)).toBeTruthy();
    expect(link.textContent).not.toContain('send_proposal');
  });

  it('has words for every real task kind and falls back for unknown ones', async () => {
    const kinds = ['storm_plan', 'send_storm_plan', 'create_ad_campaign', 'send_proposal', 'order_exact_report', 'exact_report'];
    // Front Desk live tasks and G1's agents (Claims, Scheduler, Follow-up).
    kinds.push('call', 'text_conversation', 'claims_nudges', 'claims_reply_noted', 'claims_adjuster_visit');
    kinds.push('claim_packet', 'reminders', 'no_show', 'weather_moves', 'follow_ups', 'stuck_nudges', 'proposal_call_rep');
    for (const kind of kinds) {
      expect(Object.hasOwn(TASK_KIND_LABEL, kind)).toBe(true);
    }
    showTasks([task({ id: 'u', kind: 'brand_new_kind', href: null }), task({ id: 'p', kind: 'toString', href: null })]);
    expect(await screen.findByText('brand new kind')).toBeTruthy();
    expect(screen.getByText('toString')).toBeTruthy();
  });

  it('writes times in the company time zone', async () => {
    showTasks([task()], 'America/Los_Angeles');
    expect(await screen.findByText('Oct 12, 1:05 PM')).toBeTruthy();
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
