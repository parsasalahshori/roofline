import { cleanup, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProposalView } from '@roofline/shared';
import { Button } from '@roofline/ui';
import { proposals } from '../src/copy/proposals.ts';
import { formatLastOpened } from '../src/features/proposals/format.ts';
import { renderAt } from './helpers.tsx';

const mocks = vi.hoisted(() => ({
  proposal: undefined as unknown,
  patch: vi.fn(),
  send: vi.fn(),
  copy: vi.fn(),
  revise: vi.fn(),
}));

vi.mock('../src/features/proposals/api.ts', () => ({
  useProposal: () => ({ data: mocks.proposal, isPending: false, isError: false, refetch: vi.fn() }),
  usePricebook: () => ({ data: undefined }),
  usePatchProposal: () => ({ mutate: mocks.patch, isPending: false }),
  useSendProposal: () => ({ mutate: mocks.send, isPending: false }),
  useCopyLink: () => ({ mutate: mocks.copy, isPending: false }),
  useReviseProposal: () => ({ mutate: mocks.revise, isPending: false }),
  proposalPdfUrl: (id: string) => `/api/proposals/${id}/pdf`,
}));
vi.mock('../src/features/settings/api.ts', () => ({ useCompany: () => ({ data: { timezone: 'America/Chicago' } }) }));
vi.mock('../src/features/proposals/OptionCard.tsx', () => ({
  OptionCard: (props: { option: { id: string; name: string }; editable: boolean; onChange: (patch: { enabled?: boolean }) => void }) => (
    <div data-testid={`option-${props.option.id}`} data-editable={String(props.editable)}>
      {props.option.name}
      <Button onClick={() => props.onChange({ enabled: false })}>{`off-${props.option.id}`}</Button>
    </div>
  ),
}));

const { ProposalWindow } = await import('../src/features/proposals/ProposalWindow.tsx');

function make(overrides: Partial<ProposalView> = {}): ProposalView {
  const option = (id: string, tier: 'good' | 'better' | 'best') => ({ id, tier, name: `Option ${id}`, enabled: true });
  return {
    id: 'p1',
    number: 'P-1001',
    status: 'draft',
    jobId: 'j1',
    customer: { id: 'c1', name: 'Dana Smith', phone: null },
    address: '12 Oak St',
    measurementId: 'm1',
    basis: 'estimate',
    options: [option('o1', 'good'), option('o2', 'better'), option('o3', 'best')],
    messageBody: 'Hi {link}',
    validUntil: 'Nov 11',
    sentAt: null,
    views: { count: 0, first: null, last: null },
    signed: null,
    declined: null,
    taskId: null,
    replacedById: null,
    canEdit: true,
    ...overrides,
  } as unknown as ProposalView;
}

const show = () => renderAt(<ProposalWindow />, '/estimator/proposals/p1');

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-12T20:00:00Z') });
  for (const m of Object.values(mocks)) {
    if (vi.isMockFunction(m)) m.mockReset();
  }
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('ProposalWindow', () => {
  it('a draft is editable and sends', async () => {
    mocks.proposal = make();
    const { user } = show();
    expect(screen.getByTestId('option-o1').dataset.editable).toBe('true');
    expect(screen.queryByText(proposals.readOnlyNote)).toBeNull();
    await user.click(screen.getByRole('button', { name: proposals.send }));
    expect(mocks.send).toHaveBeenCalledOnce();
  });

  it('a sent proposal is read only and can be revised', async () => {
    mocks.proposal = make({ status: 'sent', sentAt: '2026-10-12T15:00:00Z' });
    const { user } = show();
    expect(screen.getByTestId('option-o1').dataset.editable).toBe('false');
    expect(screen.getByText(proposals.readOnlyNote)).toBeTruthy();
    expect(screen.queryByRole('button', { name: proposals.send })).toBeNull();
    expect(screen.getByText(proposals.eventsNone)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: proposals.makeRevised }));
    expect(mocks.revise).toHaveBeenCalledOnce();
    await user.click(screen.getByRole('button', { name: proposals.copyLink }));
    expect(mocks.copy).toHaveBeenCalledOnce();
  });

  it('shows how often it was opened', () => {
    mocks.proposal = make({ status: 'viewed', views: { count: 3, first: '2026-10-12T14:00:00Z', last: '2026-10-13T00:12:00Z' } });
    show();
    expect(screen.getByText('Opened 3 times · last today 7:12 PM')).toBeTruthy();
  });

  it('uses the singular for one view', () => {
    mocks.proposal = make({ status: 'viewed', views: { count: 1, first: '2026-10-13T00:12:00Z', last: '2026-10-13T00:12:00Z' } });
    show();
    expect(screen.getByText('Opened 1 time · last today 7:12 PM')).toBeTruthy();
  });

  it('patches the option that changed', async () => {
    mocks.proposal = make();
    const { user } = show();
    await user.click(screen.getByRole('button', { name: 'off-o2' }));
    expect(mocks.patch).toHaveBeenCalledWith({ options: [{ id: 'o2', enabled: false }] });
  });

  it('links to the newer proposal', () => {
    mocks.proposal = make({ status: 'replaced', replacedById: 'p2' });
    show();
    expect(screen.getByRole('link', { name: proposals.openReplacement }).getAttribute('href')).toBe('/estimator/proposals/p2');
  });
});

describe('formatLastOpened', () => {
  const now = new Date('2026-10-12T20:00:00Z');
  it('words today, yesterday and older days', () => {
    expect(formatLastOpened('2026-10-13T00:12:00Z', now, 'America/Chicago')).toBe('today 7:12 PM');
    expect(formatLastOpened('2026-10-11T15:05:00Z', now, 'America/Chicago')).toBe('yesterday 10:05 AM');
    expect(formatLastOpened('2026-10-09T00:12:00Z', now, 'America/Chicago')).toBe('Oct 8 7:12 PM');
  });
  it('accepts an undefined zone', () => {
    expect(() => formatLastOpened('2026-10-12T20:00:00Z', now, undefined)).not.toThrow();
  });
});
