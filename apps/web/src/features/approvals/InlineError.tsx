import { Button, Tag } from '@roofline/ui';
import styles from './InlineError.module.css';

export type InlineErrorProps = {
  /** The red tag: what could not be done ("Couldn't load"). */
  tag: string;
  /** The one sentence: the server's own words, or ours when it had none. */
  message: string;
  /** The button that asks again. */
  retryLabel: string;
  onRetry: () => void;
};

/**
 * A page-level error that stays on the page, next to where the thing was meant to be: a red tag, one sentence and a
 * Try again button. It is an alert, so a screen reader hears it as it appears.
 */
export function InlineError({ tag, message, retryLabel, onRetry }: InlineErrorProps) {
  return (
    <div className={styles.error} role="alert">
      <Tag tone="bad" icon="alert">
        {tag}
      </Tag>
      <p className={styles.message}>{message}</p>
      <Button variant="default" onClick={onRetry}>
        {retryLabel}
      </Button>
    </div>
  );
}
