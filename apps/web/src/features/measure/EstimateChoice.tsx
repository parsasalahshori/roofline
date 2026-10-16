import { Button } from '@roofline/ui';
import { paidReports } from '../../copy/billing.ts';
import { measure } from '../../copy/measure.ts';
import styles from './EstimateChoice.module.css';

export type PriceChoice = 'free' | 'exact';

const OPTIONS: { value: PriceChoice; label: string; note: string }[] = [
  { value: 'free', label: measure.choiceFree, note: measure.choiceFreeNote },
  { value: 'exact', label: paidReports.exactChoice, note: measure.choiceExactNote },
];

/** Free estimate (the default) or a paid exact report, which goes through the usual approval. */
export function EstimateChoice({ choice, onChoose, disabled = false }: { choice: PriceChoice; onChoose: (next: PriceChoice) => void; disabled?: boolean }) {
  return (
    <section className={styles.root} aria-labelledby="measure-choice">
      <h2 id="measure-choice" className={styles.title}>
        {measure.choiceTitle}
      </h2>
      <div role="group" aria-labelledby="measure-choice" className={styles.options}>
        {OPTIONS.map((o) => (
          <Button
            key={o.value}
            variant="default"
            className={styles.option}
            aria-pressed={choice === o.value}
            data-state={choice === o.value ? 'on' : 'off'}
            disabled={disabled}
            onClick={() => onChoose(o.value)}
          >
            <span className={styles.label}>{o.label}</span>
            <span className={styles.note}>{o.note}</span>
          </Button>
        ))}
      </div>
    </section>
  );
}
