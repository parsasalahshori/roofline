import { cleanup, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { approvals } from '../src/copy/approvals.ts';
import { errors } from '../src/copy/errors.ts';
import { TASK_STATUS_LABEL } from '../src/copy/status.ts';
import { ApprovalsList } from '../src/features/approvals/ApprovalsList.tsx';
import { ACCOUNT, makeTask, renderAt, type Routes, stubApi } from './helpers.tsx';

let api: ReturnType<typeof stubApi>;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  expect(api?.unexpected ?? []).toEqual([]);
});

/** Signed in as an owner, with the given answer for the plans. */
function ownerApi(approvalsReply: Routes[string]) {
  api = stubApi({
    'GET /api/auth/me': () => ({ body: ACCOUNT }),
    'GET /api/approvals': approvalsReply,
  });
  return api;
}

describe('approvals list', () => {
  it('lists the plans newest first as links', async () => {
    ownerApi(() => ({
      body: {
        count: 2,
        tasks: [
          makeTask({ id: 'old', title: 'Older plan', createdAt: '2026-10-10T09:00:00.000Z' }),
          makeTask({
            id: 'new',
            title: 'Newer plan',
            createdAt: '2026-10-11T09:00:00.000Z',
            agent: 'estimator',
            summary: 'Proposals to send.',
          }),
        ],
      },
    }));
    renderAt(<ApprovalsList />, '/approvals');

    const links = await screen.findAllByRole('link');
    expect(links).toHaveLength(2);
    expect(links[0]).toHaveAttribute('href', '/approvals/new');
    expect(links[0]).toHaveTextContent('Newer plan');
    expect(links[0]).toHaveTextContent('Estimator');
    expect(links[0]).toHaveTextContent('Proposals to send.');
    expect(links[0]).toHaveTextContent(TASK_STATUS_LABEL.draft);
    expect(links[1]).toHaveAttribute('href', '/approvals/old');
    expect(links[1]).toHaveTextContent('Older plan');
  });

  it('marks an expired draft as Expired', async () => {
    ownerApi(() => ({ body: { count: 0, tasks: [makeTask({ id: 'e1', expired: true })] } }));
    renderAt(<ApprovalsList />, '/approvals');

    const link = await screen.findByRole('link');
    expect(link).toHaveTextContent(approvals.expired);
    expect(link).not.toHaveTextContent(TASK_STATUS_LABEL.draft);
  });

  it('shows plans waiting for the owner', async () => {
    ownerApi(() => ({ body: { count: 1, tasks: [makeTask({ id: 'o1', status: 'awaiting_owner' })] } }));
    renderAt(<ApprovalsList />, '/approvals');

    const link = await screen.findByRole('link');
    expect(link).toHaveTextContent(TASK_STATUS_LABEL.awaiting_owner);
  });

  it('says so when nothing needs a yes', async () => {
    ownerApi(() => ({ body: { count: 0, tasks: [] } }));
    renderAt(<ApprovalsList />, '/approvals');

    expect(await screen.findByText(approvals.emptyTitle)).toBeInTheDocument();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('a rep sees the owners-only empty state', async () => {
    api = stubApi({
      'GET /api/auth/me': () => ({ body: { ...ACCOUNT, role: 'rep' } }),
      'GET /api/approvals': () => ({ body: { count: 0, tasks: [] } }),
    });
    renderAt(<ApprovalsList />, '/approvals');

    expect(await screen.findByText(approvals.repTitle)).toBeInTheDocument();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('a rep sees the owners-only state even when plans come back', async () => {
    api = stubApi({
      'GET /api/auth/me': () => ({ body: { ...ACCOUNT, role: 'rep' } }),
      'GET /api/approvals': () => ({ body: { count: 1, tasks: [makeTask({ id: 'r1' })] } }),
    });
    renderAt(<ApprovalsList />, '/approvals');

    expect(await screen.findByText(approvals.repTitle)).toBeInTheDocument();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('shows the message the server gave when the list cannot load', async () => {
    ownerApi(() => ({ status: 500, body: { error: 'Something broke on our side.' } }));
    renderAt(<ApprovalsList />, '/approvals');

    expect(await screen.findByText('Something broke on our side.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: errors.tryAgain })).toBeInTheDocument();
  });

  it('Try again asks for the plans once more', async () => {
    // The server is down for the first ask and back for the second
    let back = false;
    ownerApi(() =>
      back ? { body: { count: 1, tasks: [makeTask({ id: 'r2', title: 'Back again' })] } } : { status: 500, body: { error: 'Something broke on our side.' } },
    );
    const { user } = renderAt(<ApprovalsList />, '/approvals');

    await screen.findByText('Something broke on our side.');
    back = true;
    await user.click(screen.getByRole('button', { name: errors.tryAgain }));

    expect(await screen.findByRole('link', { name: /Back again/ })).toHaveAttribute('href', '/approvals/r2');
  });
});
