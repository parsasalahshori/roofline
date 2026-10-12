import { parse } from 'csv-parse/sync';
import ExcelJS from 'exceljs';
import { MAX_IMPORT_ROWS } from '@roofline/shared';

export type ParsedFile = { headers: string[]; rows: string[][] };

// The message is shown to the user as is.
export class ImportFileError extends Error {}

const UNSUPPORTED_MESSAGE = 'Please upload a .csv or .xlsx file.';
const NO_ROWS_MESSAGE = 'This file has no rows.';
const TOO_MANY_ROWS_MESSAGE = `This file has more than ${MAX_IMPORT_ROWS.toLocaleString('en-US')} rows. Split it into smaller files and import each one.`;
const UNREADABLE_XLSX_MESSAGE = "We couldn't read this spreadsheet. Save it as .csv and try again.";
const UNREADABLE_CSV_MESSAGE = "We couldn't read this file. Check that it is a .csv and try again.";

function decodeCsv(bytes: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

function numberToText(n: number): string {
  return Number.isInteger(n)
    ? BigInt(n).toString()
    : n.toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: 20 });
}

function cellToText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number') return numberToText(value).trim();
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return '';
    return value.toISOString().slice(0, 10);
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if (Array.isArray(obj.richText)) {
      return (obj.richText as { text?: unknown }[])
        .map((part) => (typeof part.text === 'string' ? part.text : ''))
        .join('')
        .trim();
    }
    if ('formula' in obj || 'sharedFormula' in obj) {
      return cellToText(obj.result);
    }
    if (typeof obj.text === 'string') return obj.text.trim();
  }
  return '';
}

function normalizeGrid(grid: string[][]): ParsedFile {
  const trimmed = grid.map((row) => row.map((cell) => cell.trim()));
  const isBlank = (row: string[]): boolean => row.every((cell) => cell === '');

  const headerIndex = trimmed.findIndex((row) => !isBlank(row));
  if (headerIndex === -1) {
    throw new ImportFileError(NO_ROWS_MESSAGE);
  }

  const headerRow = trimmed[headerIndex] ?? [];
  const width = headerRow.length;
  const headers = headerRow.map((cell, index) => (cell === '' ? `Column ${index + 1}` : cell));

  const rows: string[][] = [];
  for (const row of trimmed.slice(headerIndex + 1)) {
    if (isBlank(row)) continue;
    const fitted = row.slice(0, width);
    while (fitted.length < width) fitted.push('');
    rows.push(fitted);
  }

  if (rows.length === 0) {
    throw new ImportFileError(NO_ROWS_MESSAGE);
  }
  if (rows.length > MAX_IMPORT_ROWS) {
    throw new ImportFileError(TOO_MANY_ROWS_MESSAGE);
  }
  return { headers, rows };
}

function parseCsv(bytes: Buffer): string[][] {
  const text = decodeCsv(bytes);
  try {
    return parse(text, {
      bom: true,
      relax_column_count: true,
      skip_empty_lines: true,
    }) as string[][];
  } catch {
    throw new ImportFileError(UNREADABLE_CSV_MESSAGE);
  }
}

async function parseXlsx(bytes: Buffer): Promise<string[][]> {
  let worksheet: ExcelJS.Worksheet | undefined;
  try {
    const workbook = new ExcelJS.Workbook();
    // exceljs declares its own global Buffer type that shadows Node's, so cast to its parameter type.
    const data = bytes as unknown as Parameters<ExcelJS.Workbook['xlsx']['load']>[0];
    await workbook.xlsx.load(data);
    worksheet = workbook.worksheets[0];
  } catch {
    throw new ImportFileError(UNREADABLE_XLSX_MESSAGE);
  }
  if (!worksheet) {
    throw new ImportFileError(UNREADABLE_XLSX_MESSAGE);
  }

  const grid: string[][] = [];
  for (let r = 1; r <= worksheet.rowCount; r++) {
    const row = worksheet.getRow(r);
    const cells: string[] = [];
    for (let c = 1; c <= worksheet.columnCount; c++) {
      cells.push(cellToText(row.getCell(c).value));
    }
    grid.push(cells);
  }
  return grid;
}

export async function parseUpload(bytes: Buffer, fileName: string): Promise<ParsedFile> {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.csv')) {
    return normalizeGrid(parseCsv(bytes));
  }
  if (lower.endsWith('.xlsx')) {
    return normalizeGrid(await parseXlsx(bytes));
  }
  throw new ImportFileError(UNSUPPORTED_MESSAGE);
}
