import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { settings } from '../src/copy/settings.ts';
import { SaveBar } from '../src/features/settings/SaveBar.tsx';

afterEach(cleanup);

describe('save bar', () => {
  it('is not there while the form has nothing to save', () => {
    render(<SaveBar dirty={false} saving={false} saveLabel="Save" onDiscard={() => {}} />);
    expect(screen.queryByRole('group', { name: settings.saveBar.label })).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('offers Discard and the form submit while it has changes', async () => {
    const onDiscard = vi.fn();
    const onSubmit = vi.fn((event: { preventDefault: () => void }) => event.preventDefault());
    render(
      <form onSubmit={onSubmit}>
        <SaveBar dirty saving={false} saveLabel="Save prices" onDiscard={onDiscard} />
      </form>,
    );
    const user = userEvent.setup();
    expect(screen.getByRole('group', { name: settings.saveBar.label })).toHaveTextContent(settings.saveBar.unsaved);

    await user.click(screen.getByRole('button', { name: settings.saveBar.discard }));
    expect(onDiscard).toHaveBeenCalledTimes(1);

    const save = screen.getByRole('button', { name: 'Save prices' });
    expect(save).toHaveAttribute('type', 'submit');
    await user.click(save);
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('waits while a save is on its way, and when the form cannot be saved yet', () => {
    const { rerender } = render(<SaveBar dirty saving saveLabel="Save" onDiscard={() => {}} />);
    expect(screen.getByRole('button', { name: settings.saveBar.discard })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();

    rerender(<SaveBar dirty saving={false} saveLabel="Save" saveDisabled onDiscard={() => {}} />);
    expect(screen.getByRole('button', { name: settings.saveBar.discard })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });
});

describe('save bar and the column that scrolls', () => {
  function inColumn(dirty: boolean) {
    return (
      <div data-testid="column" style={{ overflowY: 'auto' }}>
        <form>
          <SaveBar dirty={dirty} saving={false} saveLabel="Save" onDiscard={() => {}} />
        </form>
      </div>
    );
  }

  it('keeps the column clear of itself while it is there, and gives the column back when it goes', () => {
    const { rerender } = render(inColumn(false));
    const column = () => screen.getByTestId('column');
    expect(column().style.getPropertyValue('scroll-padding-bottom')).toBe('');

    rerender(inColumn(true));
    expect(column().style.getPropertyValue('scroll-padding-bottom')).toMatch(/^\d+px$/);

    rerender(inColumn(false));
    expect(column().style.getPropertyValue('scroll-padding-bottom')).toBe('');
  });

  it('lifts the field that is being typed in when the bar appears over it', () => {
    const lift = vi.fn();
    // jsdom has no layout and no scrollIntoView: every box overlaps every other, and the call is recorded
    Element.prototype.scrollIntoView = lift;
    const box = { top: 0, bottom: 100, left: 0, right: 100, width: 100, height: 100, x: 0, y: 0, toJSON: () => ({}) };
    const rects = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(box);
    const withField = (dirty: boolean) => (
      <div style={{ overflowY: 'auto' }}>
        <form>
          <input aria-label="Name" />
          <SaveBar dirty={dirty} saving={false} saveLabel="Save" onDiscard={() => {}} />
        </form>
      </div>
    );
    const { rerender } = render(withField(false));
    screen.getByLabelText('Name').focus();
    expect(lift).not.toHaveBeenCalled();

    rerender(withField(true));
    expect(lift).toHaveBeenCalledWith({ block: 'nearest' });

    rects.mockRestore();
    delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  });
});
