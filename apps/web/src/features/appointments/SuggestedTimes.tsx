import { Button, Skeleton } from '@roofline/ui';
import { useState } from 'react';
import { appointments } from '../../copy/appointments.ts';
import { useTeam } from '../settings/api.ts';
import { useAvailability } from './api.ts';
import styles from './SuggestedTimes.module.css';
import type { Slot, SuggestedTimesProps } from './types.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
/** How many suggested times the sheet shows. */
const SHOWN = 5;
/** How far ahead the times are looked for. */
const WINDOW_DAYS = 14;

const choiceFormatters = new Map<string, Intl.DateTimeFormat>();

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

/** The suggested times for one kind of appointment: the next five open slots in the next 14 days. */
export function SuggestedTimes({ kind, userId, propertyId, zone, onPick }: SuggestedTimesProps) {
  // Fixed per mount so the query key stays the same while the sheet is open
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

  const heading = <p className={styles.heading}>{appointments.suggestedTitle}</p>;

  if (availability.isError) {
    return (
      <div className={styles.box}>
        {heading}
        <p className={styles.line}>{appointments.suggestedError}</p>
      </div>
    );
  }
  if (availability.isPending || availability.data === undefined) {
    return (
      <div className={styles.box}>
        {heading}
        <p className={styles.line}>{appointments.suggestedLoading}</p>
        <Skeleton lines={3} height="40px" />
      </div>
    );
  }

  const slots: Slot[] = availability.data.slots.slice(0, SHOWN);
  if (slots.length === 0) {
    return (
      <div className={styles.box}>
        {heading}
        <p className={styles.line}>{appointments.suggestedEmpty}</p>
      </div>
    );
  }

  const nameOf = (id: string): string => team.data?.members.find((member) => member.userId === id)?.name ?? '';

  return (
    <div className={styles.box}>
      {heading}
      <ul className={styles.list} aria-label={appointments.suggestedTitle}>
        {slots.map((slot) => {
          const who = slot.userIds[0] ?? userId;
          return (
            <li key={slot.start} className={styles.item}>
              <Button
                variant="ghost"
                className={styles.slot}
                onClick={() => onPick(slot, who)}
              >
                {appointments.suggestedChoice(formatChoiceWhen(slot.start, zone), nameOf(who))}
              </Button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
