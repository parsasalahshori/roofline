import { Segmented } from '@roofline/ui';
import { TIME_PERIODS, type TimePeriod } from '@roofline/shared';
import { agentPage } from '../../copy/agents.ts';
import styles from './PeriodPicker.module.css';

/** Today / this week / this month / last 90 days: one picked at a time. */
export function PeriodPicker({ value, onChange }: { value: TimePeriod; onChange(period: TimePeriod): void }) {
  return (
    <Segmented
      className={styles.picker}
      label={agentPage.periodLabel}
      value={value}
      onChange={onChange}
      options={TIME_PERIODS.map((period) => ({ value: period, label: agentPage.periods[period] }))}
    />
  );
}
