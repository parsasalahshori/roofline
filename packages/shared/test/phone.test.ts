import { expect, test } from 'vitest';
import { toE164 } from '../src/phone.ts';

test.each(['(402) 555-0144', '402.555.0144', '+1 402 555 0144', '4025550144'])('%s → +14025550144', (s) => {
  expect(toE164(s)).toBe('+14025550144');
});
test.each(['555-0144', '', 'call me', '+1 000 000 0000'])('%s → null', (s) => expect(toE164(s)).toBeNull());

// Pinned in Task 10 (the Task 2 ruling): the check is the NANP shape, not libphonenumber's metadata.
test('a fictional area code is accepted: (555) 555-0144 → +15555550144', () => {
  expect(toE164('(555) 555-0144')).toBe('+15555550144');
});
test('an exchange that starts with 1 is not a US number: (402) 155-0144 → null', () => {
  expect(toE164('(402) 155-0144')).toBeNull();
});
test('a non-US country code is rejected: +44 20 7946 0958 → null', () => {
  expect(toE164('+44 20 7946 0958')).toBeNull();
});
test('eleven digits that do not start with the country code 1 are rejected: 4025550144 4 → null', () => {
  expect(toE164('4025550144 4')).toBeNull();
});
