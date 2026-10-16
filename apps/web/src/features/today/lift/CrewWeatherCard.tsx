import { Button, Icon, Panel, Skeleton, Tag } from '@roofline/ui';
import { liftFeed } from '../../../copy/liftFeed.ts';
import { WeatherIcon } from '../../../shell/weatherIcon.tsx';
import { useWeatherOutlook } from './liftApi.ts';
import styles from './CrewWeatherCard.module.css';

/**
 * The next six days for the crew: the day, the weather, the high and the chance of rain, the days the Scheduler's rain
 * rule calls risky marked with a flag and a word, and what the Scheduler can move, with a button to fix the day. Everything
 * comes from the same forecast the Scheduler reads (GET /api/weather/outlook). With no forecast it renders nothing.
 */
export function CrewWeatherCard() {
  const { data, isPending } = useWeatherOutlook();

  if (isPending) {
    return (
      <Panel as="section" aria-busy="true" aria-label={liftFeed.weatherLoading} className={styles.panel}>
        <Skeleton lines={3} height="2.5rem" />
      </Panel>
    );
  }
  const outlook = data?.outlook;
  if (!outlook || outlook.days.length === 0) return null;

  const worst = outlook.worstDate === null ? undefined : outlook.days.find((day) => day.date === outlook.worstDate);

  return (
    <Panel
      title={liftFeed.weatherTitle}
      tag={
        outlook.atRisk > 0 ? (
          <Tag tone="warn" icon="alert">
            {liftFeed.atRisk(outlook.atRisk)}
          </Tag>
        ) : undefined
      }
      className={styles.panel}
    >
      <ul className={styles.days} aria-label={liftFeed.weatherDaysLabel}>
        {outlook.days.map((day) => (
          <li
            key={day.date}
            className={styles.day}
            data-risky={day.risky}
            data-icon={day.icon}
            aria-label={liftFeed.dayLabel(day.date, day.highF, day.precipChancePercent, day.risky)}
          >
            <span className={styles.name}>{day.date === outlook.today ? liftFeed.today : liftFeed.dayShort(day.date)}</span>
            <span className={styles.icon}>
              <WeatherIcon icon={day.icon} />
            </span>
            <span className={styles.high}>{liftFeed.high(day.highF)}</span>
            <span className={styles.rain}>
              {day.risky ? <Icon name="alert" size={16} className={styles.flag} /> : null}
              {liftFeed.rain(day.precipChancePercent)}
            </span>
          </li>
        ))}
      </ul>
      {worst && worst.installs > 0 ? (
        <div className={styles.move}>
          <p className={styles.moveText}>{liftFeed.schedulerCanMove(worst.installs, liftFeed.dayLong(worst.date))}</p>
          <Button size="sm" variant="default" href="/calendar">
            {liftFeed.fixRainDay}
          </Button>
        </div>
      ) : null}
    </Panel>
  );
}
