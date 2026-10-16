import { cleanup, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProposalView } from '@roofline/shared';
import { Button } from '@roofline/ui';
import { proposals } from '../src/copy/proposals.ts';
import { formatLastOpened } from '../src/features/proposals/format.ts';
import { renderAt } from './helpers.tsx';

const phoneMode = vi.hoisted(() => ({ phone: false }));
vi.mock('../src/shell/useIsPhone.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/shell/useIsPhone.ts')>()),
  useIsPhone: () => phoneMode.phone,
}));

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
  OptionCard: (props: {
    option: { id: string; name: string };
    editable: boolean;
    open?: boolean;
    onSelect?: () => void;
    radioName?: string;
    onChange: (patch: { enabled?: boolean }) => void;
  }) => (
    <div data-testid={`option-${props.option.id}`} data-editable={String(props.editable)} data-open={String(props.open)} data-pickable={String(props.onSelect !== undefined)}>
      {props.option.name}
      {props.onSelect ? (
        <input type="radio" name={props.radioName} aria-label={`pick-${props.option.id}`} checked={props.open} onChange={props.onSelect} />
      ) : null}
      <Button onClick={() => props.onChange({ enabled: false })}>{`off-${props.option.id}`}</Button>
    </div>
  ),
}));

const { ProposalWindow } = await import('../src/features/proposals/ProposalWindow.tsx');

function make(overrides: Partial<ProposalView> = {}): ProposalView {
  const option = (id: string, tier: 'good' | 'better' | 'best', totalCents: number) => ({ id, tier, name: `Option ${id}`, enabled: true, totalCents });
  return {
    id: 'p1',
    number: 'P-1001',
    status: 'draft',
    jobId: 'j1',
    customer: { id: 'c1', name: 'Dana Smith', phone: null },
    address: '12 Oak St',
    measurementId: 'm1',
    basis: 'estimate',
    options: [option('o1', 'good', 940000), option('o2', 'better', 1100000), option('o3', 'best', 1380000)],
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
  phoneMode.phone = false;
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

describe('ProposalWindow page', () => {
  it('the number is the title; Jobs and the customer are in the trail', () => {
    mocks.proposal = make();
    show();
    expect(screen.getByRole('heading', { level: 1, name: proposals.title('P-1001') })).toBeInTheDocument();
    const trail = within(screen.getByRole('navigation', { name: 'Breadcrumb' }));
    expect(trail.getByRole('link', { name: 'Jobs' })).toHaveAttribute('href', '/jobs');
    expect(trail.getByRole('link', { name: 'Dana Smith' })).toHaveAttribute('href', '/jobs/j1');
  });

  it('under the title: its status, who it is for and until when', () => {
    mocks.proposal = make();
    show();
    expect(screen.getByText(proposals.statusLabelFor('draft'))).toBeInTheDocument();
    expect(screen.getByText(proposals.customerLine('Dana Smith', '12 Oak St'))).toBeInTheDocument();
    expect(screen.getByText(proposals.validUntil('Nov 11'))).toBeInTheDocument();
  });

  it('the valid-until date is plain: Nov 9, not 2026-11-09', () => {
    mocks.proposal = make({ validUntil: '2026-11-09' });
    show();
    expect(screen.getByText(proposals.validUntil('Nov 9'))).toBeInTheDocument();
  });

  it('the actions are in the head: the PDF is a link to the proposal pdf', () => {
    mocks.proposal = make();
    show();
    expect(screen.getByRole('link', { name: proposals.downloadPdf })).toHaveAttribute('href', '/api/proposals/p1/pdf');
  });

  it('shows all three options as radio rows on a desktop, the recommended one picked first', async () => {
    mocks.proposal = make();
    const { user } = show();
    const group = within(screen.getByRole('radiogroup', { name: proposals.tiersLabel }));
    for (const id of ['o1', 'o2', 'o3']) {
      expect(screen.getByTestId(`option-${id}`).closest('[hidden]')).toBeNull();
      expect(screen.getByTestId(`option-${id}`)).toHaveAttribute('data-pickable', 'true');
    }
    expect(screen.getByTestId('option-o2')).toHaveAttribute('data-open', 'true');
    expect(screen.getByTestId('option-o1')).toHaveAttribute('data-open', 'false');
    expect(screen.getByTestId('option-o3')).toHaveAttribute('data-open', 'false');

    await user.click(group.getByRole('radio', { name: 'pick-o3' }));
    expect(screen.getByTestId('option-o3')).toHaveAttribute('data-open', 'true');
    expect(screen.getByTestId('option-o2')).toHaveAttribute('data-open', 'false');
  });

  it('the rows share one radio name, and the arrow keys move the pick between them, round the ends', async () => {
    mocks.proposal = make();
    const { user } = show();
    const radio = (id: string) => screen.getByRole('radio', { name: `pick-${id}` });
    expect(new Set(['o1', 'o2', 'o3'].map((id) => (radio(id) as HTMLInputElement).name)).size).toBe(1);

    radio('o2').focus();
    await user.keyboard('{ArrowDown}');
    expect(screen.getByTestId('option-o3')).toHaveAttribute('data-open', 'true');
    expect(radio('o3')).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(screen.getByTestId('option-o1')).toHaveAttribute('data-open', 'true');
    expect(radio('o1')).toHaveFocus();
    await user.keyboard('{ArrowUp}');
    expect(screen.getByTestId('option-o3')).toHaveAttribute('data-open', 'true');
  });

  it('on a phone: three tabs with their prices, the recommended option first, one option at a time', async () => {
    phoneMode.phone = true;
    mocks.proposal = make();
    const { user } = show();

    const tabs = within(screen.getByRole('radiogroup', { name: proposals.tiersLabel }));
    expect(tabs.getAllByRole('radio').map((tab) => tab.textContent)).toEqual([
      expect.stringContaining('Good'),
      expect.stringContaining('Better'),
      expect.stringContaining('Best'),
    ]);
    expect(tabs.getByRole('radio', { name: /^Better/ })).toBeChecked();
    expect(tabs.getByRole('radio', { name: /^Good/ })).toHaveTextContent(proposals.money(940000));
    // Better is shown; Good and Best are mounted but hidden
    expect(screen.getByTestId('option-o2').closest('[hidden]')).toBeNull();
    expect(screen.getByTestId('option-o1').closest('[hidden]')).not.toBeNull();
    expect(screen.getByTestId('option-o3').closest('[hidden]')).not.toBeNull();
    // The tabs pick, so the headings are not radios
    expect(screen.getByTestId('option-o2')).toHaveAttribute('data-pickable', 'false');

    await user.click(tabs.getByRole('radio', { name: /^Good/ }));
    expect(screen.getByTestId('option-o1').closest('[hidden]')).toBeNull();
    expect(screen.getByTestId('option-o2').closest('[hidden]')).not.toBeNull();
  });

  it('shows activity only when something has happened', () => {
    mocks.proposal = make();
    show();
    expect(screen.queryByRole('region', { name: proposals.activityHeading })).toBeNull();
    cleanup();

    mocks.proposal = make({ status: 'sent', sentAt: '2026-10-12T15:00:00Z' });
    show();
    const activity = within(screen.getByRole('region', { name: proposals.activityHeading }));
    expect(activity.getByText(proposals.eventsNone)).toBeInTheDocument();
  });

  it('the text message is a panel of its own', () => {
    mocks.proposal = make({ status: 'sent', sentAt: '2026-10-12T15:00:00Z', messageBody: 'Hi there' });
    show();
    expect(within(screen.getByRole('region', { name: proposals.messageHeading })).getByText('Hi there')).toBeInTheDocument();
  });
});
