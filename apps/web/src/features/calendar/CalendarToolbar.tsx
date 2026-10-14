import { Button, IconButton, Toggle } from '@roofline/ui';
import { calendar } from '../../copy/calendar.ts';
import { PeoplePicker } from './PeoplePicker.tsx';
import type { CalendarPerson, CalendarView } from './types.ts';
import styles from './CalendarToolbar.module.css';

const VIEWS: { view: CalendarView; label: string }[] = [
  { view: 'week', label: calendar.viewWeek },
  { view: 'day', label: calendar.viewDay },
  { view: 'list', label: calendar.viewList },
];

/** A chevron drawn as a plain SVG, so no text sits inside the icon. */
function Chevron({ direction }: { direction: 'left' | 'right' }) {
  const d = direction === 'left' ? 'M15 6l-6 6 6 6' : 'M9 6l6 6-6 6';
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">
      <path d={d} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

type CalendarToolbarProps = {
  view: CalendarView;
  label: string;
  onView: (view: CalendarView) => void;
  onToday: () => void;
  onPrev: () => void;
  onNext: () => void;
  onNew: () => void;
  people: CalendarPerson[];
  selected: string[];
  onPeople: (ids: string[]) => void;
  showPeople: boolean;
  showCanceled: boolean;
  onShowCanceled: (value: boolean) => void;
  zoneNote: string | null;
};

/** The calendar's controls: move through dates, switch the view, pick people, show canceled, and add an appointment. */
export function CalendarToolbar(props: CalendarToolbarProps) {
  const { view, label, onView, onToday, onPrev, onNext, onNew, people, selected, onPeople, showPeople } = props;
  const { showCanceled, onShowCanceled, zoneNote } = props;

  return (
    <div className={styles.toolbar}>
      <div className={styles.row}>
        <div className={styles.nav}>
          <Button variant="ghost" onClick={onToday}>
            {calendar.today}
          </Button>
          <IconButton label={calendar.previous} icon={<Chevron direction="left" />} onClick={onPrev} />
          <IconButton label={calendar.next} icon={<Chevron direction="right" />} onClick={onNext} />
          <span className={styles.label}>{label}</span>
        </div>
        <div className={styles.views} role="group" aria-label={calendar.viewOptions}>
          {VIEWS.map((option) => {
            const selectedView = option.view === view;
            return (
              <Button
                key={option.view}
                variant={selectedView ? 'primary' : 'ghost'}
                aria-pressed={selectedView}
                data-selected={selectedView ? 'true' : 'false'}
                onClick={() => onView(option.view)}
              >
                {option.label}
              </Button>
            );
          })}
        </div>
      </div>
      <div className={styles.row}>
        {showPeople ? <PeoplePicker people={people} selected={selected} onChange={onPeople} /> : null}
        <div className={styles.end}>
          <Toggle checked={showCanceled} onChange={onShowCanceled} label={calendar.showCanceled} />
          <Button variant="primary" onClick={onNew}>
            {calendar.newAppointment}
          </Button>
        </div>
      </div>
      {zoneNote !== null ? (
        <p className={styles.zoneNote} data-testid="zone-note">
          {zoneNote}
        </p>
      ) : null}
    </div>
  );
}
