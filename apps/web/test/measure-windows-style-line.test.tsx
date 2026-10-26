import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WindowsTable } from '../src/features/measure/windows/WindowsTable.tsx';
import type { WindowRow } from '../src/features/measure/windows/rows.ts';

afterEach(cleanup);

const row = (key: string, over: Partial<WindowRow>): WindowRow => ({
  key,
  kind: 'photo',
  tag: 'W1',
  first: 1,
  count: 1,
  name: 'Bathroom',
  sizeClass: 'standard',
  size: { widthIn: 36, heightIn: 48, pm: 0.125 },
  method: 'lidar',
  grade: 'quote',
  status: 'quote',
  excluded: false,
  photos: 1,
  reasons: [],
  ids: [key],
  open: null,
  was: null,
  ...over,
});

const noop = vi.fn();
const actions = { onMeasureAgain: noop, onToggle: noop, onDelete: noop, onAddPhotos: noop, estimated: { value: () => 0, onChange: noop } };

describe("the staff windows table shows a homeowner window's style choice and frosted glass", () => {
  it('names the choice the way the homeowner saw it, with the frosted flag, and shows nothing for a window with no style', () => {
    render(
      <WindowsTable
        rows={[row('a', { style: 'double-hung', frosted: true }), row('b', { name: 'Kitchen', tag: 'W2', style: 'circle' }), row('c', { name: 'Den', tag: 'W3' })]}
        selectedKey={null}
        onSelect={noop}
        actions={actions as never}
        summary="3 windows"
        covers="all-sides"
        countsOpen={false}
        onCountsOpen={noop}
      />,
    );
    const lines = document.querySelectorAll('[data-window-style]');
    expect([...lines].map((l) => l.textContent)).toEqual(['Opens up and down · Frosted glass', 'Bay, bow or odd shape']);
    expect(screen.getByText('Den').closest('td')!.querySelector('[data-window-style]')).toBeNull();
  });

  it("uses the company's own wording when it gives the choices", () => {
    render(
      <WindowsTable
        rows={[row('a', { style: 'picture' })]}
        selectedKey={null}
        onSelect={noop}
        actions={actions as never}
        summary="1 window"
        covers="all-sides"
        countsOpen={false}
        onCountsOpen={noop}
        styleTiles={[{ id: 'fixed', label: 'Stays shut', hint: '', styles: ['picture'], atVisit: false }]}
      />,
    );
    expect(document.querySelector('[data-window-style]')).toHaveTextContent('Stays shut');
  });

  it("shows the look the homeowner customized (kind, grid, color, glass) in one line, and nothing for a window without one", () => {
    render(
      <WindowsTable
        rows={[
          row('a', { name: 'Kitchen', look: { kind: 'casement', grid: 'prairie', glass: 'lowE', color: 'black' } }),
          row('b', { name: 'Den', tag: 'W2', look: { kind: 'doubleHung', grid: 'none', glass: 'clear', color: 'white' } }),
          row('c', { name: 'Hall', tag: 'W3' }),
        ]}
        selectedKey={null}
        onSelect={noop}
        actions={actions as never}
        summary="3 windows"
        covers="all-sides"
        countsOpen={false}
        onCountsOpen={noop}
      />,
    );
    const lines = document.querySelectorAll('[data-window-look]');
    expect([...lines].map((l) => l.textContent)).toEqual(['Casement · Prairie grid · Black · Low-E glass', 'Double-hung · No grid · White · Clear glass']);
    expect(screen.getByText('Hall').closest('td')!.querySelector('[data-window-look]')).toBeNull();
  });
});
