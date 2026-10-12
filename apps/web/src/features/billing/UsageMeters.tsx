import type { BillingView } from '@roofline/shared';
import { ProgressBar } from '@roofline/ui';
import { billing } from '../../copy/billing.ts';
import styles from './UsageMeters.module.css';

type Entry = BillingView['usage'][number];

/** The copy key for each meter. The meter names stay in the shared data; the copy uses camelCase keys. */
const METER_KEY: Record<Entry['meter'], 'smsSegment' | 'aiCallMinute'> = {
  sms_segment: 'smsSegment',
  ai_call_minute: 'aiCallMinute',
};

/** This period's use of each meter. A meter with an included amount shows a bar; one without shows the count alone. */
export function UsageMeters({ usage }: { usage: BillingView['usage'] }) {
  return (
    <section className={styles.section}>
      <h3 className={styles.heading}>{billing.usageHeading}</h3>
      <ul className={styles.list}>
        {usage.map((entry) => {
          const key = METER_KEY[entry.meter];
          if (entry.included === null) {
            return (
              <li key={entry.meter} className={styles.meter}>
                <p className={styles.label}>{billing.meterLabel[key]}</p>
                <p className={styles.line}>{billing.usedSoFar(entry.used)}</p>
              </li>
            );
          }
          const text = billing.usedOf(entry.used, entry.included, key);
          return (
            <li key={entry.meter} className={styles.meter}>
              <p className={styles.label}>{billing.meterLabel[key]}</p>
              <p className={styles.line}>{text}</p>
              <ProgressBar value={entry.used} max={entry.included} label={text} />
            </li>
          );
        })}
      </ul>
    </section>
  );
}
