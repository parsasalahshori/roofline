import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MiniChart } from '../src/features/agents/MiniChart.tsx';

function makeDays(n: number, f: (i: number) => number) {
  return Array.from({ length: n }, (_, i) => ({
    date: `2026-10-${String(i + 1).padStart(2, '0')}`,
    finished: f(i),
  }));
}

describe('MiniChart', () => {
  it('renders one rect and one table row per day', () => {
    const { container } = render(<MiniChart days={makeDays(14, (i) => i)} label="Chart" />);
    expect(container.querySelectorAll('rect')).toHaveLength(14);
    expect(container.querySelectorAll('tbody tr')).toHaveLength(14);
  });

  it('scales bars to the max day and never emits NaN', () => {
    const days = makeDays(14, (i) => (i === 5 ? 9 : 1));
    const { container } = render(<MiniChart days={days} label="Chart" />);
    const heights = [...container.querySelectorAll('rect')].map((r) => Number(r.getAttribute('height')));
    expect(heights.indexOf(Math.max(...heights))).toBe(5);
    const zero = render(<MiniChart days={makeDays(14, () => 0)} label="Zero" />).container;
    const zh = [...zero.querySelectorAll('rect')].map((r) => r.getAttribute('height'));
    expect(new Set(zh).size).toBe(1);
    for (const el of zero.querySelectorAll('rect, svg')) {
      for (const a of el.getAttributeNames()) expect(el.getAttribute(a)).not.toContain('NaN');
    }
  });

  it('has a caption equal to the label and date/count cells', () => {
    const { container } = render(<MiniChart days={makeDays(14, (i) => i + 20)} label="My label" />);
    expect(container.querySelector('caption')?.textContent).toBe('My label');
    const cells = [...container.querySelectorAll('tbody td, tbody th')].map((c) => c.textContent);
    expect(cells).toContain('2026-10-03');
    expect(cells).toContain('22');
  });

  it('handles empty days', () => {
    const { container } = render(<MiniChart days={[]} label="Empty" />);
    expect(container.querySelectorAll('rect')).toHaveLength(0);
    expect(container.querySelectorAll('tbody tr')).toHaveLength(0);
  });
});
