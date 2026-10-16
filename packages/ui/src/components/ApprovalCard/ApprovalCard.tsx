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
  /** The key that does it from the keyboard. The button carries it as `data-key`, so a screen can find the button for a key. */
  keyHint?: string;
  /** Approve only: the glyph before the label. A check unless the action opens something to look at first. */
  icon?: IconName;
};

export type ApprovalCardProps = {
  /** The agent's glyph, drawn ink on a sunken square. */
  agentIcon: IconName;
  /** "Estimator drafted · 3 days ago". */
  drafted: string;
  /** "Needs your OK". */
  tag: string;
  title: string;
  /** One sentence under the title: what the plan does. Three lines at most; the whole sentence is still read out. */
  summary?: string;
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
export function ApprovalCard({ agentIcon, drafted, tag, title, summary, facts, approve, edit, later, meta, lockedLabel, className }: ApprovalCardProps) {
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
      {summary ? <p className={styles.summary}>{summary}</p> : null}
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
        <Button size="sm" className={styles.action} data-role="approve" onClick={approve.onClick} href={approve.href} busy={approve.busy} data-key={approve.keyHint}>
          <Icon name={approve.icon ?? 'check'} size={16} />
          {approve.label}
        </Button>
        {edit ? (
          <Button size="sm" variant="default" className={styles.action} onClick={edit.onClick} href={edit.href} busy={edit.busy} data-key={edit.keyHint}>
            {edit.label}
          </Button>
        ) : null}
        {later ? (
          <Button size="sm" variant="ghost" className={styles.action} onClick={later.onClick} href={later.href} busy={later.busy} data-key={later.keyHint}>
            {later.label}
          </Button>
        ) : null}
        {meta ? <span className={styles.meta}>{meta}</span> : null}
      </div>
    </article>
  );
}
