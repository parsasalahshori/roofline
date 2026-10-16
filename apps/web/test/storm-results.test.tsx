import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { storm } from '../src/copy/storm.ts';
import { StormResults } from '../src/features/storm/StormResults.tsx';
import type { StormResultsView } from '../src/features/storm/types.ts';

const ZERO: StormResultsView = {
  textsSent: 0, textsDelivered: 0, replies: 0, yesReplies: 0, emailsSent: 0, unsubscribes: 0,
  doorsKnocked: 0, wantsCheck: 0, adSpendCents: 0, adMaxCents: 0, adClicks: 0, landingRequests: 0, inspectionsBooked: 0,
};
const FULL: StormResultsView = {
  textsSent: 40, textsDelivered: 38, replies: 6, yesReplies: 3, emailsSent: 25, unsubscribes: 1,
  doorsKnocked: 18, wantsCheck: 4, adSpendCents: 12000, adMaxCents: 27000, adClicks: 90, landingRequests: 5, inspectionsBooked: 2,
};

afterEach(cleanup);

/** The number shown beside a label. */
const valueOf = (label: string): string | null =>
  screen.getByText(label).closest('dl')?.querySelector('dd')?.textContent ?? null;

describe('StormResults', () => {
  it('shows every label with its number', () => {
    render(<StormResults results={FULL} running={false} />);
    const region = screen.getByRole('region', { name: storm.resultsHeading });
    expect(within(region).getByRole('heading', { level: 2, name: storm.resultsHeading })).toBeTruthy();
    const expected: [string, string][] = [
      [storm.textsSent, '40'], [storm.textsDelivered, '38'], [storm.replies, '6'], [storm.yesReplies, '3'],
      [storm.emailsSent, '25'], [storm.unsubscribes, '1'], [storm.doorsKnocked, '18'], [storm.wantsCheck, '4'],
      [storm.adClicks, '90'], [storm.landingRequests, '5'], [storm.inspectionsBooked, '2'],
    ];
    for (const [label, value] of expected) expect(valueOf(label)).toBe(value);
    // Counts read with their thousands separator
    cleanup();
    render(<StormResults results={{ ...FULL, textsSent: 1280 }} running={false} />);
    expect(valueOf(storm.textsSent)).toBe('1,280');
    cleanup();
    render(<StormResults results={FULL} running={false} />);
    // The spend is a tile of its own: what has gone out, and the most the ads may cost
    expect(valueOf(storm.adSpendLabel)).toBe('$120.00');
    expect(screen.getByText(storm.adSpendOf('$270.00'))).toBeTruthy();
    expect(region.getAttribute('aria-live')).toBeNull();
  });

  it('shows the empty line when nothing happened and nothing runs', () => {
    render(<StormResults results={ZERO} running={false} />);
    expect(screen.getByText(storm.resultsEmpty)).toBeTruthy();
    expect(screen.queryByTestId('storm-results-grid')).toBeNull();
  });

  it('has no results yet when only the ad budget is set: a budget is a ceiling, not a result', () => {
    render(<StormResults results={{ ...ZERO, adMaxCents: 27000 }} running={false} />);
    expect(screen.getByText(storm.resultsEmpty)).toBeTruthy();
    expect(screen.queryByTestId('storm-results-grid')).toBeNull();
  });

  it('shows zeros in a live region while the plan runs', () => {
    render(<StormResults results={ZERO} running />);
    expect(screen.queryByText(storm.resultsEmpty)).toBeNull();
    expect(screen.getByTestId('storm-results-grid')).toBeTruthy();
    expect(valueOf(storm.textsSent)).toBe('0');
    expect(screen.getByRole('region', { name: storm.resultsHeading }).getAttribute('aria-live')).toBe('polite');
  });
});
