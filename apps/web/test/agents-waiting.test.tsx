import { cleanup, screen, within } from '@testing-library/react';
import type { WaitingItem } from '@roofline/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { agents, agentsCommon } from '../src/copy/agents.ts';
import { agentsKeys } from '../src/features/agents/api.ts';
import { AGENT_LABEL, TASK_STATUS_LABEL } from '../src/copy/status.ts';
import { WaitingList } from '../src/features/agents/WaitingList.tsx';
import { type Routes, renderAt, stubApi } from './helpers.tsx';

let api: ReturnType<typeof stubApi>;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  expect(api?.unexpected ?? []).toEqual([]);
});

function item(id: string, waitingOn: WaitingItem['waitingOn'], overrides: Partial<WaitingItem> = {}): WaitingItem {
  return { id, agent: 'estimator', kind: 'draft', text: `Needs ${id}`, since: '2026-10-12T15:05:00.000Z', waitingOn, href: null, ...overrides };
}

function show(routes: Routes, timezone = 'America/Chicago') {
  api = stubApi({ 'GET /api/company': () => ({ body: { id: 'c1', name: 'A', timezone } }), ...routes });
  return renderAt(<WaitingList />);
}

describe('WaitingList', () => {
  it('groups rows by who they wait on: You, Office, then each person', async () => {
    show({
      'GET /api/agents/waiting': () => ({
        body: {
          items: [
            item('d1', { kind: 'person', name: 'Dana' }),
            item('l1', { kind: 'person', name: 'Lee' }),
            item('o1', { kind: 'office' }),
            item('y1', { kind: 'you' }),
            item('d2', { kind: 'person', name: 'Dana' }),
          ],
        },
      }),
    });
    const region = await screen.findByLabelText(agents.waitingListLabel);
    const headings = within(region).getAllByRole('heading', { level: 2 });
    expect(headings.map((h) => h.textContent)).toEqual([
      agents.waitingGroupYou,
      agents.waitingGroupOffice,
      'Dana',
      'Lee',
    ]);
    const dana = within(region).getByRole('region', { name: 'Dana' });
    const rows = within(dana).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByText('Needs d1')).toBeTruthy();
    expect(within(rows[0]!).getByText(AGENT_LABEL.estimator)).toBeTruthy();
    expect(within(rows[1]!).getByText('Needs d2')).toBeTruthy();
    expect(within(region).getByRole('region', { name: 'Lee' })).toBeTruthy();
  });

  it('shows an Open link only when there is an href', async () => {
    show({
      'GET /api/agents/waiting': () => ({
        body: { items: [item('a', { kind: 'you' }, { href: '/jobs/j1' }), item('b', { kind: 'you' })] },
      }),
    });
    const region = await screen.findByLabelText(agents.waitingListLabel);
    const rows = within(region).getAllByRole('listitem');
    expect(within(rows[0]!).getByRole('link', { name: agents.waitingOpen }).getAttribute('href')).toBe('/jobs/j1');
    expect(within(rows[1]!).queryByRole('link')).toBeNull();
  });

  it('marks a row that needs help with a tag, and leaves the drafts and follow-ups plain', async () => {
    show({
      'GET /api/agents/waiting': () => ({
        body: {
          items: [
            item('a', { kind: 'you' }, { kind: 'attention', agent: 'storm_scout', text: 'Storm Scout needs help: Storm plan for Bellevue.', href: '/approvals/a' }),
            item('b', { kind: 'you' }),
            item('c', { kind: 'you' }, { kind: 'front_desk_follow_up', agent: 'front_desk' }),
          ],
        },
      }),
    });
    const region = await screen.findByLabelText(agents.waitingListLabel);
    const [needsHelp, draft, followUp] = within(region).getAllByRole('listitem');
    expect(within(needsHelp!).getByText(TASK_STATUS_LABEL.needs_attention)).toBeTruthy();
    // It can be acted on: the row opens the plan's own page
    expect(within(needsHelp!).getByRole('link', { name: agents.waitingOpen }).getAttribute('href')).toBe('/approvals/a');
    expect(within(draft!).queryByText(TASK_STATUS_LABEL.needs_attention)).toBeNull();
    expect(within(followUp!).queryByText(TASK_STATUS_LABEL.needs_attention)).toBeNull();
  });

  it('shows the empty state', async () => {
    show({ 'GET /api/agents/waiting': () => ({ body: { items: [] } }) });
    expect(await screen.findByText(agents.waitingEmpty)).toBeTruthy();
  });

  it('shows the load error', async () => {
    show({ 'GET /api/agents/waiting': () => ({ status: 500, body: { error: 'x' } }) });
    expect(await screen.findByText(agents.waitingLoadError)).toBeTruthy();
  });

  it('is a labelled section', async () => {
    show({ 'GET /api/agents/waiting': () => ({ body: { items: [item('a', { kind: 'you' })] } }) });
    const region = await screen.findByRole('region', { name: agents.waitingListLabel });
    expect(region.tagName).toBe('SECTION');
  });

  it('announces loading while pending', async () => {
    show({ 'GET /api/agents/waiting': () => ({ body: { items: [] } }) });
    expect(screen.getByRole('status', { name: agents.waitingLoading })).toBeTruthy();
    await screen.findByText(agents.waitingEmpty);
  });

  it('first-load failure shows a retry that recovers', async () => {
    let fail = true;
    const { user } = show({
      'GET /api/agents/waiting': () => (fail ? { status: 500, body: { error: 'x' } } : { body: { items: [item('a', { kind: 'you' })] } }),
    });
    expect(await screen.findByText(agents.waitingLoadError)).toBeTruthy();
    fail = false;
    await user.click(screen.getByRole('button', { name: agentsCommon.retry }));
    expect(await screen.findByText('Needs a')).toBeTruthy();
  });

  it('a failed refetch keeps the rows and shows a banner', async () => {
    let fail = false;
    const { queryClient } = show({
      'GET /api/agents/waiting': () => (fail ? { status: 500, body: { error: 'x' } } : { body: { items: [item('a', { kind: 'you' })] } }),
    });
    await screen.findByText('Needs a');
    fail = true;
    await queryClient.refetchQueries({ queryKey: agentsKeys.waiting });
    expect(await screen.findByText(agentsCommon.refreshFailed)).toBeTruthy();
    expect(screen.getByText('Needs a')).toBeTruthy();
    expect(screen.queryByText(agents.waitingLoadError)).toBeNull();
  });

  it('writes times in the company time zone', async () => {
    show(
      { 'GET /api/agents/waiting': () => ({ body: { items: [item('a', { kind: 'you' }, { since: '2026-10-12T20:05:00Z' })] } }) },
      'America/Los_Angeles',
    );
    expect(await screen.findByText('Oct 12, 1:05 PM')).toBeTruthy();
  });
});
