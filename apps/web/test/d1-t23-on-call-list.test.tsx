import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OnCallMember } from '@roofline/shared';
import { frontDeskSettings } from '../src/copy/front-desk-settings.ts';
import { OnCallList } from '../src/features/front-desk/settings/OnCallList.tsx';

const copy = frontDeskSettings.onCall;

const members: OnCallMember[] = [
  { userId: 'u-ana', name: 'Ana', onCallOrder: 0, transferPhoneE164: '+15555550101', recordingAcknowledged: true },
  { userId: 'u-ben', name: 'Ben', onCallOrder: 1, transferPhoneE164: null, recordingAcknowledged: false },
  { userId: 'u-cy', name: 'Cy', onCallOrder: 2, transferPhoneE164: '+15555550103', recordingAcknowledged: true },
  { userId: 'u-dee', name: 'Dee', onCallOrder: null, transferPhoneE164: '+15555550104', recordingAcknowledged: true },
];

afterEach(() => {
  cleanup();
});

function rows() {
  return screen.getAllByRole('listitem');
}

describe('OnCallList', () => {
  it('lists members in the given order with their phones', () => {
    render(<OnCallList members={members} order={['u-cy', 'u-ana', 'u-ben']} onChange={vi.fn()} />);

    const items = rows();
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveTextContent('Cy');
    expect(items[0]).toHaveTextContent('(555) 555-0103');
    expect(items[1]).toHaveTextContent('Ana');
    expect(items[1]).toHaveTextContent('(555) 555-0101');
    expect(items[2]).toHaveTextContent('Ben');
    expect(items[2]).toHaveTextContent(copy.noPhone);
  });

  it('moves a row down by swapping it with the next one, and disables up on the first and down on the last', () => {
    const onChange = vi.fn();
    render(<OnCallList members={members} order={['u-ana', 'u-ben', 'u-cy']} onChange={onChange} />);

    const first = rows()[0] as HTMLElement;
    expect(within(first).getByRole('button', { name: copy.moveUp('Ana') })).toBeDisabled();
    fireEvent.click(within(first).getByRole('button', { name: copy.moveDown('Ana') }));
    expect(onChange).toHaveBeenCalledWith(['u-ben', 'u-ana', 'u-cy']);

    const last = rows()[2] as HTMLElement;
    expect(within(last).getByRole('button', { name: copy.moveDown('Cy') })).toBeDisabled();
  });

  it('moves a row up and does not mutate the order prop', () => {
    const onChange = vi.fn();
    const order = ['u-ana', 'u-ben', 'u-cy'];
    render(<OnCallList members={members} order={order} onChange={onChange} />);

    fireEvent.click(within(rows()[2] as HTMLElement).getByRole('button', { name: copy.moveUp('Cy') }));
    expect(onChange).toHaveBeenCalledWith(['u-ana', 'u-cy', 'u-ben']);
    expect(order).toEqual(['u-ana', 'u-ben', 'u-cy']);
  });

  it('takes a member off the list', () => {
    const onChange = vi.fn();
    render(<OnCallList members={members} order={['u-ana', 'u-ben', 'u-cy']} onChange={onChange} />);

    fireEvent.click(within(rows()[1] as HTMLElement).getByRole('button', { name: copy.remove('Ben') }));
    expect(onChange).toHaveBeenCalledWith(['u-ana', 'u-cy']);
  });

  it('puts an off-list member on the end of the list', () => {
    const onChange = vi.fn();
    render(<OnCallList members={members} order={['u-ana', 'u-ben']} onChange={onChange} />);

    expect(screen.getByText(copy.notOnList)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: copy.add('Dee') }));
    expect(onChange).toHaveBeenCalledWith(['u-ana', 'u-ben', 'u-dee']);
  });

  it('shows a drag handle for each row and drops a dragged row after the target', () => {
    const onChange = vi.fn();
    render(<OnCallList members={members} order={['u-ana', 'u-ben', 'u-cy']} onChange={onChange} />);

    expect(screen.getByLabelText(copy.dragHandle('Ana'))).toBeInTheDocument();
    expect(screen.getByLabelText(copy.dragHandle('Ben'))).toBeInTheDocument();
    expect(screen.getByLabelText(copy.dragHandle('Cy'))).toBeInTheDocument();

    const dataTransfer = { setData() {}, getData: () => '', effectAllowed: 'move' };
    const [rowA, , rowC] = rows();
    fireEvent.dragStart(rowA as HTMLElement, { dataTransfer });
    fireEvent.dragOver(rowC as HTMLElement, { dataTransfer });
    fireEvent.drop(rowC as HTMLElement, { dataTransfer });
    expect(onChange).toHaveBeenCalledWith(['u-ben', 'u-cy', 'u-ana']);
  });

  it('disables every control when disabled', () => {
    render(<OnCallList members={members} order={['u-ana', 'u-ben', 'u-cy']} onChange={vi.fn()} disabled />);

    const buttons = screen.getAllByRole('button');
    expect(buttons.length).toBeGreaterThan(0);
    for (const button of buttons) {
      expect(button).toBeDisabled();
    }
  });

  it('is a panel with the heading and the help line, and the people off the list under their own heading', () => {
    render(<OnCallList members={members} order={['u-ana', 'u-ben', 'u-cy']} onChange={vi.fn()} />);
    const panel = screen.getByRole('region', { name: copy.heading });
    expect(within(panel).getByText(copy.help)).toBeInTheDocument();
    expect(within(panel).getByRole('heading', { name: copy.notOnList })).toBeInTheDocument();
    // The ordered list is the three on it; the one off it is not a list item
    expect(within(panel).getAllByRole('listitem')).toHaveLength(3);
    expect(within(panel).getByText('Dee')).toBeInTheDocument();
  });

  it('shows the empty line when nobody is on the list', () => {
    render(<OnCallList members={members} order={[]} onChange={vi.fn()} />);
    expect(screen.getByText(copy.empty)).toBeInTheDocument();
  });

  it('gives the up, down and remove buttons a 40px minimum size in the stylesheet', () => {
    // The web tests run under jsdom, where import.meta.url is not a file URL, so the path comes from the working directory
    const css = readFileSync(resolve(process.cwd(), 'apps/web/src/features/front-desk/settings/OnCallList.module.css'), 'utf8');
    expect(css).toContain('min-width: 40px');
    expect(css).toContain('min-height: 40px');
  });
});
