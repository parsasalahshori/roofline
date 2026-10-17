import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { quote } from '../src/copy/quote.ts';
import { MeasurePage } from '../src/features/quote/MeasurePage.tsx';
import { measureLink, measurePath } from '../src/features/quote/paths.ts';

afterEach(cleanup);

describe('/q/:slug/measure (placeholder)', () => {
  it('has a route constant and a link carrying the estimate, and says it is coming', () => {
    expect(measurePath('summit-ridge')).toBe('/q/summit-ridge/measure');
    expect(measureLink('summit-ridge', 'abc 1')).toBe('/q/summit-ridge/measure?request=abc%201');
    render(<MeasurePage slug="summit-ridge" />);
    expect(screen.getByRole('heading', { name: quote.browserSoonTitle })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: quote.browserSoonBack })).toHaveAttribute('href', '/q/summit-ridge');
  });
});
