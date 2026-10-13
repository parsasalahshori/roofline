import type { AgentCard } from '@roofline/shared';
import { agentsDash } from '../../copy/agents.ts';
import { groupDigits, staffDollars, wholeHours } from './agentTheme.ts';
import type { AgentsDashboardData } from './api.ts';
import { rateLabel } from './money.ts';
import { Sparkline } from './Sparkline.tsx';
import styles from './KpiTiles.module.css';

/** A full-time week, the yardstick for "same as N full-time staff". */
const FULL_TIME_HOURS = 40;
const EMPTY_HOURS = new Array<number>(12).fill(0);

export type KpiTilesProps = {
  cards: AgentCard[];
  dashboard: AgentsDashboardData | undefined;
};

/** The header tiles. Every number is read from the overview (cards) or the dashboard numbers. */
export function KpiTiles({ cards, dashboard }: KpiTilesProps) {
  const tasksToday = dashboard?.tasksToday ?? cards.reduce((sum, card) => sum + card.finishedToday, 0);
  const running = cards.filter((card) => card.status === 'on' || card.status === 'waiting').length;
  const minutes = dashboard?.minutesThisWeek ?? null;
  const hours = minutes === null ? null : wholeHours(minutes);
  const rate = dashboard?.hourlyRateCents ?? null;
  return (
    <section className={styles.tiles} aria-label={agentsDash.tilesLabel}>
      <div className={styles.row}>
        <article className={styles.tile}>
          <h3 className={styles.label}>
            <span className={styles.live} aria-hidden="true" />
            {agentsDash.tasksToday}
          </h3>
          <p className={styles.value}>{groupDigits(tasksToday)}</p>
          <p className={styles.sub}>{`${running} ${agentsDash.agentsOf} ${cards.length} ${agentsDash.agentsRunning}`}</p>
        </article>
        <article className={styles.tile}>
          <h3 className={styles.label}>{agentsDash.hoursWeek}</h3>
          <p className={styles.value}>
            {hours === null ? '-' : groupDigits(hours)}
            <span className={styles.unit}>{agentsDash.hoursUnit}</span>
          </p>
          <p className={styles.sub}>{agentsDash.hoursSub}</p>
        </article>
        <article className={styles.tile}>
          <h3 className={styles.label}>{agentsDash.fullTimeLead}</h3>
          <p className={styles.value}>
            {minutes === null ? '-' : (minutes / 60 / FULL_TIME_HOURS).toFixed(1)}
            <span className={styles.unit}>{agentsDash.fullTimeUnit}</span>
          </p>
          <p className={styles.sub}>
            {hours === null ? '' : `${hours} ${agentsDash.fullTimeSubPrefix} ${FULL_TIME_HOURS} ${agentsDash.fullTimeSubSuffix}`}
          </p>
        </article>
        {rate === null || minutes === null ? null : (
          <article className={styles.tile}>
            <h3 className={styles.label}>{agentsDash.officeSaved}</h3>
            <p className={styles.value}>{`$${groupDigits(staffDollars(minutes, rate))}`}</p>
            <p className={styles.sub}>{`${agentsDash.officeSub} ${rateLabel(rate)} ${agentsDash.officeSubSuffix}`}</p>
          </article>
        )}
      </div>
      <article className={`${styles.tile} ${styles.chart}`}>
        <h3 className={styles.label}>{agentsDash.perHourTitle}</h3>
        <div className={styles.plot}>
          <Sparkline values={dashboard?.tasksPerHour ?? EMPTY_HOURS} label={agentsDash.perHourChart} width={360} height={84} grid endLabel />
        </div>
        <p className={styles.axis}>
          <span>{agentsDash.perHourStart}</span>
          <span>{agentsDash.perHourNow}</span>
        </p>
      </article>
    </section>
  );
}
