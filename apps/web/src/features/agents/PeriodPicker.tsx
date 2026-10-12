import { Button } from '@roofline/ui';
import { TIME_PERIODS, type TimePeriod } from '@roofline/shared';
import { agentPage } from '../../copy/agents.ts';
import styles from './AgentPage.module.css';

/** Today / this week / this month / last 90 days: one pressed at a time. */
export function PeriodPicker({ value, onChange }: { value: TimePeriod; onChange(period: TimePeriod): void }) {
  return (
    <div role="group" aria-label={agentPage.periodLabel} className={styles.periods}>
      {TIME_PERIODS.map((period) => (
        <Button
          key={period}
          type="button"
          variant={period === value ? 'primary' : 'ghost'}
          aria-pressed={period === value}
          onClick={() => onChange(period)}
        >
          {agentPage.periods[period]}
        </Button>
      ))}
    </div>
  );
}
