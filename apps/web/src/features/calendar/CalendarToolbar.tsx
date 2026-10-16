import { Button, Icon, IconButton, Segmented, Toggle } from '@roofline/ui';
import { calendar } from '../../copy/calendar.ts';
import { PeoplePicker } from './PeoplePicker.tsx';
import type { CalendarPerson, CalendarView } from './types.ts';
import styles from './CalendarToolbar.module.css';

const VIEWS: { value: CalendarView; label: string }[] = [
  { value: 'day', label: calendar.viewDay },
  { value: 'week', label: calendar.viewWeek },
  { value: 'list', label: calendar.viewList },
];

type CalendarToolbarProps = {
  view: CalendarView;
  label: string;
  onView: (view: CalendarView) => void;
  onToday: () => void;
  onPrev: () => void;
  onNext: () => void;
  people: CalendarPerson[];
  selected: string[];
  onPeople: (ids: string[]) => void;
  showPeople: boolean;
  showCanceled: boolean;
  onShowCanceled: (value: boolean) => void;
  zoneNote: string | null;
};

/**
 * The calendar's controls. First row: Today and the two arrows (ghost), the range in Archivo, and the Day / Week / List switch.
 * Second row: whose appointments to show, as chips with a colour dot, and Show canceled. The New appointment button is the page's.
 */
export function CalendarToolbar(props: CalendarToolbarProps) {
  const { view, label, onView, onToday, onPrev, onNext, people, selected, onPeople, showPeople } = props;
  const { showCanceled, onShowCanceled, zoneNote } = props;

  return (
    <div className={styles.toolbar}>
      <div className={styles.row}>
        <div className={styles.nav}>
          <div className={styles.steps}>
            <Button variant="ghost" onClick={onToday}>
              {calendar.today}
            </Button>
            <IconButton label={calendar.previous} icon={<Icon name="chevl" size={18} />} onClick={onPrev} />
            <IconButton label={calendar.next} icon={<Icon name="chev" size={18} />} onClick={onNext} />
          </div>
          <p className={styles.label} aria-live="polite">
            {label}
          </p>
        </div>
        <Segmented<CalendarView> label={calendar.viewLabel} value={view} onChange={onView} options={VIEWS} className={styles.views} />
      </div>
      <div className={styles.row}>
        {showPeople ? <PeoplePicker people={people} selected={selected} onChange={onPeople} /> : <span />}
        <Toggle checked={showCanceled} onChange={onShowCanceled} label={calendar.showCanceled} />
      </div>
      {zoneNote !== null ? (
        <p className={styles.zoneNote} data-testid="zone-note">
          {zoneNote}
        </p>
      ) : null}
    </div>
  );
}
