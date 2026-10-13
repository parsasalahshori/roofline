import { liftSigned, signedMoney, signedWeekLabel } from '../../../copy/liftSigned.ts';
import styles from './SignedCard.module.css';
import { useSignedSummary, type SignedSummary } from './signedApi.ts';

/** The chart is drawn at the card's inner width (332) and 54 tall; the reference leaves a floor under every bar. */
const WIDTH = 332;
const HEIGHT = 54;
const GAP = 4;
const FLOOR = 0.5;
const RADIUS = 4;

/** Twelve bars, one per week; the last (this week) is dark and the rest light. A hidden table carries the numbers. */
function WeeklyChart({ weekly }: { weekly: SignedSummary['weekly'] }) {
  const max = Math.max(1, ...weekly.map((w) => w.totalCents));
  const n = Math.max(1, weekly.length);
  const barWidth = (WIDTH - GAP * (n - 1)) / n;
  const slot = barWidth + GAP;
  const last = weekly.length - 1;
  return (
    <div className={styles.chart}>
      <svg className={styles.svg} viewBox={`0 0 ${WIDTH} ${HEIGHT}`} preserveAspectRatio="none" width="100%" aria-hidden="true" focusable="false">
        {weekly.map((w, i) => {
          const h = HEIGHT * (FLOOR + (1 - FLOOR) * (w.totalCents / max));
          return (
            <rect
              key={w.weekStart}
              className={i === last ? styles.barNow : styles.bar}
              data-current={i === last}
              data-cents={w.totalCents}
              x={i * slot}
              y={HEIGHT - h}
              width={barWidth}
              height={h + RADIUS}
              rx={RADIUS}
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
    <section className={styles.card} aria-labelledby="signed-card-title" aria-busy={query.isPending}>
      <div className={styles.inner}>
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
            {data.goalCents ? (
              <>
                <div className={styles.track} aria-hidden="true">
                  <div className={styles.fill} style={{ width: Math.min(100, Math.max(0, percent ?? 0)) + '%' }} />
                </div>
                <p className={styles.goal}>
                  <span>{liftSigned.goal(data.goalCents)}</span>
                  {data.monthTotalCents < data.goalCents ? <span>{liftSigned.toGo(data.goalCents - data.monthTotalCents)}</span> : null}
                </p>
              </>
            ) : null}
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
    </section>
  );
}
