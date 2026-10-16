import { fractionInches } from '@roofline/shared';
import type { HTMLAttributes } from 'react';
import { cx } from '../../cx.ts';
import { Icon, type IconName } from '../../icons.tsx';
import styles from './Size.module.css';

/** How a size was taken. Each has its own glyph, and the method is always shown next to the number. */
export type MeasureMethod = 'lidar' | 'sheet' | 'room' | 'walls';

const METHOD_ICONS: Record<MeasureMethod, IconName> = { lidar: 'lidar', sheet: 'sheet', room: 'cube', walls: 'ruler' };

/** The words the readout needs. They come from the app's copy: the kit holds no wording of its own. */
export type SizeCopy = {
  /** Between width and height for a screen reader: "by". */
  by: string;
  /** After the height for a screen reader: "inches". */
  inches: string;
  /** Before an estimate for a screen reader: "about". */
  about: string;
  /** Before the tolerance for a screen reader: "plus or minus". */
  plusMinus: string;
  /** The method's name, by kind: "LiDAR", "Sheet photo", "Room scan", "From walls". */
  methods: Record<MeasureMethod, string>;
};

export type SizeScale = 'table' | 'card' | 'readout';

export type SizeProps = Omit<HTMLAttributes<HTMLSpanElement>, 'children'> & {
  /** Width and height in inches. */
  w: number;
  h: number;
  /** The tolerance in inches ("plus or minus"). An exact size with no tolerance known shows none. */
  pm?: number | null;
  /** An estimate: a "~" in front, a lighter weight, and the tolerance in whole inches. */
  estimate?: boolean;
  /** table 16px, card 17px, readout 26px. */
  scale?: SizeScale;
  /** How it was measured, with its glyph and name. */
  method?: MeasureMethod | null;
  copy: SizeCopy;
};

/** Splits what `fractionInches` writes ("35 7/8", "7/8", "36") into its whole inches and its fraction. */
function split(value: number): { whole: string; num: string; den: string } {
  const text = fractionInches(value);
  const match = /^(?:(\d+) )?(?:(\d+)\/(\d+))?$|^(\d+)$/.exec(text);
  if (!match) return { whole: text, num: '', den: '' };
  if (match[4] !== undefined) return { whole: match[4], num: '', den: '' };
  return { whole: match[1] ?? '', num: match[2] ?? '', den: match[3] ?? '' };
}

/** One dimension: whole inches, then the fraction stacked small, raised over lowered with a light slash between. */
function Inches({ value }: { value: number }) {
  const { whole, num, den } = split(value);
  return (
    <span className={styles.inches}>
      {whole !== '' ? <span className={styles.whole}>{whole}</span> : null}
      {num !== '' ? (
        <span className={styles.frac}>
          <span className={styles.num}>{num}</span>
          <span className={styles.slash}>/</span>
          <span className={styles.den}>{den}</span>
        </span>
      ) : null}
    </span>
  );
}

/** The plain words for a size, as a screen reader should hear it: "about 36 by 60 inches, plus or minus 2". */
export function sizeSpeech(copy: SizeCopy, w: number, h: number, pm: number | null | undefined, estimate: boolean): string {
  const parts = [`${estimate ? copy.about + ' ' : ''}${fractionInches(w)} ${copy.by} ${fractionInches(h)} ${copy.inches}`];
  if (pm !== null && pm !== undefined) parts.push(`${copy.plusMinus} ${fractionInches(pm)}`);
  return parts.join(', ');
}

/**
 * A window or roof size, the product's signature: whole inches in mono with the eighth stacked small beside them, the
 * tolerance after it in a quieter ink, and how it was measured. Fractions are always reduced (4/8 is 1/2) and a
 * frame size is never a decimal. The visible marks are decoration; a screen reader hears one sentence.
 */
export function Size({ w, h, pm, estimate = false, scale = 'table', method = null, copy, className, ...rest }: SizeProps) {
  return (
    <span {...rest} className={cx(styles.size, className)} data-scale={scale} data-estimate={estimate ? 'true' : undefined}>
      <span className="visually-hidden">{sizeSpeech(copy, w, h, pm, estimate)}</span>
      <span className={styles.visual} aria-hidden="true">
        {estimate ? <span className={styles.tilde}>~</span> : null}
        <Inches value={w} />
        <span className={styles.times}>&times;</span>
        <Inches value={h} />
        {pm !== null && pm !== undefined ? <span className={styles.pm}>&plusmn;{fractionInches(pm)}</span> : null}
      </span>
      {method ? (
        <span className={styles.method} aria-hidden="true">
          <Icon name={METHOD_ICONS[method]} size={16} />
          {copy.methods[method]}
        </span>
      ) : null}
    </span>
  );
}
