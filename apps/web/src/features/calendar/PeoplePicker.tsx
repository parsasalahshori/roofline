import { Checkbox } from '@roofline/ui';
import { calendar } from '../../copy/calendar.ts';
import type { CalendarPerson } from './types.ts';
import styles from './PeoplePicker.module.css';

/** The colour of each person, in team order. Stage and hail tokens only: they are the palette the app already uses. */
export const PERSON_COLORS = [
  'var(--st-lead)',
  'var(--st-insp)',
  'var(--st-prop)',
  'var(--st-won)',
  'var(--st-inst)',
  'var(--hail-3)',
  'var(--hail-4)',
  'var(--hail-5)',
] as const;

/** The colour for the person at `index` in team order; the palette repeats after eight people. */
export function colorFor(index: number): string {
  const color = PERSON_COLORS[index % PERSON_COLORS.length];
  return color ?? PERSON_COLORS[0];
}

type PeoplePickerProps = {
  people: CalendarPerson[];
  selected: string[];
  onChange: (ids: string[]) => void;
};

/** Which people's appointments and busy times the calendar shows. Each row is a checkbox with the person's colour. */
export function PeoplePicker({ people, selected, onChange }: PeoplePickerProps) {
  return (
    <fieldset className={styles.picker}>
      <legend className={styles.legend}>{calendar.people}</legend>
      <ul className={styles.list}>
        {people.map((person) => {
          const checked = selected.includes(person.userId);
          return (
            <li key={person.userId} className={styles.item}>
              <Checkbox
                checked={checked}
                onChange={(next) => {
                  const ids = next
                    ? [...selected, person.userId]
                    : selected.filter((id) => id !== person.userId);
                  onChange(ids);
                }}
                label={
                  <span className={styles.person}>
                    <span className={styles.dot} style={{ background: person.color }} aria-hidden="true" />
                    {person.name}
                  </span>
                }
              />
            </li>
          );
        })}
      </ul>
    </fieldset>
  );
}
