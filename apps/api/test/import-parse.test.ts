import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { ImportFileError, parseUpload } from '../src/imports/parse.ts';

async function refusal(bytes: Buffer, name: string): Promise<string> {
  try {
    await parseUpload(bytes, name);
  } catch (err) {
    expect(err).toBeInstanceOf(ImportFileError);
    return (err as ImportFileError).message;
  }
  throw new Error('Expected parseUpload() to throw');
}

describe('parseUpload', () => {
  it('reads a CSV with a BOM, CRLF, quoted commas and trailing blank rows', async () => {
    const bytes = Buffer.from('﻿Name,Address\r\n"Lee, Ann","12 Elm St, Apt 2"\r\n\r\n,\r\n');
    const parsed = await parseUpload(bytes, 'a.csv');
    expect(parsed).toEqual({ headers: ['Name', 'Address'], rows: [['Lee, Ann', '12 Elm St, Apt 2']] });
  });

  it('reads Windows-1252 text', async () => {
    const bytes = Buffer.from([...Buffer.from('Name\r\nPe'), 0xf1, 0x61]);
    const parsed = await parseUpload(bytes, 'b.csv');
    expect(parsed.rows).toEqual([['Peña']]);
  });

  it('reads an xlsx built in the test', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Sheet1');
    ws.addRow(['Phone', 'Zip', 'Date']);
    ws.addRow([4025550144, 2134, new Date(Date.UTC(2026, 9, 11))]);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const parsed = await parseUpload(buf, 'c.XLSX');
    expect(parsed).toEqual({
      headers: ['Phone', 'Zip', 'Date'],
      rows: [['4025550144', '2134', '2026-10-11']],
    });
  });

  it('names blank headers', async () => {
    const parsed = await parseUpload(Buffer.from('Name,Phone,,Notes\r\nA,B,C,D\r\n'), 'd.csv');
    expect(parsed.headers[2]).toBe('Column 3');
  });

  it('refuses other files, empty files and more than 20,000 rows', async () => {
    expect(await refusal(Buffer.from('%PDF-1.4'), 'x.pdf')).toBe('Please upload a .csv or .xlsx file.');

    expect(await refusal(Buffer.from('Name,Phone\r\n'), 'empty.csv')).toBe('This file has no rows.');

    const lines = ['Name'];
    for (let i = 1; i <= 20_001; i++) lines.push(`n${i}`);
    expect(await refusal(Buffer.from(lines.join('\r\n')), 'big.csv')).toBe(
      'This file has more than 20,000 rows. Split it into smaller files and import each one.',
    );

    expect(await refusal(Buffer.from('not a spreadsheet'), 'g.xlsx')).toBe(
      "We couldn't read this spreadsheet. Save it as .csv and try again.",
    );
  });
});
