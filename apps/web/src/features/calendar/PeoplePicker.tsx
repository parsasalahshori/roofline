import { Chip } from '@roofline/ui';
import { calendar } from '../../copy/calendar.ts';
import type { CalendarPerson } from './types.ts';
import styles from './PeoplePicker.module.css';

export { colorFor, PERSON_COLORS } from './colors.ts';

type PeoplePickerProps = {
  people: CalendarPerson[];
  selected: string[];
  onChange: (ids: string[]) => void;
};

/** Whose appointments and busy times the calendar shows: one chip for each person, with their colour, on or off. */
export function PeoplePicker({ people, selected, onChange }: PeoplePickerProps) {
  return (
    <div className={styles.picker}>
      <span className={styles.eyebrow}>{calendar.people}</span>
      <div role="group" aria-label={calendar.peopleLabel} className={styles.chips}>
        {people.map((person) => {
          const on = selected.includes(person.userId);
          return (
            <Chip
              key={person.userId}
              pressed={on}
              icon={<span className={styles.dot} style={{ background: person.color }} />}
              onClick={() => onChange(on ? selected.filter((id) => id !== person.userId) : [...selected, person.userId])}
            >
              {person.name}
            </Chip>
          );
        })}
      </div>
    </div>
  );
}
