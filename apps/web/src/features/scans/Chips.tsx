import { Icon, type IconName } from '@roofline/ui';
import type { ScanStatus } from '@roofline/shared';
import { scanReview } from '../../copy/scanReview.ts';
import apple from './apple.module.css';
import { spanText } from './scanMarks.ts';

const STATUS_LOOK: Record<ScanStatus, { tone: string; icon: IconName }> = {
  processing: { tone: 'gray', icon: 'refresh' },
  needs_review: { tone: 'orange', icon: 'alert' },
  in_review: { tone: 'blue', icon: 'pen' },
  junior_done: { tone: 'indigo', icon: 'users' },
  measured: { tone: 'green', icon: 'check' },
  visit_required: { tone: 'gray', icon: 'truck' },
};

/** Where a scan is: an icon, a word, a tint. */
export function StatusChip({ status }: { status: ScanStatus }) {
  const look = STATUS_LOOK[status];
  return (
    <span className={apple.chip} data-tone={look.tone}>
      <Icon name={look.icon} size={16} />
      {scanReview.status[status]}
    </span>
  );
}

/** The deadline: time left, red once overdue; an expedited scan has none and says so. */
export function SlaChip({ secondsLeft, expedite }: { secondsLeft: number | null; expedite: boolean }) {
  if (expedite) {
    return (
      <span className={apple.chip} data-tone="orange">
        <Icon name="bolt" size={16} />
        {scanReview.expedited}
      </span>
    );
  }
  if (secondsLeft === null) return null;
  const overdue = secondsLeft < 0;
  return (
    <span className={apple.chip} data-tone={overdue ? 'red' : 'gray'}>
      <Icon name="clock" size={16} />
      {overdue ? scanReview.slaOver(spanText(secondsLeft)) : scanReview.slaLeft(spanText(secondsLeft))}
    </span>
  );
}
