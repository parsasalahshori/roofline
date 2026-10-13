import type { QuoteLine } from '@roofline/shared';
import { liftProposal } from '../../../copy/liftMeasure.ts';
import type { PreviewOption } from '../types.ts';

export type PanelLine = { key: string; name: string; quantity: string; cents: number };

const ADD_ON = /^addon:/;

function quantityText(line: QuoteLine): string {
  const u = liftProposal.unit;
  if (ADD_ON.test(line.code)) {
    const unit = line.unit as keyof typeof liftProposal.addOnUnit;
    return unit in liftProposal.addOnUnit ? liftProposal.addOnUnit[unit](line.quantity) : '';
  }
  switch (line.unit) {
    case 'bundle':
      return u.bundle(Math.round(line.quantity));
    case 'sq':
    case 'sq-layer':
    case 'sq-story':
      return u.sq(line.quantity);
    case 'ft':
      return u.ft(line.quantity);
    case 'sheet':
      return u.sheet(Math.round(line.quantity));
    case 'job':
      return '';
    default:
      return u.other(line.quantity, line.unit);
  }
}

/**
 * The option's lines as the panel lists them, with the markup spread over each line so the rows add up to the
 * price before tax: materials are the taxable lines, labor and fees the rest, and sales tax (when any) closes
 * the second group. The total shown is always the option's own total.
 */
export function panelLines(option: PreviewOption): { materials: PanelLine[]; labor: PanelLine[] } {
  const calc = option.calculation;
  const lines = calc.lines;
  const factor = calc.subtotalCents > 0 ? (calc.subtotalCents + calc.markupCents) / calc.subtotalCents : 1;
  const row = (line: QuoteLine): PanelLine => ({
    key: line.code,
    name: line.name,
    quantity: quantityText(line),
    cents: Math.round(line.totalCents * factor),
  });
  const materials = lines.filter((l) => l.taxable).map(row);
  const labor = lines.filter((l) => !l.taxable).map(row);
  if (calc.taxCents > 0) labor.push({ key: 'tax', name: liftProposal.tax, quantity: '', cents: calc.taxCents });
  return { materials, labor };
}

const dollars = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
/** Whole dollars, as the panel shows every price. */
export const wholeDollars = (cents: number): string => dollars.format(Math.round(cents / 100));

/** The squares line under the title: what is ordered (with the option's waste) and what was measured. */
export function squaresFor(option: PreviewOption): { ordered: number; measured: number; wastePct: number } {
  const measured = option.calculation.roofSquares;
  return { ordered: measured * (1 + option.wastePercent / 100), measured, wastePct: option.wastePercent };
}
