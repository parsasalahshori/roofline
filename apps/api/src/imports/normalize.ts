import { toE164, toUsStateCode } from '@roofline/shared';
import type { ImportField, ImportMapping, JobStage, NormalizedRow, RowSkip } from '@roofline/shared';

export type { NormalizedRow, RowSkip } from '@roofline/shared';


const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const STAGE_BY_WORD: ReadonlyMap<string, JobStage> = new Map<string, JobStage>(Object.entries({
  lead: 'lead',
  new: 'lead',
  prospect: 'lead',
  inspection: 'inspection',
  inspected: 'inspection',
  appointment: 'inspection',
  proposal: 'proposal',
  estimate: 'proposal',
  quote: 'proposal',
  quoted: 'proposal',
  bid: 'proposal',
  won: 'won',
  sold: 'won',
  signed: 'won',
  'closed won': 'won',
  installed: 'installed',
  complete: 'installed',
  completed: 'installed',
  done: 'installed',
  lost: 'lost',
  'closed lost': 'lost',
  dead: 'lost',
}));

// The trimmed text of one mapped column, or '' when the field is not mapped or the cell is missing.
function cell(cells: readonly string[], mapping: ImportMapping, field: ImportField): string {
  const index = mapping[field];
  if (index === undefined) return '';
  return (cells[index] ?? '').trim();
}

export function normalizeRow(cells: readonly string[], mapping: ImportMapping): NormalizedRow | RowSkip {
  const nameCell = cell(cells, mapping, 'name');
  const firstCell = cell(cells, mapping, 'firstName');
  const lastCell = cell(cells, mapping, 'lastName');

  const displayName = nameCell !== '' ? nameCell : `${firstCell} ${lastCell}`.trim();
  if (displayName === '') return { skip: 'noName' };

  let firstName: string | null;
  let lastName: string | null;
  if (firstCell === '' && lastCell === '') {
    const words = displayName.split(/\s+/);
    firstName = words[0] ?? null;
    lastName = words.length > 1 ? words.slice(1).join(' ') : null;
  } else {
    firstName = firstCell !== '' ? firstCell : null;
    lastName = lastCell !== '' ? lastCell : null;
  }

  const phoneCells = [cell(cells, mapping, 'phone'), cell(cells, mapping, 'phone2')];
  let badPhoneFilled = false;
  const phones: string[] = [];
  for (const raw of phoneCells) {
    if (raw === '') continue;
    const e164 = toE164(raw);
    if (e164 === null) {
      badPhoneFilled = true;
      continue;
    }
    if (!phones.includes(e164)) phones.push(e164);
  }

  const emailCell = cell(cells, mapping, 'email').toLowerCase();
  const emails: string[] = EMAIL_PATTERN.test(emailCell) ? [emailCell] : [];

  if (badPhoneFilled && phones.length === 0) return { skip: 'badPhone' };
  if (phones.length === 0 && emails.length === 0) return { skip: 'noContact' };

  const street = cell(cells, mapping, 'street');
  const city = cell(cells, mapping, 'city');
  const state = normalizeState(cell(cells, mapping, 'state')) ?? '';
  const zip = normalizeZip(cell(cells, mapping, 'zip')) ?? '';
  const address =
    street !== '' && (zip !== '' || (city !== '' && state !== ''))
      ? { addressLine: street, city, state, zip }
      : null;

  const notesCell = cell(cells, mapping, 'notes');
  const notes = notesCell !== '' ? notesCell : null;
  const stage = mapping.stage === undefined ? null : normalizeStage(cell(cells, mapping, 'stage'));

  return { displayName, firstName, lastName, phones, emails, address, notes, stage };
}

// 'Nebraska' | 'ne' | 'NE.' -> 'NE'. Unknown -> null.
export function normalizeState(value: string): string | null {
  return toUsStateCode(value);
}

// The first 5-digit group ('68102-1234' -> '68102'). A 3- or 4-digit number is left-padded ('2134' -> '02134').
// Anything else -> null.
export function normalizeZip(value: string): string | null {
  const trimmed = value.trim();
  const fiveDigits = /\d{5}/.exec(trimmed);
  if (fiveDigits) return fiveDigits[0];
  const digitRun = /\d+/.exec(trimmed);
  if (digitRun && (digitRun[0].length === 3 || digitRun[0].length === 4)) {
    return digitRun[0].padStart(5, '0');
  }
  return null;
}

// Maps a spreadsheet stage word to a job stage. Blank -> null; any other unknown word -> 'lead'.
export function normalizeStage(value: string): JobStage | null {
  const word = value.trim().toLowerCase().replace(/\s+/g, ' ');
  if (word === '') return null;
  return STAGE_BY_WORD.get(word) ?? 'lead';
}
