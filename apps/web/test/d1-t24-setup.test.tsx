import { cleanup, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { SetupItemView } from '@roofline/shared';
import { SetupRow } from '../src/features/setup/SetupRow.tsx';
import { setup, setupItems } from '../src/copy/setup.ts';
import { renderAt } from './helpers.tsx';

afterEach(() => {
  cleanup();
});

/** The phone number step as the server sends it while Front Desk is not yet live: status todo, comingWith front_desk. */
function phoneItem(overrides: Partial<SetupItemView> = {}): SetupItemView {
  return { key: 'phone_number', status: 'todo', comingWith: 'front_desk', skippable: false, data: {}, ...overrides };
}

/** The phone number row, rendered alone under the app providers and a memory router. */
function renderRow(item: SetupItemView, canAct: boolean) {
  return renderAt(
    <ul>
      <SetupRow item={item} canAct={canAct} />
    </ul>,
  );
}

describe('phone number setup row', () => {
  it('the owner sees a Forward your calls action to the forwarding guide, not the coming-soon chip', () => {
    renderRow(phoneItem(), true);

    const row = screen.getByText(setupItems.phone_number.title).closest('li') as HTMLElement;
    expect(within(row).queryByText('Coming with Front Desk')).toBeNull();
    expect(within(row).getByText(setup.chips.todo)).toBeInTheDocument();

    const action = within(row).getByRole('link', { name: setup.actions.forwardCalls });
    expect(action).toHaveAttribute('href', '/settings/front-desk#forwarding');
  });

  it('a non-owner sees the row without the action', () => {
    renderRow(phoneItem(), false);

    const row = screen.getByText(setupItems.phone_number.title).closest('li') as HTMLElement;
    expect(within(row).queryByRole('link', { name: setup.actions.forwardCalls })).toBeNull();
    expect(within(row).queryByText('Coming with Front Desk')).toBeNull();
  });

  it('a done phone number step shows no action', () => {
    renderRow(phoneItem({ status: 'done' }), true);

    const row = screen.getByText(setupItems.phone_number.title).closest('li') as HTMLElement;
    expect(within(row).queryByRole('link', { name: setup.actions.forwardCalls })).toBeNull();
    expect(within(row).getByText(setup.chips.done)).toBeInTheDocument();
  });
});
