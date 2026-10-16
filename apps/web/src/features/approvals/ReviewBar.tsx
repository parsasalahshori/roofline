import { Button, Icon, type ApprovalSummary } from '@roofline/ui';
import { review } from '../../copy/review.ts';
import styles from './ReviewBar.module.css';

/** A line over the buttons: a refusal (an error) or a change the screen has taken in (a notice). */
export type BarNotice = { tone: 'error' | 'notice'; text: string };

export type ReviewBarProps = {
  /** What pressing Approve would do right now. */
  summary: ApprovalSummary;
  /** A step spends money: the note says where it comes from. */
  spends: boolean;
  /** The approval is on its way, or a switch is: Approve waits. */
  approving: boolean;
  notice: BarNotice | null;
  onApprove: () => void;
  onNotNow: () => void;
};

/**
 * The decision, pinned to the bottom of the screen while the plan scrolls: what Approve will do, in its own words
 * ("Approve 3 steps · up to $270"), and Not now. On a phone it runs edge to edge just above the tabs.
 */
export function ReviewBar({ summary, spends, approving, notice, onApprove, onNotNow }: ReviewBarProps) {
  const nothingOn = summary.count + summary.ownerSteps === 0;
  return (
    <div className={styles.bar} role="group" aria-label={review.barLabel}>
      {notice !== null ? (
        <p className={styles.notice} data-tone={notice.tone} role={notice.tone === 'error' ? 'alert' : 'status'}>
          <Icon name="alert" size={16} />
          {notice.text}
        </p>
      ) : null}
      <div className={styles.row}>
        <p className={styles.note}>{spends ? review.footerNoteSpend : review.footerNote}</p>
        <div className={styles.buttons}>
          <Button variant="ghost" disabled={approving} onClick={onNotNow}>
            {review.notNow}
          </Button>
          <Button variant="primary" size="lg" busy={approving} disabled={nothingOn} onClick={onApprove}>
            {nothingOn ? (
              review.nothingOn
            ) : (
              <>
                <Icon name="check" size={16} />
                {review.approveButton(summary)}
              </>
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}
