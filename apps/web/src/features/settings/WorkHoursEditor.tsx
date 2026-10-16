import { WEEKDAYS, type WorkHours, type Weekday } from '@roofline/shared';
import { Button, Field, Icon, Toggle } from '@roofline/ui';
import { schedule } from '../../copy/schedule.ts';
import styles from './WorkHoursEditor.module.css';

/** Up to this many time ranges on one day. */
const MAX_RANGES = 3;
/** The range a day gets when it is switched on. */
const OPENING_RANGE: [string, string] = ['08:00', '17:00'];
/** The range a day gets when a second one is added and there is no earlier end to start from. */
const FALLBACK_RANGE: [string, string] = ['09:00', '17:00'];
/** Two hours, in minutes: how far a new range runs past the last end. */
const NEW_RANGE_MINUTES = 120;
const LAST_MINUTE = 23 * 60 + 59;
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** 'HH:MM' to minutes past midnight, or null when the text is not a clock time. */
function toMinutes(time: string): number | null {
  const match = TIME.exec(time);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

/** Minutes past midnight to 'HH:MM', clamped so it never passes 23:59. */
function toClock(minutes: number): string {
  const clamped = Math.min(minutes, LAST_MINUTE);
  const hours = Math.floor(clamped / 60);
  const mins = clamped % 60;
  return `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
}

/** A new range starts where the last one ends and runs two hours, or the fallback when that end is not a time. */
function nextRange(ranges: [string, string][]): [string, string] {
  const last = ranges[ranges.length - 1];
  const start = last === undefined ? null : toMinutes(last[1]);
  if (start === null) return FALLBACK_RANGE;
  return [toClock(start), toClock(start + NEW_RANGE_MINUTES)];
}

export type WorkHoursEditorProps = {
  value: WorkHours;
  onChange: (next: WorkHours) => void;
  disabled?: boolean;
  /** A message from the server about one day, shown under that day. */
  errors?: Partial<Record<Weekday, string>>;
};

/** Weekly hours: per weekday an on/off switch and up to three time ranges, one day to a row. Fully controlled. */
export function WorkHoursEditor({ value, onChange, disabled = false, errors }: WorkHoursEditorProps) {
  function setDay(day: Weekday, ranges: [string, string][]) {
    onChange({ ...value, [day]: ranges });
  }

  function setRange(day: Weekday, index: number, edge: 0 | 1, time: string) {
    setDay(
      day,
      value[day].map((range, position) => {
        if (position !== index) return range;
        const next: [string, string] = [range[0], range[1]];
        next[edge] = time;
        return next;
      }),
    );
  }

  return (
    <div className={styles.days}>
      {WEEKDAYS.map((day) => {
        const name = schedule.weekday[day];
        const ranges = value[day];
        const open = ranges.length > 0;
        const problem = errors?.[day];
        return (
          <div key={day} role="group" aria-label={name} className={styles.day} data-open={open ? true : undefined}>
            <div className={styles.header}>
              <Toggle
                checked={open}
                label={name}
                labelHidden
                disabled={disabled}
                onChange={(next) => setDay(day, next ? [OPENING_RANGE] : [])}
              />
              <span className={styles.name}>{name}</span>
              <span className={styles.state}>{open ? schedule.open : schedule.closed}</span>
            </div>
            {open ? (
              <div className={styles.ranges}>
                {ranges.map((range, index) => (
                  <div key={index} className={styles.range}>
                    <Field
                      type="time"
                      label={schedule.start}
                      labelHidden
                      aria-label={`${name} ${schedule.start}`}
                      value={range[0]}
                      disabled={disabled}
                      onChange={(event) => setRange(day, index, 0, event.target.value)}
                      className={styles.time}
                    />
                    <span className={styles.to} aria-hidden="true">
                      {'–'}
                    </span>
                    <Field
                      type="time"
                      label={schedule.end}
                      labelHidden
                      aria-label={`${name} ${schedule.end}`}
                      value={range[1]}
                      disabled={disabled}
                      onChange={(event) => setRange(day, index, 1, event.target.value)}
                      className={styles.time}
                    />
                    {/* A day's last range is not removed: the switch closes the day */}
                    {ranges.length > 1 ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={disabled}
                        onClick={() => setDay(day, ranges.filter((_, position) => position !== index))}
                      >
                        {schedule.removeRange}
                      </Button>
                    ) : null}
                  </div>
                ))}
                {ranges.length < MAX_RANGES ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={disabled}
                    onClick={() => setDay(day, [...ranges, nextRange(ranges)])}
                  >
                    <Icon name="plus" size={16} />
                    {schedule.addRange}
                  </Button>
                ) : null}
              </div>
            ) : (
              <span />
            )}
            {problem ? (
              <p role="alert" className={styles.error}>
                {problem}
              </p>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
