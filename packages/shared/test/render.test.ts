import { expect, test } from 'vitest';
import { renderBody } from '../src/render.ts';

test('replaces {first_name} and {company}', () => {
  expect(renderBody("Hi {first_name}, it's {company}.", { first_name: 'Molly', company: 'Acme Roofing' })).toBe(
    "Hi Molly, it's Acme Roofing.",
  );
});

test('replaces every occurrence, not just the first', () => {
  expect(renderBody('{company}: {first_name}, {first_name}! {company}', { first_name: 'Al', company: 'Acme' })).toBe(
    'Acme: Al, Al! Acme',
  );
});

test.each([[undefined], [''], ['   ']])('a missing or empty first name (%j) reads as "there"', (first_name) => {
  expect(renderBody('Hi {first_name}.', { ...(first_name !== undefined && { first_name }), company: 'Acme' })).toBe('Hi there.');
});

test('unknown {tokens} are left as they are, and so are tokens in other cases', () => {
  expect(renderBody('{first_name} {Company} {x} {} {first_name', { first_name: 'Al', company: 'Acme' })).toBe(
    'Al {Company} {x} {} {first_name',
  );
});

test('a replacement is never read as another token or as a replace pattern', () => {
  expect(renderBody('Hi {first_name} from {company}', { first_name: '{company}', company: '$& $1 $$' })).toBe(
    'Hi {company} from $& $1 $$',
  );
});

test('a template with no tokens comes back unchanged', () => {
  expect(renderBody('Roof check this week?', { company: 'Acme' })).toBe('Roof check this week?');
});
