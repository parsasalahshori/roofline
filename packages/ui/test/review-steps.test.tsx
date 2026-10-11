import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ReviewSteps, type ReviewStep, type ReviewStepsProps } from '../src/index.ts';
import { copy, internal, msg, spend } from './review-fixtures.ts';

function setup(steps: ReviewStep[], props: Partial<ReviewStepsProps> = {}) {
  const handlers = {
    onToggle: vi.fn(),
    onEdit: vi.fn(),
    onRetry: vi.fn(),
    onApprove: vi.fn(),
    onNotNow: vi.fn(),
  };
  const ui = (next: ReviewStep[]) => (
    <ReviewSteps mode="review" steps={next} copy={copy} {...handlers} {...props} />
  );
  const view = render(ui(steps));
  return { ...handlers, rerender: (next: ReviewStep[]) => view.rerender(ui(next)) };
}

/** The row for a step, found by its title. */
function row(title: string): HTMLElement {
  const item = screen.getAllByRole('listitem').find((li) => within(li).queryByText(title) !== null);
  if (!item) throw new Error(`No row titled ${title}`);
  return item;
}

describe('ReviewSteps in review mode', () => {
  it('labels Approve from the summary', () => {
    setup([msg(), internal(), spend(27000)]);
    expect(
      screen.getByRole('button', { name: copy.approveButton({ count: 3, maxSpendCents: 27000, ownerSteps: 0 }) }),
    ).toBeEnabled();
  });

  it('renders an ordered list with a switch per step', () => {
    setup([msg(), internal(), spend(27000)]);
    const list = document.querySelector('ol')!;
    const items = Array.from(list.querySelectorAll<HTMLElement>(':scope > li'));
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveAttribute('data-state', 'on');
    expect(items[0]).toHaveAttribute('data-status', 'awaiting_owner');
    expect(within(items[1]).getByText('Plan the route').tagName).toBe('STRONG');
    expect(screen.getAllByRole('switch')).toHaveLength(3);
  });

  it('greys a switched-off step and leaves it out of the count', async () => {
    const user = userEvent.setup();
    const { onToggle, rerender } = setup([msg(), internal(), spend(27000)]);
    await user.click(screen.getByRole('switch', { name: copy.switchLabel('Run the ad') }));
    expect(onToggle).toHaveBeenCalledWith('spend', false);

    rerender([msg(), internal(), spend(27000, { enabled: false })]);
    expect(row('Run the ad')).toHaveAttribute('data-state', 'off');
    expect(row('Text customers')).toHaveAttribute('data-state', 'on');
    expect(
      screen.getByRole('button', { name: copy.approveButton({ count: 2, maxSpendCents: 0, ownerSteps: 0 }) }),
    ).toBeInTheDocument();
  });

  it('turns a switched-off step back on', async () => {
    const user = userEvent.setup();
    const { onToggle } = setup([internal({ enabled: false })]);
    await user.click(screen.getByRole('switch', { name: copy.switchLabel('Plan the route') }));
    expect(onToggle).toHaveBeenCalledWith('int', true);
  });

  it('tells an office user the owner approves spending', () => {
    setup([msg(), internal(), spend(27000, { canApprove: false })]);
    expect(within(row('Run the ad')).getByText(copy.ownerApprovesSpending)).toBeInTheDocument();
    expect(screen.getAllByText(copy.ownerApprovesSpending)).toHaveLength(1);
    expect(screen.getByRole('switch', { name: copy.switchLabel('Run the ad') })).toBeDisabled();
    expect(
      screen.getByRole('button', { name: copy.approveButton({ count: 2, maxSpendCents: 0, ownerSteps: 1 }) }),
    ).toBeEnabled();
  });

  it('disables Approve when nothing is on', () => {
    setup([msg({ enabled: false }), internal({ enabled: false })]);
    const approve = screen.getByRole('button', { name: copy.nothingOn });
    expect(approve).toBeDisabled();
    expect(screen.queryByRole('button', { name: /^Approve/ })).not.toBeInTheDocument();
  });

  it('keeps Approve on for an office user whose only step is the owner approval', () => {
    setup([spend(27000, { canApprove: false })]);
    expect(
      screen.getByRole('button', { name: copy.approveButton({ count: 0, maxSpendCents: 0, ownerSteps: 1 }) }),
    ).toBeEnabled();
  });

  it('wraps a 400-character message', () => {
    const long = 'wordwithoutspaces'.repeat(24).slice(0, 400);
    setup([msg({ preview: { title: 'Text customers', lines: [], messageSample: long } })]);
    const bubble = screen.getByText(long);
    expect(bubble).toHaveAttribute('data-wrap', 'anywhere');
    expect(bubble.textContent).toHaveLength(400);

    // jsdom does not apply module CSS, so check the stylesheet keys on the same attribute.
    const css = readFileSync(resolve(import.meta.dirname, '../src/components/ReviewSteps/ReviewSteps.module.css'), 'utf8');
    const rule = /\[data-wrap="anywhere"\]\s*\{([^}]*)\}/.exec(css);
    expect(rule?.[1]).toMatch(/overflow-wrap:\s*anywhere/);
    expect(rule?.[1]).toMatch(/white-space:\s*pre-wrap/);
  });

  it('shows what the step will do', () => {
    setup([msg({ preview: { ...msg().preview, maxSpendCents: 900 } })]);
    const item = row('Text customers');
    expect(within(item).getByText('Hi Dana, we are in your area this week.')).toBeInTheDocument();
    expect(within(item).getByText(copy.recipients(31))).toBeInTheDocument();
    expect(within(item).getByText(copy.sendTime('Tomorrow at 9 am'))).toBeInTheDocument();
    expect(within(item).getByText(copy.spend(900))).toBeInTheDocument();
    expect(within(item).getByText('From the shop number')).toBeInTheDocument();
  });

  it('still shows a recipient count of zero', () => {
    setup([msg({ preview: { title: 'Text customers', lines: [], recipientCount: 0 } })]);
    expect(screen.getByText(copy.recipients(0))).toBeInTheDocument();
  });

  it('offers Edit only on an editable, open step the caller can approve', async () => {
    const user = userEvent.setup();
    const { onEdit } = setup([
      msg(),
      msg({ id: 'm2', title: 'Second text', editable: false }),
      msg({ id: 'm3', title: 'Third text', open: false, status: 'done' }),
      msg({ id: 'm4', title: 'Fourth text', canApprove: false }),
    ]);
    const edits = screen.getAllByRole('button', { name: copy.edit });
    expect(edits).toHaveLength(1);
    expect(edits[0]).toHaveAttribute('data-variant', 'ghost');
    await user.click(edits[0]!);
    expect(onEdit).toHaveBeenCalledWith('msg');
  });

  it('shows no Edit button when there is no edit handler', () => {
    render(
      <ReviewSteps mode="review" steps={[msg()]} copy={copy} onToggle={vi.fn()} onApprove={vi.fn()} onNotNow={vi.fn()} />,
    );
    expect(screen.queryByRole('button', { name: copy.edit })).not.toBeInTheDocument();
  });

  it('shows the status instead of a live switch on a step that is no longer open', () => {
    setup([msg({ open: false, status: 'done' })]);
    const item = row('Text customers');
    expect(screen.getByRole('switch', { name: copy.switchLabel('Text customers') })).toBeDisabled();
    expect(within(item).getByText(copy.stepStatus('done'))).toBeInTheDocument();
    expect(item).toHaveAttribute('data-state', 'on');
    expect(item).toHaveAttribute('data-status', 'done');
  });

  it('does not show a status on a step that is still waiting', () => {
    setup([msg()]);
    expect(screen.queryByText(copy.stepStatus('awaiting_owner'))).not.toBeInTheDocument();
  });

  it('disables the switch of a step with a change on its way', () => {
    setup([msg(), internal()], { pendingStepIds: new Set(['int']) });
    expect(screen.getByRole('switch', { name: copy.switchLabel('Plan the route') })).toBeDisabled();
    expect(screen.getByRole('switch', { name: copy.switchLabel('Text customers') })).toBeEnabled();
  });

  it('picks the footer note by whether a step spends money', () => {
    const first = setup([msg()]);
    expect(screen.getByText(copy.footerNote)).toBeInTheDocument();
    expect(screen.queryByText(copy.footerNoteSpend)).not.toBeInTheDocument();
    first.rerender([msg(), spend(100, { enabled: false })]);
    expect(screen.getByText(copy.footerNoteSpend)).toBeInTheDocument();
    expect(screen.queryByText(copy.footerNote)).not.toBeInTheDocument();
  });

  it('approves and steps back through the footer buttons', async () => {
    const user = userEvent.setup();
    const { onApprove, onNotNow } = setup([msg()]);
    const notNow = screen.getByRole('button', { name: copy.notNow });
    expect(notNow).toHaveAttribute('data-variant', 'ghost');
    await user.click(notNow);
    expect(onNotNow).toHaveBeenCalledTimes(1);
    const approve = screen.getByRole('button', { name: /^Approve/ });
    expect(approve).toHaveAttribute('data-variant', 'primary');
    expect(approve).toHaveAttribute('data-size', 'lg');
    await user.click(approve);
    expect(onApprove).toHaveBeenCalledTimes(1);
  });

  it('shows Approve as busy while approving, and does not fire it twice', async () => {
    const user = userEvent.setup();
    const { onApprove } = setup([msg()], { approving: true });
    const approve = screen.getByRole('button', { name: /^Approve/ });
    expect(approve).toHaveAttribute('aria-busy', 'true');
    expect(approve).toBeDisabled();
    await user.click(approve);
    expect(onApprove).not.toHaveBeenCalled();
  });
});

