import { useWeather } from '../../api/hooks.ts';
import { shell } from '../../copy/shell.ts';
import { WeatherIcon } from './topbarIcons.tsx';
import styles from './WeatherChip.module.css';

/**
 * The weather at the company: an icon, the temperature and a short summary. Hidden when there is
 * no weather or it cannot be loaded. A failed read says nothing: the weather is a nicety, not a task.
 */
export function WeatherChip() {
  const { data, isError } = useWeather();
  const weather = isError ? null : data?.weather;
  if (!weather) return null;
  return (
    <span className={styles.chip} data-weather={weather.icon}>
      <WeatherIcon icon={weather.icon} />
      <span className={styles.temp}>{shell.degrees(weather.tempF)}</span>
      <span className={styles.summary}>{weather.summary}</span>
    </span>
  );
}
