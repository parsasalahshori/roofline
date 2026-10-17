import { Button, Icon, Panel, Skeleton } from '@roofline/ui';
import { useState, type ReactNode } from 'react';
import { appointments } from '../../copy/appointments.ts';
import { useTeam } from '../settings/api.ts';
import { useAvailability } from './api.ts';
import styles from './SuggestedTimes.module.css';
import type { Slot, SuggestedTimesProps } from './types.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
/** How many suggested times the panel shows. */
const SHOWN = 5;
/** How far ahead the times are looked for. */
const WINDOW_DAYS = 14;

const choiceFormatters = new Map<string, Intl.DateTimeFormat>();
const dayFormatters = new Map<string, Intl.DateTimeFormat>();

/** A cached formatter of the weekday and clock time, in the company zone. */
function choiceFormatter(zone: string): Intl.DateTimeFormat {
  let formatter = choiceFormatters.get(zone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-US', { timeZone: zone, weekday: 'short', hour: 'numeric', minute: '2-digit' });
    choiceFormatters.set(zone, formatter);
  }
  return formatter;
}

/** "Tue 2:00 PM" for an instant, read from the company zone's own parts (never the browser's zone). */
function formatChoiceWhen(instant: string, zone: string): string {
  const parts = choiceFormatter(zone).formatToParts(new Date(instant));
  const part = (type: Intl.DateTimeFormatPartTypes): string => parts.find((p) => p.type === type)?.value ?? '';
  return `${part('weekday')} ${part('hour')}:${part('minute')} ${part('dayPeriod')}`;
}

/** "Oct 13": the date of a suggestion, since a weekday alone repeats within the two weeks. */
function formatChoiceDay(instant: string, zone: string): string {
  let formatter = dayFormatters.get(zone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-US', { timeZone: zone, month: 'short', day: 'numeric' });
    dayFormatters.set(zone, formatter);
  }
  return formatter.format(new Date(instant));
}

/** The suggested times for one kind of appointment: the next five open slots in the next 14 days, as rows to press. */
export function SuggestedTimes({ kind, userId, propertyId, zone, onPick, pickedStart = null }: SuggestedTimesProps) {
  // Fixed per mount so the query key stays the same while the panel is open
  const [now] = useState(() => new Date());
  const from = now.toISOString();
  const to = new Date(now.getTime() + WINDOW_DAYS * DAY_MS).toISOString();
  const availability = useAvailability({
    kind,
    userId: userId || undefined,
    propertyId: propertyId || undefined,
    from,
    to,
    enabled: true,
  });
  const team = useTeam();
  const wrap = (children: ReactNode) => (
    <Panel as="section" title={appointments.suggestedTitle} headingLevel={3} tag={appointments.suggestedHint} className={styles.panel}>
      {children}
    </Panel>
  );

  if (availability.isError) {
    return wrap(
      <div className={styles.errorBox}>
        <p className={styles.note} role="alert">
          <Icon name="alert" size={18} />
          {appointments.suggestedError}
        </p>
        <Button variant="default" size="sm" onClick={() => void availability.refetch()}>
          {appointments.tryAgain}
        </Button>
      </div>,
    );
  }
  if (availability.isPending || availability.data === undefined) {
    return wrap(
      <div className={styles.loading} role="status">
        <p className={styles.line}>{appointments.suggestedLoading}</p>
        <Skeleton lines={3} height="44px" />
      </div>,
    );
  }

  const slots: Slot[] = availability.data.slots.slice(0, SHOWN);
  if (slots.length === 0) {
    return wrap(
      <div className={styles.empty}>
        <p className={styles.emptyTitle}>
          <Icon name="cal" size={18} />
          {appointments.suggestedEmpty}
        </p>
        <p className={styles.line}>{appointments.suggestedEmptyHint}</p>
        <div className={styles.ghosts} aria-hidden="true">
          {[0, 1, 2].map((row) => (
            <span key={row} className={styles.ghost} />
          ))}
        </div>
      </div>,
    );
  }

  const nameOf = (id: string): string => team.data?.members.find((member) => member.userId === id)?.name ?? '';
  const pickedAt = pickedStart === null ? Number.NaN : Date.parse(pickedStart);

  return wrap(
    <ul className={styles.list} aria-label={appointments.suggestedTitle}>
      {slots.map((slot) => {
        const who = slot.userIds[0] ?? userId;
        const picked = Date.parse(slot.start) === pickedAt;
        return (
          <li key={slot.start} className={styles.item}>
            <Button variant="default" className={styles.slot} aria-pressed={picked} data-picked={picked ? 'true' : undefined} onClick={() => onPick(slot, who)}>
              <span className={styles.when}>{formatChoiceWhen(slot.start, zone)}</span>
              <span className={styles.sep}>{appointments.suggestedSeparator}</span>
              <span className={styles.who}>{nameOf(who)}</span>
              <span className={styles.day}>{formatChoiceDay(slot.start, zone)}</span>
              {picked ? <Icon name="check" size={16} className={styles.check} /> : null}
            </Button>
          </li>
        );
      })}
    </ul>,
  );
}
