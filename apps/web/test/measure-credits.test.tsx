import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { liftMeasure } from '../src/copy/liftMeasure.ts';
import { Credits } from '../src/features/measure/lift/Credits.tsx';

afterEach(cleanup);

describe('Credits: the map credits in a corner', () => {
  it('keeps every credit in the page (a span each), closed until the "i" is pressed', () => {
    render(
      <Credits>
        <span>Imagery credit</span>
        <span>Footprints credit</span>
      </Credits>,
    );
    const toggle = screen.getByRole('button', { name: liftMeasure.creditsToggle });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByText('Imagery credit')).toBeInTheDocument();
    expect(screen.getByText('Footprints credit')).toBeInTheDocument();
    expect(document.querySelector('[data-credits]')).toHaveAttribute('data-open', 'false');
  });

  it('opens and closes with the "i"', () => {
    render(
      <Credits>
        <span>Imagery credit</span>
      </Credits>,
    );
    const toggle = screen.getByRole('button', { name: liftMeasure.creditsToggle });
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(document.querySelector('[data-credits]')).toHaveAttribute('data-open', 'true');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
  });
});
