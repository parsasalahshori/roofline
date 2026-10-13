import { Card } from '@roofline/ui';
import { liftSigned, signedMoney, signedWeekLabel } from '../../../copy/liftSigned.ts';
import styles from './SignedCard.module.css';
import { useSignedSummary, type SignedSummary } from './signedApi.ts';

const WIDTH = 240;
const HEIGHT = 48;
const GAP = 4;

/** Twelve bars, one per week; the last (this week) is dark and the rest light. A hidden table carries the numbers. */
function WeeklyChart({ weekly }: { weekly: SignedSummary['weekly'] }) {
  const max = Math.max(1, ...weekly.map((w) => w.totalCents));
  const slot = weekly.length > 0 ? WIDTH / weekly.length : WIDTH;
  const barWidth = Math.max(1, slot - GAP);
  const last = weekly.length - 1;
  return (
    <div className={styles.chart}>
      <svg className={styles.svg} viewBox={`0 0 ${WIDTH} ${HEIGHT}`} preserveAspectRatio="none" width="100%" aria-hidden="true" focusable="false">
        {weekly.map((w, i) => {
          const h = w.totalCents > 0 ? Math.max(2, (w.totalCents / max) * HEIGHT) : 2;
          return (
            <rect
              key={w.weekStart}
              className={i === last ? styles.barNow : styles.bar}
              data-current={i === last}
              data-cents={w.totalCents}
              x={i * slot + GAP / 2}
              y={HEIGHT - h}
              width={barWidth}
              height={h}
              rx={1.5}
            />
          );
        })}
      </svg>
      <table className={styles.srOnly}>
        <caption>{liftSigned.chartLabel}</caption>
        <thead>
          <tr>
            <th scope="col">{liftSigned.chartWeek}</th>
            <th scope="col">{liftSigned.chartTotal}</th>
          </tr>
        </thead>
        <tbody>
          {weekly.map((w) => (
            <tr key={w.weekStart}>
              <td>{signedWeekLabel(w.weekStart)}</td>
              <td>{signedMoney(w.totalCents)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * The home page's "Signed this month" card: this calendar month's signed total (company zone), the goal and
 * how far along it is when the company has one, twelve weeks of signings, and the open pipeline.
 */
export function SignedCard() {
  const query = useSignedSummary();
  const data = query.data;
  const nothingYet = data !== undefined && data.monthTotalCents === 0 && data.weekly.every((w) => w.totalCents === 0);
  const percent = data?.goalCents ? Math.round((data.monthTotalCents / data.goalCents) * 100) : null;

  return (
    <Card as="section" aria-labelledby="signed-card-title">
      <div className={styles.card} aria-busy={query.isPending}>
        <div className={styles.head}>
          <h3 className={styles.title} id="signed-card-title">{liftSigned.title}</h3>
          {percent === null ? null : <span className={styles.chip}>{liftSigned.percentOfGoal(percent)}</span>}
        </div>
        {query.isPending ? (
          <div className={styles.skeleton} role="status" aria-label={liftSigned.loading} />
        ) : data === undefined ? (
          <p className={styles.hint} role="alert">{liftSigned.loadFailed}</p>
        ) : (
          <>
            <p className={styles.total}>{signedMoney(data.monthTotalCents)}</p>
            {data.goalCents ? <p className={styles.goal}>{liftSigned.goal(data.goalCents)}</p> : null}
            {nothingYet ? (
              <p className={styles.hint}>{liftSigned.empty}</p>
            ) : (
              <>
                <WeeklyChart weekly={data.weekly} />
                <div className={styles.axis}>
                  <span>{liftSigned.axisStart}</span>
                  <span>{liftSigned.axisEnd}</span>
                </div>
              </>
            )}
            <p className={styles.pipeline}>
              <span>{liftSigned.openPipeline}</span>
              <span className={styles.pipelineValue}>{signedMoney(data.openPipelineCents)}</span>
            </p>
          </>
        )}
      </div>
    </Card>
  );
}
