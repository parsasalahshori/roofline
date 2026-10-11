import { act, fireEvent, render, renderHook, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode, useRef, useState, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  Dock,
  Sheet,
  ToastProvider,
  TopBar,
  UiLinkProvider,
  Window,
  useFocusTrap,
  useToast,
  type DockItem,
  type UiLinkProps,
} from '../src/index.ts';

/** The name of the focused element, so a Tab sequence reads as a list of names. */
function focusedName(): string {
  const active = document.activeElement;
  if (!active || active === document.body) return 'body';
  return active.getAttribute('aria-label') ?? active.textContent?.trim() ?? active.tagName;
}

/** Presses Tab (or Shift+Tab) `count` times and returns who had focus after each press. */
async function tabThrough(user: ReturnType<typeof userEvent.setup>, count: number, shift = false) {
  const seen: string[] = [];
  for (let i = 0; i < count; i += 1) {
    await (shift ? user.tab({ shift: true }) : user.tab());
    seen.push(focusedName());
  }
  return seen;
}

/** A bare trap around whatever it is given, to test which controls count as tabbable. */
function Trap({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref, { active: true });
  return (
    <div ref={ref} tabIndex={-1}>
      {children}
    </div>
  );
}

/** A page with an opener button that mounts a Window holding two buttons. */
function WindowHarness({ onClose = () => {} }: { onClose?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        opener
      </button>
      {open ? (
        <Window title="Need your OK" closeLabel="Close window" onClose={onClose}>
          <button type="button">first</button>
          <button type="button">second</button>
        </Window>
      ) : null}
    </>
  );
}

