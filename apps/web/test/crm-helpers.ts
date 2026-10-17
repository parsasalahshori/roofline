import { screen } from '@testing-library/react';
import type userEvent from '@testing-library/user-event';

type User = ReturnType<typeof userEvent.setup>;

/**
 * Picks an option in a kit Listbox (the field variant, with its label above): opens it by its label, then clicks the
 * option by its name. The list is mounted only while it is open, so the option is awaited.
 */
export async function chooseFromListbox(user: User, label: string, option: string): Promise<void> {
  await user.click(screen.getByLabelText(label, { selector: 'button' }));
  await user.click(await screen.findByRole('option', { name: option }));
}

/** Picks an option of a filter chip: the chip is named "Label: current", and its list opens under it. */
export async function chooseChip(user: User, label: string, current: string, option: string): Promise<void> {
  await user.click(screen.getByRole('button', { name: `${label}: ${current}` }));
  await user.click(await screen.findByRole('option', { name: option }));
}
