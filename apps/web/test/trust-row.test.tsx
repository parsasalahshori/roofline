import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { publicCopy } from '../src/copy/public.ts';
import { TrustRow } from '../src/features/public/TrustRow.tsx';
import { trustItems, type TrustFacts } from '../src/features/public/trust.ts';

/*
 * The trust row under the first step of the instant quote page: what the company says about itself, each fact only when
 * its own settings hold it. With fewer than two facts it is replaced by what happens at the visit. A number the company
 * did not give is never shown.
 */

const NOW = new Date('2026-10-16T12:00:00Z');
const ALL: TrustFacts = {
  rating: { value: 4.9, count: 212, source: 'Google' },
  sinceYear: 2004,
  license: { state: 'NE', number: '48213' },
};

afterEach(cleanup);

describe('trustItems', () => {
  it('lists the rating, the year and the licence, in that order, each worded from what the company gave', () => {
    expect(trustItems(ALL, NOW)).toEqual([
      { key: 'rating', value: '4.9', caption: '212 Google reviews' },
      { key: 'since', value: '2004', caption: publicCopy.sinceCaption },
      { key: 'license', value: 'NE #48213', caption: publicCopy.licenseCaption },
    ]);
  });

  it('every item is optional: any one of them can stand alone', () => {
    expect(trustItems({ rating: ALL.rating }, NOW).map((item) => item.key)).toEqual(['rating']);
    expect(trustItems({ sinceYear: 2004 }, NOW).map((item) => item.key)).toEqual(['since']);
    expect(trustItems({ license: ALL.license }, NOW).map((item) => item.key)).toEqual(['license']);
    expect(trustItems({ sinceYear: 2004, license: ALL.license }, NOW).map((item) => item.key)).toEqual(['since', 'license']);
  });

  it('nothing at all gives nothing', () => {
    expect(trustItems(undefined, NOW)).toEqual([]);
    expect(trustItems(null, NOW)).toEqual([]);
    expect(trustItems({}, NOW)).toEqual([]);
    expect(trustItems({ rating: null, sinceYear: null, license: null }, NOW)).toEqual([]);
  });

  it('says one review as one review, and a whole number of thousands with a separator', () => {
    expect(trustItems({ rating: { value: 5, count: 1, source: 'Google' } }, NOW)[0]?.caption).toBe('1 Google review');
    expect(trustItems({ rating: { value: 4.8, count: 1234, source: 'Yelp' } }, NOW)[0]).toEqual({ key: 'rating', value: '4.8', caption: '1,234 Yelp reviews' });
  });

  it('drops a fact that is incomplete or not believable instead of showing half of it', () => {
    // A rating needs its source and its count, and a value on the 1 to 5 scale
    expect(trustItems({ rating: { value: 4.9, count: 212, source: '' } }, NOW)).toEqual([]);
    expect(trustItems({ rating: { value: 4.9, count: 212, source: '   ' } }, NOW)).toEqual([]);
    expect(trustItems({ rating: { value: 4.9, count: 0, source: 'Google' } }, NOW)).toEqual([]);
    expect(trustItems({ rating: { value: 4.9, count: 2.5, source: 'Google' } }, NOW)).toEqual([]);
    expect(trustItems({ rating: { value: 0, count: 10, source: 'Google' } }, NOW)).toEqual([]);
    expect(trustItems({ rating: { value: 5.1, count: 10, source: 'Google' } }, NOW)).toEqual([]);
    expect(trustItems({ rating: { value: Number.NaN, count: 10, source: 'Google' } }, NOW)).toEqual([]);
    // A year that has not come yet, or one before 1900, is not shown
    expect(trustItems({ sinceYear: 2027 }, NOW)).toEqual([]);
    expect(trustItems({ sinceYear: 1850 }, NOW)).toEqual([]);
    expect(trustItems({ sinceYear: 2004.5 }, NOW)).toEqual([]);
    expect(trustItems({ sinceYear: 2026 }, NOW).map((item) => item.value)).toEqual(['2026']);
    // A licence needs a two-letter state and a number
    expect(trustItems({ license: { state: 'Nebraska', number: '48213' } }, NOW)).toEqual([]);
    expect(trustItems({ license: { state: 'NE', number: '' } }, NOW)).toEqual([]);
    expect(trustItems({ license: { state: 'NE', number: 'x'.repeat(25) } }, NOW)).toEqual([]);
  });

  it('tidies the licence: the state in capitals, one # in front of the number', () => {
    expect(trustItems({ license: { state: 'ne', number: ' #48213 ' } }, NOW)[0]?.value).toBe('NE #48213');
  });
});

describe('TrustRow', () => {
  it('with three facts shows them as a row, each value over its caption', () => {
    render(<TrustRow facts={ALL} now={NOW} />);
    const row = screen.getByRole('list', { name: publicCopy.trustLabel });
    const items = within(row).getAllByRole('listitem');
    expect(items.map((item) => item.textContent)).toEqual(['4.9212 Google reviews', '2004In business since', 'NE #48213Licensed']);
    expect(screen.queryByText(publicCopy.visitTitle)).toBeNull();
  });

  it('with two facts shows the two', () => {
    render(<TrustRow facts={{ sinceYear: 2004, license: ALL.license }} now={NOW} />);
    const row = screen.getByRole('list', { name: publicCopy.trustLabel });
    expect(row).toHaveAttribute('data-count', '2');
    expect(within(row).getAllByRole('listitem')).toHaveLength(2);
    expect(screen.queryByText(publicCopy.visitTitle)).toBeNull();
  });

  it('with fewer than two facts says what happens at the visit instead, and shows none of the facts', () => {
    render(<TrustRow facts={{ rating: ALL.rating }} now={NOW} />);
    // The one fact the company has is not shown on its own: the row would look thin, and the visit is what the person needs
    expect(screen.queryByRole('list', { name: publicCopy.trustLabel })).toBeNull();
    expect(screen.queryByText('4.9')).toBeNull();
    expect(screen.queryByText('212 Google reviews')).toBeNull();
    const visit = screen.getByRole('region', { name: publicCopy.visitTitle });
    expect(within(visit).getAllByRole('listitem')).toHaveLength(2);
    expect(visit).toHaveTextContent(`${publicCopy.visitChecks[0]!.lead}${publicCopy.visitChecks[0]!.rest}`);
    expect(visit).toHaveTextContent(`${publicCopy.visitChecks[1]!.lead}${publicCopy.visitChecks[1]!.rest}`);
  });

  it('with no facts at all (what the API sends today) shows the visit, and the visit states no number of its own', () => {
    render(<TrustRow />);
    const visit = screen.getByRole('region', { name: publicCopy.visitTitle });
    expect(within(visit).getAllByRole('listitem')).toHaveLength(2);
    // No "45 minutes", no "30 days": only what the company did not give would need a number
    expect(visit.textContent ?? '').not.toMatch(/\d/);
    cleanup();
    render(<TrustRow facts={null} />);
    expect(screen.getByRole('region', { name: publicCopy.visitTitle })).toBeInTheDocument();
  });

  it('a fact that is not believable does not count towards the two', () => {
    render(<TrustRow facts={{ rating: { value: 4.9, count: 0, source: 'Google' }, sinceYear: 2004 }} now={NOW} />);
    expect(screen.getByRole('region', { name: publicCopy.visitTitle })).toBeInTheDocument();
    expect(screen.queryByText('2004')).toBeNull();
  });
});
