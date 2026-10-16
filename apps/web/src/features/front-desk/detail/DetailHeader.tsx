import type { ConversationDetail } from '@roofline/shared';
import { Avatar, Banner, Button, Icon, Tag } from '@roofline/ui';
import { useMe } from '../../../api/hooks.ts';
import { conversationCopy } from '../../../copy/front-desk-conversation.ts';
import { formatPhone } from '../../../lib/phone.ts';
import { useMarkSpam } from '../conversation-api.ts';
import { clock, outcomeChip, whenLabel } from '../format.ts';
import { callSeconds } from './RecordingPanel.tsx';
import styles from './DetailHeader.module.css';

const copy = conversationCopy;

/**
 * Who this is and what came of it: the name, the outcome as a tag, the number, when and how long, and the things to do next:
 * call them back, open their job, or (for the owner and the office, on a call) mark it as spam.
 */
export function DetailHeader({ conversation, zone, nameId }: { conversation: ConversationDetail; zone: string; nameId: string }) {
  const name = conversation.customer?.name ?? null;
  const role = useMe().data?.role;
  const markSpam = useMarkSpam(conversation.id);
  const lastCall = conversation.calls.at(-1) ?? null;
  const isCall = conversation.channel === 'voice';
  const jobId = conversation.links?.jobIds[0] ?? null;
  const first = conversation.turns.reduce<string | null>((earliest, turn) => (earliest === null || turn.at < earliest ? turn.at : earliest), null);
  const started = lastCall?.startedAt ?? first;
  const seconds = lastCall === null ? null : callSeconds(lastCall);
  const chip = conversation.outcome !== null ? outcomeChip({ outcome: conversation.outcome, channel: conversation.channel }) : null;
  const marked = isCall && lastCall !== null && lastCall.spamReason !== null;
  const canMarkSpam = (role === 'owner' || role === 'office') && isCall && lastCall !== null && lastCall.spamReason === null;

  return (
    <div className={styles.header}>
      <span className={styles.lead}>
        {name === null ? (
          <span className={styles.glyph} aria-hidden="true">
            <Icon name={isCall ? 'phone' : 'msg'} size={22} />
          </span>
        ) : (
          <Avatar name={name} size={40} />
        )}
      </span>
      <div className={styles.who}>
        <h2 id={nameId} className={styles.name}>
          {name ?? copy.unknownCaller}
        </h2>
        <p className={styles.tags}>
          {chip !== null ? (
            <Tag tone={chip.tone} icon={chip.icon}>
              {chip.label}
            </Tag>
          ) : null}
          {marked ? (
            <Tag tone="warn" icon="lock">
              {copy.spamMarked}
            </Tag>
          ) : null}
        </p>
      </div>
      <div className={styles.actions}>
        <Button variant="default" href={`tel:${conversation.phoneE164}`}>
          <Icon name="phone" size={16} />
          {copy.callBack}
        </Button>
        {jobId !== null ? (
          <Button variant="default" href={`/jobs/${jobId}`}>
            <Icon name="jobs" size={16} />
            {copy.openJob}
          </Button>
        ) : null}
        {canMarkSpam ? (
          <Button variant="ghost" busy={markSpam.isPending} onClick={() => lastCall !== null && markSpam.mutate(lastCall.id)}>
            {copy.markSpam}
          </Button>
        ) : null}
      </div>
      <p className={styles.meta}>
        <span className={styles.item}>
          <Icon name="phone" size={16} />
          <span className={styles.mono}>{formatPhone(conversation.phoneE164)}</span>
        </span>
        {started !== null ? (
          <span className={styles.item}>
            <Icon name="clock" size={16} />
            <span>{whenLabel(started, new Date(), zone)}</span>
          </span>
        ) : null}
        {seconds !== null ? (
          <span className={styles.item}>
            <Icon name={isCall ? 'phone' : 'msg'} size={16} />
            <span className={styles.mono}>{clock(seconds)}</span>
            <span>{isCall ? copy.callWord : copy.textWord}</span>
          </span>
        ) : null}
      </p>
      {markSpam.isError ? (
        <div className={styles.banner}>
          <Banner tone="danger">{copy.spamFailed}</Banner>
        </div>
      ) : null}
    </div>
  );
}
