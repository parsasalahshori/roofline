import { describe, expect, it } from 'vitest';
import { skippedCsv } from '../src/imports/skipped-csv.ts';

describe('skippedCsv', () => {
  const headers = ['Name', 'Phone'];

  it('prefixes a formula cell with an apostrophe so a spreadsheet will not run it', () => {
    const csv = skippedCsv(headers, [{ row: 2, reason: 'No name', cells: ['=SUM(A1)', ''] }]);
    expect(csv.split('\r\n')[1]).toBe("2,No name,'=SUM(A1),");
  });

  it('prefixes a leading plus sign', () => {
    const csv = skippedCsv(headers, [{ row: 3, reason: 'Bad phone number', cells: ['Ann', '+1 402'] }]);
    expect(csv.split('\r\n')[1]).toBe("3,Bad phone number,Ann,'+1 402");
  });

  it('quotes a cell with a comma and doubles its inner quotes', () => {
    const csv = skippedCsv(headers, [{ row: 4, reason: 'No name', cells: ['Lee, "Ann"', '555'] }]);
    expect(csv.split('\r\n')[1]).toBe('4,No name,"Lee, ""Ann""",555');
  });

  it('writes the Row and Reason columns before the file headers', () => {
    const csv = skippedCsv(headers, []);
    expect(csv.split('\r\n')[0]).toBe('Row,Reason,Name,Phone');
  });

  it('ends every line with CRLF and never a bare LF', () => {
    const csv = skippedCsv(headers, [
      { row: 2, reason: 'No name', cells: ['', '555'] },
      { row: 3, reason: 'No phone and no email', cells: ['Ann', ''] },
    ]);
    expect(csv.endsWith('\r\n')).toBe(true);
    expect(csv.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
    expect(csv.split('\r\n')).toHaveLength(4);
  });
});
