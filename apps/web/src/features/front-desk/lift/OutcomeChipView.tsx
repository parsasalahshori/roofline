import type { OutcomeChip } from './format.ts';
import styles from './OutcomeChipView.module.css';

const PATHS: Record<OutcomeChip['icon'], string> = {
  check: 'M2.5 3.5h11v10h-11zM2.5 6.5h11M5.5 2v3M10.5 2v3M5.8 10l1.7 1.5 2.9-3',
  shield: 'M8 1.8l5 1.8v4c0 3-2.1 5-5 6.4C5.1 12.6 3 10.6 3 7.6v-4zM6 6l4 4M10 6l-4 4',
  file: 'M4 2h5l3 3v9H4zM9 2v3h3M6 8.5h4M6 11h4',
  text: 'M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2zM5 6.2h6M5 8.2h4',
  person: 'M4 2.5h2.2l1 3-1.5 1a8 8 0 003.8 3.8l1-1.5 3 1v1.7a1.5 1.5 0 01-1.5 1.5A10 10 0 012.5 4 1.5 1.5 0 014 2.5zM9.5 6.5l3-3M9.5 4v2.5H12',
  phone: 'M4 2.5h2.2l1 3-1.5 1a8 8 0 003.8 3.8l1-1.5 3 1v1.7a1.5 1.5 0 01-1.5 1.5A10 10 0 012.5 4 1.5 1.5 0 014 2.5z',
  chat: 'M8 2.5c3 0 5.5 1.9 5.5 4.3S11 11.1 8 11.1c-.6 0-1.2-.1-1.7-.2L3.5 12.5v-2.6C2.6 9.2 2.5 8 2.5 6.8 2.5 4.4 5 2.5 8 2.5z',
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
