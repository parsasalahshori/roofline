import { KpiTile, Panel } from '@roofline/ui';
import { storm } from '../../copy/storm.ts';
import { count } from './format.ts';
import type { StormResultsView } from './types.ts';
import styles from './StormResults.module.css';

export type StormResultsProps = { results: StormResultsView; running: boolean };

const dollars = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const money = (cents: number): string => dollars.format(cents / 100);

/** The live numbers of a storm plan: texts, emails, doors, ads and bookings, each as a tile. */
export function StormResults({ results, running }: StormResultsProps) {
  // The ad budget is a ceiling, not a result: a plan that has done nothing yet has results of zero whatever its budget
  const counted = Object.entries(results).filter(([key]) => key !== 'adMaxCents');
  const empty = counted.every(([, value]) => value === 0) && !running;
  const tiles: { label: string; value: number }[] = [
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
    <Panel title={storm.resultsHeading} aria-live={running ? 'polite' : undefined}>
      {empty ? (
        <p className={styles.empty}>{storm.resultsEmpty}</p>
      ) : (
        <div className={styles.grid} data-testid="storm-results-grid">
          {tiles.map((tile) => (
            <KpiTile key={tile.label} label={tile.label} value={count(tile.value)} />
          ))}
          <KpiTile
            label={storm.adSpendLabel}
            value={money(results.adSpendCents)}
            meta={storm.adSpendOf(money(results.adMaxCents))}
          />
        </div>
      )}
    </Panel>
  );
}
