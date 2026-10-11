// A value that a spreadsheet would read as a formula (or that starts with whitespace that hides one)
// gets an apostrophe in front, so opening the download cannot run it.
const FORMULA_START = /^[=+\-@\t\r]/;
const NEEDS_QUOTES = /[,"\r\n]/;

function csvValue(value: string): string {
  const guarded = FORMULA_START.test(value) ? `'${value}` : value;
  return NEEDS_QUOTES.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

/** The skipped rows of an import as an RFC 4180 CSV with CRLF line endings. */
export function skippedCsv(headers: readonly string[], rows: readonly { row: number; reason: string; cells: string[] }[]): string {
  const lines = [['Row', 'Reason', ...headers].map(csvValue).join(',')];
  for (const r of rows) {
    lines.push([String(r.row), r.reason, ...r.cells].map(csvValue).join(','));
  }
  return lines.map((line) => `${line}\r\n`).join('');
}
