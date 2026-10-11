import { describe, expect, it } from 'vitest';
import { autoMap, normalizeHeader } from '../src/imports/mapping.ts';

describe('autoMap', () => {
  it('maps common header spellings', () => {
    expect(
      autoMap([' Customer Name ', 'CELL', 'E-Mail', 'Street Address', 'city', 'ST', 'Zip Code', 'Notes']),
    ).toEqual({ name: 0, phone: 1, email: 2, street: 3, city: 4, state: 5, zip: 6, notes: 7 });
  });

  it('sends a second phone-like column to phone2', () => {
    expect(autoMap(['First', 'Last', 'Mobile', 'Home Phone', 'Status'])).toEqual({
      firstName: 0,
      lastName: 1,
      phone: 2,
      phone2: 3,
      stage: 4,
    });
  });

  it('leaves unknown headers unmapped', () => {
    expect(autoMap(['Favorite color', 'Name'])).toEqual({ name: 1 });
  });

  it('normalizes headers to lowercase words', () => {
    expect(normalizeHeader(' Customer Name ')).toBe('customer name');
    expect(normalizeHeader('E-Mail')).toBe('e mail');
  });
});
