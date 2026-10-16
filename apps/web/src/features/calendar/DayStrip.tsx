import { Button } from '@roofline/ui';
import { calendar } from '../../copy/calendar.ts';
import { addZonedDays, formatDayLabel, formatDayNumber, formatWeekday, weekStart, zonedDateKey } from './time.ts';
import styles from './DayStrip.module.css';

type DayStripProps = {
  zone: string;
  /** The day being looked at (any instant of it). */
  date: Date;
  /** The day that is today, "YYYY-MM-DD". */
  todayKey: string;
  /** Called with the picked day, "YYYY-MM-DD". */
  onPick: (dateKey: string) => void;
};

/** The seven days of the week being looked at, a thumb each, for a phone: Mon 2, Tue 3 ... The picked day is filled, today is ringed. */
export function DayStrip({ zone, date, todayKey, onPick }: DayStripProps) {
  const first = weekStart(date, zone);
  const picked = zonedDateKey(date, zone);
  const days = Array.from({ length: 7 }, (_, offset) => addZonedDays(first, offset, zone));
  return (
    <div role="group" aria-label={calendar.dayStripLabel} className={styles.strip}>
      {days.map((day) => {
        const key = zonedDateKey(day, zone);
        return (
          <Button
            key={key}
            variant="ghost"
            className={styles.day}
            aria-pressed={key === picked}
            aria-label={formatDayLabel(day, zone)}
            data-today={key === todayKey ? 'true' : undefined}
            data-picked={key === picked ? 'true' : undefined}
            onClick={() => onPick(key)}
          >
            <span className={styles.weekday} aria-hidden="true">
              {formatWeekday(day, zone)}
            </span>
            <span className={styles.number} aria-hidden="true">
              {formatDayNumber(day, zone)}
            </span>
          </Button>
        );
      })}
    </div>
  );
}
