import type { OutcomeChip } from './format.ts';
import styles from './OutcomeChipView.module.css';

const PATHS: Record<OutcomeChip['icon'], string> = {
  check: 'M3 8.5l3.2 3L13 4.8',
  shield: 'M8 1.8l5 1.8v4c0 3-2.1 5-5 6.4C5.1 12.6 3 10.6 3 7.6v-4zM6 6l4 4M10 6l-4 4',
  file: 'M4 2h5l3 3v9H4zM9 2v3h3M6 8.5h4M6 11h4',
  text: 'M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z',
  person: 'M8 8a2.6 2.6 0 100-5.2A2.6 2.6 0 008 8zM3 13.5c.4-2.5 2.3-3.8 5-3.8s4.6 1.3 5 3.8',
  phone: 'M4 2.5h2.2l1 3-1.5 1a8 8 0 003.8 3.8l1-1.5 3 1v1.7a1.5 1.5 0 01-1.5 1.5A10 10 0 012.5 4 1.5 1.5 0 014 2.5z',
  chat: 'M2.5 3h11v7.5H8l-3 2.5v-2.5H2.5zM5.5 6.7h5',
};

/** The small outcome pill of a call: a glyph and the outcome in words ("Booked inspection"). */
export function OutcomeChipView({ chip, className }: { chip: OutcomeChip; className?: string }) {
  return (
    <span className={className === undefined ? styles.chip : `${styles.chip} ${className}`} data-tone={chip.tone}>
      <svg className={styles.icon} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <path d={PATHS[chip.icon]} />
      </svg>
      {chip.label}
    </span>
  );
}
