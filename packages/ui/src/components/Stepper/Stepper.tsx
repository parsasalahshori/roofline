import { cx } from '../../cx.ts';
import { Icon } from '../../icons.tsx';
import styles from './Stepper.module.css';

export type StepperStep = {
  label: string;
};

export type StepperProps = {
  /** The list's accessible name, for example "Import steps". */
  label: string;
  steps: ReadonlyArray<StepperStep>;
  /** The step in progress, counting from 1. The steps before it are done; a number past the last step means all of them are. */
  current: number;
  /** Read after the name of a done step ("Done"): a check mark alone says nothing to a screen reader. */
  doneLabel: string;
  className?: string;
};

/**
 * The steps of a flow in order: a numbered mono marker for each, a check mark once it is done, a brand fill for the one in
 * progress, and a hairline between one and the next. On a phone only the step in progress keeps its name (the last one, once
 * every step is done).
 */
export function Stepper({ label, steps, current, doneLabel, className }: StepperProps) {
  return (
    <ol aria-label={label} className={cx(styles.stepper, className)}>
      {steps.map((step, index) => {
        const number = index + 1;
        const state = number < current ? 'done' : number === current ? 'current' : 'todo';
        // The step that keeps its name on a phone: the one in progress, or the last one once every step is done
        const named = state === 'current' || (current > steps.length && index === steps.length - 1);
        return (
          <li
            key={step.label}
            className={styles.step}
            data-state={state}
            data-named={named ? 'true' : undefined}
            aria-current={state === 'current' ? 'step' : undefined}
          >
            <span className={styles.marker}>
              {state === 'done' ? <Icon name="check" size={16} /> : <span className={styles.number}>{number}</span>}
            </span>
            <span className={styles.label}>
              {step.label}
              {state === 'done' ? <span className="visually-hidden"> {doneLabel}</span> : null}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
