import { cleanup, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { keys } from '../src/api/keys.ts';
import { shell } from '../src/copy/shell.ts';
import { OkPill } from '../src/shell/topbar/OkPill.tsx';
import { makeTask, renderAt, stubApi } from './helpers.tsx';

let api: ReturnType<typeof stubApi>;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  expect(api?.unexpected ?? []).toEqual([]);
});

describe('need your OK pill', () => {
  it('is hidden when nothing is waiting', async () => {
    api = stubApi({ 'GET /api/approvals': () => ({ body: { count: 0, tasks: [] } }) });
    const { queryClient } = renderAt(<OkPill />);
    await waitFor(() => expect(queryClient.getQueryState(keys.approvals)?.status).toBe('success'));
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('opens the one draft directly', async () => {
    // The server's count says 2, but only one draft is counted (the other has expired): the pill counts the tasks
    api = stubApi({
      'GET /api/approvals': () => ({
        body: { count: 2, tasks: [makeTask({ id: 't1' }), makeTask({ id: 't2', expired: true })] },
      }),
    });
    renderAt(<OkPill />);
    const pill = await screen.findByRole('link', { name: shell.needYourOk(1) });
    expect(pill).toHaveAttribute('href', '/approvals/t1');
  });

  it('opens the list when several are waiting', async () => {
    api = stubApi({
      'GET /api/approvals': () => ({
        body: {
          count: 2,
          tasks: [makeTask({ id: 't1', status: 'draft' }), makeTask({ id: 't2', status: 'awaiting_owner', agent: 'estimator' })],
        },
      }),
    });
    renderAt(<OkPill />);
    const pill = await screen.findByRole('link', { name: shell.needYourOk(2) });
    expect(pill).toHaveAttribute('href', '/approvals');
  });

  it('does not count tasks that are not waiting', async () => {
    api = stubApi({
      'GET /api/approvals': () => ({
        body: {
          count: 0,
          tasks: [
            makeTask({ id: 't1', status: 'approved' }),
            makeTask({ id: 't2', status: 'done' }),
            makeTask({ id: 't3', status: 'running' }),
          ],
        },
      }),
    });
    const { queryClient } = renderAt(<OkPill />);
    await waitFor(() => expect(queryClient.getQueryState(keys.approvals)?.status).toBe('success'));
    expect(screen.queryByRole('link')).toBeNull();
  });
});
