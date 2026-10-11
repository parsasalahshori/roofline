import { expect, test } from 'vitest';
import { normalizeAddressKey } from '../src/address.ts';

test('lowercases, strips punctuation, collapses whitespace, then joins the ZIP with a bar', () => {
  expect(normalizeAddressKey('12 Oak St.', '68102')).toBe('12 oak st|68102');
  expect(normalizeAddressKey("  1234   N.  O'Brien Ave., Apt #4 ", '68102')).toBe('1234 n obrien ave apt 4|68102');
});

test('the same street address written differently gives one key', () => {
  const written = ['12 Oak St', '12 oak st.', '12  OAK   ST', ' 12 Oak St, ', '12 Oak St!'];
  expect(new Set(written.map((line) => normalizeAddressKey(line, '68102'))).size).toBe(1);
});

test('a different ZIP or a different street is a different key', () => {
  expect(normalizeAddressKey('12 Oak St', '68102')).not.toBe(normalizeAddressKey('12 Oak St', '68103'));
  expect(normalizeAddressKey('12 Oak St', '68102')).not.toBe(normalizeAddressKey('21 Oak St', '68102'));
});

test('letters and digits outside ASCII are kept', () => {
  expect(normalizeAddressKey('5 Calle Peña', '78501')).toBe('5 calle peña|78501');
});

test('an accent typed as one character or as a letter plus a combining mark gives one key', () => {
  const precomposed = normalizeAddressKey('5 Calle Pe\u00f1a', '78501');
  const combining = normalizeAddressKey('5 Calle Pen\u0303a', '78501');
  expect(combining).toBe(precomposed);
  expect(precomposed).toBe('5 calle pe\u00f1a|78501');
});

test('a ZIP with stray spaces is trimmed', () => {
  expect(normalizeAddressKey('12 Oak St', ' 68102 ')).toBe('12 oak st|68102');
});
