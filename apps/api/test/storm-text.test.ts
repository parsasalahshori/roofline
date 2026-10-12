import { describe, expect, test } from 'vitest';
import { STORM_TOKEN_IN_TEXT, stormTextRender, UNFILLED_TEXT_REASON } from '../src/messaging/storm-text.ts';

/* Storm text rendering (S1 Task 11). Pure: no database. */

const ID = '3f2c1a9e-8d4b-4c61-9a0e-5b7d2e1f4a60';
const FIELDS = { [ID]: { hail_size: '1.75"', street: '12 Elm St', day: 'yesterday' } };

describe('stormTextRender', () => {
  test('fills hail_size, street and day from the customer fields', () => {
    const render = stormTextRender('Hail up to {hail_size} hit {street} {day}.', FIELDS)!;
    expect(render(ID)).toBe('Hail up to 1.75" hit 12 Elm St yesterday.');
  });

  test('fills every occurrence of a token', () => {
    const render = stormTextRender('{street} / {street}', FIELDS)!;
    expect(render(ID)).toBe('12 Elm St / 12 Elm St');
  });

  test('leaves first_name and company for the gate request builder', () => {
    const render = stormTextRender("Hi {first_name}, it's {company}. {street}", FIELDS)!;
    expect(render(ID)).toBe("Hi {first_name}, it's {company}. 12 Elm St");
  });

  test('leaves an unknown token, and a token with no value, as written', () => {
    const render = stormTextRender('{nope} {street} {day}', { [ID]: { street: '12 Elm St' } })!;
    expect(render(ID)).toBe('{nope} 12 Elm St {day}');
  });

  test('a customer with no fields entry gets the body unchanged', () => {
    const render = stormTextRender('Hello {street}', FIELDS)!;
    expect(render('other-customer')).toBe('Hello {street}');
  });

  test('returns undefined without fields', () => {
    expect(stormTextRender('Hello {street}', undefined)).toBeUndefined();
  });

  test('a value with $& or a token in it goes in literally and is not scanned again', () => {
    const fields = { [ID]: { hail_size: 'a$&b', street: '{day}', day: 'today' } };
    const render = stormTextRender('{hail_size} | {street} | {day}', fields)!;
    expect(render(ID)).toBe('a$&b | {day} | today');
  });

  test('the key lookup falls back to the lower-case customer id', () => {
    const render = stormTextRender('{street}', { [ID]: { street: '12 Elm St' } })!;
    expect(render(ID.toUpperCase())).toBe('12 Elm St');
  });
});

describe('STORM_TOKEN_IN_TEXT', () => {
  test.each(['{street}', '{first_name}', '{company}', '{hail_size}', '{day}'])('matches %s', (token) => {
    expect(STORM_TOKEN_IN_TEXT.test(`Hello ${token} there`)).toBe(true);
  });

  test('does not match a normal sentence or an unknown brace word', () => {
    expect(STORM_TOKEN_IN_TEXT.test('Radar shows hail up to 1.75" near 12 Elm St. Reply STOP to opt out.')).toBe(false);
    expect(STORM_TOKEN_IN_TEXT.test('{other}')).toBe(false);
  });

  test('the refusal reason is plain text', () => {
    expect(UNFILLED_TEXT_REASON.length).toBeGreaterThan(0);
  });
});

describe('stormTextRender day argument', () => {
  test('a third argument overrides the day in the fields', () => {
    const render = stormTextRender('Hail {day} at {street}.', FIELDS, 'today')!;
    expect(render(ID)).toBe('Hail today at 12 Elm St.');
  });

  test('without it the fields day is kept', () => {
    const render = stormTextRender('Hail {day} at {street}.', FIELDS)!;
    expect(render(ID)).toBe('Hail yesterday at 12 Elm St.');
  });
});
