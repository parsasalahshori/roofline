import { KpiTile } from '@roofline/ui';
import type { AgentCard } from '@roofline/shared';
import { agentsDash } from '../../copy/agents.ts';
import { groupDigits, staffDollars, wholeHours } from './agentTheme.ts';
import type { AgentsDashboardData } from './api.ts';
import { rateLabel } from './money.ts';
import styles from './KpiTiles.module.css';

/** A full-time week, the yardstick for "same as N full-time staff". */
const FULL_TIME_HOURS = 40;
const EMPTY_HOURS = new Array<number>(12).fill(0);

export type KpiTilesProps = {
  cards: AgentCard[];
  dashboard: AgentsDashboardData | undefined;
};

/** The estimate mark before a figure that is a guess ("about 35 hrs"), small so the figure still reads first. */
function About() {
  // The space is part of the text, so the figure reads "about 35" as words, in a copy and to a screen reader
  return <span className={styles.about}>{`${agentsDash.about} `}</span>;
}

/** The header tiles. Every number is read from the overview (cards) or the dashboard numbers; money and hours are marked as estimates. */
export function KpiTiles({ cards, dashboard }: KpiTilesProps) {
  const tasksToday = dashboard?.tasksToday ?? cards.reduce((sum, card) => sum + card.finishedToday, 0);
  const running = cards.filter((card) => card.status === 'on' || card.status === 'waiting').length;
  const minutes = dashboard?.minutesThisWeek ?? null;
  const hours = minutes === null ? null : wholeHours(minutes);
  const rate = dashboard?.hourlyRateCents ?? null;
  const perHour = dashboard?.tasksPerHour ?? EMPTY_HOURS;
  return (
    <section className={styles.tiles} aria-label={agentsDash.tilesLabel}>
      <KpiTile label={agentsDash.tasksToday} value={groupDigits(tasksToday)} meta={`${running} ${agentsDash.agentsOf} ${cards.length} ${agentsDash.agentsRunning}`} />
      <KpiTile
        label={agentsDash.hoursWeek}
        value={
          hours === null ? (
            '-'
          ) : (
            <>
              <About />
              {groupDigits(hours)}
            </>
          )
        }
        unit={agentsDash.hoursUnit}
        meta={agentsDash.hoursSub}
      />
      <KpiTile
        label={agentsDash.fullTimeLead}
        value={
          minutes === null ? (
            '-'
          ) : (
            <>
              <About />
              {(minutes / 60 / FULL_TIME_HOURS).toFixed(1)}
            </>
          )
        }
        unit={agentsDash.fullTimeUnit}
        meta={hours === null ? undefined : `${hours} ${agentsDash.fullTimeSubPrefix} ${FULL_TIME_HOURS} ${agentsDash.fullTimeSubSuffix}`}
      />
      {rate === null || minutes === null ? null : (
        <KpiTile
          label={agentsDash.officeSaved}
          value={
            <>
              <About />
              {`$${groupDigits(staffDollars(minutes, rate))}`}
            </>
          }
          meta={`${agentsDash.officeSub} ${rateLabel(rate)} ${agentsDash.officeSubSuffix}`}
        />
      )}
      <KpiTile
        className={styles.trend}
        label={agentsDash.perHourTitle}
        value={perHour[perHour.length - 1] ?? 0}
        unit={agentsDash.perHourUnit}
        spark={perHour}
        sparkLabel={`${agentsDash.perHourChart}: ${perHour.join(', ')}`}
      />
    </section>
  );
}
