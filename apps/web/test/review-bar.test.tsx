import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { review } from '../src/copy/review.ts';
import { ReviewBar } from '../src/features/approvals/ReviewBar.tsx';

afterEach(cleanup);

describe('the bar that carries the decision', () => {
  const SUMMARY = { count: 3, maxSpendCents: 27000, ownerSteps: 0 };

  function bar(overrides: Partial<Parameters<typeof ReviewBar>[0]> = {}) {
    const onApprove = vi.fn();
    const onNotNow = vi.fn();
    render(<ReviewBar summary={SUMMARY} spends approving={false} notice={null} onApprove={onApprove} onNotNow={onNotNow} {...overrides} />);
    return { onApprove, onNotNow, group: screen.getByRole('group', { name: review.barLabel }) };
  }

  it('says what Approve will do, and presses it', async () => {
    const { onApprove, group } = bar();
    await userEvent.click(within(group).getByRole('button', { name: 'Approve 3 steps · up to $270' }));
    expect(onApprove).toHaveBeenCalledOnce();
  });

  it('sets the plan aside with Not now', async () => {
    const { onNotNow, group } = bar();
    await userEvent.click(within(group).getByRole('button', { name: review.notNow }));
    expect(onNotNow).toHaveBeenCalledOnce();
  });

  it('says where the money comes from only when a step spends', () => {
    const spending = bar();
    expect(within(spending.group).getByText(review.footerNoteSpend)).toBeInTheDocument();
    cleanup();
    const plain = bar({ spends: false });
    expect(within(plain.group).getByText(review.footerNote)).toBeInTheDocument();
  });

  it('cannot approve with every step switched off', () => {
    const { group } = bar({ summary: { count: 0, maxSpendCents: 0, ownerSteps: 0 } });
    expect(within(group).getByRole('button', { name: review.nothingOn })).toBeDisabled();
  });

  it('holds both buttons while the yes is on its way', () => {
    const { group } = bar({ approving: true });
    expect(within(group).getByRole('button', { name: review.notNow })).toBeDisabled();
    expect(within(group).getByRole('button', { name: /^Approve/ })).toHaveAttribute('aria-busy', 'true');
  });

  it('says a refusal as an alert and a change under the screen as a status', () => {
    bar({ notice: { tone: 'error', text: 'That step cannot change.' } });
    expect(screen.getByRole('alert')).toHaveTextContent('That step cannot change.');
    cleanup();
    bar({ notice: { tone: 'notice', text: 'The plan changed while you were looking.' } });
    expect(screen.getByRole('status')).toHaveTextContent('The plan changed while you were looking.');
  });
});
