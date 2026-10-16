import { Segmented } from '@roofline/ui';
import { TIME_PERIODS, type TimePeriod } from '@roofline/shared';
import { agentPage } from '../../copy/agents.ts';

/** Today / this week / this month / last 90 days: one picked at a time. */
export function PeriodPicker({ value, onChange }: { value: TimePeriod; onChange(period: TimePeriod): void }) {
  return (
    <Segmented
      label={agentPage.periodLabel}
      value={value}
      onChange={onChange}
      options={TIME_PERIODS.map((period) => ({ value: period, label: agentPage.periods[period] }))}
    />
  );
}