describe('ReviewSteps in progress mode', () => {
  it('has no footer and no switches, and shows each step status', () => {
    setup([msg({ status: 'running', open: false }), internal({ status: 'done', open: false })], { mode: 'progress' });
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: copy.notNow })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Approve/ })).not.toBeInTheDocument();
    expect(screen.queryByText(copy.footerNote)).not.toBeInTheDocument();
    expect(within(row('Text customers')).getByText(copy.stepStatus('running'))).toBeInTheDocument();
    expect(within(row('Plan the route')).getByText(copy.stepStatus('done'))).toBeInTheDocument();
  });

  it('shows result lines, then the plain error', () => {
    setup(
      [msg({ status: 'failed', open: false, result: { sent: 29, blocked: 2 }, errorPlain: 'Two numbers had opted out.' })],
      { mode: 'progress' },
    );
    const item = row('Text customers');
    const text = item.textContent ?? '';
    expect(text.indexOf(copy.stepStatus('failed'))).toBeGreaterThan(-1);
    expect(text.indexOf('sent 29')).toBeGreaterThan(text.indexOf(copy.stepStatus('failed')));
    expect(text.indexOf('blocked 2')).toBeGreaterThan(text.indexOf('sent 29'));
    expect(text.indexOf('Two numbers had opted out.')).toBeGreaterThan(text.indexOf('blocked 2'));
  });

  it('shows that the owner has to decide when a step is awaiting the owner', () => {
    setup([spend(500, { canApprove: false, open: false })], { mode: 'progress' });
    expect(within(row('Run the ad')).getByText(copy.waitingForOwner)).toBeInTheDocument();
  });

  it('shows Retry only for failed or needs-attention steps', async () => {
    const user = userEvent.setup();
    const { onRetry } = setup(
      [
        msg({ id: 'a', title: 'Running step', status: 'running', open: false, errorPlain: 'Slow, but still going.' }),
        msg({ id: 'b', title: 'Failed step', status: 'failed', open: false, errorPlain: 'It did not send.' }),
        msg({ id: 'c', title: 'Attention step', status: 'needs_attention', open: false }),
        msg({ id: 'd', title: 'Done step', status: 'done', open: false }),
      ],
      { mode: 'progress' },
    );
    expect(within(row('Running step')).queryByRole('button', { name: copy.retry })).not.toBeInTheDocument();
    expect(within(row('Done step')).queryByRole('button', { name: copy.retry })).not.toBeInTheDocument();
    const retry = within(row('Failed step')).getByRole('button', { name: copy.retry });
    expect(retry).toHaveAttribute('data-variant', 'ghost');
    expect(within(row('Attention step')).getByRole('button', { name: copy.retry })).toBeInTheDocument();
    await user.click(retry);
    expect(onRetry).toHaveBeenCalledWith('b');
    expect(screen.getAllByRole('button', { name: copy.retry })).toHaveLength(2);
  });

  it('hides Retry from someone who cannot approve the step', () => {
    setup([msg({ status: 'failed', open: false, canApprove: false })], { mode: 'progress' });
    expect(screen.queryByRole('button', { name: copy.retry })).not.toBeInTheDocument();
  });

  it('shows no Edit button', () => {
    setup([msg({ status: 'running', open: true })], { mode: 'progress' });
    expect(screen.queryByRole('button', { name: copy.edit })).not.toBeInTheDocument();
  });
});
