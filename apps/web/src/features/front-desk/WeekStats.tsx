import { useId } from 'react';
import type { FrontDeskWeekStats } from '@roofline/shared';
import { Skeleton, StatCard } from '@roofline/ui';
import { frontDeskInbox } from '../../copy/front-desk-inbox.ts';
import { useWeekStats } from './inbox-api.ts';
import styles from './WeekStats.module.css';

const copy = frontDeskInbox.stats;

/** The AI minutes tile: "212 of 500 minutes" when the plan includes some, else "212 minutes". */
function aiMinutesValue(stats: FrontDeskWeekStats): string {
  return stats.aiMinutesIncluded === null
    ? copy.aiMinutesUsed(stats.aiMinutesUsed)
    : copy.aiMinutesOf(stats.aiMinutesUsed, stats.aiMinutesIncluded);
}

/** This week's counts and AI minutes as a row of stat tiles. It fetches its own numbers and never blocks the list below. */
export function WeekStats() {
  const headingId = useId();
  const { data, isPending, isError } = useWeekStats();

  return (
    <section className={styles.root} aria-labelledby={headingId}>
      <h2 id={headingId} className={styles.title}>
        {copy.title}
      </h2>
      {isError ? (
        <p className={styles.note}>{copy.loadError}</p>
      ) : isPending || data === undefined ? (
        <div className={styles.grid} aria-busy="true">
          {Array.from({ length: 6 }, (_, index) => (
            <div key={index} className={styles.placeholder}>
              <Skeleton width="60%" />
              <Skeleton width="40%" height="1.5rem" />
            </div>
          ))}
        </div>
      ) : (
        <div className={styles.grid}>
          <StatCard label={copy.answered} value={data.answered} />
          <StatCard label={copy.booked} value={data.booked} />
          <StatCard label={copy.transferred} value={data.transferred} />
          <StatCard label={copy.messages} value={data.messages} />
          <StatCard label={copy.spam} value={data.spam} />
          <StatCard label={copy.aiMinutes} value={aiMinutesValue(data)} />
        </div>
      )}
    </section>
  );
}
