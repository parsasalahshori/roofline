import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, expect, it } from 'vitest';
import { Dock, Window } from '../src/index.ts';
import { tokens } from '../src/tokens.ts';

afterEach(cleanup);

function luminance(hex: string) {
  const channels = hex.slice(1).match(/../g)!.map((part) => {
    const value = parseInt(part, 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
}

it('keeps normal and muted text AA on every neutral surface, and danger text AA on white', () => {
  for (const ink of [tokens.text, tokens['text-muted']]) {
    for (const surface of [tokens.bg, tokens.surface, tokens['surface-2']]) {
      expect((luminance(surface) + 0.05) / (luminance(ink) + 0.05)).toBeGreaterThanOrEqual(4.5);
    }
  }
  expect((luminance(tokens['on-danger']) + 0.05) / (luminance(tokens.danger) + 0.05)).toBeGreaterThanOrEqual(4.5);
});

it('the compact dock retains app names, count meanings, destinations and the current app', () => {
  render(<Dock label="Apps" items={[{
    key: 'front-desk', label: 'Front Desk', href: '/front-desk', icon: <svg />,
    badge: { count: 3, label: '3 unread conversations' }, current: true,
  }]} />);
  const link = screen.getByRole('link', { name: 'Front Desk 3 unread conversations' });
  expect(link).toHaveAttribute('href', '/front-desk');
  expect(link).toHaveAttribute('aria-current', 'page');
  expect(link).toHaveAttribute('data-app', 'front-desk');
  expect(link).toHaveAttribute('title', 'Front Desk');
});

it('a decorated window retains its accessible description, Escape and opener focus', async () => {
  function Harness() {
    const [open, setOpen] = useState(false);
    return <>
      <button onClick={() => setOpen(true)}>Open Front Desk</button>
      {open ? <Window title="Front Desk" titleIcon={<svg />} description="Calls and texts" closeLabel="Close" onClose={() => setOpen(false)}>
        <button>Read conversation</button>
      </Window> : null}
    </>;
  }
  render(<Harness />);
  const user = userEvent.setup();
  const opener = screen.getByRole('button', { name: 'Open Front Desk' });
  await user.click(opener);
  expect(screen.getByRole('dialog', { name: 'Front Desk' })).toHaveAccessibleDescription('Calls and texts');
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(opener).toHaveFocus();
});
