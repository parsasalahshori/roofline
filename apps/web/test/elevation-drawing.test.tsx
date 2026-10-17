import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ElevationDrawing } from '../src/features/measure/windows/ElevationDrawing.tsx';
import type { DrawnWindow } from '../src/features/measure/windows/rows.ts';

const win = (n: number): DrawnWindow => ({ rowKey: `r${n}`, tag: `W${n}`, widthIn: 60, heightIn: 60, status: 'ready', estimated: false });
const windows = (count: number) => Array.from({ length: count }, (_, i) => win(i + 1));

function draw(list: DrawnWindow[]) {
  // No layout under jsdom: the drawing keeps its default 800 x 268 box
  return render(<ElevationDrawing wallFt={31} heightFt={9} floors={1} windows={list} progress={1} selectedKey={null} onSelect={() => undefined} label="Front elevation" />);
}

describe('the front elevation', () => {
  it('draws a window that fits and names none left out', () => {
    const { container } = draw(windows(3));
    expect(container.querySelectorAll('[data-drawn-window]')).toHaveLength(3);
    expect(container.querySelector('[data-unseen-windows]')).toBeNull();
  });

  it('says how many windows did not fit, in the drawing’s lower corner and not over the house', () => {
    const { container } = draw(windows(9));
    const drawn = container.querySelectorAll('[data-drawn-window]').length;
    expect(drawn).toBeGreaterThan(0);
    expect(drawn).toBeLessThan(9);
    const note = container.querySelector('[data-unseen-windows]');
    expect(note?.textContent).toBe(`+${9 - drawn} more`);
    // Right-aligned 8px in from the right edge and 8px up from the bottom of the 800 x 268 box: the wall and its windows end well above
    expect(note?.getAttribute('x')).toBe('792');
    expect(note?.getAttribute('y')).toBe('260');
    expect(note?.getAttribute('text-anchor')).toBe('end');
  });

  it('shows no note while the scan is still drawing the house', () => {
    const { container } = render(
      <ElevationDrawing wallFt={31} heightFt={9} floors={1} windows={windows(9)} progress={0.5} selectedKey={null} onSelect={() => undefined} label="Front elevation" />,
    );
    expect(container.querySelector('[data-unseen-windows]')).toBeNull();
  });
});
