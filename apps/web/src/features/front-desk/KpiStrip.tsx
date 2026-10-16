import { Button, Icon, KpiTile, Skeleton } from '@roofline/ui';
import { frontDeskInbox } from '../../copy/front-desk-inbox.ts';
import { useIsPhone } from '../../shell/useIsPhone.ts';
import { useDayStats } from './inbox-api.ts';
import { secondsText } from './format.ts';
import styles from './KpiStrip.module.css';

const copy = frontDeskInbox;

/**
 * The row of today's numbers, all from GET /api/front-desk/stats?day=today: what came in, how much was picked up, what it
 * turned into and how fast. It fetches its own numbers and never blocks the list. The caller shows it to the owner and
 * the office only (the server refuses a rep). A number the server has no answer for yet reads as a dash, never as a guess.
 */
export function KpiStrip() {
  const { data, isPending, isError, refetch } = useDayStats();
  // On a phone the row slides sideways, so it must be reachable from the keyboard too
  const phone = useIsPhone();

  if (isError) {
    return (
      <section className={styles.strip} aria-label={copy.kpisLabel}>
        <div className={styles.error} role="alert">
          <Icon name="alert" size={18} />
          <span>{copy.kpisError}</span>
          <Button variant="default" size="sm" onClick={() => void refetch()}>
            {copy.tryAgain}
          </Button>
        </div>
      </section>
    );
  }

  if (isPending || data === undefined) {
    return (
      <section className={styles.strip} aria-label={copy.kpisLabel} aria-busy="true">
        <div className={styles.tiles}>
          {Array.from({ length: 5 }, (_, index) => (
            <div key={index} className={styles.placeholder}>
              <Skeleton width="55%" height="12px" />
              <Skeleton width="40%" height="28px" />
              <Skeleton width="75%" height="12px" />
            </div>
          ))}
        </div>
      </section>
    );
  }

  const quiet = data.callsToday === 0;
  return (
    <section className={styles.strip} aria-label={copy.kpisLabel}>
      <div className={styles.tiles} tabIndex={phone ? 0 : undefined}>
        <KpiTile label={copy.callsToday} value={data.callsToday} meta={quiet ? copy.noCallsYet : copy.callsTodayHint} />
        <KpiTile
          label={copy.answered}
          value={data.answeredPct === null ? '—' : `${data.answeredPct}%`}
          meta={data.answeredPct === null ? copy.noCallsYet : copy.answeredHint(data.booked, data.escalated)}
        />
        <KpiTile label={copy.inspections} value={data.inspectionsBooked} meta={copy.inspectionsHint} />
        <KpiTile label={copy.afterHours} value={data.afterHours} meta={copy.afterHoursHint} />
        {data.avgAnswerMs === null ? (
          <KpiTile label={copy.answerTime} value="—" meta={copy.noCallsYet} />
        ) : data.avgAnswerMs < 100 ? (
          <KpiTile label={copy.answerTime} value={copy.answerTimeInstant} meta={copy.answerTimeHint} />
        ) : (
          <KpiTile label={copy.answerTime} value={secondsText(data.avgAnswerMs)} unit={copy.seconds} meta={copy.answerTimeHint} />
        )}
      </div>
    </section>
  );
}
