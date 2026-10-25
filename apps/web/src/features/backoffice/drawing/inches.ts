import { fractionInches } from '@roofline/shared';

/** Sizes snap to eighths of an inch (a window shop's smallest step). */
export const EIGHTH_IN = 0.125;

/** The nearest 1/8 in. */
export const snapEighth = (inches: number): number => Math.round(inches * 8) / 8;

/** "35 1/2" -> "35 1/2"; 35.5 -> "35 1/2". */
export const formatInches = (inches: number): string => fractionInches(snapEighth(inches));

const PLAIN = /^(\d+(?:\.\d+)?)(?:[\s-]+(\d+)\/(\d+))?$/;
const FRACTION_ONLY = /^(\d+)\/(\d+)$/;

/**
 * A size a person types, in inches, snapped to 1/8: "35", "35.5", "35 1/2", "35-1/2", "1/2", "35 1/2\"", "35 1/2 in".
 * null when it is not a size (or is zero or negative).
 */
export function parseInches(text: string): number | null {
  const cleaned = text
    .trim()
    .replace(/\s*(?:inches|inch|in|")\s*$/i, '')
    .trim();
  let value: number;
  const fractionOnly = FRACTION_ONLY.exec(cleaned);
  const plain = PLAIN.exec(cleaned);
  if (fractionOnly) {
    const den = Number(fractionOnly[2]);
    if (den === 0) return null;
    value = Number(fractionOnly[1]) / den;
  } else if (plain) {
    value = Number(plain[1]);
    if (plain[2] !== undefined && plain[3] !== undefined) {
      const den = Number(plain[3]);
      if (den === 0) return null;
      value += Number(plain[2]) / den;
    }
  } else {
    return null;
  }
  const snapped = snapEighth(value);
  return Number.isFinite(snapped) && snapped > 0 ? snapped : null;
}
