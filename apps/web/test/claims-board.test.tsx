import { cleanup, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CLAIM_STATUSES, type ClaimBoardRow } from '@roofline/shared';
import { claims } from '../src/copy/claims.ts';
import { ClaimsBoard } from '../src/features/agents/ClaimsBoard.tsx';
import { renderAt, stubApi } from './helpers.tsx';

let api: ReturnType<typeof stubApi>;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const ROWS: ClaimBoardRow[] = [
  {
    claimId: 'a',
    jobId: 'j1',
    customerName: 'Pat Doe',
    address: '1 Main St',
    status: 'filed',
    insurer: 'Acme Mutual',
    claimNumber: 'CL-7',
    statusChangedAt: '2026-10-12T15:00:00.000Z',
  },
  {
    claimId: 'b',
    jobId: 'j2',
    customerName: 'Lee Kim',
    address: null,
    status: 'denied',
    insurer: null,
    claimNumber: null,
    statusChangedAt: '2026-10-13T15:00:00.000Z',
  },
];

function board(reply: { status?: number; body?: unknown }) {
  api = stubApi({
    'GET /api/company': () => ({ body: { id: 'c1', name: 'Summit Roofing', timezone: 'America/Chicago' } }),
    'GET /api/claims': () => reply,
  });
  renderAt(<ClaimsBoard />);
}

describe('claims board', () => {
  it('shows a column per status in order', async () => {
    board({ body: { claims: ROWS } });
    await screen.findByText('Pat Doe');
    const headings = screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent);
    expect(headings).toEqual(CLAIM_STATUSES.map((s) => claims.status[s]));
    expect(api.unexpected).toEqual([]);
  });

  it('a card links to its job, inside its column', async () => {
    board({ body: { claims: ROWS } });
    const link = await screen.findByRole('link', { name: /Pat Doe/ });
    expect(link).toHaveAttribute('href', '/jobs/j1');
    expect(link).toHaveTextContent(claims.since('Oct 12'));
    const column = screen.getByRole('heading', { level: 3, name: claims.status.filed }).closest('section');
    expect(column).not.toBeNull();
    expect(within(column as HTMLElement).getByRole('link', { name: /Pat Doe/ })).toBe(link);
    expect(screen.getByRole('link', { name: /Lee Kim/ })).toHaveAttribute('href', '/jobs/j2');
  });

  it('is a panel titled for the board, with how many claims each column holds', async () => {
    board({ body: { claims: ROWS } });
    await screen.findByText('Pat Doe');
    const panel = screen.getByRole('region', { name: claims.boardTitle });
    const filed = within(panel).getByRole('heading', { level: 3, name: claims.status.filed }).closest('section') as HTMLElement;
    expect(within(filed).getByText('1')).toBeInTheDocument();
    const closed = within(panel).getByRole('heading', { level: 3, name: claims.status.closed }).closest('section') as HTMLElement;
    expect(within(closed).getByText('0')).toBeInTheDocument();
    expect(api.unexpected).toEqual([]);
  });

  it('says so when there are no claims', async () => {
    board({ body: { claims: [] } });
    expect(await screen.findByText(claims.boardEmpty)).toBeInTheDocument();
  });

  it('says so when the claims cannot load', async () => {
    board({ status: 500, body: { error: 'Broken' } });
    expect(await screen.findByText(claims.boardLoadError)).toBeInTheDocument();
  });
});
