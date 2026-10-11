import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { review } from '../src/copy/review.ts';
import { EditStepSheet, type EditStepSheetProps } from '../src/features/approvals/EditStepSheet.tsx';
import { NotNowSheet, type NotNowSheetProps } from '../src/features/approvals/NotNowSheet.tsx';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderEdit(overrides: Partial<EditStepSheetProps> = {}) {
  const onSave = vi.fn<(text: string) => void>();
  const onClose = vi.fn<() => void>();
  render(
    <EditStepSheet
      fieldLabel="Message"
      initialText="Hi there"
      saving={false}
      onSave={onSave}
      onClose={onClose}
      {...overrides}
    />,
  );
  return { onSave, onClose, user: userEvent.setup() };
}

function renderNotNow(overrides: Partial<NotNowSheetProps> = {}) {
  const onConfirm = vi.fn<(reason: string) => void>();
  const onClose = vi.fn<() => void>();
  render(<NotNowSheet saving={false} onConfirm={onConfirm} onClose={onClose} {...overrides} />);
  return { onConfirm, onClose, user: userEvent.setup() };
}

describe('edit step sheet', () => {
  it('opens on the step text, labelled by the field label', () => {
    renderEdit();
    const dialog = screen.getByRole('dialog', { name: review.editTitle });
    expect(within(dialog).getByRole('textbox', { name: 'Message' })).toHaveValue('Hi there');
  });

  it('saves the text as it now stands in the field', async () => {
    const { onSave, user } = renderEdit();
    const dialog = screen.getByRole('dialog', { name: review.editTitle });
    const field = within(dialog).getByRole('textbox', { name: 'Message' });
    await user.clear(field);
    await user.type(field, 'New text');
    await user.click(within(dialog).getByRole('button', { name: review.save }));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith('New text');
  });

  it('closes without saving when cancelled', async () => {
    const { onSave, onClose, user } = renderEdit();
    const dialog = screen.getByRole('dialog', { name: review.editTitle });
    await user.click(within(dialog).getByRole('button', { name: review.cancel }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSave).not.toHaveBeenCalled();
  });

  it('shows the server sentence on the field when the text was refused', () => {
    renderEdit({ error: 'Please write the message.' });
    expect(screen.getByText('Please write the message.')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveAttribute('aria-invalid', 'true');
  });

  it('marks the save button busy while the save is on its way', () => {
    renderEdit({ saving: true });
    const dialog = screen.getByRole('dialog', { name: review.editTitle });
    expect(within(dialog).getByRole('button', { name: review.save })).toHaveAttribute('aria-busy', 'true');
  });
});

describe('not now sheet', () => {
  it('opens with an optional reason field', () => {
    renderNotNow();
    const dialog = screen.getByRole('dialog', { name: review.notNowTitle });
    expect(within(dialog).getByRole('textbox', { name: review.reasonLabel })).toHaveValue('');
  });

  it('confirms with the reason as typed', async () => {
    const { onConfirm, user } = renderNotNow();
    const dialog = screen.getByRole('dialog', { name: review.notNowTitle });
    await user.type(within(dialog).getByRole('textbox', { name: review.reasonLabel }), 'Customer called to reschedule');
    await user.click(within(dialog).getByRole('button', { name: review.notNow }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledWith('Customer called to reschedule');
  });

  it('confirms with an empty reason when nothing was typed', async () => {
    const { onConfirm, user } = renderNotNow();
    const dialog = screen.getByRole('dialog', { name: review.notNowTitle });
    await user.click(within(dialog).getByRole('button', { name: review.notNow }));
    expect(onConfirm).toHaveBeenCalledWith('');
  });

  it('allows a reason of up to 500 characters', () => {
    renderNotNow();
    const dialog = screen.getByRole('dialog', { name: review.notNowTitle });
    expect(within(dialog).getByRole('textbox', { name: review.reasonLabel })).toHaveAttribute('maxlength', '500');
  });

  it('closes without declining when cancelled', async () => {
    const { onConfirm, onClose, user } = renderNotNow();
    const dialog = screen.getByRole('dialog', { name: review.notNowTitle });
    await user.click(within(dialog).getByRole('button', { name: review.cancel }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('shows the server sentence about the reason', () => {
    renderNotNow({ error: 'That reason is too long.' });
    expect(screen.getByText('That reason is too long.')).toBeInTheDocument();
  });
});
