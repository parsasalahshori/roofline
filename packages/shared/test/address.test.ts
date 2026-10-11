import { expect, test } from 'vitest';
import { normalizeAddressKey, toUsStateCode, US_STATE_NAMES } from '../src/address.ts';

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

test('US_STATE_NAMES has the 50 states and DC, keyed by code', () => {
  expect(Object.keys(US_STATE_NAMES).length).toBe(51);
  expect(US_STATE_NAMES.NE).toBe('Nebraska');
  expect(US_STATE_NAMES.DC).toBe('District of Columbia');
});

test('toUsStateCode accepts a code in any case, with a trailing period or stray spaces', () => {
  expect(toUsStateCode('ne')).toBe('NE');
  expect(toUsStateCode('NE.')).toBe('NE');
  expect(toUsStateCode(' ne ')).toBe('NE');
});

test('toUsStateCode accepts a full state name in any case', () => {
  expect(toUsStateCode(' nebraska ')).toBe('NE');
  expect(toUsStateCode('Massachusetts')).toBe('MA');
  expect(toUsStateCode('district of columbia')).toBe('DC');
});

test('toUsStateCode returns null for a territory, a partial name or anything unknown', () => {
  expect(toUsStateCode('PR')).toBeNull();
  expect(toUsStateCode('Nebr')).toBeNull();
  expect(toUsStateCode('')).toBeNull();
});
