import { Skeleton } from '@roofline/ui';
import { liftFeed } from '../../../copy/liftFeed.ts';
import { WeatherIcon } from '../../../shell/weatherIcon.tsx';
import { useWeatherOutlook } from './liftApi.ts';
import styles from './CrewWeatherCard.module.css';

/**
 * The next six days for the crew: icon, high and rain chance per day, the days the Scheduler's rain
 * rule calls risky in amber, and what the Scheduler can move. Everything comes from the same
 * forecast the Scheduler reads (GET /api/weather/outlook). With no forecast it renders nothing.
 */
export function CrewWeatherCard() {
  const { data, isPending } = useWeatherOutlook();

  if (isPending) {
    return (
      <section className={styles.card} aria-busy="true" aria-label={liftFeed.weatherLoading}>
        <Skeleton lines={3} height="2.5rem" />
      </section>
    );
  }
  const outlook = data?.outlook;
  if (!outlook || outlook.days.length === 0) return null;

  const worst = outlook.worstDate === null ? undefined : outlook.days.find((day) => day.date === outlook.worstDate);

  return (
    <section className={styles.card} aria-labelledby="lift-crew-weather">
      <div className={styles.head}>
        <h2 id="lift-crew-weather" className={styles.title}>
          {liftFeed.weatherTitle}
        </h2>
        {outlook.atRisk > 0 ? <span className={styles.chip}>{liftFeed.atRisk(outlook.atRisk)}</span> : null}
      </div>
      <ul className={styles.days} aria-label={liftFeed.weatherDaysLabel}>
        {outlook.days.map((day) => (
          <li
            key={day.date}
            className={styles.day}
            data-risky={day.risky}
            data-icon={day.icon}
            aria-label={liftFeed.dayLabel(day.date, day.highF, day.precipChancePercent)}
          >
            <span className={styles.name}>{day.date === outlook.today ? liftFeed.today : liftFeed.dayShort(day.date)}</span>
            <span className={styles.icon}>
              <WeatherIcon icon={day.icon} />
            </span>
            <span className={styles.high}>{liftFeed.high(day.highF)}</span>
            <span className={styles.rain}>{liftFeed.rain(day.precipChancePercent)}</span>
          </li>
        ))}
      </ul>
      {worst && worst.installs > 0 ? (
        <p className={styles.move}>
          <span className={styles.moveMark} aria-hidden="true">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" focusable="false">
              <path d="M2.5 7.5L6 4l3.5 3.5" />
            </svg>
          </span>
          <span>{liftFeed.schedulerCanMove(worst.installs, liftFeed.dayLong(worst.date))}</span>
        </p>
      ) : null}
    </section>
  );
}
