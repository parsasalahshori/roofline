import { Button, Icon, Tag } from '@roofline/ui';
import type { ReactNode } from 'react';
import styles from './states.module.css';

export type EmptyPanelProps = {
  title: string;
  body?: string;
  /** What to do next: one primary Button. */
  action?: ReactNode;
  /** The shape of the content that will be here, drawn in faint hairlines: rows of a table or cards of a board. */
  ghost?: 'rows' | 'cards' | 'none';
  className?: string;
};

/**
 * An empty page or list: never a centred sentence alone. It shows the shape of what will be here (ghost rows in the
 * hairline colour), says what is missing in a line, and offers the next step as one button.
 */
export function EmptyPanel({ title, body, action, ghost = 'rows', className }: EmptyPanelProps) {
  return (
    <div className={[styles.empty, className].filter(Boolean).join(' ')} data-ghost={ghost}>
      {ghost === 'none' ? null : (
        <div className={styles.ghost} aria-hidden="true">
          {[0, 1, 2].map((row) => (
            <span key={row} className={styles.ghostRow}>
              <i className={styles.ghostDot} />
              <b className={styles.ghostBar} />
              <b className={styles.ghostBarShort} />
            </span>
          ))}
        </div>
      )}
      <div className={styles.message}>
        <p className={styles.title}>{title}</p>
        {body !== undefined ? <p className={styles.body}>{body}</p> : null}
        {action !== undefined ? <div className={styles.action}>{action}</div> : null}
      </div>
    </div>
  );
}

export type LoadErrorProps = {
  /** The red tag's word: "Couldn't load". */
  tag: string;
  /** One sentence: what failed and what to do. */
  title: string;
  /** The retry button's word. */
  retry: string;
  onRetry: () => void;
  busy?: boolean;
  className?: string;
};

/** A load that failed, in place of the thing that did not load: a red tag, one sentence and Try again. Never a modal. */
export function LoadError({ tag, title, retry, onRetry, busy = false, className }: LoadErrorProps) {
  return (
    <div role="alert" className={[styles.error, className].filter(Boolean).join(' ')}>
      <Tag tone="bad" icon="alert">
        {tag}
      </Tag>
      <p className={styles.errorText}>{title}</p>
      <Button variant="default" size="sm" busy={busy} onClick={onRetry}>
        <Icon name="refresh" size={16} />
        {retry}
      </Button>
    </div>
  );
}
