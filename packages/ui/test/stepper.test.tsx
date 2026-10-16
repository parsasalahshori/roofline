import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Stepper } from '../src/index.ts';

afterEach(cleanup);

const STEPS = [{ label: 'Upload' }, { label: 'Match columns' }, { label: 'Check' }, { label: 'Import' }];

function steps(current: number) {
  render(<Stepper label="Import steps" steps={STEPS} current={current} doneLabel="Done" />);
  return screen.getByRole('list', { name: 'Import steps' });
}

describe('Stepper', () => {
  it('is an ordered list of the steps, each with its mono number', () => {
    const list = steps(2);
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(4);
    // The step in progress and the ones to come show their number; a done step shows a check mark instead
    expect(within(items[1]!).getByText('2')).toBeInTheDocument();
    expect(within(items[2]!).getByText('3')).toBeInTheDocument();
    expect(within(items[3]!).getByText('4')).toBeInTheDocument();
    expect(within(items[0]!).queryByText('1')).toBeNull();
    expect(items[0]!.querySelector('svg')).not.toBeNull();
  });

  it('marks the step in progress with aria-current, and says out loud which steps are done', () => {
    const list = steps(3);
    const items = within(list).getAllByRole('listitem');
    expect(items.map((item) => item.getAttribute('aria-current'))).toEqual([null, null, 'step', null]);
    expect(items.map((item) => item.getAttribute('data-state'))).toEqual(['done', 'done', 'current', 'todo']);
    // "Done" is read after the name of a finished step, so the check mark is not the only sign
    expect(within(items[0]!).getByText('Done')).toHaveClass('visually-hidden');
    expect(within(items[1]!).getByText('Done')).toBeInTheDocument();
    expect(within(items[2]!).queryByText('Done')).toBeNull();
    expect(within(items[3]!).queryByText('Done')).toBeNull();
  });

  it('starts with nothing done, and a number past the last step means all of them are', () => {
    const first = steps(1);
    expect(within(first).getAllByRole('listitem').map((item) => item.getAttribute('data-state'))).toEqual(['current', 'todo', 'todo', 'todo']);
    cleanup();

    const finished = steps(5);
    const items = within(finished).getAllByRole('listitem');
    expect(items.map((item) => item.getAttribute('data-state'))).toEqual(['done', 'done', 'done', 'done']);
    expect(items.some((item) => item.hasAttribute('aria-current'))).toBe(false);
  });

  it('keeps the names of the steps in the page for every state', () => {
    steps(2);
    for (const step of STEPS) expect(screen.getByText(step.label)).toBeInTheDocument();
  });

  it('names the one step that keeps its name on a phone: the one in progress, or the last once all are done', () => {
    const named = (current: number) =>
      within(steps(current))
        .getAllByRole('listitem')
        .map((item) => item.hasAttribute('data-named'));

    expect(named(2)).toEqual([false, true, false, false]);
    cleanup();
    expect(named(5)).toEqual([false, false, false, true]);
  });
});
