import { displayUsPhone, type TextingView } from '@roofline/shared';
import { Panel, Tag } from '@roofline/ui';
import { texting } from '../../copy/texting.ts';
import styles from './TextingStatus.module.css';

/** The sent date as the status line shows it, for example "Oct 11". */
function formatSentDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** The waiting / approved line: the registration's state as a tag at the right of the title, and the news under it. */
export function TextingStatus({ view }: { view: TextingView }) {
  if (view.state === 'waiting') {
    return (
      <Panel
        title={texting.statusTitle}
        actions={
          <Tag tone="warn" icon="clock">
            {texting.statusTags.waiting}
          </Tag>
        }
      >
        <div className={styles.body}>
          <p className={styles.line}>{texting.waiting}</p>
          {view.submittedAt === null ? null : <p className={styles.note}>{texting.submittedOn(formatSentDate(view.submittedAt))}</p>}
        </div>
      </Panel>
    );
  }
  if (view.state === 'approved' && view.number !== null) {
    return (
      <Panel
        title={texting.statusTitle}
        actions={
          <Tag tone="ok" icon="check">
            {texting.statusTags.approved}
          </Tag>
        }
      >
        <p className={styles.line}>{texting.on(displayUsPhone(view.number))}</p>
      </Panel>
    );
  }
  if (view.state === 'approved') {
    return (
      <Panel
        title={texting.statusTitle}
        actions={
          <Tag tone="info" icon="clock">
            {texting.statusTags.almost}
          </Tag>
        }
      >
        <p className={styles.line}>{texting.gettingNumber}</p>
      </Panel>
    );
  }
  return null;
}
