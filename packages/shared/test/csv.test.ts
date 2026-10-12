import { describe, expect, it } from 'vitest';
import { csvCell, toCsv } from '../src/csv.ts';

describe('csvCell formula guard', () => {
  it.each([
    ['=SUM(A1)', "'=SUM(A1)"],
    ['+1 402', "'+1 402"],
    ['-5', "'-5"],
    ['@x', "'@x"],
    ['\tx', "'\tx"],
  ])('guards %j with a leading apostrophe', (input, expected) => {
    expect(csvCell(input)).toBe(expected);
  });

  it('guards and quotes a leading CR', () => {
    expect(csvCell('\rx')).toBe('"\'\rx"');
  });

  it('does not guard text that merely contains formula characters', () => {
    expect(csvCell('a=b')).toBe('a=b');
    expect(csvCell('x+y')).toBe('x+y');
  });
});

describe('csvCell RFC 4180 quoting', () => {
  it('quotes and doubles embedded quotes and commas', () => {
    expect(csvCell('Lee, "Ann"')).toBe('"Lee, ""Ann"""');
  });

  it('quotes text with a newline', () => {
    expect(csvCell('a\nb')).toBe('"a\nb"');
  });

  it('passes plain text through unchanged', () => {
    expect(csvCell('plain')).toBe('plain');
  });
});

describe('csvCell non-text values', () => {
  it('never guards numbers', () => {
    expect(csvCell(5)).toBe('5');
    expect(csvCell(-5)).toBe('-5');
  });

  it('writes booleans as words', () => {
    expect(csvCell(true)).toBe('true');
    expect(csvCell(false)).toBe('false');
  });

  it('writes null and undefined as empty cells', () => {
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
  });
});

describe('toCsv', () => {
  it('writes the header and rows joined with CRLF and a trailing CRLF', () => {
    expect(toCsv(['a', 'b'], [[1, 'x,y'], [null, '=1']])).toBe('a,b\r\n1,"x,y"\r\n,\'=1\r\n');
  });

  it('writes a header-only file with a trailing CRLF', () => {
    expect(toCsv(['a', 'b'], [])).toBe('a,b\r\n');
  });

  it('uses CRLF only, with no bare LF, when no cell holds a newline', () => {
    const out = toCsv(['a', 'b'], [['one', 'z'], ['q', 2]]);
    expect(out).not.toMatch(/(?<!\r)\n/);
    expect(out.endsWith('\r\n')).toBe(true);
  });

  it('passes headers through the formula guard', () => {
    expect(toCsv(['=h'], [])).toBe("'=h\r\n");
  });
});
