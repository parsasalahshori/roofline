const FORMULA_START = ['=', '+', '-', '@', '\t', '\r'] as const;
const QUOTE_TRIGGER = /[",\r\n]/;

// Formula-safe CSV cells (RFC 4180). Numbers and booleans are never guarded;
// only text that a spreadsheet would read as a formula gets a leading apostrophe.
export function csvCell(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);

  let text = value;
  if (text.length > 0 && (FORMULA_START as readonly string[]).includes(text.charAt(0))) {
    text = `'${text}`;
  }
  if (QUOTE_TRIGGER.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

// Header row and data rows joined with CRLF, with a trailing CRLF.
export function toCsv(
  headers: readonly string[],
  rows: readonly (readonly (string | number | boolean | null | undefined)[])[],
): string {
  let out = headers.map((header) => csvCell(header)).join(',') + '\r\n';
  for (const row of rows) {
    out += row.map((cell) => csvCell(cell)).join(',') + '\r\n';
  }
  return out;
}
