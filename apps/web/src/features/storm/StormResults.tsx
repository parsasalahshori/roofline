import { StatCard } from '@roofline/ui';
import { storm } from '../../copy/storm.ts';
import type { StormResultsView } from './types.ts';
import styles from './StormResults.module.css';

export type StormResultsProps = { results: StormResultsView; running: boolean };

const dollars = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const money = (cents: number): string => dollars.format(cents / 100);

/** The live numbers of a storm plan: texts, emails, doors, ads and bookings. */
export function StormResults({ results, running }: StormResultsProps) {
  const empty = Object.values(results).every((value) => value === 0) && !running;
  const cards: { label: string; value: number }[] = [
    { label: storm.textsSent, value: results.textsSent },
    { label: storm.textsDelivered, value: results.textsDelivered },
    { label: storm.replies, value: results.replies },
    { label: storm.yesReplies, value: results.yesReplies },
    { label: storm.emailsSent, value: results.emailsSent },
    { label: storm.unsubscribes, value: results.unsubscribes },
    { label: storm.doorsKnocked, value: results.doorsKnocked },
    { label: storm.wantsCheck, value: results.wantsCheck },
    { label: storm.adClicks, value: results.adClicks },
    { label: storm.landingRequests, value: results.landingRequests },
    { label: storm.inspectionsBooked, value: results.inspectionsBooked },
  ];
  return (
    <section className={styles.results} aria-label={storm.resultsHeading} aria-live={running ? 'polite' : undefined}>
      <h2 className={styles.heading}>{storm.resultsHeading}</h2>
      {!empty ? <p className={styles.empty}>{storm.resultsHelp}</p> : null}
      {empty ? (
        <p className={styles.empty}>{storm.resultsEmpty}</p>
      ) : (
        <div className={styles.grid} data-testid="storm-results-grid">
          {cards.map((card) => (
            <StatCard key={card.label} label={card.label} value={card.value} />
          ))}
          <StatCard
            label={storm.adSpend(money(results.adSpendCents), money(results.adMaxCents))}
            value={money(results.adSpendCents)}
          />
        </div>
      )}
    </section>
  );
}