describe('Window and the focus trap', () => {
  it('traps Tab inside the window and closes on Esc', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<WindowHarness onClose={onClose} />);

    await user.click(screen.getByRole('button', { name: 'opener' }));
    const dialog = screen.getByRole('dialog', { name: 'Need your OK' });
    // Focus starts on the dialog itself, so a screen reader announces the title
    expect(dialog).toHaveFocus();

    // The close button is first in the title bar; Tab then reaches the two page buttons and wraps
    expect(await tabThrough(user, 7)).toEqual([
      'Close window',
      'first',
      'second',
      'Close window',
      'first',
      'second',
      'Close window',
    ]);
    // ...and Shift+Tab wraps the other way
    expect(await tabThrough(user, 3, true)).toEqual(['second', 'first', 'Close window']);
    expect(await tabThrough(user, 1, true)).toEqual(['second']);

    expect(onClose).not.toHaveBeenCalled();
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('behaves the same under StrictMode, where effects run twice', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <StrictMode>
        <WindowHarness onClose={onClose} />
      </StrictMode>,
    );
    const opener = screen.getByRole('button', { name: 'opener' });
    await user.click(opener);
    expect(screen.getByRole('dialog')).toHaveFocus();
    expect(await tabThrough(user, 3)).toEqual(['Close window', 'first', 'second']);
    await user.keyboard('{Escape}');
    // One listener, not two
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('wraps Shift+Tab from the dialog itself to the last control', async () => {
    const user = userEvent.setup();
    render(<WindowHarness />);
    await user.click(screen.getByRole('button', { name: 'opener' }));
    expect(screen.getByRole('dialog')).toHaveFocus();
    expect(await tabThrough(user, 1, true)).toEqual(['second']);
  });

  it('returns focus to the opener on unmount', () => {
    function Page({ open }: { open: boolean }) {
      return (
        <>
          <button type="button">opener</button>
          {open ? (
            <Window title="Need your OK" closeLabel="Close window" onClose={() => {}}>
              <button type="button">first</button>
            </Window>
          ) : null}
        </>
      );
    }
    const { rerender } = render(<Page open={false} />);
    const opener = screen.getByRole('button', { name: 'opener' });
    opener.focus();
    expect(opener).toHaveFocus();

    rerender(<Page open />);
    expect(screen.getByRole('dialog')).toHaveFocus();

    rerender(<Page open={false} />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it('labels the dialog by its title and describes it by its description', () => {
    render(
      <Window title="Need your OK" description="Three jobs wait for you." closeLabel="Close window" onClose={() => {}}>
        body
      </Window>,
    );
    const dialog = screen.getByRole('dialog', { name: 'Need your OK' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAccessibleDescription('Three jobs wait for you.');
    expect(screen.getByRole('heading', { level: 1, name: 'Need your OK' })).toBeInTheDocument();
  });

  it('has no description attribute when there is no description', () => {
    render(
      <Window title="Need your OK" closeLabel="Close window" onClose={() => {}}>
        body
      </Window>,
    );
    expect(screen.getByRole('dialog')).not.toHaveAttribute('aria-describedby');
  });

  it('defaults to the floating variant and takes the page variant', () => {
    const { rerender } = render(
      <Window title="Need your OK" closeLabel="Close window" onClose={() => {}}>
        body
      </Window>,
    );
    expect(screen.getByRole('dialog')).toHaveAttribute('data-variant', 'floating');
    rerender(
      <Window title="Need your OK" closeLabel="Close window" onClose={() => {}} variant="page">
        body
      </Window>,
    );
    expect(screen.getByRole('dialog')).toHaveAttribute('data-variant', 'page');
  });

  it('closes from the close button', async () => {
    const onClose = vi.fn();
    render(
      <Window title="Need your OK" closeLabel="Close window" onClose={onClose}>
        body
      </Window>,
    );
    await userEvent.setup().click(screen.getByRole('button', { name: 'Close window' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('shows the stats, the body and the footer', () => {
    render(
      <Window
        title="Need your OK"
        closeLabel="Close window"
        onClose={() => {}}
        stats={<p>12 open jobs</p>}
        footer={<button type="button">Send all</button>}
      >
        <p>The list</p>
      </Window>,
    );
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('12 open jobs')).toBeInTheDocument();
    expect(within(dialog).getByText('The list')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Send all' })).toBeInTheDocument();
  });

  it('keeps the page behind clickable and reachable: nothing outside is made inert', async () => {
    const user = userEvent.setup();
    const onOutside = vi.fn();
    render(
      <>
        <button type="button" onClick={onOutside}>
          outside
        </button>
        <Window title="Need your OK" closeLabel="Close window" onClose={() => {}}>
          <button type="button">first</button>
        </Window>
      </>,
    );
    const outside = screen.getByRole('button', { name: 'outside' });
    await user.click(outside);
    expect(onOutside).toHaveBeenCalledTimes(1);
    expect(outside).not.toHaveAttribute('inert');
    expect(outside).not.toHaveAttribute('aria-hidden');
    expect(outside.parentElement).not.toHaveAttribute('inert');
  });

  it('pulls focus back in when Tab is pressed from outside the window', async () => {
    const user = userEvent.setup();
    render(
      <>
        <button type="button">outside</button>
        <Window title="Need your OK" closeLabel="Close window" onClose={() => {}}>
          <button type="button">first</button>
        </Window>
      </>,
    );
    await user.click(screen.getByRole('button', { name: 'outside' }));
    expect(focusedName()).toBe('outside');
    expect(await tabThrough(user, 1)).toEqual(['Close window']);

    await user.click(screen.getByRole('button', { name: 'outside' }));
    expect(await tabThrough(user, 1, true)).toEqual(['first']);
  });

  it('wraps at the first and last control that can really be reached', async () => {
    const user = userEvent.setup();
    // Around the real controls sit ones Tab cannot reach: they must not count as the first or the last
    const unreachable = (
      <>
        <button type="button" disabled>
          disabled
        </button>
        <button type="button" tabIndex={-1}>
          skipped
        </button>
        <div hidden>
          <button type="button">in hidden</button>
        </div>
        <div inert>
          <button type="button">in inert</button>
        </div>
        <div aria-hidden="true">
          <button type="button">in aria-hidden</button>
        </div>
        <div style={{ display: 'none' }}>
          <button type="button">in display none</button>
        </div>
        <button type="button" style={{ visibility: 'hidden' }}>
          invisible
        </button>
        <fieldset disabled>
          <button type="button">in disabled fieldset</button>
        </fieldset>
        <input type="hidden" />
        <a>no href</a>
      </>
    );
    render(
      <Trap>
        {unreachable}
        <button type="button">real first</button>
        <a href="/jobs">link</a>
        <input aria-label="name" />
        <select aria-label="size">
          <option>one</option>
        </select>
        <textarea aria-label="notes" />
        <div contentEditable suppressContentEditableWarning aria-label="editable" />
        <span tabIndex={0} aria-label="focusable span" />
        <button type="button">real last</button>
        {unreachable}
      </Trap>,
    );
    screen.getByRole('button', { name: 'real first' }).focus();
    expect(await tabThrough(user, 7)).toEqual([
      'link',
      'name',
      'size',
      'notes',
      'editable',
      'focusable span',
      'real last',
    ]);
    // Past the last real control, Tab goes to the first real one; Shift+Tab goes back the other way
    expect(await tabThrough(user, 1)).toEqual(['real first']);
    expect(await tabThrough(user, 1, true)).toEqual(['real last']);
  });


  it('keeps focus in the window when it has nothing to tab to', async () => {
    const user = userEvent.setup();
    render(
      <Window title="Need your OK" closeLabel="Close window" onClose={() => {}}>
        <p>read only</p>
      </Window>,
    );
    // Only the close button is tabbable: Tab and Shift+Tab stay on it
    expect(await tabThrough(user, 2)).toEqual(['Close window', 'Close window']);
    expect(await tabThrough(user, 1, true)).toEqual(['Close window']);
  });

  it('does not steal focus on unmount when the opener is gone', () => {
    function Page({ withOpener, open }: { withOpener: boolean; open: boolean }) {
      return (
        <>
          {withOpener ? <button type="button">opener</button> : null}
          {open ? (
            <Window title="Need your OK" closeLabel="Close window" onClose={() => {}}>
              body
            </Window>
          ) : null}
        </>
      );
    }
    const { rerender } = render(<Page withOpener open={false} />);
    screen.getByRole('button', { name: 'opener' }).focus();
    rerender(<Page withOpener open />);
    // The opener leaves the page while the window is open, then the window closes
    rerender(<Page withOpener={false} open />);
    rerender(<Page withOpener={false} open={false} />);
    expect(document.body).toHaveFocus();
  });
});

describe('useFocusTrap', () => {
  function Probe({
    active,
    onEscape,
    withInitial = false,
  }: {
    active: boolean;
    onEscape?: () => void;
    withInitial?: boolean;
  }) {
    const ref = useRef<HTMLDivElement>(null);
    const initial = useRef<HTMLInputElement>(null);
    useFocusTrap(ref, { active, onEscape, initialFocus: withInitial ? initial : undefined });
    return (
      <div ref={ref} tabIndex={-1} data-testid="trap">
        <button type="button">before</button>
        <input ref={initial} aria-label="name" />
      </div>
    );
  }

  it('focuses initialFocus when given, the container otherwise', () => {
    const { unmount } = render(<Probe active withInitial />);
    expect(screen.getByRole('textbox', { name: 'name' })).toHaveFocus();
    unmount();
    render(<Probe active />);
    expect(screen.getByTestId('trap')).toHaveFocus();
  });

  it('does nothing while inactive, then traps and restores focus when toggled', async () => {
    const user = userEvent.setup();
    const onEscape = vi.fn();
    function Page({ active }: { active: boolean }) {
      return (
        <>
          <button type="button">opener</button>
          <Probe active={active} onEscape={onEscape} />
        </>
      );
    }
    const { rerender } = render(<Page active={false} />);
    const opener = screen.getByRole('button', { name: 'opener' });
    opener.focus();

    await user.keyboard('{Escape}');
    expect(onEscape).not.toHaveBeenCalled();
    expect(opener).toHaveFocus();

    rerender(<Page active />);
    expect(screen.getByTestId('trap')).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(onEscape).toHaveBeenCalledTimes(1);

    rerender(<Page active={false} />);
    expect(opener).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(onEscape).toHaveBeenCalledTimes(1);
  });

  it('calls the latest onEscape without re-trapping', async () => {
    const user = userEvent.setup();
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = render(<Probe active onEscape={first} />);
    const trap = screen.getByTestId('trap');
    rerender(<Probe active onEscape={second} />);
    expect(trap).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('leaves an Esc that something inside already handled alone', () => {
    const onEscape = vi.fn();
    render(<Probe active onEscape={onEscape} />);
    const input = screen.getByRole('textbox', { name: 'name' });
    input.addEventListener('keydown', (event) => event.preventDefault());
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onEscape).not.toHaveBeenCalled();
  });

  it('returns nothing and tolerates a missing container', () => {
    const { result } = renderHook(() => {
      const ref = useRef<HTMLElement>(null);
      return useFocusTrap(ref, { active: true });
    });
    expect(result.current).toBeUndefined();
  });
});

describe('Sheet', () => {
  it('renders nothing when closed', () => {
    render(
      <Sheet open={false} title="Edit job" closeLabel="Close sheet" onClose={() => {}}>
        body
      </Sheet>,
    );
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByText('body')).toBeNull();
  });

  it('is a modal dialog named by its title, with a close button, body and footer', async () => {
    const onClose = vi.fn();
    render(
      <Sheet
        open
        title="Edit job"
        closeLabel="Close sheet"
        onClose={onClose}
        footer={<button type="button">Save</button>}
      >
        <p>fields</p>
      </Sheet>,
    );
    const dialog = screen.getByRole('dialog', { name: 'Edit job' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(within(dialog).getByRole('heading', { level: 2, name: 'Edit job' })).toBeInTheDocument();
    expect(within(dialog).getByText('fields')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeInTheDocument();
    await userEvent.setup().click(within(dialog).getByRole('button', { name: 'Close sheet' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('traps Tab, closes on Esc and returns focus to the opener', async () => {
    const user = userEvent.setup();
    function Page() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            opener
          </button>
          <Sheet open={open} title="Edit job" closeLabel="Close sheet" onClose={() => setOpen(false)}>
            <button type="button">first</button>
          </Sheet>
        </>
      );
    }
    render(<Page />);
    const opener = screen.getByRole('button', { name: 'opener' });
    await user.click(opener);
    expect(screen.getByRole('dialog', { name: 'Edit job' })).toHaveFocus();
    expect(await tabThrough(user, 3)).toEqual(['Close sheet', 'first', 'Close sheet']);

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(opener).toHaveFocus();
  });

  it('is portaled into the body, outside the markup of the window it is rendered from', () => {
    const { container } = render(
      <Window title="Need your OK" closeLabel="Close window" onClose={() => {}}>
        <Sheet open title="Edit job" closeLabel="Close sheet" onClose={() => {}}>
          body
        </Sheet>
      </Window>,
    );
    const sheet = screen.getByRole('dialog', { name: 'Edit job' });
    const window = screen.getByRole('dialog', { name: 'Need your OK' });
    expect(sheet.parentElement).toBe(document.body);
    expect(container).not.toContainElement(sheet);
    expect(window).not.toContainElement(sheet);
  });

  describe('over a window', () => {
    function Stack({ sheetOpenAtStart, onWindowClose, onSheetClose }: {
      sheetOpenAtStart: boolean;
      onWindowClose: () => void;
      onSheetClose: () => void;
    }) {
      const [sheetOpen, setSheetOpen] = useState(sheetOpenAtStart);
      return (
        <Window title="Need your OK" closeLabel="Close window" onClose={onWindowClose}>
          <button type="button" onClick={() => setSheetOpen(true)}>
            open sheet
          </button>
          <Sheet
            open={sheetOpen}
            title="Edit job"
            closeLabel="Close sheet"
            onClose={() => {
              onSheetClose();
              setSheetOpen(false);
            }}
          >
            <button type="button">in sheet</button>
          </Sheet>
        </Window>
      );
    }

    it('closes only the sheet on Esc, then the window on the next Esc', async () => {
      const user = userEvent.setup();
      const onWindowClose = vi.fn();
      const onSheetClose = vi.fn();
      render(<Stack sheetOpenAtStart={false} onWindowClose={onWindowClose} onSheetClose={onSheetClose} />);

      const trigger = screen.getByRole('button', { name: 'open sheet' });
      await user.click(trigger);
      expect(screen.getByRole('dialog', { name: 'Edit job' })).toHaveFocus();

      await user.keyboard('{Escape}');
      expect(onSheetClose).toHaveBeenCalledTimes(1);
      expect(onWindowClose).not.toHaveBeenCalled();
      expect(screen.queryByRole('dialog', { name: 'Edit job' })).toBeNull();
      // Focus is back on the control that opened the sheet, inside the window
      expect(trigger).toHaveFocus();

      await user.keyboard('{Escape}');
      expect(onWindowClose).toHaveBeenCalledTimes(1);
      expect(onSheetClose).toHaveBeenCalledTimes(1);
    });

    it('lets the sheet, not the window, handle Esc and Tab when both mount together', async () => {
      const user = userEvent.setup();
      const onWindowClose = vi.fn();
      const onSheetClose = vi.fn();
      render(<Stack sheetOpenAtStart onWindowClose={onWindowClose} onSheetClose={onSheetClose} />);

      // A parent's effects run after its children's, so the window activates last. The sheet still wins,
      // and it keeps the focus the window's own start would otherwise have taken.
      expect(screen.getByRole('dialog', { name: 'Edit job' })).toHaveFocus();
      expect(await tabThrough(user, 1)).toEqual(['Close sheet']);
      expect(await tabThrough(user, 2)).toEqual(['in sheet', 'Close sheet']);

      await user.keyboard('{Escape}');
      expect(onSheetClose).toHaveBeenCalledTimes(1);
      expect(onWindowClose).not.toHaveBeenCalled();
    });

    /** A page with a real opener and a Window holding an open Sheet, so both can mount and unmount in one render. */
    function Together({ open, sheetOpen = true }: { open: boolean; sheetOpen?: boolean }) {
      return (
        <>
          <button type="button">page opener</button>
          {open ? (
            <Window title="Need your OK" closeLabel="Close window" onClose={() => {}}>
              <Sheet open={sheetOpen} title="Edit job" closeLabel="Close sheet" onClose={() => {}}>
                <button type="button">in sheet</button>
              </Sheet>
            </Window>
          ) : null}
        </>
      );
    }

    it.each([
      ['', (children: ReactNode) => children],
      [' under StrictMode', (children: ReactNode) => <StrictMode>{children}</StrictMode>],
    ])('starts on the sheet and restores to the real opener when both mount together%s', (_name, wrap) => {
      const { rerender } = render(wrap(<Together open={false} />));
      const opener = screen.getByRole('button', { name: 'page opener' });
      opener.focus();

      rerender(wrap(<Together open />));
      expect(screen.getByRole('dialog', { name: 'Edit job' })).toHaveFocus();

      // Both go at once: the window's opener is the real one, not the sheet that was on top of it
      rerender(wrap(<Together open={false} />));
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(opener).toHaveFocus();
    });

    it('returns focus into the window when only the sheet closes, then to the real opener', () => {
      const { rerender } = render(<Together open={false} />);
      const opener = screen.getByRole('button', { name: 'page opener' });
      opener.focus();

      rerender(<Together open />);
      expect(screen.getByRole('dialog', { name: 'Edit job' })).toHaveFocus();

      rerender(<Together open sheetOpen={false} />);
      expect(screen.queryByRole('dialog', { name: 'Edit job' })).toBeNull();
      expect(screen.getByRole('dialog', { name: 'Need your OK' })).toHaveFocus();

      rerender(<Together open={false} />);
      expect(opener).toHaveFocus();
    });

    it('gives the keys back to the window once a sheet that mounted with it closes', async () => {
      const user = userEvent.setup();
      const onWindowClose = vi.fn();
      function Page({ sheetOpen }: { sheetOpen: boolean }) {
        return (
          <Window title="Need your OK" closeLabel="Close window" onClose={onWindowClose}>
            <button type="button">first</button>
            <Sheet open={sheetOpen} title="Edit job" closeLabel="Close sheet" onClose={() => {}}>
              body
            </Sheet>
          </Window>
        );
      }
      const { rerender } = render(<Page sheetOpen />);
      rerender(<Page sheetOpen={false} />);
      expect(await tabThrough(user, 3)).toEqual(['Close window', 'first', 'Close window']);
      await user.keyboard('{Escape}');
      expect(onWindowClose).toHaveBeenCalledTimes(1);
    });

    it('keeps Tab inside the sheet while it is open', async () => {
      const user = userEvent.setup();
      render(<Stack sheetOpenAtStart={false} onWindowClose={() => {}} onSheetClose={() => {}} />);
      await user.click(screen.getByRole('button', { name: 'open sheet' }));
      const seen = await tabThrough(user, 5);
      expect(seen).toEqual(['Close sheet', 'in sheet', 'Close sheet', 'in sheet', 'Close sheet']);
      expect(seen).not.toContain('open sheet');
      expect(seen).not.toContain('Close window');
    });
  });
});

const ITEMS: DockItem[] = [
  { key: 'jobs', label: 'Jobs', href: '/jobs', icon: <svg data-testid="icon-jobs" />, current: true },
  { key: 'customers', label: 'Customers', href: '/customers', icon: <svg /> },
  {
    key: 'inbox',
    label: 'Inbox',
    href: '/inbox',
    icon: <svg />,
    badge: { count: 3, label: '3 unread messages' },
  },
  { key: 'calendar', label: 'Calendar', href: '/calendar', icon: <svg /> },
  { key: 'money', label: 'Money', href: '/money', icon: <svg /> },
  { key: 'reports', label: 'Reports', href: '/reports', icon: <svg />, comingSoon: 'Coming soon' },
];

describe('Dock', () => {
  it('keeps dock labels visible and marks the current app', () => {
    render(<Dock label="Apps" items={ITEMS} />);
    const nav = screen.getByRole('navigation', { name: 'Apps' });
    const links = within(nav).getAllByRole('link');
    expect(links).toHaveLength(6);

    for (const item of ITEMS) {
      expect(within(nav).getByText(item.label)).toBeVisible();
    }

    const current = within(nav).getByRole('link', { name: /^Jobs/ });
    expect(current).toHaveAttribute('aria-current', 'page');
    expect(current).toHaveAttribute('href', '/jobs');
    expect(links.filter((link) => link.hasAttribute('aria-current'))).toEqual([current]);

    const soon = within(nav).getByRole('link', { name: /^Reports/ });
    expect(soon).toHaveAttribute('data-state', 'soon');
    expect(soon).toHaveAttribute('title', 'Coming soon');
    // Still a working link, with the note available to a screen reader after the label
    expect(soon).toHaveAttribute('href', '/reports');
    expect(soon).toHaveAccessibleName('Reports Coming soon');
    expect(links.filter((link) => link.getAttribute('data-state') === 'soon')).toEqual([soon]);
  });

  it('lists the items in a list', () => {
    render(<Dock label="Apps" items={ITEMS} />);
    const list = within(screen.getByRole('navigation')).getByRole('list');
    expect(within(list).getAllByRole('listitem')).toHaveLength(6);
  });

  it('shows a badge with its own label, and none at zero', () => {
    render(<Dock label="Apps" items={ITEMS} />);
    expect(screen.getByRole('img', { name: '3 unread messages' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Inbox 3 unread messages' })).toBeInTheDocument();
  });

  it('draws no badge when the count is zero', () => {
    const items: DockItem[] = [
      { key: 'inbox', label: 'Inbox', href: '/inbox', icon: <svg />, badge: { count: 0, label: 'No unread messages' } },
    ];
    render(<Dock label="Apps" items={items} />);
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('hides the icon from assistive tech', () => {
    render(<Dock label="Apps" items={ITEMS} />);
    expect(screen.getByTestId('icon-jobs').closest('[aria-hidden="true"]')).not.toBeNull();
  });

  it('draws its links through the provided link component', () => {
    function RouterLink(props: UiLinkProps) {
      return <a {...props} data-provided="yes" />;
    }
    render(
      <UiLinkProvider component={RouterLink}>
        <Dock label="Apps" items={ITEMS} />
      </UiLinkProvider>,
    );
    for (const link of screen.getAllByRole('link')) {
      expect(link).toHaveAttribute('data-provided', 'yes');
    }
  });

  it('is reachable by keyboard', async () => {
    const user = userEvent.setup();
    render(<Dock label="Apps" items={ITEMS} />);
    expect(await tabThrough(user, 2)).toEqual(['Jobs', 'Customers']);
  });
});

describe('TopBar', () => {
  it('is a header with start, middle and end slots', () => {
    render(<TopBar start={<span>logo</span>} middle={<span>search</span>} end={<span>me</span>} />);
    const header = screen.getByRole('banner');
    expect(header.tagName).toBe('HEADER');
    for (const [slot, text] of [
      ['start', 'logo'],
      ['middle', 'search'],
      ['end', 'me'],
    ] as const) {
      const container = header.querySelector(`[data-slot="${slot}"]`);
      expect(container).not.toBeNull();
      expect(within(container as HTMLElement).getByText(text)).toBeInTheDocument();
    }
  });

  it('keeps the middle and end slots when only the start is given', () => {
    render(<TopBar start={<span>logo</span>} />);
    const header = screen.getByRole('banner');
    expect(header.querySelector('[data-slot="middle"]')).toBeEmptyDOMElement();
    expect(header.querySelector('[data-slot="end"]')).toBeEmptyDOMElement();
  });
});

describe('Toast', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function Shower({ message, tone }: { message: string; tone?: 'info' | 'success' | 'error' }) {
    const toast = useToast();
    return (
      <button type="button" onClick={() => toast.show(message, tone)}>
        show {message}
      </button>
    );
  }

  function renderToasts(children: ReactNode) {
    return render(<ToastProvider closeLabel="Dismiss">{children}</ToastProvider>);
  }

  it('announces errors as alerts and others as status', () => {
    renderToasts(
      <>
        <Shower message="Saved" tone="success" />
        <Shower message="Heads up" />
        <Shower message="Could not send" tone="error" />
      </>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'show Saved' }));
    fireEvent.click(screen.getByRole('button', { name: 'show Heads up' }));
    fireEvent.click(screen.getByRole('button', { name: 'show Could not send' }));

    const status = screen.getByRole('status');
    const alert = screen.getByRole('alert');
    expect(status).toHaveTextContent('Saved');
    expect(status).toHaveTextContent('Heads up');
    expect(status).not.toHaveTextContent('Could not send');
    expect(alert).toHaveTextContent('Could not send');
    expect(alert).not.toHaveTextContent('Saved');
  });

  it('renders the live regions from the start, empty, so insertions are announced', () => {
    renderToasts(<p>page</p>);
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
    expect(screen.getByRole('alert')).toBeEmptyDOMElement();
  });

  it('marks each toast with its tone and defaults to info', () => {
    renderToasts(
      <>
        <Shower message="Plain" />
        <Shower message="Saved" tone="success" />
        <Shower message="Failed" tone="error" />
      </>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'show Plain' }));
    fireEvent.click(screen.getByRole('button', { name: 'show Saved' }));
    fireEvent.click(screen.getByRole('button', { name: 'show Failed' }));
    expect(screen.getByText('Plain').closest('[data-tone]')).toHaveAttribute('data-tone', 'info');
    expect(screen.getByText('Saved').closest('[data-tone]')).toHaveAttribute('data-tone', 'success');
    expect(screen.getByText('Failed').closest('[data-tone]')).toHaveAttribute('data-tone', 'error');
  });

  it('dismisses a toast after 6 seconds', () => {
    vi.useFakeTimers();
    renderToasts(<Shower message="Saved" tone="success" />);
    fireEvent.click(screen.getByRole('button', { name: 'show Saved' }));
    expect(screen.getByRole('status')).toHaveTextContent('Saved');

    act(() => {
      vi.advanceTimersByTime(5999);
    });
    expect(screen.getByRole('status')).toHaveTextContent('Saved');
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
  });

  it('does not stack the same message twice, and restarts its timer', () => {
    vi.useFakeTimers();
    renderToasts(<Shower message="Saved" tone="success" />);
    const show = screen.getByRole('button', { name: 'show Saved' });
    fireEvent.click(show);
    act(() => {
      vi.advanceTimersByTime(4000);
    });
    fireEvent.click(show);
    expect(within(screen.getByRole('status')).getAllByText('Saved')).toHaveLength(1);

    // 4s + 4s is past the first timer's 6s; the restarted one runs until 4s + 6s
    act(() => {
      vi.advanceTimersByTime(4000);
    });
    expect(screen.getByRole('status')).toHaveTextContent('Saved');
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
  });

  it('stacks different messages, each on its own timer', () => {
    vi.useFakeTimers();
    renderToasts(
      <>
        <Shower message="One" />
        <Shower message="Two" />
      </>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'show One' }));
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    fireEvent.click(screen.getByRole('button', { name: 'show Two' }));
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('One');
    expect(status).toHaveTextContent('Two');

    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(status).not.toHaveTextContent('One');
    expect(status).toHaveTextContent('Two');
  });

  it('closes a toast from its close button and cancels its timer', () => {
    vi.useFakeTimers();
    renderToasts(<Shower message="Saved" tone="success" />);
    fireEvent.click(screen.getByRole('button', { name: 'show Saved' }));
    fireEvent.click(within(screen.getByRole('status')).getByRole('button', { name: 'Dismiss' }));
    expect(screen.getByRole('status')).toBeEmptyDOMElement();

    // Showing it again after a close starts fresh: a stale timer must not cut it short
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    fireEvent.click(screen.getByRole('button', { name: 'show Saved' }));
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.getByRole('status')).toHaveTextContent('Saved');
  });

  it('gives an error its own close button inside the alert region', () => {
    renderToasts(<Shower message="Could not send" tone="error" />);
    fireEvent.click(screen.getByRole('button', { name: 'show Could not send' }));
    const alert = screen.getByRole('alert');
    fireEvent.click(within(alert).getByRole('button', { name: 'Dismiss' }));
    expect(alert).toBeEmptyDOMElement();
  });

  it('moves a repeated message to the alert region when it comes back as an error', () => {
    function Both() {
      const toast = useToast();
      return (
        <>
          <button type="button" onClick={() => toast.show('Try again')}>
            info
          </button>
          <button type="button" onClick={() => toast.show('Try again', 'error')}>
            error
          </button>
        </>
      );
    }
    renderToasts(<Both />);
    fireEvent.click(screen.getByRole('button', { name: 'info' }));
    fireEvent.click(screen.getByRole('button', { name: 'error' }));
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
    expect(screen.getByRole('alert')).toHaveTextContent('Try again');
  });

  it('keeps show stable between renders', () => {
    const seen: Array<ReturnType<typeof useToast>['show']> = [];
    function Spy() {
      seen.push(useToast().show);
      return null;
    }
    const { rerender } = renderToasts(<Spy />);
    rerender(
      <ToastProvider closeLabel="Dismiss">
        <Spy />
      </ToastProvider>,
    );
    expect(seen.length).toBeGreaterThan(1);
    expect(new Set(seen).size).toBe(1);
  });

  it('clears its timers when the provider unmounts', () => {
    vi.useFakeTimers();
    const { unmount } = renderToasts(<Shower message="Saved" tone="success" />);
    fireEvent.click(screen.getByRole('button', { name: 'show Saved' }));
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('throws a clear error when used without a provider', () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    function Orphan() {
      useToast();
      return null;
    }
    expect(() => render(<Orphan />)).toThrow(/ToastProvider/);
    quiet.mockRestore();
  });
});
