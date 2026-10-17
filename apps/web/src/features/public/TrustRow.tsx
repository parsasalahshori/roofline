import { useId } from 'react';
import { publicCopy } from '../../copy/public.ts';
import { CheckIcon } from './icons.tsx';
import { trustBadges, trustItems, type TrustFacts } from './trust.ts';
import styles from './TrustRow.module.css';

/**
 * Under the first step: what the company itself says about itself (a rating with its source and count, the year it
 * started, its licence), each only when its own settings hold it. With fewer than two facts the row would look
 * thin or empty, so it says what happens at the visit instead. A number the company did not give is never shown.
 */
export function TrustRow({ facts, now }: { facts?: TrustFacts | null; now?: Date }) {
  const items = trustItems(facts, now);
  const badges = trustBadges(facts);
  const titleId = useId();
  if (items.length >= 2) {
    return (
      <div className={styles.wrap}>
        <ul className={styles.facts} aria-label={publicCopy.trustLabel} data-count={items.length}>
          {items.map((item) => (
            <li key={item.key} className={styles.fact}>
              <b className={styles.value}>{item.value}</b>
              <span className={styles.caption}>{item.caption}</span>
            </li>
          ))}
        </ul>
        <Badges badges={badges} />
      </div>
    );
  }
  return (
    <section className={styles.visit} aria-labelledby={titleId}>
      <h2 id={titleId} className={styles.visitTitle}>
        {publicCopy.visitTitle}
      </h2>
      <ul className={styles.checks}>
        {publicCopy.visitChecks.map((check) => (
          <li key={check.lead} className={styles.check}>
            <CheckIcon size={16} />
            <span>
              <b>{check.lead}</b>
              {check.rest}
            </span>
          </li>
        ))}
      </ul>
      <Badges badges={badges} />
    </section>
  );
}

/** Up to three short badges as quiet pills ("A+ BBB", "Made in USA"). */
export function Badges({ badges }: { badges: readonly string[] }) {
  if (badges.length === 0) return null;
  return (
    <ul className={styles.badges} aria-label={publicCopy.badgesLabel} data-badges="">
      {badges.map((b) => (
        <li key={b} className={styles.badge}>
          {b}
        </li>
      ))}
    </ul>
  );
}
