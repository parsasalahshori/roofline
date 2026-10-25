import { FRAME_COLORS } from '@roofline/shared';

/** What a frame colour looks like in the drawing (a hint, not a swatch match). Anything unknown draws white. */
const HEX: Readonly<Record<string, string>> = {
  white: '#f7f7f4',
  almond: '#e8dcc2',
  clay: '#b9a58a',
  bronze: '#5b4636',
  black: '#23262b',
  woodgrain: '#a8774a',
};

export const frameColorHex = (value: string | null | undefined): string => (value && HEX[value]) || HEX.white!;

/** The frame colour names the drawing knows (kept in step with the factory order's colours). */
export const KNOWN_FRAME_COLORS: readonly string[] = FRAME_COLORS;
