import { cleanup, screen, waitFor, within } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Account } from '../src/api/types.ts';
import { search } from '../src/copy/search.ts';
import { SearchDialog } from '../src/shell/topbar/SearchDialog.tsx';
import { ACCOUNT, renderAt, stubApi, where } from './helpers.tsx';

const EMPTY = { customers: [], jobs: [], addresses: [] };

let api: ReturnType<typeof stubApi>;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.localStorage.clear();
  expect(api?.unexpected ?? []).toEqual([]);
});

function setup(role: Account['role'] = 'owner') {
  api = stubApi({
    'GET /api/auth/me': () => ({ body: { ...ACCOUNT, role } }),
    // Typing a word of two letters or more also asks the server; the answer is nothing
    'GET /api/search?q=new': () => ({ body: EMPTY }),
    'GET /api/search?q=book': () => ({ body: EMPTY }),
    'GET /api/search?q=down': () => ({ body: EMPTY }),
  });
  return renderAt(<SearchDialog />);
}

/** Opens with Ctrl+K, then waits until the signed-in account has loaded. */
async function open(user: UserEvent) {
  await user.keyboard('{Control>}k{/Control}');
  const combobox = await screen.findByRole('combobox', { name: search.inputLabel });
  await waitFor(() => expect(api.count('GET /api/auth/me')).toBeGreaterThan(0));
  await new Promise((resolve) => setTimeout(resolve, 50));
  return combobox;
}

const { newJob, newCustomer, bookInspection, downloadCustomers } = search.actionItems;

describe('search actions', () => {
  it('lists matching actions under Actions', async () => {
    const { user } = setup();
    const combobox = await open(user);
    await user.type(combobox, 'new');

    const group = await screen.findByRole('group', { name: search.actions });
    expect(within(group).getByRole('option', { name: newJob.label })).toBeInTheDocument();
    expect(within(group).getByRole('option', { name: newCustomer.label })).toBeInTheDocument();
  });

  it('opens New job and Book an inspection with the keyboard', async () => {
    const first = setup();
    const combobox = await open(first.user);
    await first.user.type(combobox, 'new');
    await screen.findByRole('option', { name: newJob.label });
    await first.user.keyboard('{ArrowDown}{Enter}');
    await waitFor(() => expect(where(first.router)).toBe('/jobs/new'));
    cleanup();

    const second = setup();
    const input = await open(second.user);
    await second.user.type(input, 'book');
    await screen.findByRole('option', { name: bookInspection.label });
    await second.user.keyboard('{ArrowDown}{Enter}');
    await waitFor(() => expect(where(second.router)).toBe('/calendar/new?kind=inspection'));
  });

  it.each(['owner', 'office'] as const)('offers the customers download to %s', async (role) => {
    const { user } = setup(role);
    const combobox = await open(user);
    await user.type(combobox, 'down');
    expect(await screen.findByRole('option', { name: downloadCustomers.label })).toBeInTheDocument();
  });

  it('does not offer the customers download to a rep', async () => {
    const { user } = setup('rep');
    const combobox = await open(user);
    await user.type(combobox, 'down');
    expect(await screen.findByText(search.noMatches('down'))).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: downloadCustomers.label })).not.toBeInTheDocument();
  });
});

describe('search recents', () => {
  const key = `roofline.recents.${ACCOUNT.company.id}`;

  it('lists recents on an empty query and opens one', async () => {
    window.localStorage.setItem(
      key,
      JSON.stringify([
        { kind: 'job', id: 'j1', label: 'Maria Lopez roof' },
        { kind: 'customer', id: 'c1', label: 'Ben Carter' },
      ]),
    );
    const { router, user } = setup();
    await open(user);

    const group = await screen.findByRole('group', { name: search.recent });
    expect(within(group).getByRole('option', { name: 'Maria Lopez roof' })).toBeInTheDocument();
    expect(within(group).getByRole('option', { name: 'Ben Carter' })).toBeInTheDocument();

    await user.keyboard('{ArrowDown}{Enter}');
    await waitFor(() => expect(where(router)).toBe('/jobs/j1'));
  });

  it('survives a storage error', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const { user } = setup();
    await open(user);

    expect(await screen.findByText(search.hint)).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: search.recent })).not.toBeInTheDocument();
  });
});
