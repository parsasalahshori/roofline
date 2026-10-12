import { cleanup, screen, within } from '@testing-library/react';
import type { WaitingItem } from '@roofline/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { agents } from '../src/copy/agents.ts';
import { AGENT_LABEL } from '../src/copy/status.ts';
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

function show(routes: Routes) {
  api = stubApi(routes);
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

  it('shows the empty state', async () => {
    show({ 'GET /api/agents/waiting': () => ({ body: { items: [] } }) });
    expect(await screen.findByText(agents.waitingEmpty)).toBeTruthy();
  });

  it('shows the load error', async () => {
    show({ 'GET /api/agents/waiting': () => ({ status: 500, body: { error: 'x' } }) });
    expect(await screen.findByText(agents.waitingLoadError)).toBeTruthy();
  });
});
