import { liftMeasure } from '../../../copy/liftMeasure.ts';
import styles from './AiMark.module.css';

/** The small tape-yellow tile that marks work done by the AI (the reference's "Done by AI" mark). */
export function AiMark({ size = 18, labelled = false }: { size?: number; labelled?: boolean }) {
  const glyph = Math.round(size * 0.66 * 100) / 100;
  return (
    <span
      className={styles.mark}
      style={{ width: size, height: size }}
      {...(labelled ? { role: 'img', 'aria-label': liftMeasure.doneByAi } : { 'aria-hidden': true })}
    >
      <svg width={glyph} height={glyph} viewBox="0 0 12 12" fill="none" focusable="false" aria-hidden="true">
        <path d="M2.6 7.6 6 4.2l3.4 3.4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  );
}
