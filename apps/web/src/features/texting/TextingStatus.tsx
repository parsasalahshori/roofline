import { displayUsPhone, type TextingView } from '@roofline/shared';
import { Card } from '@roofline/ui';
import { texting } from '../../copy/texting.ts';
import styles from './TextingStatus.module.css';

/** The sent date as the status line shows it, for example "Oct 11". */
function formatSentDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** The waiting / approved line. */
export function TextingStatus({ view }: { view: TextingView }) {
  if (view.state === 'waiting') {
    return (
      <Card className={styles.card}>
        <p className={styles.line}>{texting.waiting}</p>
        {view.submittedAt === null ? null : <p className={styles.note}>{texting.submittedOn(formatSentDate(view.submittedAt))}</p>}
      </Card>
    );
  }
  if (view.state === 'approved' && view.number !== null) {
    return (
      <Card className={styles.card}>
        <p className={styles.line}>{texting.on(displayUsPhone(view.number))}</p>
      </Card>
    );
  }
  return null;
}
