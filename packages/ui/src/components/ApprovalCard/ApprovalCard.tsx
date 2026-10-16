import { useId, type ReactNode } from 'react';
import { cx } from '../../cx.ts';
import { Icon, type IconName } from '../../icons.tsx';
import { Button } from '../Button/Button.tsx';
import { Tag } from '../Tag/Tag.tsx';
import styles from './ApprovalCard.module.css';

export type ApprovalFact = {
  label: string;
  value: ReactNode;
  /** Money, sizes and counts read in mono. */
  mono?: boolean;
  /** The agent cannot change it and the person cannot edit it here: price, customer and recipient. */
  locked?: boolean;
};

export type ApprovalAction = {
  label: string;
  onClick?: () => void;
  href?: string;
  busy?: boolean;
  /** The key that does it from the keyboard, shown on the button. */
  keyHint?: string;
};

export type ApprovalCardProps = {
  /** The agent's glyph, drawn ink on a sunken square. */
  agentIcon: IconName;
  /** "Estimator drafted · 3 days ago". */
  drafted: string;
  /** "Needs your OK". */
  tag: string;
  title: string;
  facts: ReadonlyArray<ApprovalFact>;
  approve: ApprovalAction;
  edit?: ApprovalAction;
  later?: ApprovalAction;
  /** "Expires Sat": the last line, at the right of the buttons. */
  meta?: string;
  /** The name a screen reader hears for a locked fact's lock. */
  lockedLabel: string;
  className?: string;
};

/**
 * An agent's draft waiting for a yes: a 3px tape edge, who drafted it and when, the title, the facts that matter (cost in
 * mono, price, customer and recipient locked), then Approve, Edit and Not now. The keys 1, E and H do the same from the keyboard.
 */
export function ApprovalCard({ agentIcon, drafted, tag, title, facts, approve, edit, later, meta, lockedLabel, className }: ApprovalCardProps) {
  const titleId = useId();
  return (
    <article className={cx(styles.card, className)} aria-labelledby={titleId}>
      <header className={styles.head}>
        <span className={styles.glyph} aria-hidden="true">
          <Icon name={agentIcon} size={16} />
        </span>
        <span className={styles.drafted}>{drafted}</span>
        <Tag tone="tape" icon="alert">
          {tag}
        </Tag>
      </header>
      <h3 id={titleId} className={styles.title}>
        {title}
      </h3>
      <dl className={styles.facts}>
        {facts.map((fact) => (
          <div key={fact.label} className={styles.fact}>
            <dt className={styles.factLabel}>
              {fact.label}
              {fact.locked ? <Icon name="lock" size={16} className={styles.lock} label={lockedLabel} /> : null}
            </dt>
            <dd className={styles.factValue} data-mono={fact.mono ? 'true' : undefined}>
              {fact.value}
            </dd>
          </div>
        ))}
      </dl>
      <div className={styles.actions}>
        <Button size="sm" onClick={approve.onClick} href={approve.href} busy={approve.busy} data-key={approve.keyHint}>
          <Icon name="check" size={16} />
          {approve.label}
        </Button>
        {edit ? (
          <Button size="sm" variant="default" onClick={edit.onClick} href={edit.href} busy={edit.busy} data-key={edit.keyHint}>
            {edit.label}
          </Button>
        ) : null}
        {later ? (
          <Button size="sm" variant="ghost" onClick={later.onClick} href={later.href} busy={later.busy} data-key={later.keyHint}>
            {later.label}
          </Button>
        ) : null}
        {meta ? <span className={styles.meta}>{meta}</span> : null}
      </div>
    </article>
  );
}
